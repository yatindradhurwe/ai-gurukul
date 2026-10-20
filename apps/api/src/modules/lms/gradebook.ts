import { Router } from "express";
import { z } from "zod";
import { audit, withTenant } from "../../database/pool.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { resolveStudent } from "../../lib/student-access.js";
import { requirePermission } from "../../middleware/authorization.js";
import { gradeFor, loadClass, roster, round1 } from "./access.js";
import { ATTENDED_SQL, COUNTED_SQL } from "./attendance.js";

export const gradebookRouter = Router();

/** The class gradebook: columns (items) × students, with marks. */
gradebookRouter.get(
  "/classes/:classId",
  requirePermission("classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(z.object({ term: z.string().trim().max(60).optional() }), req.query);
    const data = await withTenant(tenant.id, async (db) => {
      const { cls } = await loadClass(req, db, req.params.classId, { manage: true });
      const items = (
        await db.query(`SELECT * FROM grade_items WHERE class_id = $1 AND ($2::text IS NULL OR term = $2) ORDER BY date NULLS LAST, created_at`, [cls.id, q.term ?? null])
      ).rows;
      const scores = await db.query(`SELECT item_id, student_id, marks, remarks FROM grade_scores WHERE item_id = ANY($1::uuid[])`, [items.map((i) => i.id)]);
      const terms = (await db.query(`SELECT DISTINCT term FROM grade_items WHERE class_id = $1 ORDER BY term`, [cls.id])).rows.map((r) => r.term);
      const students = (await roster(db, cls.id)).map((s) => {
        const mine = scores.rows.filter((x) => x.student_id === s.student_id && x.marks != null);
        const max = mine.reduce((t, x) => t + Number(items.find((i) => i.id === x.item_id).max_marks), 0);
        const got = mine.reduce((t, x) => t + Number(x.marks), 0);
        const percent = max ? round1((got / max) * 100) : null;
        return { ...s, scores: Object.fromEntries(scores.rows.filter((x) => x.student_id === s.student_id).map((x) => [x.item_id, { marks: x.marks, remarks: x.remarks }])), percent, grade: gradeFor(percent) };
      });
      return { class: cls, terms, items, students };
    });
    res.json(data);
  }),
);

gradebookRouter.post(
  "/classes/:classId/items",
  requirePermission("classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(
      z.object({
        title: z.string().trim().min(1).max(160),
        term: z.string().trim().min(1).max(60).default("Term 1"),
        category: z.enum(["test", "exam", "project", "homework", "practical"]).default("test"),
        maxMarks: z.number().positive().max(1000),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
      }),
      req.body,
    );
    const row = await withTenant(tenant.id, async (db) => {
      const { cls } = await loadClass(req, db, req.params.classId, { manage: true });
      return (
        await db.query(
          `INSERT INTO grade_items (tenant_id, class_id, title, term, category, max_marks, date, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [tenant.id, cls.id, body.title, body.term, body.category, body.maxMarks, body.date ?? null, userId],
        )
      ).rows[0];
    });
    res.status(201).json({ item: row });
  }),
);

async function loadItem(req: Parameters<typeof loadClass>[0], db: Parameters<typeof loadClass>[1], id: string) {
  const item = (await db.query(`SELECT * FROM grade_items WHERE id = $1`, [id])).rows[0];
  if (!item) throw notFound("Gradebook column");
  await loadClass(req, db, item.class_id, { manage: true });
  return item;
}

gradebookRouter.delete(
  "/items/:id",
  requirePermission("classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    await withTenant(tenant.id, async (db) => {
      const item = await loadItem(req, db, req.params.id);
      await db.query(`DELETE FROM grade_items WHERE id = $1`, [item.id]);
    });
    res.json({ ok: true });
  }),
);

gradebookRouter.put(
  "/items/:id/scores",
  requirePermission("classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(
      z.object({
        scores: z
          .array(z.object({ studentId: z.string().uuid(), marks: z.number().min(0).nullable(), remarks: z.string().trim().max(500).nullish() }))
          .min(1)
          .max(500),
      }),
      req.body,
    );
    const saved = await withTenant(tenant.id, async (db) => {
      const item = await loadItem(req, db, req.params.id);
      const enrolled = new Set((await roster(db, item.class_id)).map((s) => s.student_id));
      for (const s of body.scores) {
        if (!enrolled.has(s.studentId)) throw badRequest("Every student must be enrolled in this class");
        if (s.marks != null && s.marks > Number(item.max_marks)) throw badRequest(`Marks cannot exceed ${item.max_marks}`);
        await db.query(
          `INSERT INTO grade_scores (tenant_id, item_id, student_id, marks, remarks, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (item_id, student_id) DO UPDATE SET marks = EXCLUDED.marks, remarks = EXCLUDED.remarks, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [tenant.id, item.id, s.studentId, s.marks, s.remarks ?? null, userId],
        );
      }
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "gradebook.scores", resourceType: "grade_item", resourceId: item.id, metadata: { count: body.scores.length } });
      return body.scores.length;
    });
    res.json({ saved });
  }),
);

