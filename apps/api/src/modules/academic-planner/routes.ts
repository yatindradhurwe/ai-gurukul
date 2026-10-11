import { Router, type Request } from "express";
import { z } from "zod";
import { withTenant } from "../../database/pool.js";
import { forbidden, notFound } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { resolveStudent } from "../../lib/student-access.js";
import { requirePermission } from "../../middleware/authorization.js";
import { addDays, todayIn } from "./dates.js";
import { createPlanVersion, getPlanWithTasks, loadMastery, lockActivePlan, recommendations } from "./service.js";

export const academicRouter = Router();
academicRouter.use(requirePermission("planner.self", "planner.manage_students", "reports.children"));

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const studentIdOf = (req: Request) => (req.query.studentId as string) || (req.body?.studentId as string) || null;

const weightsSchema = z
  .object({ weightage: z.number().min(0), gap: z.number().min(0), prerequisite: z.number().min(0), urgency: z.number().min(0) })
  .partial()
  .optional();

academicRouter.get(
  "/syllabus-progress",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db, studentIdOf(req));
      const mastery = await loadMastery(db, student.id);
      const rows = (
        await db.query(
          `SELECT t.id, c.id AS chapter_id, c.title AS chapter, c.sequence, s.id AS subject_id, s.name AS subject,
                  sc.status AS coverage,
                  EXISTS (SELECT 1 FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id
                           WHERE l.topic_id = t.id AND lp.student_id = $2 AND lp.status = 'completed') AS lesson_completed
             FROM topics t JOIN chapters c ON c.id = t.chapter_id JOIN subjects s ON s.id = c.subject_id
             LEFT JOIN syllabus_coverage sc ON sc.topic_id = t.id AND sc.student_id = $2
            WHERE c.curriculum_version_id = $1 ORDER BY s.name, c.sequence, t.sequence`,
          [student.curriculumVersionId, student.id],
        )
      ).rows;
      const chapters = new Map<string, any>();
      for (const r of rows) {
        const ch = chapters.get(r.chapter_id) ?? {
          chapterId: r.chapter_id, chapter: r.chapter, subjectId: r.subject_id, subject: r.subject,
          topics: 0, taught: 0, lessonsCompleted: 0, mastered: 0, assessed: 0, masterySum: 0,
        };
        ch.topics++;
        if (r.coverage === "taught" || r.coverage === "self_studied") ch.taught++;
        if (r.lesson_completed) ch.lessonsCompleted++;
        const m = mastery.get(r.id);
        if (m) {
          ch.assessed++;
          ch.masterySum += m.score;
          if (m.score >= 0.8 && m.kind === "measured") ch.mastered++;
        }
        chapters.set(r.chapter_id, ch);
      }
      const list = [...chapters.values()].map(({ masterySum, ...c }) => ({
        ...c,
        averageMastery: c.assessed ? Math.round((masterySum / c.assessed) * 100) / 100 : null,
        status: c.mastered === c.topics ? "mastered" : c.taught + c.lessonsCompleted > 0 ? "in_progress" : "not_started",
      }));
      const totalTopics = rows.length;
      const covered = list.reduce((a, c) => a + Math.max(c.taught, c.lessonsCompleted), 0);
      return { student: { id: student.id, name: student.name }, totalTopics, coveredTopics: covered, chapters: list };
    });
    res.json(data);
  }),
);

academicRouter.patch(
  "/preferences",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const body = parse(
      z.object({
        studentId: z.string().uuid().optional(),
        dailyStudyMinutes: z.number().int().min(0).max(720).optional(),
        weekdayMinutes: z.record(z.enum(["0", "1", "2", "3", "4", "5", "6"]), z.number().int().min(0).max(720)).optional(),
        language: z.string().min(2).max(10).optional(),
      }),
      req.body,
    );
    const row = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db, body.studentId);
      if (student.access === "staff") throw forbidden("Study preferences are set by the student or guardian");
      return (
        await db.query(
          `UPDATE student_profiles SET daily_study_minutes = COALESCE($2, daily_study_minutes),
                  weekday_minutes = COALESCE($3, weekday_minutes), language = COALESCE($4, language)
            WHERE id = $1 RETURNING daily_study_minutes, weekday_minutes, language`,
          [student.id, body.dailyStudyMinutes ?? null, body.weekdayMinutes ? JSON.stringify(body.weekdayMinutes) : null, body.language ?? null],
        )
      ).rows[0];
    });
    res.json({ preferences: row });
  }),
);

const examSchema = z.object({
  studentId: z.string().uuid().optional(),
  allStudents: z.boolean().default(false),
  subjectId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  examDate: date,
  maxMarks: z.number().int().min(1).max(1000),
  chapterIds: z.array(z.string().uuid()).default([]),
});

