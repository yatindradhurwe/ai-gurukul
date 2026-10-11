import { Router } from "express";
import { z } from "zod";
import { audit, withTenant, type Db } from "../../database/pool.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { resolveStudent } from "../../lib/student-access.js";
import { requirePermission } from "../../middleware/authorization.js";
import { blendMastery, gradeAnswer } from "./grading.js";

export const assessmentsRouter = Router();

assessmentsRouter.get(
  "/",
  requirePermission("assessments.take", "assessments.manage", "reports.children"),
  asyncHandler(async (req, res) => {
    const { chapterId } = parse(z.object({ chapterId: z.string().uuid().optional() }), req.query);
    const rows = await withTenant(requireTenant(req).id, (db) =>
      db.query(
        `SELECT a.id, a.title, a.kind, a.max_marks, a.chapter_id, c.title AS chapter,
                (SELECT count(*)::int FROM questions q WHERE q.assessment_id = a.id) AS question_count
           FROM assessments a LEFT JOIN chapters c ON c.id = a.chapter_id
          WHERE a.status = 'published' AND ($1::uuid IS NULL OR a.chapter_id = $1) ORDER BY c.sequence NULLS LAST, a.title`,
        [chapterId ?? null],
      ),
    );
    res.json({ assessments: rows.rows });
  }),
);

/** Questions for taking a test — answer keys and rubrics are never sent to students. */
assessmentsRouter.get(
  "/:id",
  requirePermission("assessments.take", "assessments.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const staff = tenant.permissions.has("assessments.manage");
    const data = await withTenant(tenant.id, async (db) => {
      const a = (await db.query(`SELECT id, title, kind, max_marks, status, chapter_id FROM assessments WHERE id = $1 AND (status = 'published' OR $2)`, [req.params.id, staff])).rows[0];
      if (!a) throw notFound("Assessment");
      const q = await db.query(
        `SELECT id, topic_id, type, prompt, options, marks, sequence ${staff ? ", answer_key, rubric" : ""} FROM questions WHERE assessment_id = $1 ORDER BY sequence`,
        [a.id],
      );
      return { assessment: a, questions: q.rows };
    });
    res.json(data);
  }),
);

const questionSchema = z.object({
  topicId: z.string().uuid(),
  type: z.enum(["mcq", "numeric", "short_answer", "descriptive"]),
  prompt: z.string().min(1).max(5000),
  options: z.array(z.string()).min(2).max(8).optional(),
  answerKey: z.record(z.unknown()).optional(),
  rubric: z.string().max(5000).optional(),
  marks: z.number().int().min(1).max(100),
});

