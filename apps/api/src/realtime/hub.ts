import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import jwt from "jsonwebtoken";
import pg from "pg";
import { WebSocketServer, type WebSocket } from "ws";
import { env } from "../config/env.js";
import { pool, withSystem, withTenant, type Db } from "../database/pool.js";

/**
 * Real-time push over one WebSocket per browser tab (/api/v1/ws).
 *
 * - The client authenticates with its first frame ({type:"auth", token, tenantId});
 *   tokens never go in the URL, so they stay out of proxy logs.
 * - Events are published with pg_notify inside the writing transaction, so they
 *   fan out only after commit and across every API instance (LISTEN chat_events).
 * - Chat: new messages, delivered/read receipts, typing indicators and presence
 *   (online / last seen). Clients also receive "notify" events for other modules.
 */

export interface ChatEvent {
  type: string;
  [k: string]: unknown;
}

interface Client {
  ws: WebSocket;
  userId: string;
  tenantId: string;
  name: string;
  watching: Set<string>;
  conversations: Set<string>; // memberships verified for typing
  alive: boolean;
}

const CHANNEL = "chat_events";
// NOTIFY payloads are capped at 8000 bytes; larger events are sent without the
// message body and clients fetch it.
const MAX_NOTIFY = 7500;

/** Queue an event for some users of a tenant ("all" = everyone signed in to it); delivered after the transaction commits. */
export async function publish(db: Db | pg.Pool, tenantId: string, userIds: string[] | "all", event: ChatEvent) {
  if (userIds !== "all" && !userIds.length) return;
  const u = userIds === "all" ? "all" : [...new Set(userIds)];
  let payload = JSON.stringify({ t: tenantId, u, e: event });
  if (payload.length > MAX_NOTIFY && event.message && typeof event.message === "object") {
    payload = JSON.stringify({ t: tenantId, u, e: { ...event, message: { ...(event.message as object), body: null }, truncated: true } });
  }
  if (payload.length > MAX_NOTIFY) payload = JSON.stringify({ t: tenantId, u, e: { type: event.type, conversationId: event.conversationId, truncated: true } });
  await db.query(`SELECT pg_notify($1, $2)`, [CHANNEL, payload]);
}

class ChatHub {
  private wss: WebSocketServer | null = null;
  private clients = new Set<Client>();
  private listener: pg.Client | null = null;
  private connecting: Promise<void> | null = null;
  private heartbeat: NodeJS.Timeout | null = null;

