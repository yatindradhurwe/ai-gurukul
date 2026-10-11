/** Live AI classroom: the avatar teaches a class; students ask doubts that are answered for everyone. */
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/database/pool.js";
import { liveHub } from "../src/modules/live/events.js";
import { buildTeachingScript, estimateSpeechSeconds } from "../src/modules/live/script.js";
import { api, app, dbAvailable, login, register, resetDb, uniqueEmail, type Session } from "./helpers.js";

describe("teaching script", () => {
  it("starts with an intro, splits the lesson into short parts and ends with doubt time", () => {
    const script = buildTeachingScript({ title: "Pressure", topic: "Pressure", content: "One. Two. Three. Four.\n\nFive." });
    expect(script[0].title).toBe("Introduction");
    expect(script.at(-1)!.title).toBe("Doubt time");
    expect(script.slice(1, -1).map((s) => s.text)).toEqual(["One. Two. Three.", "Four.", "Five."]);
    expect(estimateSpeechSeconds("word ".repeat(150))).toBe(60);
  });
});

describe.skipIf(!dbAvailable)("live AI classroom", () => {
  let owner: Session;
  let teacher: Session;
  let s1: Session;
  let s2: Session;
  let outsider: Session;
  let schoolId: string;
  let classId: string;
  let sessionId: string;
  const profileOf: Record<string, string> = {};

  const events = async (s: Session) => (await api.get(s, `/api/v1/live/sessions/${sessionId}/events`).expect(200)).body.events as any[];
  const types = async (s: Session) => (await events(s)).map((e) => e.type);

  beforeAll(async () => {
    await resetDb();
    owner = await register("parent", "Principal");
    schoolId = (await request(app).post("/api/v1/tenants").set("Authorization", `Bearer ${owner.token}`).send({ name: "Sunrise School", type: "school" }).expect(201)).body.tenant.id;
    owner = { ...owner, tenantId: schoolId, headers: { ...owner.headers, "X-Tenant-Id": schoolId } };
    const join = async (role: string, name: string) => {
      const email = uniqueEmail(role);
      await request(app).post("/api/v1/auth/register").send({ name, email, password: "password-1234", accountType: "student" }).expect(201);
      const inv = await api.post(owner, `/api/v1/tenants/${schoolId}/invitations`, { email, role }).expect(201);
      const s = await login(email, "password-1234", schoolId);
      await api.post(s, "/api/v1/tenants/invitations/accept", { token: inv.body.token }).expect(200);
      return s;
    };
    teacher = await join("teacher", "Meera Teacher");
    s1 = await join("student", "Ravi Kumar");
    s2 = await join("student", "Anya Singh");
    outsider = await join("student", "Not Enrolled");
    for (const s of [s1, s2, outsider]) {
      profileOf[s.userId] = (await api.get(s, "/api/v1/tenants/current").expect(200)).body.studentProfileId;
    }
  });

  afterAll(async () => {
    await liveHub.close();
  });

  it("a teacher creates a class, enrols students and schedules a live session", async () => {
    await api.post(s1, "/api/v1/classes", { name: "8-A Science" }).expect(403);
    classId = (await api.post(teacher, "/api/v1/classes", { name: "8-A Science" }).expect(201)).body.class.id;
    await api.post(teacher, `/api/v1/classes/${classId}/enrollments`, { studentIds: [profileOf[s1.userId], profileOf[s2.userId]] }).expect(201);
    const lesson = (await pool.query(`SELECT l.id FROM lessons l JOIN topics t ON t.id = l.topic_id WHERE t.title LIKE 'Pressure%'`)).rows[0];
    sessionId = (await api.post(teacher, `/api/v1/classes/${classId}/sessions`, { lessonId: lesson.id }).expect(201)).body.session.id;

    const mine = await api.get(s1, "/api/v1/classes").expect(200);
    expect(mine.body.classes.map((c: any) => c.name)).toEqual(["8-A Science"]);
    expect((await api.get(outsider, "/api/v1/classes").expect(200)).body.classes).toEqual([]);
  });

  it("only enrolled students and the class teacher can join", async () => {
    await api.get(outsider, `/api/v1/live/sessions/${sessionId}`).expect(403);
    await api.get(outsider, `/api/v1/live/sessions/${sessionId}/events`).expect(403);
    const state = await api.get(s1, `/api/v1/live/sessions/${sessionId}`).expect(200);
    expect(state.body.role).toBe("student");
    expect(state.body.session.status).toBe("scheduled");
    await api.post(s1, `/api/v1/live/sessions/${sessionId}/questions`, { content: "What is pressure?" }).expect(409); // not started
  });

  it("the teacher starts the class and the avatar begins teaching from the approved lesson", async () => {
    await api.post(s1, `/api/v1/live/sessions/${sessionId}/start`).expect(403);
    const r = await api.post(teacher, `/api/v1/live/sessions/${sessionId}/start`).expect(200);
    expect(r.body.segments).toBeGreaterThan(3);
    const ev = await events(s2);
    expect(ev.map((e) => e.type)).toEqual(["session.started", "segment"]);
    expect(ev[1].payload).toMatchObject({ index: 0, title: "Introduction" });
    expect(ev[1].payload.text).toContain("Pressure");
  });

  it("pacing is server-controlled: students cannot skip ahead, duplicates are harmless", async () => {
    const early = await api.post(s1, `/api/v1/live/sessions/${sessionId}/advance`, { expectedSegment: 0 }).expect(409);
    expect(early.body.error.code).toBe("too_early");
    // Simulate the intro having been spoken.
    await pool.query(`UPDATE live_sessions SET segment_started_at = now() - interval '5 minutes' WHERE id = $1`, [sessionId]);
    const [a, b] = await Promise.all([
      api.post(s1, `/api/v1/live/sessions/${sessionId}/advance`, { expectedSegment: 0 }),
      api.post(s2, `/api/v1/live/sessions/${sessionId}/advance`, { expectedSegment: 0 }),
    ]);
    expect([a.body.advanced, b.body.advanced].sort()).toEqual([false, true]);
    expect((await types(s1)).filter((t) => t === "segment")).toHaveLength(2);
    // A teacher's automatic nudge respects pacing too; pressing "Next part" always moves on.
    await api.post(teacher, `/api/v1/live/sessions/${sessionId}/advance`, { expectedSegment: 1 }).expect(409);
    await api.post(teacher, `/api/v1/live/sessions/${sessionId}/advance`, { expectedSegment: 1, manual: true }).expect(200);
  });

  it("a student's doubt is answered for the whole class, grounded in the lesson, with citations", async () => {
    const r = await api.post(s1, `/api/v1/live/sessions/${sessionId}/questions`, { content: "Why do knives have sharp edges?", inputMode: "voice" }).expect(201);
    expect(r.body.status).toBe("answered");
    expect(r.body.sourceRefs.length).toBeGreaterThan(0);
    const seenByClassmate = (await events(s2)).find((e) => e.type === "doubt.answered");
    expect(seenByClassmate.payload).toMatchObject({ studentName: "Ravi", question: "Why do knives have sharp edges?" });
    expect(seenByClassmate.payload.answer).toMatch(/\[S\d\]/);
    // Answering holds the lesson so the class can hear it: students can't advance straight away.
    await api.post(s2, `/api/v1/live/sessions/${sessionId}/advance`, { expectedSegment: 2 }).expect(409);
  });

  it("a doubt outside the lesson material goes to the teacher instead of being guessed", async () => {
    const r = await api.post(s2, `/api/v1/live/sessions/${sessionId}/questions`, { content: "Who won the cricket world cup in 1983?" }).expect(201);
    expect(r.body.status).toBe("escalated");
    expect(r.body.answer).toMatch(/sent it to your teacher/);
    const state = await api.get(teacher, `/api/v1/live/sessions/${sessionId}`).expect(200);
    const escalated = state.body.questions.find((q: any) => q.status === "escalated");
    expect(escalated.student_name).toBe("Anya Singh");

    await api.post(s1, `/api/v1/live/sessions/${sessionId}/questions/${escalated.id}/resolve`, { answer: "x" }).expect(403);
    await api.post(teacher, `/api/v1/live/sessions/${sessionId}/questions/${escalated.id}/resolve`, { answer: "India won the 1983 World Cup." }).expect(200);
    const resolved = (await events(s1)).find((e) => e.type === "doubt.resolved");
    expect(resolved.payload).toMatchObject({ studentName: "Anya", answer: "India won the 1983 World Cup." });
  });

  it("sensitive messages are answered privately, never broadcast, and the teacher is alerted", async () => {
    const r = await api.post(s1, `/api/v1/live/sessions/${sessionId}/questions`, { content: "i want to die" }).expect(201);
    expect(r.body.status).toBe("private");
    expect(r.body.answer).toContain("14416");
    expect(await types(s1)).toContain("doubt.private");
    const classmate = await types(s2);
    expect(classmate).not.toContain("doubt.private");
    expect(classmate).not.toContain("safety.alert");
    expect(await types(teacher)).toContain("safety.alert");
    const state = await api.get(s2, `/api/v1/live/sessions/${sessionId}`).expect(200);
    expect(state.body.questions.some((q: any) => q.status === "private")).toBe(false);
  });

  it("the teacher can speak through the avatar, pause and resume", async () => {
    await api.post(teacher, `/api/v1/live/sessions/${sessionId}/say`, { text: "Listen carefully, this part is important." }).expect(201);
    await api.post(teacher, `/api/v1/live/sessions/${sessionId}/pause`).expect(200);
    await pool.query(`UPDATE live_sessions SET segment_started_at = now() - interval '5 minutes' WHERE id = $1`, [sessionId]);
    await api.post(s1, `/api/v1/live/sessions/${sessionId}/advance`, { expectedSegment: 2 }).expect(409);
    await api.post(teacher, `/api/v1/live/sessions/${sessionId}/resume`).expect(200);
    const ev = await events(s1);
    expect(ev.map((e) => e.type)).toEqual(expect.arrayContaining(["teacher.message", "session.paused", "session.resumed"]));
    expect(ev.find((e) => e.type === "session.resumed").payload).toMatchObject({ index: 2, replay: true });
  });

  it("pushes events to connected students in real time over server-sent events", async () => {
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const after = (await events(s2)).at(-1).id;
    try {
      const received = await new Promise<any[]>((resolve, reject) => {
        const got: any[] = [];
        const req = http.get(
          { port, path: `/api/v1/live/sessions/${sessionId}/stream?after=${after}`, headers: s2.headers },
          (res) => {
            expect(res.headers["content-type"]).toContain("text/event-stream");
            let buf = "";
            res.on("data", (chunk) => {
              buf += chunk.toString();
              for (const m of buf.matchAll(/^data: (.+)$/gm)) {
                const e = JSON.parse(m[1]);
                if (!got.some((g) => g.id === e.id)) got.push(e);
              }
              if (got.some((e) => e.type === "teacher.message")) {
                req.destroy();
                resolve(got);
              }
            });
          },
        );
        req.on("error", (err) => (err.message.includes("aborted") || err.message.includes("socket hang up") ? null : reject(err)));
        // Once the stream is open, the teacher speaks; the student should receive it without polling.
        setTimeout(() => {
          api.post(teacher, `/api/v1/live/sessions/${sessionId}/say`, { text: "Real-time check" }).catch(reject);
        }, 300);
        setTimeout(() => reject(new Error("no event received over SSE")), 8000);
      });
      expect(received.find((e) => e.type === "teacher.message").payload.text).toBe("Real-time check");
    } finally {
      server.close();
    }
  });

  it("finishing the lesson opens doubt time; ending records attendance and usage", async () => {
    const state = await api.get(teacher, `/api/v1/live/sessions/${sessionId}`).expect(200);
    for (let i = state.body.session.current_segment; i < state.body.script.length; i++) {
      await api.post(teacher, `/api/v1/live/sessions/${sessionId}/advance`, { expectedSegment: i, manual: true }).expect(200);
    }
    expect(await types(s1)).toContain("lesson.completed");
    // Doubts still work in doubt time.
    await api.post(s2, `/api/v1/live/sessions/${sessionId}/questions`, { content: "What is pressure equal to?" }).expect(201);

    const end = await api.post(teacher, `/api/v1/live/sessions/${sessionId}/end`).expect(200);
    expect(end.body.attendees).toBeGreaterThanOrEqual(2);
    const attendance = await api.get(teacher, `/api/v1/live/sessions/${sessionId}/attendance`).expect(200);
    expect(attendance.body.attendance.map((a: any) => a.name).sort()).toEqual(["Anya Singh", "Meera Teacher", "Ravi Kumar"]);
    await api.post(s1, `/api/v1/live/sessions/${sessionId}/questions`, { content: "One more?" }).expect(409);
    const usage = await pool.query(`SELECT count(*)::int AS n FROM usage_events WHERE event_type = 'live_class_minutes'`);
    expect(usage.rows[0].n).toBe(1);
  });

  it("another school cannot see this class at all", async () => {
    const otherOwner = await register("parent", "Other Principal");
    const other = (await request(app).post("/api/v1/tenants").set("Authorization", `Bearer ${otherOwner.token}`).send({ name: "Other School", type: "school" }).expect(201)).body.tenant.id;
    const s = { ...otherOwner, tenantId: other, headers: { ...otherOwner.headers, "X-Tenant-Id": other } };
    await api.get(s, `/api/v1/live/sessions/${sessionId}`).expect(404);
    await api.get(s, `/api/v1/classes/${classId}`).expect(404);
  });
});