academicRouter.post(
  "/exams",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const body = parse(examSchema, req.body);
    const row = await withTenant(tenant.id, async (db) => {
      let studentId: string | null = null;
      if (body.allStudents) {
        if (!tenant.permissions.has("planner.manage_students")) throw forbidden("Only staff can schedule exams for all students");
      } else {
        studentId = (await resolveStudent(req, db, body.studentId)).id;
      }
      return (
        await db.query(
          `INSERT INTO exam_schedules (tenant_id, student_id, subject_id, title, exam_date, max_marks, chapter_ids)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [tenant.id, studentId, body.subjectId, body.title, body.examDate, body.maxMarks, body.chapterIds],
        )
      ).rows[0];
    });
    res.status(201).json({ exam: row });
  }),
);

academicRouter.get(
  "/exams",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const rows = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db, studentIdOf(req));
      return db.query(
        `SELECT e.*, s.name AS subject FROM exam_schedules e JOIN subjects s ON s.id = e.subject_id
          WHERE (e.student_id = $1 OR e.student_id IS NULL) AND e.exam_date >= $2 ORDER BY e.exam_date`,
        [student.id, todayIn(student.timezone)],
      );
    });
    res.json({ exams: rows.rows });
  }),
);

academicRouter.post(
  "/marks",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const body = parse(
      z.object({
        studentId: z.string().uuid().optional(),
        examScheduleId: z.string().uuid().optional(),
        subjectId: z.string().uuid(),
        marks: z.number().min(0),
        maxMarks: z.number().positive(),
      }).refine((b) => b.marks <= b.maxMarks, "marks cannot exceed maxMarks"),
      req.body,
    );
    const row = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db, body.studentId);
      const source = student.access === "staff" ? "teacher" : "self_reported";
      const mark = (
        await db.query(
          `INSERT INTO student_marks (tenant_id, student_id, exam_schedule_id, subject_id, marks, max_marks, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [tenant.id, student.id, body.examScheduleId ?? null, body.subjectId, body.marks, body.maxMarks, source],
        )
      ).rows[0];
      // Subject-level marks are weak evidence: record them as an *estimate* for topics
      // in that exam's syllabus that have no measured (topic-level) evidence yet.
      const exam = body.examScheduleId ? (await db.query(`SELECT chapter_ids FROM exam_schedules WHERE id = $1`, [body.examScheduleId])).rows[0] : null;
      await db.query(
        `INSERT INTO topic_mastery_history (tenant_id, student_id, topic_id, kind, score, evidence_type, evidence_id)
         SELECT $1, $2, t.id, 'estimated', $3, 'exam_marks', $4
           FROM topics t JOIN chapters c ON c.id = t.chapter_id
          WHERE c.curriculum_version_id = $5 AND c.subject_id = $6
            AND (cardinality($7::uuid[]) = 0 OR c.id = ANY($7::uuid[]))
            AND NOT EXISTS (SELECT 1 FROM topic_mastery_history h WHERE h.student_id = $2 AND h.topic_id = t.id AND h.kind = 'measured')`,
        [tenant.id, student.id, Math.round((body.marks / body.maxMarks) * 10000) / 10000, mark.id, student.curriculumVersionId, body.subjectId, exam?.chapter_ids ?? []],
      );
      return mark;
    });
    res.status(201).json({ marks: row });
  }),
);

academicRouter.post(
  "/coverage",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const body = parse(
      z.object({
        studentId: z.string().uuid().optional(),
        items: z.array(z.object({ topicId: z.string().uuid(), status: z.enum(["not_started", "taught", "missed", "self_studied"]) })).min(1).max(500),
      }),
      req.body,
    );
    await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db, body.studentId);
      for (const item of body.items) {
        await db.query(
          `INSERT INTO syllabus_coverage (tenant_id, student_id, topic_id, status, source) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (student_id, topic_id) DO UPDATE SET status = EXCLUDED.status, source = EXCLUDED.source, updated_at = now()`,
          [tenant.id, student.id, item.topicId, item.status, student.access],
        );
      }
    });
    res.json({ updated: body.items.length });
  }),
);

academicRouter.post(
  "/mastery-estimates",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const body = parse(
      z.object({ studentId: z.string().uuid().optional(), items: z.array(z.object({ topicId: z.string().uuid(), score: z.number().min(0).max(1) })).min(1).max(500) }),
      req.body,
    );
    await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db, body.studentId);
      for (const item of body.items) {
        await db.query(
          `INSERT INTO topic_mastery_history (tenant_id, student_id, topic_id, kind, score, evidence_type) VALUES ($1,$2,$3,'estimated',$4,$5)`,
          [tenant.id, student.id, item.topicId, item.score, student.access === "staff" ? "teacher_estimate" : "self_report"],
        );
      }
    });
    res.json({ recorded: body.items.length });
  }),
);

