import { Router, type Request } from "express";
import { z } from "zod";
import { audit, withTenant, type Db } from "../../database/pool.js";
import { getAvatarProvider } from "../../integrations/avatar-provider/index.js";
import { AppError, badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { requirePermission } from "../../middleware/authorization.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { screenStudentMessage } from "../ai-tutor/safety.js";
import { generateGroundedAnswer } from "../ai-tutor/service.js";
import { assertQuota, recordUsage } from "../billing/entitlements.js";
import { fetchEvents, liveHub, publishEvent } from "./events.js";
import { buildTeachingScript, estimateSpeechSeconds, type ScriptSegment } from "./script.js";

// ---------------------------------------------------------------------------
// Classes (batches)
// ---------------------------------------------------------------------------
export const classesRouter = Router();
classesRouter.use(requirePermission("classes.manage", "classes.attend"));

const isAdmin = (req: Request) => {
  const t = requireTenant(req);
  return t.permissions.has("members.manage") || t.permissions.has("tenant.manage");
};

classesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const rows = await withTenant(tenant.id, (db) =>
      db.query(
        `SELECT c.id, c.name, c.subject_id, s.name AS subject, c.teacher_id, u.name AS teacher,
                (SELECT count(*)::int FROM class_enrollments e WHERE e.class_id = c.id) AS students,
                (SELECT json_agg(json_build_object('id', ls.id, 'title', ls.title, 'status', ls.status, 'scheduled_at', ls.scheduled_at)
                                 ORDER BY ls.status = 'live' DESC, ls.scheduled_at NULLS LAST)
                   FROM live_sessions ls WHERE ls.class_id = c.id AND ls.status IN ('scheduled','live')) AS sessions
           FROM classes c JOIN users u ON u.id = c.teacher_id LEFT JOIN subjects s ON s.id = c.subject_id
          WHERE ($1 AND ($2 OR c.teacher_id = $3))
             OR EXISTS (SELECT 1 FROM class_enrollments e WHERE e.class_id = c.id AND e.student_id = $4)
          ORDER BY c.created_at DESC`,
        [tenant.permissions.has("classes.manage"), isAdmin(req), userId, tenant.studentProfileId],
      ),
    );
    res.json({ classes: rows.rows });
  }),
);

