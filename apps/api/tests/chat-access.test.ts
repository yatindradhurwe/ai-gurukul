/** Chat attachments, voice notes and replies; and the principal's role-based access settings. */
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { permissionsFor } from "../src/lib/permissions.js";
import { api, app, dbAvailable, login, register, resetDb, uniqueEmail, type Session } from "./helpers.js";

describe("access overrides", () => {
  it("adds grants, removes revocations, ignores unknown or identity permissions, and never touches the owner", () => {
    const o = { teacher: { grant: ["fees.manage", "tenant.manage", "classes.attend"], revoke: ["announcements.manage"] }, tenant_owner: { revoke: ["fees.manage"] } };
    const t = permissionsFor("teacher", o);
    expect(t).toContain("fees.manage");
    expect(t).not.toContain("announcements.manage");
    expect(t).not.toContain("tenant.manage");
    expect(t).not.toContain("classes.attend");
    expect(permissionsFor("tenant_owner", o)).toContain("fees.manage");
  });
});

describe.skipIf(!dbAvailable)("chat attachments and access settings", () => {
  let owner: Session;
  let teacher: Session;
  let schoolId: string;
  let cid: string;
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");

  beforeAll(async () => {
    await resetDb();
    owner = await register("parent", "Principal");
    const t = (await request(app).post("/api/v1/tenants").set("Authorization", `Bearer ${owner.token}`).send({ name: "Sunrise School", type: "school" }).expect(201)).body.tenant;
    schoolId = t.id;
    owner = { ...owner, tenantId: schoolId, headers: { ...owner.headers, "X-Tenant-Id": schoolId } };
    const email = uniqueEmail("teacher");
    await request(app).post("/api/v1/auth/register").send({ name: "Meera Teacher", email, password: "password-1234", accountType: "student" }).expect(201);
    const inv = await api.post(owner, `/api/v1/tenants/${schoolId}/invitations`, { email, role: "teacher" }).expect(201);
    teacher = await login(email, "password-1234", schoolId);
    await api.post(teacher, "/api/v1/tenants/invitations/accept", { token: inv.body.token }).expect(200);
    cid = (await api.post(owner, "/api/v1/messages/conversations", { recipientId: teacher.userId, body: "Please share the timetable" }).expect(201)).body.conversationId;
  });

  it("shares photos, files and voice notes with members only, and replies to a message", async () => {
    const first = (await api.get(teacher, `/api/v1/messages/conversations/${cid}`).expect(200)).body.messages[0];
    const photo = (
      await api.post(teacher, `/api/v1/messages/conversations/${cid}`, { replyToId: first.id, attachment: { fileName: "timetable.png", mimeType: "image/png", data: png } }).expect(201)
    ).body.message;
    expect(photo.attachment).toMatchObject({ kind: "image", file_name: "timetable.png" });
    expect(photo.reply_to).toMatchObject({ id: first.id, body: "Please share the timetable", sender: "Principal" });

    const voice = (
      await api.post(owner, `/api/v1/messages/conversations/${cid}`, { attachment: { fileName: "voice.webm", mimeType: "audio/webm;codecs=opus", data: png, durationMs: 4200 } }).expect(201)
    ).body.message;
    expect(voice.attachment).toMatchObject({ kind: "audio", mime_type: "audio/webm", duration_ms: 4200 });

    await api.post(owner, `/api/v1/messages/conversations/${cid}`, { attachment: { fileName: "x.html", mimeType: "text/html", data: png } }).expect(400);
    await api.post(owner, `/api/v1/messages/conversations/${cid}`, { body: "" }).expect(400);

    const file = await api.get(teacher, `/api/v1/messages/attachments/${photo.attachment.id}`).expect(200);
    expect(file.headers["content-type"]).toBe("image/png");
    const outsider = await register("parent", "Elsewhere");
    await api.get(outsider, `/api/v1/messages/attachments/${photo.attachment.id}`).expect(404);

    const inbox = (await api.get(teacher, "/api/v1/messages/conversations").expect(200)).body.conversations;
    expect(inbox[0].last_body).toBe("🎤 Voice note");
    // A reply can't point into another chat.
    const other = (await api.post(owner, "/api/v1/messages/conversations", { recipientId: teacher.userId, subject: "Other", body: "x", studentId: null }).expect(201)).body.conversationId;
    if (other !== cid) await api.post(owner, `/api/v1/messages/conversations/${other}`, { body: "y", replyToId: first.id }).expect(400);
  });

  it("lets the principal change what each role can do", async () => {
    const before = (await api.get(owner, "/api/v1/access").expect(200)).body;
    const t = before.roles.find((r: any) => r.id === "teacher");
    expect(t.allowed).toContain("announcements.manage");
    expect(before.roles.find((r: any) => r.id === "tenant_owner").locked).toBe(true);
    await api.get(teacher, "/api/v1/access").expect(403);

    // Teachers may now collect fees, but can no longer post announcements.
    const allowed = [...t.allowed.filter((p: string) => p !== "announcements.manage"), "fees.manage"];
    const after = (await api.put(owner, "/api/v1/access/teacher", { permissions: allowed }).expect(200)).body;
    expect(after.roles.find((r: any) => r.id === "teacher").customised).toBe(true);
    const me = (await api.get(teacher, "/api/v1/tenants/current").expect(200)).body.permissions;
    expect(me).toContain("fees.manage");
    expect(me).not.toContain("announcements.manage");
    await api.get(teacher, "/api/v1/fees/structures").expect((r) => expect(r.status).not.toBe(403));
    await api.post(teacher, "/api/v1/announcements", { title: "x", body: "y" }).expect(403);

    await api.put(owner, "/api/v1/access/teacher", { permissions: ["tenant.manage"] }).expect(400);
    await api.put(owner, "/api/v1/access/tenant_owner", { permissions: [] }).expect(400);

    await api.delete(owner, "/api/v1/access/teacher").expect(200);
    expect((await api.get(teacher, "/api/v1/tenants/current").expect(200)).body.permissions).toContain("announcements.manage");
  });
});
