/** Real-time chat over WebSocket: authentication, messages, receipts, typing and presence. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { liveHub } from "../src/modules/live/events.js";
import { chatHub } from "../src/realtime/hub.js";
import { api, app, dbAvailable, login, register, resetDb, uniqueEmail, type Session } from "./helpers.js";

describe.skipIf(!dbAvailable)("real-time chat", () => {
  let server: Server;
  let url: string;
  let owner: Session;
  let teacher: Session;
  let schoolId: string;
  const sockets: WebSocket[] = [];

  /** Open a socket, authenticate, and collect every event it receives. */
  async function connect(s: Session, tenantId = s.tenantId) {
    const ws = new WebSocket(url);
    sockets.push(ws);
    const events: any[] = [];
    ws.on("message", (raw) => events.push(JSON.parse(String(raw))));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "auth", token: s.token, tenantId }));
    const next = (type: string, timeout = 3000) =>
      new Promise<any>((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => {
          const i = events.findIndex((e) => e.type === type);
          if (i >= 0) return resolve(events.splice(i, 1)[0]);
          if (Date.now() - t0 > timeout) return reject(new Error(`no ${type} event`));
          setTimeout(tick, 20);
        };
        tick();
      });
    return { ws, events, next };
  }

  beforeAll(async () => {
    await resetDb();
    server = createServer(app);
    chatHub.attach(server);
    await new Promise<void>((r) => server.listen(0, r));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/ws`;
    owner = await register("parent", "Principal");
    const t = (await request(app).post("/api/v1/tenants").set("Authorization", `Bearer ${owner.token}`).send({ name: "Sunrise School", type: "school" }).expect(201)).body.tenant;
    schoolId = t.id;
    owner = { ...owner, tenantId: schoolId, headers: { ...owner.headers, "X-Tenant-Id": schoolId } };
    const email = uniqueEmail("teacher");
    await request(app).post("/api/v1/auth/register").send({ name: "Meera Teacher", email, password: "password-1234", accountType: "student" }).expect(201);
    const inv = await api.post(owner, `/api/v1/tenants/${schoolId}/invitations`, { email, role: "teacher" }).expect(201);
    teacher = await login(email, "password-1234", schoolId);
    await api.post(teacher, "/api/v1/tenants/invitations/accept", { token: inv.body.token }).expect(200);
  });

  afterAll(async () => {
    for (const ws of sockets) ws.terminate();
    await chatHub.close();
    await new Promise((r) => server.close(r));
    await liveHub.close();
  });

  it("rejects bad tokens and non-members", async () => {
    const bad = await connect({ ...owner, token: "nope" });
    expect((await bad.next("auth.error")).code).toBe("expired_token");
    const outsider = await register("parent", "Elsewhere");
    const stranger = await connect(outsider, schoolId);
    expect((await stranger.next("auth.error")).code).toBe("not_a_member");
  });

  it("delivers messages instantly with delivered and read receipts, typing and presence", async () => {
    const p = await connect(owner);
    await p.next("ready");
    const t = await connect(teacher);
    await t.next("ready");

    // Presence: the principal watches the teacher and sees them online.
    p.ws.send(JSON.stringify({ type: "presence.watch", userIds: [teacher.userId] }));
    expect((await p.next("presence")).users[0]).toMatchObject({ userId: teacher.userId, online: true });

    const sent = await api.post(owner, "/api/v1/messages/conversations", { recipientId: teacher.userId, body: "Staff meeting at 3?" }).expect(201);
    const cid = sent.body.conversationId;
    const got = await t.next("message");
    expect(got).toMatchObject({ conversationId: cid, message: { body: "Staff meeting at 3?", sender: "Principal" } });
    await p.next("message"); // the sender's other tabs get it too

    // Typing goes only to the other member.
    t.ws.send(JSON.stringify({ type: "typing", conversationId: cid }));
    expect(await p.next("typing")).toMatchObject({ conversationId: cid, userId: teacher.userId, name: "Meera Teacher" });

    // Delivered (✓✓) when the teacher's app acknowledges, read (blue ✓✓) when they open it.
    t.ws.send(JSON.stringify({ type: "delivered" }));
    const delivered = await p.next("receipt");
    expect(delivered).toMatchObject({ conversationId: cid, userId: teacher.userId });
    expect(new Date(delivered.deliveredAt).getTime()).toBeGreaterThan(new Date(delivered.readAt).getTime());
    await api.post(teacher, `/api/v1/messages/conversations/${cid}/read`).expect(200);
    const read = await p.next("receipt");
    expect(read.readAt).toBeTruthy();

    // A stranger can't fake typing into someone else's conversation.
    const other = await register("parent", "Other");
    const o = await connect(other);
    await o.next("ready");
    o.ws.send(JSON.stringify({ type: "typing", conversationId: cid }));
    await expect(p.next("typing", 500)).rejects.toThrow();

    // Going offline is pushed to watchers with a last-seen time.
    t.ws.close();
    const off = await p.next("presence");
    expect(off.users[0]).toMatchObject({ userId: teacher.userId, online: false });
    const thread = (await api.get(owner, `/api/v1/messages/conversations/${cid}`).expect(200)).body;
    expect(thread.members.find((m: any) => m.id === teacher.userId).last_seen_at).toBeTruthy();
  });

  it("pushes announcements to everyone signed in to the school", async () => {
    const t = await connect(teacher);
    await t.next("ready");
    await api.post(owner, "/api/v1/announcements", { title: "Holiday", body: "School closed on Friday" }).expect(201);
    expect(await t.next("notify")).toMatchObject({ module: "announcements" });
  });
});
