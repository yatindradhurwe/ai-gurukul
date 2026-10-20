import type { Request } from "express";
import { Router } from "express";
import { z } from "zod";
import { audit, withTenant, type Db } from "../../database/pool.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { resolveStudent } from "../../lib/student-access.js";
import { requirePermission } from "../../middleware/authorization.js";
import { gradeFor, loadClass, roster, round1, visibleClassesSql } from "../lms/access.js";

export const examsRouter = Router();

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");

const canManage = (req: Request) => requireTenant(req).permissions.has("exams.manage");

/** Papers whose exam has not declared results yet; students and parents don't see these marks. */
export const UNDECLARED_ITEM_SQL = (itemAlias: string) =>
  `EXISTS (SELECT 1 FROM exam_papers ep JOIN exams ex ON ex.id = ep.exam_id WHERE ep.grade_item_id = ${itemAlias}.id AND ex.status <> 'completed')`;

async function loadExam(db: Db, id: string) {
  const e = (await db.query(`SELECT * FROM exams WHERE id = $1`, [id])).rows[0];
  if (!e) throw notFound("Exam");
  return e;
}

examsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const manager = canManage(req);
    const visible = visibleClassesSql(req, 2);
    const rows = await withTenant(tenant.id, (db) =>
      db.query(
        `SELECT e.*,
                (SELECT count(*)::int FROM exam_papers p WHERE p.exam_id = e.id AND ($1::boolean OR p.class_id IN (${visible.sql}))) AS papers,
                (SELECT min(p.date) FROM exam_papers p WHERE p.exam_id = e.id AND ($1::boolean OR p.class_id IN (${visible.sql}))) AS first_paper,
                (SELECT max(p.date) FROM exam_papers p WHERE p.exam_id = e.id AND ($1::boolean OR p.class_id IN (${visible.sql}))) AS last_paper,
                (SELECT string_agg(DISTINCT c.name, ', ') FROM exam_papers p JOIN classes c ON c.id = p.class_id
                  WHERE p.exam_id = e.id AND ($1::boolean OR p.class_id IN (${visible.sql}))) AS classes
           FROM exams e
          WHERE $1::boolean OR (e.status <> 'draft' AND EXISTS (SELECT 1 FROM exam_papers p WHERE p.exam_id = e.id AND p.class_id IN (${visible.sql})))
          ORDER BY COALESCE(e.start_date, e.created_at::date) DESC`,
        [manager, ...visible.params],
      ),
    );
    res.json({ exams: rows.rows, canManage: manager });
  }),
);

const examSchema = z.object({
  name: z.string().trim().min(1).max(160),
  term: z.string().trim().min(1).max(60).default("Term 1"),
  startDate: date.nullish(),
  endDate: date.nullish(),
  instructions: z.string().trim().max(5000).default(""),
});

