import { randomUUID } from "node:crypto";
import type { Db } from "../../database/pool.js";
import { badRequest, notFound } from "../../lib/errors.js";
import type { StudentRef } from "../../lib/student-access.js";
import { addDays } from "./dates.js";
import { generatePlan, type Coverage, type MasteryKind, type PlannerInput, type PlannerTopic, type PlannerWeights } from "./engine.js";

export interface MasteryInfo {
  score: number;
  kind: Exclude<MasteryKind, "unknown">;
  at: string;
}

/** Current mastery per topic: latest measured evidence wins; otherwise the latest estimate. */
export async function loadMastery(db: Db, studentId: string): Promise<Map<string, MasteryInfo>> {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (topic_id) topic_id, score, kind, created_at
       FROM topic_mastery_history WHERE student_id = $1
      ORDER BY topic_id, (kind = 'measured') DESC, created_at DESC`,
    [studentId],
  );
  return new Map(rows.map((r) => [r.topic_id, { score: Number(r.score), kind: r.kind, at: r.created_at }]));
}

export async function buildPlannerInput(
  db: Db,
  student: StudentRef,
  opts: { startDate: string; examScheduleIds?: string[] | null; weights?: Partial<PlannerWeights>; lineageId?: string },
): Promise<{ input: PlannerInput; examIds: string[]; notes: string[] }> {
  if (!student.curriculumVersionId) throw badRequest("The student has no curriculum assigned yet");
  const exams = (
    await db.query(
      `SELECT id, subject_id, title, exam_date, chapter_ids FROM exam_schedules
        WHERE (student_id = $1 OR student_id IS NULL) AND exam_date > $2 AND ($3::uuid[] IS NULL OR id = ANY($3))
        ORDER BY exam_date`,
      [student.id, opts.startDate, opts.examScheduleIds?.length ? opts.examScheduleIds : null],
    )
  ).rows;
  if (exams.length === 0) throw badRequest("No upcoming exams found. Add an exam date first.");

  const lastExam = exams.at(-1)!.exam_date as string;
  const topicRows = (
    await db.query(
      `SELECT t.id, t.title, t.difficulty, t.estimated_minutes, t.prerequisite_topic_ids, c.title AS chapter_title,
              c.subject_id, c.exam_weightage, c.id AS chapter_id, c.sequence AS chapter_seq, t.sequence AS topic_seq,
              (SELECT count(*) FROM topics t2 WHERE t2.chapter_id = c.id) AS topics_in_chapter
         FROM topics t JOIN chapters c ON c.id = t.chapter_id
        WHERE c.curriculum_version_id = $1 AND c.subject_id = ANY($2::uuid[])
        ORDER BY c.sequence, t.sequence`,
      [student.curriculumVersionId, [...new Set(exams.map((e) => e.subject_id))]],
    )
  ).rows;

  const mastery = await loadMastery(db, student.id);
  const coverage = new Map(
    (await db.query(`SELECT topic_id, status FROM syllabus_coverage WHERE student_id = $1`, [student.id])).rows.map((r) => [r.topic_id, r.status as Coverage]),
  );
  const completed = new Map<string, number>();
  if (opts.lineageId) {
    const r = await db.query(
      `SELECT t.topic_id, sum(t.duration_minutes)::int AS minutes FROM study_plan_tasks t JOIN study_plans p ON p.id = t.plan_id
        WHERE p.lineage_id = $1 AND t.status = 'completed' AND t.task_type = 'learn' AND t.topic_id IS NOT NULL GROUP BY t.topic_id`,
      [opts.lineageId],
    );
    for (const row of r.rows) completed.set(row.topic_id, row.minutes);
  }

  const topics: PlannerTopic[] = [];
  for (const t of topicRows) {
    // The earliest upcoming exam whose syllabus includes this topic sets its deadline.
    const exam = exams.find((e) => e.subject_id === t.subject_id && (e.chapter_ids.length === 0 || e.chapter_ids.includes(t.chapter_id)));
    if (!exam) continue;
    const m = mastery.get(t.id);
    topics.push({
      id: t.id,
      title: t.title,
      chapterTitle: t.chapter_title,
      subjectId: t.subject_id,
      difficulty: t.difficulty,
      estimatedMinutes: t.estimated_minutes,
      prerequisiteIds: t.prerequisite_topic_ids ?? [],
      mastery: m?.score ?? null,
      masteryKind: m?.kind ?? "unknown",
      // Chapter weightage is shared evenly across its topics.
      weightage: t.exam_weightage == null ? null : Number(t.exam_weightage) / Math.max(1, Number(t.topics_in_chapter)),
      examDate: exam.exam_date,
      coverage: coverage.get(t.id) ?? "not_started",
      completedLearnMinutes: completed.get(t.id) ?? 0,
    });
  }
  if (topics.length === 0) {
    throw badRequest("None of these exams' subjects have syllabus topics in the student's curriculum yet, so there is nothing to plan.");
  }
  // Rescale per-topic weightage to 0..1 so it is comparable with the other factors.
  const maxW = Math.max(0, ...topics.map((t) => t.weightage ?? 0));
  if (maxW > 0) for (const t of topics) if (t.weightage != null) t.weightage = Math.round((t.weightage / maxW) * 10000) / 10000;

  const dateOverrides: Record<string, number> = {};
  const disruptions = await db.query(
    `SELECT start_date, end_date, available_minutes_per_day FROM student_disruptions
      WHERE student_id = $1 AND end_date >= $2 AND start_date <= $3`,
    [student.id, opts.startDate, lastExam],
  );
  for (const d of disruptions.rows) {
    for (let day = d.start_date as string; day <= d.end_date; day = addDays(day, 1)) {
      dateOverrides[day] = Math.min(dateOverrides[day] ?? Number.MAX_SAFE_INTEGER, d.available_minutes_per_day);
    }
  }

  const notes: string[] = [];
  const holidays = await db.query(
    `SELECT count(*)::int AS n FROM school_calendars WHERE event_type = 'holiday' AND event_date >= $1 AND event_date < $2`,
    [opts.startDate, lastExam],
  );
  if (holidays.rows[0].n > 0) {
    notes.push(
      `${holidays.rows[0].n} school holiday(s) fall in this period. They are treated as normal study days — a holiday alone doesn't mean you are behind. Report a disruption if you'll be unavailable.`,
    );
  }
  if (disruptions.rowCount) notes.push(`${disruptions.rowCount} reported disruption(s) reduce available study time on the affected days.`);

  const weekdayMinutes: Record<number, number> = {};
  for (const [k, v] of Object.entries(student.weekdayMinutes ?? {})) weekdayMinutes[Number(k)] = Number(v);

  const plannable = exams.filter((e) => topics.some((t) => t.subjectId === e.subject_id));
  for (const e of exams) {
    if (!plannable.includes(e)) notes.push(`"${e.title}" has no syllabus topics in this curriculum yet, so it is not part of this plan.`);
  }

  return {
    input: {
      startDate: opts.startDate,
      topics,
      exams: plannable.map((e) => ({ id: e.id, subjectId: e.subject_id, title: e.title, examDate: e.exam_date })),
      availability: { defaultMinutes: student.dailyStudyMinutes, weekdayMinutes, dateOverrides },
      weights: opts.weights,
    },
    examIds: plannable.map((e) => e.id),
    notes,
  };
}

export async function createPlanVersion(
  db: Db,
  args: {
    tenantId: string;
    student: StudentRef;
    startDate: string;
    examScheduleIds?: string[] | null;
    weights?: Partial<PlannerWeights>;
    trigger: "initial" | "disruption" | "missed_tasks" | "new_marks" | "assessment" | "manual";
    reason: string;
    actorId: string;
    previous?: { id: string; lineageId: string; version: number } | null;
  },
) {
  const lineageId = args.previous?.lineageId ?? randomUUID();
  const { input, examIds, notes } = await buildPlannerInput(db, args.student, {
    startDate: args.startDate,
    examScheduleIds: args.examScheduleIds,
    weights: args.weights,
    lineageId: args.previous ? lineageId : undefined,
  });
  const result = generatePlan(input);
  result.summary.explanations.unshift(...notes);

  if (args.previous) {
    // Keep history: missed tasks are marked, the old version is superseded — never deleted.
    await db.query(`UPDATE study_plan_tasks SET status = 'missed' WHERE plan_id = $1 AND status = 'pending' AND task_date < $2`, [args.previous.id, args.startDate]);
    await db.query(`UPDATE study_plans SET status = 'superseded' WHERE id = $1`, [args.previous.id]);
  }
  const plan = (
    await db.query(
      `INSERT INTO study_plans (tenant_id, student_id, lineage_id, version, exam_schedule_ids, status, start_date, end_date, inputs, summary)
       VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9) RETURNING id, lineage_id, version, status, start_date, end_date, created_at`,
      [
        args.tenantId,
        args.student.id,
        lineageId,
        (args.previous?.version ?? 0) + 1,
        examIds,
        input.startDate,
        result.summary.endDate,
        JSON.stringify(input),
        JSON.stringify({ ...result.summary, unscheduled: result.unscheduled, alternatives: result.alternatives, scores: result.scores }),
      ],
    )
  ).rows[0];

  for (const [i, t] of result.tasks.entries()) {
    await db.query(
      `INSERT INTO study_plan_tasks (tenant_id, plan_id, student_id, topic_id, task_type, title, task_date, duration_minutes, priority_score, sequence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [args.tenantId, plan.id, args.student.id, t.topicId, t.type, t.title, t.date, t.minutes, t.priority, i],
    );
  }
  await db.query(
    `INSERT INTO plan_adjustments (tenant_id, plan_id, previous_plan_id, trigger, reason, actor_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [args.tenantId, plan.id, args.previous?.id ?? null, args.trigger, args.reason, args.actorId],
  );
  return { plan, result };
}

export async function lockActivePlan(db: Db, planId: string, studentId: string) {
  const row = (
    await db.query(
      `SELECT id, lineage_id, version, status, exam_schedule_ids, inputs FROM study_plans WHERE id = $1 AND student_id = $2 FOR UPDATE`,
      [planId, studentId],
    )
  ).rows[0];
  if (!row) throw notFound("Study plan");
  if (row.status !== "active") {
    // Resolve to the current active version of the same lineage.
    const active = (
      await db.query(`SELECT id, lineage_id, version, status, exam_schedule_ids, inputs FROM study_plans WHERE lineage_id = $1 AND status = 'active' FOR UPDATE`, [
        row.lineage_id,
      ])
    ).rows[0];
    if (!active) throw notFound("Active study plan");
    return active;
  }
  return row;
}

export async function getPlanWithTasks(db: Db, planId: string, studentId: string) {
  const plan = (await db.query(`SELECT * FROM study_plans WHERE id = $1 AND student_id = $2`, [planId, studentId])).rows[0];
  if (!plan) throw notFound("Study plan");
  const tasks = await db.query(
    `SELECT t.id, t.topic_id, t.task_type, t.title, t.task_date, t.duration_minutes, t.priority_score, t.status, t.completed_at,
            tp.title AS topic, c.title AS chapter
       FROM study_plan_tasks t LEFT JOIN topics tp ON tp.id = t.topic_id LEFT JOIN chapters c ON c.id = tp.chapter_id
      WHERE t.plan_id = $1 ORDER BY t.task_date, t.sequence`,
    [planId],
  );
  const versions = await db.query(
    `SELECT p.id, p.version, p.status, p.created_at, a.trigger, a.reason
       FROM study_plans p LEFT JOIN plan_adjustments a ON a.plan_id = p.id WHERE p.lineage_id = $1 ORDER BY p.version`,
    [plan.lineage_id],
  );
  const { inputs: _inputs, ...rest } = plan;
  return { plan: rest, tasks: tasks.rows, versions: versions.rows };
}

/** Topic-level recommendations derived from current mastery evidence. */
export async function recommendations(db: Db, student: StudentRef) {
  const mastery = await loadMastery(db, student.id);
  const topics = (
    await db.query(
      `SELECT t.id, t.title, c.title AS chapter, s.name AS subject, t.prerequisite_topic_ids,
              (SELECT l.id FROM lessons l WHERE l.topic_id = t.id AND l.status = 'published' ORDER BY l.created_at LIMIT 1) AS lesson_id
         FROM topics t JOIN chapters c ON c.id = t.chapter_id JOIN subjects s ON s.id = c.subject_id
        WHERE c.curriculum_version_id = $1 ORDER BY c.sequence, t.sequence`,
      [student.curriculumVersionId],
    )
  ).rows;
  const byId = new Map(topics.map((t) => [t.id, t]));
  const items = [];
  for (const t of topics) {
    const m = mastery.get(t.id);
    if (!m) continue; // recommend from evidence only
    if (m.score >= 0.8) continue;
    const weakPrereq = (t.prerequisite_topic_ids as string[])
      .map((p) => ({ p, m: mastery.get(p) }))
      .find((x) => x.m && x.m.score < 0.6);
    items.push({
      topicId: t.id,
      topic: t.title,
      chapter: t.chapter,
      subject: t.subject,
      mastery: m.score,
      masteryKind: m.kind,
      lessonId: t.lesson_id,
      action: weakPrereq ? "review_prerequisite" : m.score < 0.5 ? "relearn" : "practice",
      reason: weakPrereq
        ? `Strengthen "${byId.get(weakPrereq.p)?.title}" first — it is a prerequisite and your score there is ${Math.round(weakPrereq.m!.score * 100)}%.`
        : m.score < 0.5
          ? `Your ${m.kind} mastery is ${Math.round(m.score * 100)}%. Re-watch the lesson, then ask the AI teacher about the parts that felt unclear.`
          : `You're at ${Math.round(m.score * 100)}%. A short practice set should lift this above 80%.`,
    });
  }
  items.sort((a, b) => a.mastery - b.mastery);
  const untested = topics.filter((t) => !mastery.has(t.id)).length;
  return { items, untestedTopics: untested };
}