classesRouter.post(
  "/",
  requirePermission("classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(120),
        subjectId: z.string().uuid().optional(),
        curriculumVersionId: z.string().uuid().optional(),
        teacherId: z.string().uuid().optional(),
      }),
      req.body,
    );
    const row = await withTenant(tenant.id, async (db) => {
      const teacherId = body.teacherId ?? userId;
      if (teacherId !== userId) {
        if (!isAdmin(req)) throw forbidden("Only admins can create classes for another teacher");
        const m = await db.query(
          `SELECT 1 FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 AND role_id IN ('teacher','tenant_admin','tenant_owner') AND status = 'active'`,
          [tenant.id, teacherId],
        );
        if (!m.rowCount) throw badRequest("teacherId is not a teacher in this organization");
      }
      return (
        await db.query(
          `INSERT INTO classes (tenant_id, name, subject_id, curriculum_version_id, teacher_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [tenant.id, body.name, body.subjectId ?? null, body.curriculumVersionId ?? null, teacherId],
        )
      ).rows[0];
    });
    res.status(201).json({ class: row });
  }),
);

async function loadManagedClass(req: Request, db: Db, classId: string) {
  const { userId } = requireAuth(req);
  const c = (await db.query(`SELECT * FROM classes WHERE id = $1`, [classId])).rows[0];
  if (!c) throw notFound("Class");
  if (!requireTenant(req).permissions.has("classes.manage") || (c.teacher_id !== userId && !isAdmin(req))) {
    throw forbidden("Only this class's teacher or an admin can do that");
  }
  return c;
}

classesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const data = await withTenant(tenant.id, async (db) => {
      const c = (await db.query(`SELECT c.*, u.name AS teacher FROM classes c JOIN users u ON u.id = c.teacher_id WHERE c.id = $1`, [req.params.id])).rows[0];
      if (!c) throw notFound("Class");
      const staff = tenant.permissions.has("classes.manage") && (c.teacher_id === userId || isAdmin(req));
      if (!staff) {
        const enrolled = await db.query(`SELECT 1 FROM class_enrollments WHERE class_id = $1 AND student_id = $2`, [c.id, tenant.studentProfileId]);
        if (!enrolled.rowCount) throw forbidden("You are not enrolled in this class");
      }
      const sessions = await db.query(
        `SELECT ls.id, ls.title, ls.status, ls.scheduled_at, ls.started_at, ls.ended_at, l.title AS lesson
           FROM live_sessions ls JOIN lessons l ON l.id = ls.lesson_id WHERE ls.class_id = $1 ORDER BY ls.created_at DESC LIMIT 50`,
        [c.id],
      );
      const students = staff
        ? (
            await db.query(
              `SELECT sp.id AS student_id, u.name FROM class_enrollments e JOIN student_profiles sp ON sp.id = e.student_id JOIN users u ON u.id = sp.user_id
                WHERE e.class_id = $1 ORDER BY u.name`,
              [c.id],
            )
          ).rows
        : undefined;
      return { class: c, staff, sessions: sessions.rows, students };
    });
    res.json(data);
  }),
);

classesRouter.post(
  "/:id/enrollments",
  requirePermission("classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { studentIds } = parse(z.object({ studentIds: z.array(z.string().uuid()).min(1).max(500) }), req.body);
    const added = await withTenant(tenant.id, async (db) => {
      const c = await loadManagedClass(req, db, req.params.id);
      // RLS limits this lookup to student profiles in the same tenant.
      const valid = await db.query(`SELECT id FROM student_profiles WHERE id = ANY($1::uuid[])`, [studentIds]);
      if (valid.rowCount !== new Set(studentIds).size) throw badRequest("Some students were not found in this organization");
      const r = await db.query(
        `INSERT INTO class_enrollments (tenant_id, class_id, student_id) SELECT $1, $2, unnest($3::uuid[]) ON CONFLICT DO NOTHING`,
        [tenant.id, c.id, studentIds],
      );
      return r.rowCount;
    });
    res.status(201).json({ added });
  }),
);

classesRouter.post(
  "/:id/sessions",
  requirePermission("classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(
      z.object({
        lessonId: z.string().uuid(),
        title: z.string().trim().min(1).max(200).optional(),
        scheduledAt: z.string().datetime({ offset: true }).optional(),
        language: z.string().min(2).max(10).default("en"),
        avatarId: z.string().min(1).max(100).default("guru-default"),
      }),
      req.body,
    );
    const row = await withTenant(tenant.id, async (db) => {
      const c = await loadManagedClass(req, db, req.params.id);
      const lesson = (await db.query(`SELECT id, title FROM lessons WHERE id = $1 AND status = 'published'`, [body.lessonId])).rows[0];
      if (!lesson) throw notFound("Published lesson");
      return (
        await db.query(
          `INSERT INTO live_sessions (tenant_id, class_id, lesson_id, title, scheduled_at, language, avatar_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [tenant.id, c.id, lesson.id, body.title ?? lesson.title, body.scheduledAt ?? null, body.language, body.avatarId, userId],
        )
      ).rows[0];
    });
    res.status(201).json({ session: row });
  }),
);

// ---------------------------------------------------------------------------
// Live sessions
// ---------------------------------------------------------------------------
export const liveRouter = Router();
liveRouter.use(requirePermission("classes.manage", "classes.attend"));

interface SessionAccess {
  session: any;
  staff: boolean;
  studentId: string | null;
  userId: string;
}

