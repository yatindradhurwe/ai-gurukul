import { Router } from "express";
import { z } from "zod";
import { audit, withTenant } from "../../database/pool.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { resolveStudent } from "../../lib/student-access.js";
import { requirePermission } from "../../middleware/authorization.js";
import { loadClass, roster, visibleClassesSql } from "./access.js";

export const assignmentsRouter = Router();

const studentQuery = z.object({ classId: z.string().uuid().optional(), studentId: z.string().uuid().optional() });

assignmentsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(studentQuery, req.query);
    const data = await withTenant(tenant.id, async (db) => {
      // Teachers and admins: every assignment in the classes they manage, with progress counts.
      if (tenant.permissions.has("classes.manage") && !q.studentId) {
        const visible = visibleClassesSql(req, 2);
        const rows = await db.query(
          `SELECT a.*, c.name AS class_name,
                  (SELECT count(*)::int FROM class_enrollments e WHERE e.class_id = a.class_id) AS students,
                  (SELECT count(*)::int FROM assignment_submissions s WHERE s.assignment_id = a.id) AS submitted,
                  (SELECT count(*)::int FROM assignment_submissions s WHERE s.assignment_id = a.id AND s.graded_at IS NOT NULL) AS graded
             FROM assignments a JOIN classes c ON c.id = a.class_id
            WHERE a.class_id IN (${visible.sql}) AND ($1::uuid IS NULL OR a.class_id = $1)
            ORDER BY a.due_at NULLS LAST, a.created_at DESC`,
          [q.classId ?? null, ...visible.params],
        );
        return { view: "staff", assignments: rows.rows };
      }
      // Students (and parents for a child): assignments of the classes the student is enrolled in.
      const student = await resolveStudent(req, db, q.studentId);
      const rows = await db.query(
        `SELECT a.*, c.name AS class_name, s.id AS submission_id, s.submitted_at, s.points, s.feedback, s.graded_at,
                CASE WHEN s.graded_at IS NOT NULL THEN 'graded' WHEN s.id IS NOT NULL THEN 'submitted'
                     WHEN a.due_at < now() THEN 'overdue' ELSE 'pending' END AS state
           FROM assignments a JOIN classes c ON c.id = a.class_id
           JOIN class_enrollments e ON e.class_id = a.class_id AND e.student_id = $1
           LEFT JOIN assignment_submissions s ON s.assignment_id = a.id AND s.student_id = $1
          WHERE ($2::uuid IS NULL OR a.class_id = $2)
          ORDER BY (s.id IS NULL) DESC, a.due_at NULLS LAST, a.created_at DESC`,
        [student.id, q.classId ?? null],
      );
      return { view: "student", student: { id: student.id, name: student.name }, assignments: rows.rows };
    });
    res.json(data);
  }),
);

const assignmentSchema = z.object({
  classId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(10000).default(""),
  dueAt: z.string().datetime({ offset: true }).nullish(),
  maxPoints: z.number().positive().max(1000).default(100),
});