const disruptionSchema = z
  .object({
    studentId: z.string().uuid().optional(),
    startDate: date,
    endDate: date,
    reasonCategory: z.enum(["illness", "travel", "family", "school_absence", "holiday_travel", "other"]),
    availableMinutesPerDay: z.number().int().min(0).max(720).default(0),
    missedSchool: z.boolean().default(false),
    missedTopicIds: z.array(z.string().uuid()).default([]),
    notes: z.string().max(1000).optional(),
    autoRecalculate: z.boolean().default(true),
    asOfDate: date.optional(), // planning "today" (defaults to the student's local date)
  })
  .refine((b) => b.endDate >= b.startDate, "endDate must be on or after startDate");

/** Report a disruption (illness, travel...). Active plans are recalculated into new versions. */
academicRouter.post(
  "/disruptions",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(disruptionSchema, req.body);
    const data = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db, body.studentId);
      const disruption = (
        await db.query(
          `INSERT INTO student_disruptions (tenant_id, student_id, start_date, end_date, reason_category, available_minutes_per_day, missed_school, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [tenant.id, student.id, body.startDate, body.endDate, body.reasonCategory, body.availableMinutesPerDay, body.missedSchool, body.notes ?? null],
        )
      ).rows[0];
      for (const topicId of body.missedTopicIds) {
        await db.query(
          `INSERT INTO syllabus_coverage (tenant_id, student_id, topic_id, status, source) VALUES ($1,$2,$3,'missed','disruption')
           ON CONFLICT (student_id, topic_id) DO UPDATE SET status = 'missed', source = 'disruption', updated_at = now()`,
          [tenant.id, student.id, topicId],
        );
      }
      const recalculated = [];
      if (body.autoRecalculate) {
        const active = await db.query(`SELECT id FROM study_plans WHERE student_id = $1 AND status = 'active'`, [student.id]);
        const today = body.asOfDate ?? todayIn(student.timezone);
        for (const p of active.rows) {
          const prev = await lockActivePlan(db, p.id, student.id);
          const { plan, result } = await createPlanVersion(db, {
            tenantId: tenant.id,
            student,
            startDate: today,
            examScheduleIds: prev.exam_schedule_ids,
            weights: prev.inputs?.weights,
            trigger: "disruption",
            reason: `${body.reasonCategory.replace("_", " ")} from ${body.startDate} to ${body.endDate}`,
            actorId: userId,
            previous: { id: prev.id, lineageId: prev.lineage_id, version: prev.version },
          });
          recalculated.push({ planId: plan.id, version: plan.version, feasible: result.summary.feasible, gapMinutes: result.summary.gapMinutes });
        }
      }
      return { disruption, recalculated };
    });
    res.status(201).json(data);
  }),
);

academicRouter.post(
  "/study-plans/generate",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(
      z.object({ studentId: z.string().uuid().optional(), examScheduleIds: z.array(z.string().uuid()).optional(), startDate: date.optional(), weights: weightsSchema }),
      req.body ?? {},
    );
    const data = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db, body.studentId);
      if (student.access === "parent") throw forbidden("Plans are generated by the student or their teacher");
      const { plan, result } = await createPlanVersion(db, {
        tenantId: tenant.id,
        student,
        startDate: body.startDate ?? todayIn(student.timezone),
        examScheduleIds: body.examScheduleIds,
        weights: body.weights,
        trigger: "initial",
        reason: "Plan generated",
        actorId: userId,
      });
      return { plan, summary: result.summary, unscheduled: result.unscheduled, alternatives: result.alternatives, taskCount: result.tasks.length };
    });
    res.status(201).json(data);
  }),
);

academicRouter.post(
  "/study-plans/:id/recalculate",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(
      z.object({
        studentId: z.string().uuid().optional(),
        startDate: date.optional(),
        trigger: z.enum(["missed_tasks", "new_marks", "assessment", "manual"]).default("manual"),
        reason: z.string().max(500).optional(),
        weights: weightsSchema,
      }),
      req.body ?? {},
    );
    const data = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db, body.studentId);
      if (student.access === "parent") throw forbidden("Plans are recalculated by the student or their teacher");
      const prev = await lockActivePlan(db, req.params.id, student.id);
      const { plan, result } = await createPlanVersion(db, {
        tenantId: tenant.id,
        student,
        startDate: body.startDate ?? todayIn(student.timezone),
        examScheduleIds: prev.exam_schedule_ids,
        weights: body.weights ?? prev.inputs?.weights,
        trigger: body.trigger,
        reason: body.reason ?? "Recalculated on request",
        actorId: userId,
        previous: { id: prev.id, lineageId: prev.lineage_id, version: prev.version },
      });
      return { plan, previousPlanId: prev.id, summary: result.summary, unscheduled: result.unscheduled, alternatives: result.alternatives };
    });
    res.status(201).json(data);
  }),
);

academicRouter.get(
  "/study-plans",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const rows = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db, studentIdOf(req));
      return db.query(
        `SELECT id, lineage_id, version, status, start_date, end_date, summary->'feasible' AS feasible, created_at
           FROM study_plans WHERE student_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [student.id],
      );
    });
    res.json({ plans: rows.rows });
  }),
);