/** Class teacher / admins are staff; students must be enrolled in the session's class. */
async function loadSession(req: Request, db: Db, sessionId: string, opts: { lock?: boolean } = {}): Promise<SessionAccess> {
  const tenant = requireTenant(req);
  const { userId } = requireAuth(req);
  const session = (
    await db.query(
      `SELECT ls.*, c.teacher_id, c.name AS class_name FROM live_sessions ls JOIN classes c ON c.id = ls.class_id
        WHERE ls.id = $1 ${opts.lock ? "FOR UPDATE OF ls" : ""}`,
      [sessionId],
    )
  ).rows[0];
  if (!session) throw notFound("Live session");
  const staff = tenant.permissions.has("classes.manage") && (session.teacher_id === userId || isAdmin(req));
  if (staff) return { session, staff, studentId: null, userId };
  if (tenant.studentProfileId) {
    const enrolled = await db.query(`SELECT 1 FROM class_enrollments WHERE class_id = $1 AND student_id = $2`, [session.class_id, tenant.studentProfileId]);
    if (enrolled.rowCount) return { session, staff: false, studentId: tenant.studentProfileId, userId };
  }
  throw forbidden("You are not enrolled in this class");
}

function requireStaff(a: SessionAccess) {
  if (!a.staff) throw forbidden("Only the class teacher can do that");
}

function requireLive(a: SessionAccess) {
  if (a.session.status !== "live") throw conflict(a.session.status === "ended" ? "This class has ended" : "This class has not started yet");
}

const segmentPayload = (script: ScriptSegment[], index: number, replay = false) => ({
  index,
  total: script.length,
  title: script[index]?.title,
  text: script[index]?.text,
  replay,
});

/** Give the class time to hear an interruption (answer, teacher message) before pacing resumes. */
async function holdPacing(db: Db, sessionId: string, spokenText: string) {
  await db.query(
    `UPDATE live_sessions SET segment_started_at = GREATEST(COALESCE(segment_started_at, now()), now()) + make_interval(secs => $2) WHERE id = $1 AND mode = 'teaching'`,
    [sessionId, estimateSpeechSeconds(spokenText)],
  );
}

async function touchAttendance(db: Db, tenantId: string, sessionId: string, userId: string) {
  await db.query(
    `INSERT INTO live_attendance (tenant_id, session_id, user_id) VALUES ($1,$2,$3)
     ON CONFLICT (session_id, user_id) DO UPDATE SET last_seen_at = now()`,
    [tenantId, sessionId, userId],
  );
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "A student";

liveRouter.get(
  "/sessions/:id",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const a = await loadSession(req, db, req.params.id);
      if (a.session.status === "live") await touchAttendance(db, tenant.id, a.session.id, a.userId);
      const questions = await db.query(
        `SELECT q.id, q.content, q.status, q.answer, q.source_refs, q.created_at, q.user_id = $2 AS mine, u.name AS student_name
           FROM live_questions q JOIN users u ON u.id = q.user_id
          WHERE q.session_id = $1 AND (q.status <> 'private' OR q.user_id = $2 OR $3) ORDER BY q.created_at`,
        [a.session.id, a.userId, a.staff],
      );
      const lastEvent = await db.query(`SELECT COALESCE(max(id),0)::bigint AS id FROM live_session_events WHERE session_id = $1`, [a.session.id]);
      const participants = await db.query(
        `SELECT count(*)::int AS n FROM live_attendance WHERE session_id = $1 AND last_seen_at > now() - interval '60 seconds'`,
        [a.session.id],
      );
      const { teacher_id: _t, script, ...session } = a.session;
      return {
        session,
        role: a.staff ? "teacher" : "student",
        script,
        current: script.length ? segmentPayload(script, Math.min(a.session.current_segment, script.length - 1)) : null,
        questions: questions.rows.map((q) => ({ ...q, student_name: a.staff ? q.student_name : firstName(q.student_name) })),
        lastEventId: Number(lastEvent.rows[0].id),
        participantsOnline: participants.rows[0].n,
        avatar: { renderer: "browser", provider: getAvatarProvider().name },
      };
    });
    res.json(data);
  }),
);

