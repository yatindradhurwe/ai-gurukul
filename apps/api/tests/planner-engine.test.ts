import { describe, expect, it } from "vitest";
import { generatePlan, normalizeWeights, requiredMinutes, DEFAULT_SETTINGS, type PlannerInput, type PlannerTopic } from "../src/modules/academic-planner/engine.js";
import { addDays } from "../src/modules/academic-planner/dates.js";

const topic = (id: string, over: Partial<PlannerTopic> = {}): PlannerTopic => ({
  id,
  title: `Topic ${id}`,
  chapterTitle: "Chapter",
  subjectId: "sci",
  difficulty: 3,
  estimatedMinutes: 60,
  prerequisiteIds: [],
  mastery: null,
  masteryKind: "unknown",
  weightage: null,
  examDate: "2026-11-13",
  coverage: "not_started",
  ...over,
});

const base = (over: Partial<PlannerInput> = {}): PlannerInput => ({
  startDate: "2026-11-01",
  exams: [{ id: "e1", subjectId: "sci", title: "Science term exam", examDate: "2026-11-13" }],
  topics: ["a", "b", "c", "d", "e", "f"].map((id) => topic(id)),
  availability: { defaultMinutes: 90 },
  ...over,
});

describe("planner engine", () => {
  it("covers six chapters in 12 days at 90 minutes/day (blueprint example)", () => {
    const plan = generatePlan(base());
    expect(plan.summary.feasible).toBe(true);
    expect(plan.unscheduled).toHaveLength(0);
    expect(plan.summary.availableMinutes).toBe(12 * 90);
    // every topic gets learn + practice + revision
    for (const id of ["a", "b", "c", "d", "e", "f"]) {
      const types = new Set(plan.tasks.filter((t) => t.topicId === id).map((t) => t.type));
      expect(types).toEqual(new Set(["learn", "practice", "revision"]));
    }
    // a mock test the day before the exam
    expect(plan.tasks.some((t) => t.type === "mock_test" && t.date === "2026-11-12")).toBe(true);
  });

  it("never exceeds daily capacity and never schedules on/after the exam", () => {
    const plan = generatePlan(base({ availability: { defaultMinutes: 90, weekdayMinutes: { 0: 150 } } }));
    const perDay = new Map<string, number>();
    for (const t of plan.tasks) perDay.set(t.date, (perDay.get(t.date) ?? 0) + t.minutes);
    for (const [date, mins] of perDay) {
      const isSunday = new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
      expect(mins).toBeLessThanOrEqual(isSunday ? 150 : 90);
      expect(date < "2026-11-13").toBe(true);
    }
  });

  it("schedules prerequisites before dependents even when the dependent has higher priority", () => {
    const topics = [
      topic("basics", { mastery: 0.75, masteryKind: "measured", weightage: 0.05 }),
      topic("advanced", { prerequisiteIds: ["basics"], mastery: 0.1, masteryKind: "measured", weightage: 0.4 }),
      topic("other", { mastery: 0.5, masteryKind: "measured", weightage: 0.2 }),
    ];
    const plan = generatePlan(base({ topics }));
    const firstLearn = (id: string) => plan.tasks.find((t) => t.topicId === id && t.type === "learn")!.date;
    const lastLearn = (id: string) => plan.tasks.filter((t) => t.topicId === id && t.type === "learn").at(-1)!.date;
    expect(lastLearn("basics") <= firstLearn("advanced")).toBe(true);
    // priority inheritance pulls the prerequisite ahead of the unrelated topic
    expect(firstLearn("basics") <= firstLearn("other")).toBe(true);
    const basics = plan.scores.find((s) => s.topicId === "basics")!;
    expect(basics.effectivePriority).toBeGreaterThan(basics.priority);
  });

  it("reports the gap and offers alternatives instead of overloading", () => {
    const plan = generatePlan(base({ availability: { defaultMinutes: 30 } }));
    expect(plan.summary.feasible).toBe(false);
    expect(plan.summary.gapMinutes).toBeGreaterThan(0);
    expect(plan.unscheduled.every((u) => u.explanation.length > 0)).toBe(true);
    const inc = plan.alternatives.find((a) => a.kind === "increase_daily_time")!;
    expect(inc.dailyMinutes).toBeGreaterThan(30);
    // and the suggested daily time really does cover the syllabus
    const check = generatePlan(base({ availability: { defaultMinutes: inc.dailyMinutes! } }));
    expect(check.summary.feasible).toBe(true);
    expect(plan.alternatives.some((a) => a.kind === "reduced_depth")).toBe(true);
  });

  it("does not half-schedule a topic", () => {
    const plan = generatePlan(base({ availability: { defaultMinutes: 30 } }));
    for (const u of plan.unscheduled) {
      expect(plan.tasks.some((t) => t.topicId === u.topicId)).toBe(false);
    }
  });

  it("skips dependents of an unscheduled prerequisite and says why", () => {
    const topics = [topic("big", { estimatedMinutes: 2000 }), topic("child", { prerequisiteIds: ["big"] })];
    const plan = generatePlan(base({ topics }));
    expect(plan.unscheduled.map((u) => [u.topicId, u.reason])).toEqual([
      ["big", "insufficient_time"],
      ["child", "prerequisite_unscheduled"],
    ]);
  });

  it("treats a disruption as zero-capacity days and schedules nothing then", () => {
    const blocked: Record<string, number> = {};
    for (let i = 2; i <= 5; i++) blocked[addDays("2026-11-01", i)] = 0;
    const plan = generatePlan(base({ availability: { defaultMinutes: 120, dateOverrides: blocked } }));
    expect(plan.tasks.some((t) => blocked[t.date] === 0)).toBe(false);
  });

  it("uses a neutral weightage and flags priorities as estimated when weightage is unknown", () => {
    const plan = generatePlan(base());
    expect(plan.summary.priorityEstimated).toBe(true);
    expect(plan.scores[0].components.W).toBe(0.5);
    const verified = generatePlan(base({ topics: [topic("a", { weightage: 0.3 })] }));
    expect(verified.summary.priorityEstimated).toBe(false);
  });

  it("only revises already-mastered topics", () => {
    const r = requiredMinutes(topic("m", { mastery: 0.9, masteryKind: "measured" }), DEFAULT_SETTINGS);
    expect(r).toEqual({ learn: 0, practice: 0, revision: DEFAULT_SETTINGS.revisionMinutes });
  });

  it("credits learning completed in an earlier plan version", () => {
    const fresh = requiredMinutes(topic("x"), DEFAULT_SETTINGS);
    const partial = requiredMinutes(topic("x", { completedLearnMinutes: 20 }), DEFAULT_SETTINGS);
    expect(partial.learn).toBeLessThan(fresh.learn);
  });

  it("is deterministic", () => {
    expect(generatePlan(base())).toEqual(generatePlan(base()));
  });

  it("normalizes weights to sum to 1 and rejects negatives", () => {
    const w = normalizeWeights({ weightage: 1, gap: 1, prerequisite: 1, urgency: 1 });
    expect(w.weightage + w.gap + w.prerequisite + w.urgency).toBeCloseTo(1);
    expect(() => normalizeWeights({ gap: -1 })).toThrow();
  });

  it("handles multiple exams: earlier-exam topics finish before their own exam", () => {
    const topics = [
      topic("m1", { subjectId: "math", examDate: "2026-11-05" }),
      topic("s1", { subjectId: "sci", examDate: "2026-11-13" }),
    ];
    const plan = generatePlan(
      base({
        topics,
        exams: [
          { id: "m", subjectId: "math", title: "Maths", examDate: "2026-11-05" },
          { id: "s", subjectId: "sci", title: "Science", examDate: "2026-11-13" },
        ],
      }),
    );
    expect(plan.summary.feasible).toBe(true);
    expect(plan.tasks.filter((t) => t.topicId === "m1").every((t) => t.date < "2026-11-05")).toBe(true);
  });
});

describe("planner task layout", () => {
  it("never creates learning pieces shorter than the minimum session, and keeps each topic's sessions together", () => {
    const plan = generatePlan(base({ topics: ["a", "b", "c"].map((id) => topic(id, { estimatedMinutes: 50 })) }));
    for (const t of plan.tasks.filter((t) => t.type === "learn")) expect(t.minutes).toBeGreaterThanOrEqual(DEFAULT_SETTINGS.minPieceMinutes);
    const learnOrder = plan.tasks.filter((t) => t.type === "learn").map((t) => t.topicId);
    const firstSeen = learnOrder.filter((id, i) => learnOrder.indexOf(id) === i);
    // once a topic's learning ends, it does not reappear after another topic's learning
    const compressed = learnOrder.filter((id, i) => i === 0 || id !== learnOrder[i - 1]);
    expect(compressed).toEqual(firstSeen);
  });
});
