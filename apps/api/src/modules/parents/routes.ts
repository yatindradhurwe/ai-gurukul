import { Router } from "express";
import { z } from "zod";
import { audit, withSystem, withTenant } from "../../database/pool.js";
import { hashPassword } from "../../lib/crypto.js";
import { conflict, forbidden } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { resolveStudent } from "../../lib/student-access.js";
import { requirePermission } from "../../middleware/authorization.js";
import { assertStudentSeatAvailable } from "../tenants/service.js";
import { loadMastery } from "../academic-planner/service.js";
import { addDays, todayIn } from "../academic-planner/dates.js";

export const parentsRouter = Router();
parentsRouter.use(requirePermission("reports.children"));

parentsRouter.get(
  "/children",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const rows = await withTenant(tenant.id, (db) =>
      db.query(
        `SELECT sp.id AS student_id, u.name, u.email, l.relationship, l.consent_status
           FROM parent_student_links l JOIN student_profiles sp ON sp.id = l.student_id JOIN users u ON u.id = sp.user_id
          WHERE l.parent_id = $1 ORDER BY u.name`,
        [userId],
      ),
    );
    res.json({ children: rows.rows });
  }),
);

const childSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(200),
  curriculumVersionId: z.string().uuid(),
  relationship: z.enum(["mother", "father", "guardian", "other"]).default("guardian"),
});

/** A parent creates a child's student account in their family workspace and gives consent. */
parentsRouter.post(
  "/children",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(childSchema, req.body);
    const passwordHash = await hashPassword(body.password);
    const child = await withSystem(async (db) => {
      const exists = await db.query(`SELECT 1 FROM users WHERE lower(email) = $1`, [body.email]);
      if (exists.rowCount) throw conflict("An account with this email already exists");
      await assertStudentSeatAvailable(db, tenant.id);
      const u = (await db.query(`INSERT INTO users (name, email, password_hash) VALUES ($1,$2,$3) RETURNING id, name, email`, [body.name, body.email, passwordHash])).rows[0];
      await db.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role_id) VALUES ($1,$2,'student')`, [tenant.id, u.id]);
      const sp = (
        await db.query(`INSERT INTO student_profiles (tenant_id, user_id, curriculum_version_id) VALUES ($1,$2,$3) RETURNING id`, [tenant.id, u.id, body.curriculumVersionId])
      ).rows[0];
      await db.query(
        `INSERT INTO parent_student_links (tenant_id, parent_id, student_id, relationship, consent_status) VALUES ($1,$2,$3,$4,'granted')`,
        [tenant.id, userId, sp.id, body.relationship],
      );
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "parent.child_created", resourceType: "student_profile", resourceId: sp.id });
      return { studentId: sp.id, userId: u.id, name: u.name, email: u.email };
    });
    res.status(201).json({ child });
  }),
);

parentsRouter.post(
  "/children/:studentId/consent",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const { status } = parse(z.object({ status: z.enum(["granted", "revoked"]) }), req.body);
    const row = await withTenant(tenant.id, async (db) => {
      const r = await db.query(
        `UPDATE parent_student_links SET consent_status = $3 WHERE parent_id = $1 AND student_id = $2 RETURNING student_id, consent_status`,
        [userId, req.params.studentId, status],
      );
      if (!r.rows[0]) throw forbidden("You are not linked to this student");
      await audit(db, { tenantId: tenant.id, actorId: userId, action: `consent.${status}`, resourceType: "student_profile", resourceId: req.params.studentId });
      return r.rows[0];
    });
    res.json({ link: row });
  }),
);

/** Weekly learning report for an authorized guardian. */
parentsRouter.get(
  "/children/:studentId/report",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db, req.params.studentId);
      if (student.access !== "parent") throw forbidden("Only a linked guardian can view this report");
      const today = (req.query.date as string) && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date as string) ? (req.query.date as string) : todayIn(student.timezone);
      const weekAgo = addDays(today, -7);
      const tasks = (
        await db.query(
          `SELECT count(*) FILTER (WHERE t.status = 'completed')::int AS completed,
                  count(*) FILTER (WHERE t.status IN ('pending','missed') AND t.task_date < $3)::int AS missed,
                  count(*)::int AS planned,
                  COALESCE(sum(t.duration_minutes) FILTER (WHERE t.status = 'completed'),0)::int AS minutes_studied
             FROM study_plan_tasks t JOIN study_plans p ON p.id = t.plan_id
            WHERE t.student_id = $1 AND t.task_date >= $2 AND t.task_date < $3 AND p.status IN ('active','superseded')`,
          [student.id, weekAgo, today],
        )
      ).rows[0];
      const attempts = await db.query(
        `SELECT a.title, at.score, at.max_score, at.status, at.submitted_at FROM assessment_attempts at JOIN assessments a ON a.id = at.assessment_id
          WHERE at.student_id = $1 AND at.status <> 'in_progress' ORDER BY at.submitted_at DESC LIMIT 5`,
        [student.id],
      );
      const exams = await db.query(
        `SELECT e.title, e.exam_date, s.name AS subject FROM exam_schedules e JOIN subjects s ON s.id = e.subject_id
          WHERE (e.student_id = $1 OR e.student_id IS NULL) AND e.exam_date >= $2 ORDER BY e.exam_date LIMIT 5`,
        [student.id, today],
      );
      const mastery = await loadMastery(db, student.id);
      const plan = (
        await db.query(
          `SELECT p.id, p.version, p.summary->'feasible' AS feasible, p.summary->'gapMinutes' AS gap_minutes,
                  (SELECT a.reason FROM plan_adjustments a WHERE a.plan_id = p.id LIMIT 1) AS last_change
             FROM study_plans p WHERE p.student_id = $1 AND p.status = 'active' ORDER BY p.created_at DESC LIMIT 1`,
          [student.id],
        )
      ).rows[0];
      const scores = [...mastery.values()];
      return {
        student: { id: student.id, name: student.name },
        period: { from: weekAgo, to: today },
        studyTasks: tasks,
        recentAssessments: attempts.rows,
        upcomingExams: exams.rows,
        mastery: {
          topicsAssessed: scores.filter((m) => m.kind === "measured").length,
          topicsMastered: scores.filter((m) => m.kind === "measured" && m.score >= 0.8).length,
          averageMeasured: scores.filter((m) => m.kind === "measured").length
            ? Math.round((scores.filter((m) => m.kind === "measured").reduce((a, m) => a + m.score, 0) / scores.filter((m) => m.kind === "measured").length) * 100) / 100
            : null,
        },
        activePlan: plan ?? null,
      };
    });
    res.json(data);
  }),
);