liveRouter.post(
  "/sessions/:id/start",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const a = await loadSession(req, db, req.params.id, { lock: true });
      requireStaff(a);
      if (a.session.status !== "scheduled") throw conflict(`Session is already ${a.session.status}`);
      const lesson = (
        await db.query(`SELECT l.title, l.content, t.title AS topic FROM lessons l JOIN topics t ON t.id = l.topic_id WHERE l.id = $1`, [a.session.lesson_id])
      ).rows[0];
      const script = buildTeachingScript(lesson);
      await db.query(
        `UPDATE live_sessions SET status = 'live', mode = 'teaching', started_at = now(), script = $2, current_segment = 0, segment_started_at = now() WHERE id = $1`,
        [a.session.id, JSON.stringify(script)],
      );
      await publishEvent(db, { tenantId: tenant.id, sessionId: a.session.id, type: "session.started", actorId: a.userId, payload: { total: script.length, language: a.session.language } });
      await publishEvent(db, { tenantId: tenant.id, sessionId: a.session.id, type: "segment", actorId: a.userId, payload: segmentPayload(script, 0) });
      await audit(db, { tenantId: tenant.id, actorId: a.userId, action: "live.start", resourceType: "live_session", resourceId: a.session.id });
      return { status: "live", segments: script.length };
    });
    res.json(data);
  }),
);

/**
 * Move to the next segment. Pacing is server-authoritative: any participant's
 * client may nudge it when its avatar finishes speaking (compare-and-set on
 * the expected index, so duplicates are harmless), but nobody skips ahead
 * before the segment has had time to be heard — except the teacher pressing "Next part".
 */
liveRouter.post(
  "/sessions/:id/advance",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    // manual = the teacher pressed "Next part"; automatic nudges from any client respect pacing.
    const { expectedSegment, manual } = parse(z.object({ expectedSegment: z.number().int().min(0), manual: z.boolean().default(false) }), req.body);
    const data = await withTenant(tenant.id, async (db) => {
      const a = await loadSession(req, db, req.params.id, { lock: true });
      requireLive(a);
      const s = a.session;
      const script: ScriptSegment[] = s.script;
      if (s.current_segment !== expectedSegment) return { advanced: false, reason: "already_advanced", current: s.current_segment };
      if (s.mode === "paused") throw conflict("The class is paused");
      if (s.mode === "qa") return { advanced: false, reason: "lesson_complete", current: s.current_segment };
      if (!(a.staff && manual)) {
        const minSeconds = estimateSpeechSeconds(script[s.current_segment]?.text ?? "") * 0.5;
        const ready = await db.query(`SELECT now() >= $1::timestamptz + make_interval(secs => $2) AS ok`, [s.segment_started_at, minSeconds]);
        if (!ready.rows[0].ok) throw new AppError(409, "too_early", "The avatar is still teaching this part");
      }
      const next = s.current_segment + 1;
      if (next >= script.length) {
        await db.query(`UPDATE live_sessions SET mode = 'qa' WHERE id = $1`, [s.id]);
        await publishEvent(db, { tenantId: tenant.id, sessionId: s.id, type: "lesson.completed", actorId: a.userId, payload: { total: script.length } });
        return { advanced: true, current: s.current_segment, mode: "qa" };
      }
      await db.query(`UPDATE live_sessions SET current_segment = $2, segment_started_at = now() WHERE id = $1`, [s.id, next]);
      await publishEvent(db, { tenantId: tenant.id, sessionId: s.id, type: "segment", actorId: a.userId, payload: segmentPayload(script, next) });
      return { advanced: true, current: next, mode: "teaching" };
    });
    res.json(data);
  }),
);

