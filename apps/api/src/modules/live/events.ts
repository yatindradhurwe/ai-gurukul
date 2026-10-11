import pg from "pg";
import { env } from "../../config/env.js";
import type { Db } from "../../database/pool.js";

export type Audience = { kind: "all" } | { kind: "staff" } | { kind: "user"; userId: string };

/**
 * Append an event to the session log and notify listeners. pg_notify is
 * transactional, so subscribers are only woken once the event is committed —
 * and LISTEN/NOTIFY fans out across every API instance.
 */
export async function publishEvent(
  db: Db,
  e: { tenantId: string; sessionId: string; type: string; payload: unknown; actorId?: string | null; audience?: Audience },
) {
  const audience = e.audience ?? { kind: "all" };
  const row = (
    await db.query(
      `INSERT INTO live_session_events (tenant_id, session_id, type, audience, recipient_id, actor_id, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [e.tenantId, e.sessionId, e.type, audience.kind, audience.kind === "user" ? audience.userId : null, e.actorId ?? null, JSON.stringify(e.payload)],
    )
  ).rows[0];
  await db.query(`SELECT pg_notify('live_events', $1)`, [JSON.stringify({ s: e.sessionId })]);
  return Number(row.id);
}

/** Events this viewer may see, after a given id. */
export async function fetchEvents(db: Db, sessionId: string, afterId: number, viewer: { userId: string; staff: boolean }, limit = 200) {
  const { rows } = await db.query(
    `SELECT id, type, payload, created_at FROM live_session_events
      WHERE session_id = $1 AND id > $2
        AND (audience = 'all' OR (audience = 'staff' AND $3) OR (audience = 'user' AND recipient_id = $4))
      ORDER BY id LIMIT $5`,
    [sessionId, afterId, viewer.staff, viewer.userId, limit],
  );
  return rows.map((r) => ({ id: Number(r.id), type: r.type as string, payload: r.payload, createdAt: r.created_at }));
}

type Listener = () => void;

/** Process-wide LISTEN connection that wakes local stream subscribers per session. */
class LiveHub {
  private listeners = new Map<string, Set<Listener>>();
  private client: pg.Client | null = null;
  private connecting: Promise<void> | null = null;

  async subscribe(sessionId: string, fn: Listener): Promise<() => void> {
    await this.ensureListening();
    let set = this.listeners.get(sessionId);
    if (!set) this.listeners.set(sessionId, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.listeners.delete(sessionId);
    };
  }

  private ensureListening(): Promise<void> {
    if (this.client) return Promise.resolve();
    this.connecting ??= (async () => {
      const client = new pg.Client({ connectionString: env.DATABASE_URL });
      client.on("notification", (msg) => {
        try {
          const { s } = JSON.parse(msg.payload ?? "{}");
          for (const fn of this.listeners.get(s) ?? []) fn();
        } catch {
          /* ignore malformed payloads */
        }
      });
      client.on("error", (err) => {
        console.error("live hub connection lost", err.message);
        this.client = null;
        this.connecting = null;
        // Wake everyone so they re-read from the database, then reconnect lazily.
        for (const set of this.listeners.values()) for (const fn of set) fn();
        if (this.listeners.size) setTimeout(() => this.ensureListening().catch(() => {}), 2000);
      });
      await client.connect();
      await client.query("LISTEN live_events");
      this.client = client;
    })().finally(() => (this.connecting = null));
    return this.connecting;
  }

  async close() {
    await this.client?.end().catch(() => {});
    this.client = null;
  }
}

export const liveHub = new LiveHub();