  attach(server: Server) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!req.url?.startsWith("/api/v1/ws")) return socket.destroy();
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        c.ws.ping();
      }
    }, 30_000);
    this.ensureListening().catch((err) => console.error("chat hub: could not LISTEN", err.message));
  }

  async close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
    this.wss?.close();
    await this.listener?.end().catch(() => {});
    this.listener = null;
    this.connecting = null;
  }

  /** Online now (on this instance or any other that has told us). */
  isOnline(tenantId: string, userId: string) {
    for (const c of this.clients) if (c.tenantId === tenantId && c.userId === userId) return true;
    return false;
  }

  private ensureListening(): Promise<void> {
    if (this.listener) return Promise.resolve();
    this.connecting ??= (async () => {
      const client = new pg.Client({ connectionString: env.DATABASE_URL });
      client.on("notification", (msg) => {
        try {
          const { t, u, e } = JSON.parse(msg.payload ?? "{}");
          this.deliver(t, u, e);
        } catch {
          /* ignore malformed payloads */
        }
      });
      client.on("error", (err) => {
        console.error("chat hub connection lost", err.message);
        this.listener = null;
        this.connecting = null;
        setTimeout(() => this.ensureListening().catch(() => {}), 2000);
      });
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      this.listener = client;
    })().catch((err) => {
      this.connecting = null;
      throw err;
    });
    return this.connecting;
  }

  private deliver(tenantId: string, userIds: string[] | "all", event: ChatEvent) {
    const to = userIds === "all" ? null : new Set(userIds);
    const data = JSON.stringify(event);
    for (const c of this.clients) if (c.tenantId === tenantId && (!to || to.has(c.userId)) && c.ws.readyState === c.ws.OPEN) c.ws.send(data);
  }

  private onConnection(ws: WebSocket) {
    let client: Client | null = null;
    const authTimer = setTimeout(() => !client && ws.close(4401, "authentication required"), 10_000);
    ws.on("message", async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      try {
        if (!client) {
          if (msg.type !== "auth") return;
          client = await this.authenticate(ws, msg);
          clearTimeout(authTimer);
          if (!client) return;
          return;
        }
        await this.handle(client, msg);
      } catch (err) {
        console.error("chat hub message error", (err as Error).message);
      }
    });
    ws.on("pong", () => client && (client.alive = true));
    ws.on("close", () => {
      clearTimeout(authTimer);
      if (!client) return;
      this.clients.delete(client);
      if (!this.isOnline(client.tenantId, client.userId)) {
        const c = client;
        withSystem((db) => db.query(`UPDATE users SET last_seen_at = now() WHERE id = $1`, [c.userId]))
          .then(() => this.broadcastPresence(c.tenantId, c.userId, false))
          .catch(() => {});
      }
    });
  }

  private async authenticate(ws: WebSocket, msg: { token?: string; tenantId?: string }): Promise<Client | null> {
    const fail = (code: string) => {
      ws.send(JSON.stringify({ type: "auth.error", code }));
      ws.close(4401, code);
      return null;
    };
    let userId: string;
    try {
      const claims = jwt.verify(String(msg.token ?? ""), env.JWT_SECRET, { issuer: "ai-gurukul" }) as { sub: string; typ: string };
      if (claims.typ !== "access") return fail("invalid_token");
      userId = claims.sub;
    } catch {
      return fail("expired_token");
    }
    const tenantId = String(msg.tenantId ?? "");
    const row = await withSystem(async (db) =>
      (
        await db.query(
          `SELECT u.name FROM tenant_memberships m JOIN users u ON u.id = m.user_id JOIN tenants t ON t.id = m.tenant_id
            WHERE m.tenant_id::text = $1 AND m.user_id = $2 AND m.status = 'active' AND t.status = 'active' AND u.status = 'active' LIMIT 1`,
          [tenantId, userId],
        )
      ).rows[0],
    );
    if (!row) return fail("not_a_member");
    const client: Client = { ws, userId, tenantId, name: row.name, watching: new Set(), conversations: new Set(), alive: true };
    const wasOnline = this.isOnline(tenantId, userId);
    this.clients.add(client);
    ws.send(JSON.stringify({ type: "ready", userId }));
    if (!wasOnline) this.broadcastPresence(tenantId, userId, true);
    return client;
  }

  private broadcastPresence(tenantId: string, userId: string, online: boolean) {
    const data = JSON.stringify({ type: "presence", users: [{ userId, online, lastSeen: online ? null : new Date().toISOString() }] });
    for (const c of this.clients) if (c.tenantId === tenantId && c.watching.has(userId) && c.ws.readyState === c.ws.OPEN) c.ws.send(data);
  }

  private async isMember(c: Client, conversationId: string) {
    if (c.conversations.has(conversationId)) return true;
    const ok = await withTenant(c.tenantId, async (db) => (await db.query(`SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`, [conversationId, c.userId])).rowCount);
    if (ok) c.conversations.add(conversationId);
    return !!ok;
  }

  private async membersOf(tenantId: string, conversationId: string) {
    return withTenant(tenantId, async (db) => (await db.query(`SELECT user_id FROM conversation_members WHERE conversation_id = $1`, [conversationId])).rows.map((r) => r.user_id as string));
  }

  private async handle(c: Client, msg: any) {
    switch (msg.type) {
      case "ping":
        c.ws.send(JSON.stringify({ type: "pong" }));
        return;
      case "typing": {
        const id = String(msg.conversationId ?? "");
        if (!/^[0-9a-f-]{36}$/i.test(id) || !(await this.isMember(c, id))) return;
        const others = (await this.membersOf(c.tenantId, id)).filter((u) => u !== c.userId);
        await publish(pool, c.tenantId, others, { type: "typing", conversationId: id, userId: c.userId, name: c.name, typing: msg.typing !== false });
        return;
      }
      case "presence.watch": {
        const ids: string[] = Array.isArray(msg.userIds) ? msg.userIds.filter((x: unknown) => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)).slice(0, 200) : [];
        c.watching = new Set(ids);
        if (!ids.length) return;
        const seen = await withSystem(async (db) => (await db.query(`SELECT id, last_seen_at FROM users WHERE id = ANY($1::uuid[])`, [ids])).rows);
        c.ws.send(
          JSON.stringify({
            type: "presence",
            users: seen.map((u) => ({ userId: u.id, online: this.isOnline(c.tenantId, u.id), lastSeen: u.last_seen_at })),
          }),
        );
        return;
      }
      case "delivered": {
        // The client got new messages: mark every conversation of theirs delivered.
        await withTenant(c.tenantId, async (db) => {
          const rows = (
            await db.query(
              `UPDATE conversation_members me SET last_delivered_at = now()
                 FROM conversations cv WHERE cv.id = me.conversation_id AND me.user_id = $1 AND me.last_delivered_at < cv.last_message_at
               RETURNING me.conversation_id, me.last_delivered_at, me.last_read_at`,
              [c.userId],
            )
          ).rows;
          for (const r of rows) {
            const members = (await db.query(`SELECT user_id FROM conversation_members WHERE conversation_id = $1`, [r.conversation_id])).rows.map((x) => x.user_id);
            await publish(db, c.tenantId, members, { type: "receipt", conversationId: r.conversation_id, userId: c.userId, deliveredAt: r.last_delivered_at, readAt: r.last_read_at });
          }
        });
        return;
      }
    }
  }
}

export const chatHub = new ChatHub();