examsRouter.post(
  "/",
  requirePermission("exams.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(examSchema, req.body);
    if (body.startDate && body.endDate && body.endDate < body.startDate) throw badRequest("The exam ends before it starts");
    const row = await withTenant(tenant.id, async (db) => {
      const e = (
        await db.query(`INSERT INTO exams (tenant_id, name, term, start_date, end_date, instructions, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [
          tenant.id,
          body.name,
          body.term,
          body.startDate ?? null,
          body.endDate ?? null,
          body.instructions,
          userId,
        ])
      ).rows[0];
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "exam.create", resourceType: "exam", resourceId: e.id });
      return e;
    });
    res.status(201).json({ exam: row });
  }),
);

examsRouter.patch(
  "/:id",
  requirePermission("exams.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(examSchema.partial().extend({ status: z.enum(["draft", "published", "completed"]).optional() }), req.body);
    const row = await withTenant(tenant.id, async (db) => {
      const e = await loadExam(db, req.params.id);
      const start = body.startDate !== undefined ? body.startDate : e.start_date;
      const end = body.endDate !== undefined ? body.endDate : e.end_date;
      if (start && end && end < start) throw badRequest("The exam ends before it starts");
      const u = (
        await db.query(
          `UPDATE exams SET name = COALESCE($2, name), term = COALESCE($3, term), start_date = $4, end_date = $5,
                  instructions = COALESCE($6, instructions), status = COALESCE($7, status) WHERE id = $1 RETURNING *`,
          [e.id, body.name ?? null, body.term ?? null, start, end, body.instructions ?? null, body.status ?? null],
        )
      ).rows[0];
      // Keep the linked gradebook columns in the exam's term.
      if (body.term) await db.query(`UPDATE grade_items SET term = $2 WHERE id IN (SELECT grade_item_id FROM exam_papers WHERE exam_id = $1)`, [e.id, body.term]);
      if (body.status) await audit(db, { tenantId: tenant.id, actorId: userId, action: `exam.${body.status}`, resourceType: "exam", resourceId: e.id });
      return u;
    });
    res.json({ exam: row });
  }),
);

examsRouter.delete(
  "/:id",
  requirePermission("exams.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    await withTenant(tenant.id, async (db) => {
      const e = await loadExam(db, req.params.id);
      await db.query(`DELETE FROM grade_items WHERE id IN (SELECT grade_item_id FROM exam_papers WHERE exam_id = $1)`, [e.id]);
      await db.query(`DELETE FROM exams WHERE id = $1`, [e.id]);
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "exam.delete", resourceType: "exam", resourceId: e.id });
    });
    res.json({ ok: true });
  }),
);

/** The date sheet. Managers see every paper; others only papers for their classes (and only once published). */
examsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const manager = canManage(req);
    const visible = visibleClassesSql(req, 3);
    const data = await withTenant(tenant.id, async (db) => {
      const e = await loadExam(db, req.params.id);
      if (!manager && e.status === "draft") throw notFound("Exam");
      const papers = await db.query(
        `SELECT p.id, p.class_id, c.name AS class_name, p.subject, p.date, to_char(p.start_time, 'HH24:MI') AS start_time,
                p.duration_minutes, p.max_marks, p.pass_marks, p.room, p.grade_item_id,
                (SELECT count(*)::int FROM class_enrollments en WHERE en.class_id = p.class_id) AS students,
                (SELECT count(*)::int FROM grade_scores gs WHERE gs.item_id = p.grade_item_id AND gs.marks IS NOT NULL) AS marked
           FROM exam_papers p JOIN classes c ON c.id = p.class_id
          WHERE p.exam_id = $1 AND ($2::boolean OR p.class_id IN (${visible.sql}))
          ORDER BY p.date, p.start_time, c.name`,
        [e.id, manager, ...visible.params],
      );
      if (!manager && !papers.rowCount) throw forbidden("This exam has no papers for your classes");
      const staff = manager || tenant.permissions.has("classes.manage");
      return {
        exam: e,
        canManage: manager,
        papers: papers.rows.map(({ students, marked, ...p }) => (staff ? { ...p, students, marked } : p)),
      };
    });
    res.json(data);
  }),
);

examsRouter.post(
  "/:id/papers",
  requirePermission("exams.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(
      z.object({
        classId: z.string().uuid(),
        subject: z.string().trim().min(1).max(120),
        date,
        startTime: time.default("09:00"),
        durationMinutes: z.number().int().min(15).max(600).default(180),
        maxMarks: z.number().positive().max(1000),
        passMarks: z.number().min(0).nullish(),
        room: z.string().trim().max(60).nullish(),
      }),
      req.body,
    );
    if (body.passMarks != null && body.passMarks > body.maxMarks) throw badRequest("Pass marks cannot exceed maximum marks");
    const row = await withTenant(tenant.id, async (db) => {
      const e = await loadExam(db, req.params.id);
      if ((e.start_date && body.date < e.start_date) || (e.end_date && body.date > e.end_date)) throw badRequest("The paper date is outside the exam's dates");
      const cls = (await db.query(`SELECT id, name FROM classes WHERE id = $1`, [body.classId])).rows[0];
      if (!cls) throw notFound("Class");
      const dup = await db.query(`SELECT 1 FROM exam_papers WHERE exam_id = $1 AND class_id = $2 AND lower(subject) = lower($3)`, [e.id, cls.id, body.subject]);
      if (dup.rowCount) throw conflict(`${cls.name} already has a ${body.subject} paper in this exam`);
      const clash = await db.query(
        `SELECT subject FROM exam_papers WHERE class_id = $1 AND date = $2
            AND start_time < ($3::time + make_interval(mins => $4)) AND (start_time + make_interval(mins => duration_minutes)) > $3::time LIMIT 1`,
        [cls.id, body.date, body.startTime, body.durationMinutes],
      );
      if (clash.rowCount) throw conflict(`${cls.name} already has the ${clash.rows[0].subject} paper at that time`);
      const item = (
        await db.query(
          `INSERT INTO grade_items (tenant_id, class_id, title, term, category, max_marks, date, created_by) VALUES ($1,$2,$3,$4,'exam',$5,$6,$7) RETURNING id`,
          [tenant.id, cls.id, `${e.name} — ${body.subject}`, e.term, body.maxMarks, body.date, userId],
        )
      ).rows[0];
      return (
        await db.query(
          `INSERT INTO exam_papers (tenant_id, exam_id, class_id, subject, date, start_time, duration_minutes, max_marks, pass_marks, room, grade_item_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [tenant.id, e.id, cls.id, body.subject, body.date, body.startTime, body.durationMinutes, body.maxMarks, body.passMarks ?? null, body.room ?? null, item.id],
        )
      ).rows[0];
    });
    res.status(201).json({ paper: row });
  }),
);

examsRouter.delete(
  "/papers/:paperId",
  requirePermission("exams.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    await withTenant(tenant.id, async (db) => {
      const p = (await db.query(`SELECT id, grade_item_id FROM exam_papers WHERE id = $1`, [req.params.paperId])).rows[0];
      if (!p) throw notFound("Paper");
      await db.query(`DELETE FROM exam_papers WHERE id = $1`, [p.id]);
      if (p.grade_item_id) await db.query(`DELETE FROM grade_items WHERE id = $1`, [p.grade_item_id]);
    });
    res.json({ ok: true });
  }),
);