academicRouter.get(
  "/study-plans/:id",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db, studentIdOf(req));
      return getPlanWithTasks(db, req.params.id, student.id);
    });
    res.json(data);
  }),
);

academicRouter.patch(
  "/tasks/:id",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { status } = parse(z.object({ status: z.enum(["pending", "completed", "skipped"]) }), req.body);
    const row = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db, studentIdOf(req));
      if (student.access !== "self") throw forbidden("Only the student can update their tasks");
      const r = await db.query(
        `UPDATE study_plan_tasks t SET status = $2, completed_at = CASE WHEN $2 = 'completed' THEN now() END
           FROM study_plans p WHERE t.id = $1 AND t.plan_id = p.id AND p.status = 'active' AND t.student_id = $3
         RETURNING t.id, t.status, t.completed_at`,
        [req.params.id, status, student.id],
      );
      if (!r.rows[0]) throw notFound("Task in an active plan");
      return r.rows[0];
    });
    res.json({ task: row });
  }),
);

academicRouter.get(
  "/recommendations",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => recommendations(db, await resolveStudent(req, db, studentIdOf(req))));
    res.json(data);
  }),
);

/** Student home: today's tasks, next exam with coverage, and top recommendations in one call. */
academicRouter.get(
  "/dashboard",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db, studentIdOf(req));
      const today = (req.query.date as string) && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date as string) ? (req.query.date as string) : todayIn(student.timezone);
      const tasks = await db.query(
        `SELECT t.id, t.title, t.task_type, t.duration_minutes, t.status, t.topic_id, t.plan_id
           FROM study_plan_tasks t JOIN study_plans p ON p.id = t.plan_id
          WHERE t.student_id = $1 AND p.status = 'active' AND t.task_date = $2 ORDER BY t.sequence`,
        [student.id, today],
      );
      const overdue = await db.query(
        `SELECT count(*)::int AS n FROM study_plan_tasks t JOIN study_plans p ON p.id = t.plan_id
          WHERE t.student_id = $1 AND p.status = 'active' AND t.task_date < $2 AND t.status = 'pending'`,
        [student.id, today],
      );
      const nextExam = (
        await db.query(
          `SELECT e.id, e.title, e.exam_date, e.chapter_ids, s.name AS subject, e.subject_id
             FROM exam_schedules e JOIN subjects s ON s.id = e.subject_id
            WHERE (e.student_id = $1 OR e.student_id IS NULL) AND e.exam_date >= $2 ORDER BY e.exam_date LIMIT 1`,
          [student.id, today],
        )
      ).rows[0];
      let examInfo = null;
      if (nextExam) {
        const mastery = await loadMastery(db, student.id);
        const topics = (
          await db.query(
            `SELECT t.id FROM topics t JOIN chapters c ON c.id = t.chapter_id
              WHERE c.curriculum_version_id = $1 AND c.subject_id = $2 AND (cardinality($3::uuid[]) = 0 OR c.id = ANY($3::uuid[]))`,
            [student.curriculumVersionId, nextExam.subject_id, nextExam.chapter_ids],
          )
        ).rows;
        const ready = topics.filter((t) => (mastery.get(t.id)?.score ?? 0) >= 0.8).length;
        const daysLeft = Math.round((Date.parse(`${nextExam.exam_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
        examInfo = {
          ...nextExam,
          daysLeft,
          topicsTotal: topics.length,
          topicsReady: ready,
          readiness: topics.length ? Math.round((ready / topics.length) * 100) : 0,
          readinessExplanation: `${ready} of ${topics.length} topics in this exam have mastery of 80% or more based on your recorded results.`,
        };
      }
      const recs = await recommendations(db, student);
      const plan = (await db.query(`SELECT id, version, summary->'feasible' AS feasible, summary->'gapMinutes' AS gap_minutes FROM study_plans WHERE student_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`, [student.id])).rows[0] ?? null;
      return {
        student: { id: student.id, name: student.name },
        date: today,
        tomorrow: addDays(today, 1),
        todayTasks: tasks.rows,
        overdueTasks: overdue.rows[0].n,
        activePlan: plan,
        nextExam: examInfo,
        recommendations: recs.items.slice(0, 3),
      };
    });
    res.json(data);
  }),
);