assignmentsRouter.post(
  "/",
  requirePermission("classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(assignmentSchema, req.body);
    const row = await withTenant(tenant.id, async (db) => {
      await loadClass(req, db, body.classId, { manage: true });
      const a = (
        await db.query(
          `INSERT INTO assignments (tenant_id, class_id, title, description, due_at, max_points, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [tenant.id, body.classId, body.title, body.description, body.dueAt ?? null, body.maxPoints, userId],
        )
      ).rows[0];
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "assignment.create", resourceType: "assignment", resourceId: a.id });
      return a;
    });
    res.status(201).json({ assignment: row });
  }),
);

async function loadAssignment(db: Parameters<typeof loadClass>[1], id: string) {
  const a = (await db.query(`SELECT a.*, c.name AS class_name FROM assignments a JOIN classes c ON c.id = a.class_id WHERE a.id = $1`, [id])).rows[0];
  if (!a) throw notFound("Assignment");
  return a;
}

assignmentsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(studentQuery, req.query);
    const data = await withTenant(tenant.id, async (db) => {
      const a = await loadAssignment(db, req.params.id);
      const { staff } = await loadClass(req, db, a.class_id);
      if (staff && !q.studentId) {
        const students = await roster(db, a.class_id);
        const subs = await db.query(`SELECT * FROM assignment_submissions WHERE assignment_id = $1`, [a.id]);
        const byStudent = new Map(subs.rows.map((s) => [s.student_id, s]));
        return { assignment: a, staff: true, submissions: students.map((s) => ({ ...s, submission: byStudent.get(s.student_id) ?? null })) };
      }
      const student = await resolveStudent(req, db, q.studentId);
      const enrolled = await db.query(`SELECT 1 FROM class_enrollments WHERE class_id = $1 AND student_id = $2`, [a.class_id, student.id]);
      if (!enrolled.rowCount) throw forbidden("This student is not in this class");
      const sub = (await db.query(`SELECT * FROM assignment_submissions WHERE assignment_id = $1 AND student_id = $2`, [a.id, student.id])).rows[0];
      return { assignment: a, staff: false, submission: sub ?? null };
    });
    res.json(data);
  }),
);

assignmentsRouter.patch(
  "/:id",
  requirePermission("classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const body = parse(
      z.object({
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().trim().max(10000).optional(),
        dueAt: z.string().datetime({ offset: true }).nullish(),
        status: z.enum(["published", "closed"]).optional(),
      }),
      req.body,
    );
    const row = await withTenant(tenant.id, async (db) => {
      const a = await loadAssignment(db, req.params.id);
      await loadClass(req, db, a.class_id, { manage: true });
      return (
        await db.query(
          `UPDATE assignments SET title = COALESCE($2, title), description = COALESCE($3, description),
                  due_at = CASE WHEN $5 THEN $4::timestamptz ELSE due_at END, status = COALESCE($6, status)
            WHERE id = $1 RETURNING *`,
          [a.id, body.title ?? null, body.description ?? null, body.dueAt ?? null, body.dueAt !== undefined, body.status ?? null],
        )
      ).rows[0];
    });
    res.json({ assignment: row });
  }),
);

assignmentsRouter.delete(
  "/:id",
  requirePermission("classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    await withTenant(tenant.id, async (db) => {
      const a = await loadAssignment(db, req.params.id);
      await loadClass(req, db, a.class_id, { manage: true });
      await db.query(`DELETE FROM assignments WHERE id = $1`, [a.id]);
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "assignment.delete", resourceType: "assignment", resourceId: a.id });
    });
    res.json({ ok: true });
  }),
);

assignmentsRouter.post(
  "/:id/submit",
  requirePermission("classes.attend"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const body = parse(
      z.object({ content: z.string().trim().min(1).max(20000), linkUrl: z.string().trim().url().max(2000).nullish() }),
      req.body,
    );
    if (!tenant.studentProfileId) throw badRequest("Only students can submit assignments");
    const row = await withTenant(tenant.id, async (db) => {
      const a = await loadAssignment(db, req.params.id);
      const enrolled = await db.query(`SELECT 1 FROM class_enrollments WHERE class_id = $1 AND student_id = $2`, [a.class_id, tenant.studentProfileId]);
      if (!enrolled.rowCount) throw forbidden("You are not in this class");
      if (a.status === "closed") throw conflict("This assignment is closed for submissions");
      const prev = (await db.query(`SELECT graded_at FROM assignment_submissions WHERE assignment_id = $1 AND student_id = $2`, [a.id, tenant.studentProfileId])).rows[0];
      if (prev?.graded_at) throw conflict("This submission has already been graded");
      return (
        await db.query(
          `INSERT INTO assignment_submissions (tenant_id, assignment_id, student_id, content, link_url) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (assignment_id, student_id) DO UPDATE SET content = EXCLUDED.content, link_url = EXCLUDED.link_url, submitted_at = now()
           RETURNING *`,
          [tenant.id, a.id, tenant.studentProfileId, body.content, body.linkUrl ?? null],
        )
      ).rows[0];
    });
    res.status(201).json({ submission: row });
  }),
);

assignmentsRouter.post(
  "/:id/submissions/:submissionId/grade",
  requirePermission("classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(z.object({ points: z.number().min(0), feedback: z.string().trim().max(5000).nullish() }), req.body);
    const row = await withTenant(tenant.id, async (db) => {
      const a = await loadAssignment(db, req.params.id);
      await loadClass(req, db, a.class_id, { manage: true });
      if (body.points > Number(a.max_points)) throw badRequest(`Points cannot exceed ${a.max_points}`);
      const s = (
        await db.query(
          `UPDATE assignment_submissions SET points = $3, feedback = $4, graded_by = $5, graded_at = now()
            WHERE id = $1 AND assignment_id = $2 RETURNING *`,
          [req.params.submissionId, a.id, body.points, body.feedback ?? null, userId],
        )
      ).rows[0];
      if (!s) throw notFound("Submission");
      return s;
    });
    res.json({ submission: row });
  }),
);