export interface PaperRow {
  id: string;
  subject: string;
  max_marks: string | number;
  pass_marks: string | number | null;
  grade_item_id: string | null;
}

export function summarise(papers: PaperRow[], marksFor: (p: PaperRow) => number | null) {
  const rows = papers.map((p) => {
    const marks = marksFor(p);
    const passed = marks == null || p.pass_marks == null ? null : marks >= Number(p.pass_marks);
    return { paperId: p.id, subject: p.subject, max: Number(p.max_marks), pass: p.pass_marks == null ? null : Number(p.pass_marks), marks, passed };
  });
  const scored = rows.filter((r) => r.marks != null);
  const max = scored.reduce((t, r) => t + r.max, 0);
  const total = scored.reduce((t, r) => t + (r.marks ?? 0), 0);
  const percent = max ? round1((total / max) * 100) : null;
  const result = !scored.length ? "pending" : rows.some((r) => r.passed === false) ? "fail" : scored.length < rows.length ? "pending" : "pass";
  return { papers: rows, total, max, percent, grade: gradeFor(percent), result };
}

/** Class result sheet: every student's marks for one class's papers, ranked. */
examsRouter.get(
  "/:id/results",
  requirePermission("exams.manage", "classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(z.object({ classId: z.string().uuid() }), req.query);
    const data = await withTenant(tenant.id, async (db) => {
      const e = await loadExam(db, req.params.id);
      if (!canManage(req)) await loadClass(req, db, q.classId, { manage: true });
      const papers: PaperRow[] = (await db.query(`SELECT id, subject, max_marks, pass_marks, grade_item_id FROM exam_papers WHERE exam_id = $1 AND class_id = $2 ORDER BY date, start_time`, [e.id, q.classId])).rows;
      const scores = await db.query(`SELECT item_id, student_id, marks FROM grade_scores WHERE item_id = ANY($1::uuid[])`, [papers.map((p) => p.grade_item_id).filter(Boolean)]);
      const students = (await roster(db, q.classId)).map((s) => {
        const mine = new Map(scores.rows.filter((x) => x.student_id === s.student_id).map((x) => [x.item_id, x.marks == null ? null : Number(x.marks)]));
        return { ...s, ...summarise(papers, (p) => (p.grade_item_id ? (mine.get(p.grade_item_id) ?? null) : null)) };
      });
      // Competition ranking ("1, 2, 2, 4") on percentage.
      const ranked = [...students].filter((s) => s.percent != null).sort((a, b) => b.percent! - a.percent!);
      const rank = new Map<string, number>();
      ranked.forEach((s, i) => rank.set(s.student_id, i > 0 && ranked[i - 1].percent === s.percent ? rank.get(ranked[i - 1].student_id)! : i + 1));
      const passed = students.filter((s) => s.result === "pass").length;
      return {
        exam: e,
        subjects: papers.map((p) => ({ id: p.id, subject: p.subject, max: Number(p.max_marks), pass: p.pass_marks == null ? null : Number(p.pass_marks), gradeItemId: p.grade_item_id })),
        students: students.map((s) => ({ ...s, rank: rank.get(s.student_id) ?? null })).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.name.localeCompare(b.name)),
        summary: {
          students: students.length,
          passed,
          failed: students.filter((s) => s.result === "fail").length,
          average: ranked.length ? round1(ranked.reduce((t, s) => t + s.percent!, 0) / ranked.length) : null,
          highest: ranked[0]?.percent ?? null,
        },
      };
    });
    res.json(data);
  }),
);

/** One student's result for an exam (students and parents only once results are declared). */
examsRouter.get(
  "/:id/student",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(z.object({ studentId: z.string().uuid().optional() }), req.query);
    const data = await withTenant(tenant.id, async (db) => {
      const e = await loadExam(db, req.params.id);
      const student = await resolveStudent(req, db, q.studentId);
      if (student.access !== "staff" && e.status !== "completed") return { exam: e, student: { id: student.id, name: student.name }, declared: false };
      const papers: PaperRow[] = (
        await db.query(
          `SELECT p.id, p.subject, p.max_marks, p.pass_marks, p.grade_item_id FROM exam_papers p
             JOIN class_enrollments en ON en.class_id = p.class_id AND en.student_id = $2
            WHERE p.exam_id = $1 ORDER BY p.date, p.start_time`,
          [e.id, student.id],
        )
      ).rows;
      const scores = await db.query(`SELECT item_id, marks FROM grade_scores WHERE student_id = $1 AND item_id = ANY($2::uuid[])`, [student.id, papers.map((p) => p.grade_item_id).filter(Boolean)]);
      const by = new Map(scores.rows.map((s) => [s.item_id, s.marks == null ? null : Number(s.marks)]));
      return { exam: e, student: { id: student.id, name: student.name }, declared: true, ...summarise(papers, (p) => (p.grade_item_id ? (by.get(p.grade_item_id) ?? null) : null)) };
    });
    res.json(data);
  }),
);