for (const action of ["pause", "resume"] as const) {
  liveRouter.post(
    `/sessions/:id/${action}`,
    asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const data = await withTenant(tenant.id, async (db) => {
        const a = await loadSession(req, db, req.params.id, { lock: true });
        requireStaff(a);
        requireLive(a);
        const s = a.session;
        if (action === "pause") {
          if (s.mode !== "teaching") throw conflict("The avatar is not teaching right now");
          await db.query(`UPDATE live_sessions SET mode = 'paused' WHERE id = $1`, [s.id]);
          await publishEvent(db, { tenantId: tenant.id, sessionId: s.id, type: "session.paused", actorId: a.userId, payload: {} });
          return { mode: "paused" };
        }
        if (s.mode !== "paused") throw conflict("The class is not paused");
        await db.query(`UPDATE live_sessions SET mode = 'teaching', segment_started_at = now() WHERE id = $1`, [s.id]);
        await publishEvent(db, { tenantId: tenant.id, sessionId: s.id, type: "session.resumed", actorId: a.userId, payload: segmentPayload(s.script, s.current_segment, true) });
        return { mode: "teaching" };
      });
      res.json(data);
    }),
  );
}

/** The teacher types; the avatar says it to the class. */
liveRouter.post(
  "/sessions/:id/say",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { text } = parse(z.object({ text: z.string().trim().min(1).max(1000) }), req.body);
    await withTenant(tenant.id, async (db) => {
      const a = await loadSession(req, db, req.params.id, { lock: true });
      requireStaff(a);
      requireLive(a);
      const teacher = (await db.query(`SELECT name FROM users WHERE id = $1`, [a.userId])).rows[0];
      await publishEvent(db, { tenantId: tenant.id, sessionId: a.session.id, type: "teacher.message", actorId: a.userId, payload: { text, teacherName: teacher.name, resumeSegment: a.session.current_segment } });
      await holdPacing(db, a.session.id, text);
    });
    res.status(201).json({ sent: true });
  }),
);

const ESCALATED_REPLY = (name: string) =>
  `That's a great question, ${name}! It isn't covered in today's lesson material, so I don't want to guess. I've sent it to your teacher, who will answer it for you.`;