/** Teachers draft a test; it must be reviewed/published before students see it. */
assessmentsRouter.post(
  "/",
  requirePermission("assessments.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const body = parse(
      z.object({ title: z.string().min(1).max(200), chapterId: z.string().uuid().optional(), kind: z.enum(["diagnostic", "quiz", "chapter_test", "mock_exam"]), questions: z.array(questionSchema).min(1).max(200) }),
      req.body,
    );
    for (const q of body.questions) {
      if (q.type === "mcq" && (!q.options || !Number.isInteger(q.answerKey?.correct))) throw badRequest("MCQ questions need options and answerKey.correct");
    }
    const id = await withTenant(tenant.id, async (db) => {
      const max = body.questions.reduce((a, q) => a + q.marks, 0);
      const a = (
        await db.query(`INSERT INTO assessments (tenant_id, chapter_id, title, kind, max_marks, status) VALUES ($1,$2,$3,$4,$5,'in_review') RETURNING id`, [
          tenant.id,
          body.chapterId ?? null,
          body.title,
          body.kind,
          max,
        ])
      ).rows[0];
      for (const [i, q] of body.questions.entries()) {
        await db.query(
          `INSERT INTO questions (assessment_id, topic_id, type, prompt, options, answer_key, rubric, marks, sequence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [a.id, q.topicId, q.type, q.prompt, q.options ? JSON.stringify(q.options) : null, JSON.stringify(q.answerKey ?? null), q.rubric ?? null, q.marks, i + 1],
        );
      }
      return a.id;
    });
    res.status(201).json({ assessment: { id, status: "in_review" } });
  }),
);

assessmentsRouter.post(
  "/:id/publish",
  requirePermission("assessments.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const r = await withTenant(tenant.id, (db) =>
      db.query(`UPDATE assessments SET status = 'published' WHERE id = $1 AND tenant_id = current_tenant_id() RETURNING id, status`, [req.params.id]),
    );
    if (!r.rows[0]) throw notFound("Assessment");
    res.json({ assessment: r.rows[0] });
  }),
);

/** Start (or resume) an attempt. A partial unique index guarantees one open attempt per student. */
assessmentsRouter.post(
  "/:id/attempts",
  requirePermission("assessments.take"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const attempt = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db);
      if (student.access !== "self") throw forbidden("Only the student can take an assessment");
      const a = (await db.query(`SELECT id, max_marks FROM assessments WHERE id = $1 AND status = 'published'`, [req.params.id])).rows[0];
      if (!a) throw notFound("Assessment");
      const inserted = await db.query(
        `INSERT INTO assessment_attempts (tenant_id, assessment_id, student_id, max_score) VALUES ($1,$2,$3,$4)
         ON CONFLICT (assessment_id, student_id) WHERE status = 'in_progress' DO NOTHING RETURNING id, status, started_at`,
        [tenant.id, a.id, student.id, a.max_marks],
      );
      if (inserted.rows[0]) return inserted.rows[0];
      return (
        await db.query(`SELECT id, status, started_at FROM assessment_attempts WHERE assessment_id = $1 AND student_id = $2 AND status = 'in_progress'`, [a.id, student.id])
      ).rows[0];
    });
    res.status(201).json({ attempt });
  }),
);

export const attemptsRouter = Router();

const submitSchema = z.object({
  answers: z.array(z.object({ questionId: z.string().uuid(), answer: z.record(z.unknown()) })).max(500),
});

async function recordMasteryEvidence(db: Db, tenantId: string, studentId: string, attemptId: string, byTopic: Map<string, { got: number; max: number }>) {
  for (const [topicId, { got, max }] of byTopic) {
    if (max <= 0) continue;
    const prev = (
      await db.query(
        `SELECT score FROM topic_mastery_history WHERE student_id = $1 AND topic_id = $2 AND kind = 'measured' ORDER BY created_at DESC LIMIT 1`,
        [studentId, topicId],
      )
    ).rows[0];
    await db.query(
      `INSERT INTO topic_mastery_history (tenant_id, student_id, topic_id, kind, score, evidence_type, evidence_id) VALUES ($1,$2,$3,'measured',$4,'assessment_attempt',$5)`,
      [tenantId, studentId, topicId, blendMastery(prev?.score ?? null, got / max), attemptId],
    );
  }
}

/** Submit answers. Idempotent: a second submit of the same attempt is rejected, never double-scored. */
attemptsRouter.post(
  "/:id/submit",
  requirePermission("assessments.take"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const body = parse(submitSchema, req.body);
    const result = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db);
      // Claim the attempt atomically; concurrent duplicate submissions lose here.
      const claimed = await db.query(
        `UPDATE assessment_attempts SET status = 'submitted', submitted_at = now()
          WHERE id = $1 AND student_id = $2 AND status = 'in_progress' RETURNING id, assessment_id`,
        [req.params.id, student.id],
      );
      if (!claimed.rows[0]) {
        const exists = await db.query(`SELECT status FROM assessment_attempts WHERE id = $1 AND student_id = $2`, [req.params.id, student.id]);
        if (!exists.rows[0]) throw notFound("Attempt");
        throw conflict("This attempt has already been submitted");
      }
      const { assessment_id } = claimed.rows[0];
      const questions = (await db.query(`SELECT id, topic_id, type, marks, answer_key FROM questions WHERE assessment_id = $1`, [assessment_id])).rows;
      const answers = new Map(body.answers.map((a) => [a.questionId, a.answer]));
      let score = 0;
      let pending = 0;
      const byTopic = new Map<string, { got: number; max: number }>();
      for (const q of questions) {
        const answer = answers.get(q.id) ?? {};
        const marks = gradeAnswer(q, answer);
        await db.query(
          `INSERT INTO student_answers (tenant_id, attempt_id, question_id, answer, marks_awarded, review_status) VALUES ($1,$2,$3,$4,$5,$6)`,
          [tenant.id, req.params.id, q.id, JSON.stringify(answer), marks, marks == null ? "pending_review" : "auto"],
        );
        if (marks == null) {
          pending++;
          continue;
        }
        score += marks;
        const t = byTopic.get(q.topic_id) ?? { got: 0, max: 0 };
        t.got += marks;
        t.max += q.marks;
        byTopic.set(q.topic_id, t);
      }
      await db.query(`UPDATE assessment_attempts SET score = $2, status = $3 WHERE id = $1`, [req.params.id, score, pending ? "submitted" : "graded"]);
      await recordMasteryEvidence(db, tenant.id, student.id, req.params.id, byTopic);
      return {
        attemptId: req.params.id,
        status: pending ? "submitted" : "graded",
        score,
        pendingReview: pending,
        topicResults: [...byTopic].map(([topicId, v]) => ({ topicId, ...v })),
      };
    });
    res.json(result);
  }),
);

attemptsRouter.get(
  "/:id",
  requirePermission("assessments.take", "assessments.review", "reports.children"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const attempt = (await db.query(`SELECT * FROM assessment_attempts WHERE id = $1`, [req.params.id])).rows[0];
      if (!attempt) throw notFound("Attempt");
      await resolveStudent(req, db, attempt.student_id); // authorization: self, linked parent or staff
      const answers = await db.query(
        `SELECT sa.id, sa.question_id, q.prompt, q.type, q.marks, sa.answer, sa.marks_awarded, sa.review_status,
                CASE WHEN $2 THEN q.answer_key END AS answer_key
           FROM student_answers sa JOIN questions q ON q.id = sa.question_id WHERE sa.attempt_id = $1 ORDER BY q.sequence`,
        [attempt.id, attempt.status !== "in_progress"],
      );
      return { attempt, answers: answers.rows };
    });
    res.json(data);
  }),
);

/** Teacher marks a descriptive answer; when nothing is pending the attempt becomes graded. */
attemptsRouter.post(
  "/:id/answers/:answerId/review",
  requirePermission("assessments.review"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const { marks } = parse(z.object({ marks: z.number().min(0) }), req.body);
    const result = await withTenant(tenant.id, async (db) => {
      const ans = (
        await db.query(
          `SELECT sa.id, q.marks AS max, q.topic_id, a.student_id FROM student_answers sa
             JOIN questions q ON q.id = sa.question_id JOIN assessment_attempts a ON a.id = sa.attempt_id
            WHERE sa.id = $1 AND sa.attempt_id = $2 AND sa.review_status = 'pending_review' FOR UPDATE OF sa`,
          [req.params.answerId, req.params.id],
        )
      ).rows[0];
      if (!ans) throw notFound("Pending answer");
      if (marks > ans.max) throw badRequest(`Marks cannot exceed ${ans.max}`);
      await db.query(`UPDATE student_answers SET marks_awarded = $2, review_status = 'reviewed', reviewed_by = $3 WHERE id = $1`, [ans.id, marks, userId]);
      await recordMasteryEvidence(db, tenant.id, ans.student_id, req.params.id, new Map([[ans.topic_id, { got: marks, max: ans.max }]]));
      const remaining = await db.query(`SELECT count(*)::int AS n FROM student_answers WHERE attempt_id = $1 AND review_status = 'pending_review'`, [req.params.id]);
      const total = await db.query(`SELECT COALESCE(sum(marks_awarded),0) AS s FROM student_answers WHERE attempt_id = $1`, [req.params.id]);
      await db.query(`UPDATE assessment_attempts SET score = $2, status = CASE WHEN $3 THEN 'graded' ELSE status END WHERE id = $1`, [
        req.params.id,
        total.rows[0].s,
        remaining.rows[0].n === 0,
      ]);
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "assessment.review", resourceType: "student_answer", resourceId: ans.id, metadata: { marks } });
      return { score: Number(total.rows[0].s), pendingReview: remaining.rows[0].n };
    });
    res.json(result);
  }),
);