/** Report card for one student: every enrolled class, its marks, percentage and grade, plus attendance and homework. */
gradebookRouter.get(
  "/report-card",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(z.object({ studentId: z.string().uuid().optional(), term: z.string().trim().max(60).optional() }), req.query);
    const data = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db, q.studentId);
      const classes = (
        await db.query(
          `SELECT c.id, c.name, u.name AS teacher FROM class_enrollments e JOIN classes c ON c.id = e.class_id JOIN users u ON u.id = c.teacher_id
            WHERE e.student_id = $1 ORDER BY c.name`,
          [student.id],
        )
      ).rows;
      const items = await db.query(
        `SELECT i.id, i.class_id, i.title, i.term, i.category, i.max_marks, i.date, s.marks, s.remarks
           FROM grade_items i LEFT JOIN grade_scores s ON s.item_id = i.id AND s.student_id = $1
          WHERE i.class_id = ANY($2::uuid[]) AND ($3::text IS NULL OR i.term = $3)
          ORDER BY i.date NULLS LAST, i.created_at`,
        [student.id, classes.map((c) => c.id), q.term ?? null],
      );
      const terms = (await db.query(`SELECT DISTINCT term FROM grade_items WHERE class_id = ANY($1::uuid[]) ORDER BY term`, [classes.map((c) => c.id)])).rows.map((r) => r.term);
      const subjects = classes.map((c) => {
        const mine = items.rows.filter((i) => i.class_id === c.id);
        const scored = mine.filter((i) => i.marks != null);
        const max = scored.reduce((t, i) => t + Number(i.max_marks), 0);
        const got = scored.reduce((t, i) => t + Number(i.marks), 0);
        const percent = max ? round1((got / max) * 100) : null;
        return { classId: c.id, name: c.name, teacher: c.teacher, items: mine, obtained: got, max, percent, grade: gradeFor(percent) };
      });
      const graded = subjects.filter((s) => s.percent != null);
      const overall = graded.length ? round1(graded.reduce((t, s) => t + s.percent!, 0) / graded.length) : null;
      const att = (
        await db.query(`SELECT ${ATTENDED_SQL}::int AS attended, ${COUNTED_SQL}::int AS counted FROM attendance_records WHERE student_id = $1`, [student.id])
      ).rows[0];
      const hw = (
        await db.query(
          `SELECT count(a.*)::int AS total, count(s.id)::int AS submitted,
                  avg(CASE WHEN s.graded_at IS NOT NULL THEN s.points / a.max_points END) AS avg_score
             FROM assignments a JOIN class_enrollments e ON e.class_id = a.class_id AND e.student_id = $1
             LEFT JOIN assignment_submissions s ON s.assignment_id = a.id AND s.student_id = $1`,
          [student.id],
        )
      ).rows[0];
      const tenantRow = (await db.query(`SELECT name FROM tenants WHERE id = $1`, [tenant.id])).rows[0];
      return {
        organization: tenantRow?.name,
        student: { id: student.id, name: student.name },
        term: q.term ?? null,
        terms,
        subjects,
        overall: { percent: overall, grade: gradeFor(overall) },
        attendance: { ...att, rate: att.counted ? round1((att.attended / att.counted) * 100) : null },
        assignments: { total: hw.total, submitted: hw.submitted, averagePercent: hw.avg_score == null ? null : round1(Number(hw.avg_score) * 100) },
        generatedAt: new Date().toISOString(),
      };
    });
    res.json(data);
  }),
);