/** A student asks a doubt by voice or text; the avatar answers the whole class from approved material. */
liveRouter.post(
  "/sessions/:id/questions",
  rateLimit({ name: "live-questions", windowMs: 60_000, max: 6 }),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const body = parse(z.object({ content: z.string().trim().min(2).max(500), inputMode: z.enum(["text", "voice"]).default("text") }), req.body);
    const result = await withTenant(tenant.id, async (db) => {
      const a = await loadSession(req, db, req.params.id, { lock: true });
      if (a.staff || !a.studentId) throw forbidden("Doubts are asked by enrolled students");
      requireLive(a);
      const s = a.session;
      const me = (await db.query(`SELECT name FROM users WHERE id = $1`, [a.userId])).rows[0];
      const name = firstName(me.name);

      // 1. Safety first. Sensitive messages are never broadcast to the class.
      const screen = screenStudentMessage(body.content);
      if (screen.response) {
        const q = (
          await db.query(
            `INSERT INTO live_questions (tenant_id, session_id, student_id, user_id, content, input_mode, status, answer, safety_flags)
             VALUES ($1,$2,$3,$4,$5,$6,'private',$7,$8) RETURNING id`,
            [tenant.id, s.id, a.studentId, a.userId, body.content, body.inputMode, screen.response, screen.flags],
          )
        ).rows[0];
        await publishEvent(db, { tenantId: tenant.id, sessionId: s.id, type: "doubt.private", actorId: a.userId, audience: { kind: "user", userId: a.userId }, payload: { questionId: q.id, question: body.content, answer: screen.response } });
        if (screen.flags.some((f) => f !== "personal_info")) {
          await publishEvent(db, { tenantId: tenant.id, sessionId: s.id, type: "safety.alert", actorId: a.userId, audience: { kind: "staff" }, payload: { questionId: q.id, studentName: me.name, flags: screen.flags } });
          await audit(db, { tenantId: tenant.id, actorId: a.userId, action: "safety.escalation", resourceType: "live_question", resourceId: q.id, metadata: { flags: screen.flags } });
        }
        return { questionId: q.id, status: "private", answer: screen.response };
      }

      // 2. Quota, then a grounded answer from the lesson's approved material.
      await assertQuota(db, tenant.id, a.userId, "ai_questions_per_month");
      const ctx = (
        await db.query(
          `SELECT l.topic_id, t.title AS topic, sub.name AS subject, g.name AS grade, ch.curriculum_version_id
             FROM lessons l JOIN topics t ON t.id = l.topic_id JOIN chapters ch ON ch.id = t.chapter_id
             JOIN subjects sub ON sub.id = ch.subject_id JOIN curriculum_versions cv ON cv.id = ch.curriculum_version_id JOIN grades g ON g.id = cv.grade_id
            WHERE l.id = $1`,
          [s.lesson_id],
        )
      ).rows[0];
      const answer = await generateGroundedAnswer(db, {
        tenantId: tenant.id,
        userId: a.userId,
        question: body.content,
        topicId: ctx?.topic_id,
        curriculumVersionId: ctx?.curriculum_version_id,
        context: { grade: ctx?.grade, subject: ctx?.subject, topic: ctx?.topic, language: s.language, classroom: true },
        usageMetadata: { liveSessionId: s.id },
      });
      const grounded = answer.flags.length === 0;
      const spoken = grounded ? answer.text : ESCALATED_REPLY(name);
      const q = (
        await db.query(
          `INSERT INTO live_questions (tenant_id, session_id, student_id, user_id, content, input_mode, status, answer, source_refs)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [tenant.id, s.id, a.studentId, a.userId, body.content, body.inputMode, grounded ? "answered" : "escalated", grounded ? answer.text : null, JSON.stringify(answer.sourceRefs)],
        )
      ).rows[0];
      await publishEvent(db, {
        tenantId: tenant.id,
        sessionId: s.id,
        type: grounded ? "doubt.answered" : "doubt.escalated",
        actorId: a.userId,
        payload: { questionId: q.id, studentName: name, question: body.content, answer: spoken, sourceRefs: answer.sourceRefs, resumeSegment: s.current_segment },
      });
      await holdPacing(db, s.id, `${body.content} ${spoken}`);
      return { questionId: q.id, status: grounded ? "answered" : "escalated", answer: spoken, sourceRefs: answer.sourceRefs };
    });
    res.status(201).json(result);
  }),
);

/** The teacher answers an escalated doubt; the avatar reads it to the class. */
liveRouter.post(
  "/sessions/:id/questions/:questionId/resolve",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { answer } = parse(z.object({ answer: z.string().trim().min(1).max(2000) }), req.body);
    await withTenant(tenant.id, async (db) => {
      const a = await loadSession(req, db, req.params.id, { lock: true });
      requireStaff(a);
      const q = (
        await db.query(
          `UPDATE live_questions SET status = 'resolved', answer = $3, resolved_by = $4
            WHERE id = $1 AND session_id = $2 AND status = 'escalated' RETURNING id, content, user_id`,
          [req.params.questionId, a.session.id, answer, a.userId],
        )
      ).rows[0];
      if (!q) throw notFound("Escalated doubt");
      const student = (await db.query(`SELECT name FROM users WHERE id = $1`, [q.user_id])).rows[0];
      await publishEvent(db, {
        tenantId: tenant.id,
        sessionId: a.session.id,
        type: "doubt.resolved",
        actorId: a.userId,
        payload: { questionId: q.id, studentName: firstName(student.name), question: q.content, answer, resumeSegment: a.session.current_segment },
      });
      if (a.session.status === "live") await holdPacing(db, a.session.id, answer);
    });
    res.json({ resolved: true });
  }),
);

liveRouter.post(
  "/sessions/:id/end",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const a = await loadSession(req, db, req.params.id, { lock: true });
      requireStaff(a);
      requireLive(a);
      const r = (
        await db.query(
          `UPDATE live_sessions SET status = 'ended', ended_at = now() WHERE id = $1
           RETURNING GREATEST(1, ceil(extract(epoch FROM ended_at - started_at) / 60))::int AS minutes`,
          [a.session.id],
        )
      ).rows[0];
      const attendees = (await db.query(`SELECT count(*)::int AS n FROM live_attendance WHERE session_id = $1`, [a.session.id])).rows[0].n;
      await recordUsage(db, { tenantId: tenant.id, userId: null, eventType: "live_class_minutes", quantity: r.minutes, metadata: { liveSessionId: a.session.id, attendees } });
      await publishEvent(db, { tenantId: tenant.id, sessionId: a.session.id, type: "session.ended", actorId: a.userId, payload: { minutes: r.minutes } });
      await audit(db, { tenantId: tenant.id, actorId: a.userId, action: "live.end", resourceType: "live_session", resourceId: a.session.id, metadata: { minutes: r.minutes, attendees } });
      return { status: "ended", minutes: r.minutes, attendees };
    });
    res.json(data);
  }),
);

liveRouter.get(
  "/sessions/:id/attendance",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const rows = await withTenant(tenant.id, async (db) => {
      const a = await loadSession(req, db, req.params.id);
      requireStaff(a);
      return db.query(
        `SELECT u.name, la.joined_at, la.last_seen_at, la.last_seen_at > now() - interval '60 seconds' AS online,
                (SELECT count(*)::int FROM live_questions q WHERE q.session_id = la.session_id AND q.user_id = la.user_id) AS doubts
           FROM live_attendance la JOIN users u ON u.id = la.user_id WHERE la.session_id = $1 ORDER BY u.name`,
        [a.session.id],
      );
    });
    res.json({ attendance: rows.rows });
  }),
);

/** Polling fallback for networks/proxies that buffer server-sent events. */
liveRouter.get(
  "/sessions/:id/events",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const after = Number(req.query.after ?? 0) || 0;
    const events = await withTenant(tenant.id, async (db) => {
      const a = await loadSession(req, db, req.params.id);
      if (a.session.status === "live") await touchAttendance(db, tenant.id, a.session.id, a.userId);
      return fetchEvents(db, a.session.id, after, { userId: a.userId, staff: a.staff });
    });
    res.json({ events });
  }),
);

/** Real-time stream (server-sent events). Replays from ?after= or Last-Event-ID, then pushes as events commit. */
liveRouter.get(
  "/sessions/:id/stream",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const access = await withTenant(tenant.id, async (db) => {
      const a = await loadSession(req, db, req.params.id);
      await touchAttendance(db, tenant.id, a.session.id, a.userId);
      return { sessionId: a.session.id as string, userId: a.userId, staff: a.staff };
    });
    let lastId = Number(req.header("last-event-id") ?? req.query.after ?? 0) || 0;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");

    let closed = false;
    let running = false;
    let dirty = false;
    const flush = async () => {
      if (closed) return;
      if (running) {
        dirty = true;
        return;
      }
      running = true;
      try {
        do {
          dirty = false;
          const events = await withTenant(tenant.id, (db) => fetchEvents(db, access.sessionId, lastId, access));
          for (const e of events) {
            if (closed) return;
            res.write(`id: ${e.id}\nevent: live\ndata: ${JSON.stringify(e)}\n\n`);
            lastId = e.id;
          }
        } while (dirty && !closed);
      } catch (err) {
        console.error("live stream flush failed", (err as Error).message);
      } finally {
        running = false;
      }
    };

    const unsubscribe = await liveHub.subscribe(access.sessionId, () => void flush());
    const heartbeat = setInterval(() => {
      res.write(": ping\n\n");
      withTenant(tenant.id, (db) => touchAttendance(db, tenant.id, access.sessionId, access.userId)).catch(() => {});
      void flush(); // also covers a missed notification
    }, 20_000);
    req.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });
    await flush();
  }),
);
