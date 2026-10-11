import { Router } from "express";
import { z } from "zod";
import { withTenant } from "../../database/pool.js";
import { notFound } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { resolveStudent } from "../../lib/student-access.js";
import { requirePermission } from "../../middleware/authorization.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { answerQuestion } from "./service.js";

export const aiRouter = Router();
aiRouter.use(requirePermission("tutor.use"));

aiRouter.post(
  "/sessions",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const body = parse(
      z.object({ topicId: z.string().uuid().optional(), lessonId: z.string().uuid().optional(), mode: z.enum(["text", "voice", "avatar"]).default("text") }),
      req.body ?? {},
    );
    const row = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db);
      let topicId = body.topicId ?? null;
      if (!topicId && body.lessonId) topicId = (await db.query(`SELECT topic_id FROM lessons WHERE id = $1`, [body.lessonId])).rows[0]?.topic_id ?? null;
      return (
        await db.query(
          `INSERT INTO tutor_sessions (tenant_id, student_id, topic_id, lesson_id, mode) VALUES ($1,$2,$3,$4,$5) RETURNING id, topic_id, lesson_id, mode, created_at`,
          [tenant.id, student.id, topicId, body.lessonId ?? null, body.mode],
        )
      ).rows[0];
    });
    res.status(201).json({ session: row });
  }),
);

aiRouter.get(
  "/sessions",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const rows = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db);
      return db.query(
        `SELECT ts.id, ts.mode, ts.created_at, t.title AS topic,
                (SELECT content FROM tutor_messages m WHERE m.session_id = ts.id AND m.role = 'student' ORDER BY created_at LIMIT 1) AS first_question
           FROM tutor_sessions ts LEFT JOIN topics t ON t.id = ts.topic_id WHERE ts.student_id = $1 ORDER BY ts.created_at DESC LIMIT 20`,
        [student.id],
      );
    });
    res.json({ sessions: rows.rows });
  }),
);

aiRouter.get(
  "/sessions/:id",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db);
      const s = (await db.query(`SELECT id, topic_id, lesson_id, mode, created_at FROM tutor_sessions WHERE id = $1 AND student_id = $2`, [req.params.id, student.id])).rows[0];
      if (!s) throw notFound("Session");
      const messages = await db.query(
        `SELECT id, role, content, source_refs, safety_flags, feedback, created_at FROM tutor_messages WHERE session_id = $1 ORDER BY created_at`,
        [s.id],
      );
      return { session: s, messages: messages.rows };
    });
    res.json(data);
  }),
);

aiRouter.post(
  "/sessions/:id/messages",
  rateLimit({ name: "ai-messages", windowMs: 60_000, max: 20 }),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const { content } = parse(z.object({ content: z.string().trim().min(1).max(2000) }), req.body);
    const reply = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db);
      const r = await answerQuestion(db, {
        tenantId: tenant.id,
        userId,
        sessionId: req.params.id,
        studentId: student.id,
        question: content,
        language: student.language,
        curriculumVersionId: student.curriculumVersionId,
      });
      if (!r) throw notFound("Session");
      return r;
    });
    res.status(201).json({ message: reply });
  }),
);

aiRouter.post(
  "/messages/:id/feedback",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { rating } = parse(z.object({ rating: z.union([z.literal(1), z.literal(-1)]) }), req.body);
    const row = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db);
      const r = await db.query(
        `UPDATE tutor_messages m SET feedback = $2 FROM tutor_sessions s
          WHERE m.id = $1 AND m.session_id = s.id AND s.student_id = $3 AND m.role = 'assistant' RETURNING m.id, m.feedback`,
        [req.params.id, rating, student.id],
      );
      if (!r.rows[0]) throw notFound("Message");
      return r.rows[0];
    });
    res.json({ message: row });
  }),
);
