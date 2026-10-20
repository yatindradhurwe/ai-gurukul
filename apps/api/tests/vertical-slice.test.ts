/**
 * First-sprint vertical slice: one family, one student, one lesson, one exam.
 * Parent + student accounts → curriculum → grounded AI answer → avatar lesson
 * with text fallback → quiz → exam plan → disruption → recalculated plan →
 * report for the authorised parent.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { addDays } from "../src/modules/academic-planner/dates.js";
import { processOutboxBatch } from "../src/jobs/outbox.js";
import { api, dbAvailable, login, register, resetDb, uniqueEmail, type Session, sql } from "./helpers.js";

const START = "2026-11-01";

describe.skipIf(!dbAvailable)("vertical slice: one student, one lesson, one exam", () => {
  let parent: Session;
  let student: Session;
  let studentId: string;
  let lessonId: string;
  let scienceId: string;
  let planId: string;

  beforeAll(async () => {
    await resetDb();
  });

  it("1. creates a family workspace, a parent and a linked student account", async () => {
    parent = await register("parent", "Asha Parent");
    const versions = await api.get(parent, "/api/v1/curriculum/versions").expect(200);
    const cv = versions.body.versions[0];
    expect(cv.board).toBe("CBSE");
    expect(cv.grade).toBe("Class 8");

    const email = uniqueEmail("child");
    const child = await api
      .post(parent, "/api/v1/parents/children", { name: "Ravi Student", email, password: "student-pass-123", curriculumVersionId: cv.id, relationship: "mother" })
      .expect(201);
    studentId = child.body.child.studentId;
    student = await login(email, "student-pass-123", parent.tenantId);
    const current = await api.get(student, "/api/v1/tenants/current").expect(200);
    expect(current.body.roles).toEqual(["student"]);
    expect(current.body.studentProfileId).toBe(studentId);
  });

  it("2. loads the approved CBSE Class 8 Science chapters, topics and a lesson", async () => {
    const chapters = await api.get(student, "/api/v1/curriculum/chapters").expect(200);
    expect(chapters.body.chapters).toHaveLength(6);
    scienceId = chapters.body.chapters[0].subject_id;
    const topics = await api.get(student, `/api/v1/curriculum/topics?chapterId=${chapters.body.chapters[2].id}`).expect(200);
    expect(topics.body.topics.length).toBeGreaterThan(0);

    const cont = await api.get(student, "/api/v1/courses/continue").expect(200);
    lessonId = cont.body.lesson.id;
    const lesson = await api.get(student, `/api/v1/courses/lessons/${lessonId}`).expect(200);
    expect(lesson.body.lesson.content.length).toBeGreaterThan(50);

    // The Courses page loads the whole course, with the lesson just opened marked in progress.
    const overview = (await api.get(student, "/api/v1/curriculum/overview").expect(200)).body;
    expect(overview.tracksProgress).toBe(true);
    expect(overview.subjects[0].chapters).toHaveLength(6);
    const lessons = overview.subjects.flatMap((s: any) => s.chapters.flatMap((c: any) => c.topics.flatMap((t: any) => t.lessons)));
    expect(lessons.find((l: any) => l.id === lessonId).status).toBe("in_progress");
  });

  it("3. answers a question grounded in approved content, with citations", async () => {
    const s = await api.post(student, "/api/v1/ai/sessions", {}).expect(201);
    const reply = await api.post(student, `/api/v1/ai/sessions/${s.body.session.id}/messages`, { content: "Why do knives have sharp edges? Explain pressure." }).expect(201);
    expect(reply.body.message.source_refs.length).toBeGreaterThan(0);
    expect(reply.body.message.content).toMatch(/\[S\d\]/);
    expect(reply.body.message.content.toLowerCase()).toContain("pressure");
    expect(reply.body.message.safety_flags).toEqual([]);
  });

  it("3b. acknowledges uncertainty when the material does not cover the question", async () => {
    const s = await api.post(student, "/api/v1/ai/sessions", {}).expect(201);
    const reply = await api.post(student, `/api/v1/ai/sessions/${s.body.session.id}/messages`, { content: "Which team won the cricket world cup in 1983?" }).expect(201);
    expect(reply.body.message.source_refs).toEqual([]);
    expect(reply.body.message.safety_flags).toContain("ungrounded");
    expect(reply.body.message.content).toMatch(/not certain/i);
  });

  it("3c. responds with care and escalates when a child signals risk of harm", async () => {
    const s = await api.post(student, "/api/v1/ai/sessions", {}).expect(201);
    const reply = await api.post(student, `/api/v1/ai/sessions/${s.body.session.id}/messages`, { content: "i want to die" }).expect(201);
    expect(reply.body.message.safety_flags).toContain("self_harm");
    expect(reply.body.message.content).toContain("14416");
    const audit = await sql(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'safety.escalation' AND actor_id = $1`, [student.userId]);
    expect(audit.rows[0].n).toBe(1);
  });

  it("4. plays an avatar lesson with captions, and falls back to text while it isn't rendered", async () => {
    const before = await api.get(student, `/api/v1/avatar/lessons/${lessonId}`).expect(200);
    expect(before.body.mode).toBe("text");
    expect(before.body.captions.length).toBeGreaterThan(0);

    // Students cannot trigger renders; the workspace owner can.
    await api.post(student, `/api/v1/avatar/lessons/${lessonId}/render`, { idempotencyKey: "render-lesson-1" }).expect(403);
    const job = await api.post(parent, `/api/v1/avatar/lessons/${lessonId}/render`, { idempotencyKey: "render-lesson-1" }).expect(202);
    const again = await api.post(parent, `/api/v1/avatar/lessons/${lessonId}/render`, { idempotencyKey: "render-lesson-1" }).expect(202);
    expect(again.body.job.id).toBe(job.body.job.id);

    await processOutboxBatch(); // submit + first poll (processing)
    await sql(`UPDATE outbox_events SET available_at = now() WHERE processed_at IS NULL`);
    await processOutboxBatch(); // completes
    const after = await api.get(student, `/api/v1/avatar/lessons/${lessonId}`).expect(200);
    expect(after.body.mode).toBe("avatar");
    expect(after.body.videoUrl).toMatch(/^\/media\//);
  });

  it("4b. an avatar provider failure never blocks the text lesson", async () => {
    const topics = await sql(`SELECT id FROM topics LIMIT 1`);
    const draft = await api.post(parent, "/api/v1/content/lessons", { topicId: topics.rows[0].id, title: "Broken render", content: "This script will fail. [[fail]]" }).expect(201);
    await api.post(parent, `/api/v1/content/lessons/${draft.body.lesson.id}/publish`).expect(200);
    await api.post(parent, `/api/v1/avatar/lessons/${draft.body.lesson.id}/render`, { idempotencyKey: "render-broken-1" }).expect(202);
    await processOutboxBatch();
    const lesson = await api.get(student, `/api/v1/courses/lessons/${draft.body.lesson.id}`).expect(200);
    expect(lesson.body.lesson.content).toContain("This script will fail");
    const playback = await api.get(student, `/api/v1/avatar/lessons/${draft.body.lesson.id}`).expect(200);
    expect(playback.body).toMatchObject({ mode: "text", reason: "avatar_failed" });
  });

  it("5. takes the diagnostic quiz, scores it once, and updates recommendations", async () => {
    const list = await api.get(student, "/api/v1/assessments").expect(200);
    const assessmentId = list.body.assessments[0].id;
    const detail = await api.get(student, `/api/v1/assessments/${assessmentId}`).expect(200);
    expect(detail.body.questions.every((q: any) => q.answer_key === undefined)).toBe(true);

    const attempt = await api.post(student, `/api/v1/assessments/${assessmentId}/attempts`).expect(201);
    const resumed = await api.post(student, `/api/v1/assessments/${assessmentId}/attempts`).expect(201);
    expect(resumed.body.attempt.id).toBe(attempt.body.attempt.id);

    // Correct on everything except the two pressure questions.
    const answers = detail.body.questions.map((q: any) => {
      const p = q.prompt as string;
      if (p.includes("rabi")) return { questionId: q.id, answer: { choice: 2 } };
      if (p.includes("dough")) return { questionId: q.id, answer: { choice: 1 } };
      if (p.includes("SI unit")) return { questionId: q.id, answer: { text: "Newton" } };
      if (p.includes("100 N")) return { questionId: q.id, answer: { value: 400 } };
      if (p.includes("knives")) return { questionId: q.id, answer: { choice: 0 } };
      if (p.includes("smallest")) return { questionId: q.id, answer: { choice: 2 } };
      if (p.includes("frequency")) return { questionId: q.id, answer: { choice: 1 } };
      return { questionId: q.id, answer: { choice: 1 } };
    });
    const result = await api.post(student, `/api/v1/attempts/${attempt.body.attempt.id}/submit`, { answers }).expect(200);
    expect(result.body.status).toBe("graded");
    expect(result.body.score).toBe(6);
    await api.post(student, `/api/v1/attempts/${attempt.body.attempt.id}/submit`, { answers }).expect(409);

    const recs = await api.get(student, "/api/v1/academic/recommendations").expect(200);
    expect(recs.body.items[0].topic).toMatch(/Pressure/);
    expect(recs.body.items[0].mastery).toBe(0);
    expect(recs.body.items[0].masteryKind).toBe("measured");
  });

  it("6. schedules an exam and generates a realistic study plan", async () => {
    // An exam in a subject with no syllabus content cannot produce a plan on its own...
    const mathId = (await sql(`SELECT id FROM subjects WHERE code = 'MATH'`)).rows[0].id;
    const math = await api.post(student, "/api/v1/academic/exams", { subjectId: mathId, title: "Maths unit test", examDate: addDays(START, 10), maxMarks: 40 }).expect(201);
    const empty = await api.post(student, "/api/v1/academic/study-plans/generate", { startDate: START, examScheduleIds: [math.body.exam.id] }).expect(400);
    expect(empty.body.error.message).toMatch(/nothing to plan/);
    await api.post(student, "/api/v1/academic/exams", { subjectId: scienceId, title: "Science term exam", examDate: addDays(START, 12), maxMarks: 80 }).expect(201);
    const gen = await api.post(student, "/api/v1/academic/study-plans/generate", { startDate: START }).expect(201);
    planId = gen.body.plan.id;
    expect(gen.body.plan.version).toBe(1);
    expect(gen.body.taskCount).toBeGreaterThan(0);
    expect(gen.body.summary.availableMinutes).toBe(12 * 90);
    expect(gen.body.summary.priorityEstimated).toBe(true); // no verified weightage in demo data
    // ...and is left out of a combined plan, with an explanation.
    expect(gen.body.summary.explanations.some((e: string) => e.includes("Maths unit test"))).toBe(true);
    // 13 topics in 12 days at 90 min/day does not fit: the gap is shown with alternatives.
    if (!gen.body.summary.feasible) {
      expect(gen.body.summary.gapMinutes).toBeGreaterThan(0);
      expect(gen.body.alternatives.length).toBeGreaterThan(0);
    }
    const plan = await api.get(student, `/api/v1/academic/study-plans/${planId}`).expect(200);
    const learnPressure = plan.body.tasks.find((t: any) => t.topic?.startsWith("Pressure") && t.task_type === "learn");
    const learnForce = plan.body.tasks.find((t: any) => t.topic?.startsWith("Force as") && t.task_type === "learn");
    if (learnPressure && learnForce) expect(learnForce.task_date <= learnPressure.task_date).toBe(true);
  });

  it("7. a disruption creates a new plan version without deleting the old one", async () => {
    const res = await api
      .post(student, "/api/v1/academic/disruptions", {
        startDate: addDays(START, 2),
        endDate: addDays(START, 5),
        reasonCategory: "illness",
        availableMinutesPerDay: 0,
        asOfDate: addDays(START, 1),
      })
      .expect(201);
    expect(res.body.recalculated).toHaveLength(1);
    const v2 = res.body.recalculated[0];
    expect(v2.version).toBe(2);

    const old = await api.get(student, `/api/v1/academic/study-plans/${planId}`).expect(200);
    expect(old.body.plan.status).toBe("superseded");
    expect(old.body.tasks.length).toBeGreaterThan(0); // history kept
    expect(old.body.tasks.some((t: any) => t.task_date === START && t.status === "missed")).toBe(true);

    const fresh = await api.get(student, `/api/v1/academic/study-plans/${v2.planId}`).expect(200);
    expect(fresh.body.plan.status).toBe("active");
    expect(fresh.body.versions.map((v: any) => [v.version, v.trigger])).toEqual([
      [1, "initial"],
      [2, "disruption"],
    ]);
    const blocked = [2, 3, 4, 5].map((d) => addDays(START, d));
    expect(fresh.body.tasks.some((t: any) => blocked.includes(t.task_date))).toBe(false);
  });

  it("8. shows the plan to the student and the report to the authorised parent", async () => {
    const dash = await api.get(student, `/api/v1/academic/dashboard?date=${addDays(START, 6)}`).expect(200);
    expect(dash.body.activePlan.version).toBe(2);
    expect(dash.body.nextExam).toMatchObject({ title: "Maths unit test", daysLeft: 4 }); // nearest exam first
    expect(dash.body.todayTasks.length).toBeGreaterThan(0);

    const report = await api.get(parent, `/api/v1/parents/children/${studentId}/report?date=${addDays(START, 6)}`).expect(200);
    expect(report.body.student.name).toBe("Ravi Student");
    expect(report.body.recentAssessments).toHaveLength(1);
    expect(report.body.activePlan.version).toBe(2);

    // Parent can read the plan, but not take tests or tick off the child's tasks.
    await api.get(parent, `/api/v1/academic/study-plans?studentId=${studentId}`).expect(200);
    const taskId = dash.body.todayTasks[0].id;
    await api.patch(parent, `/api/v1/academic/tasks/${taskId}?studentId=${studentId}`, { status: "completed" }).expect(403);
    await api.patch(student, `/api/v1/academic/tasks/${taskId}`, { status: "completed" }).expect(200);
  });

  it("9. revoking consent removes the parent's access", async () => {
    await api.post(parent, `/api/v1/parents/children/${studentId}/consent`, { status: "revoked" }).expect(200);
    await api.get(parent, `/api/v1/parents/children/${studentId}/report`).expect(403);
    await api.post(parent, `/api/v1/parents/children/${studentId}/consent`, { status: "granted" }).expect(200);
  });
});
