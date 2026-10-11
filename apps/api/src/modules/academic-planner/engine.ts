/**
 * Academic planning engine.
 *
 * Pure and deterministic: given the same input it always produces the same
 * plan, so plans are reproducible and explainable. No LLM is involved — the
 * syllabus, marks and mastery come from recorded data, and every priority is
 * the transparent weighted score
 *
 *     P_t = w1·W_t + w2·G_t + w3·R_t + w4·D_t
 *
 * W = verified exam weightage (neutral 0.5 fallback, flagged as estimated)
 * G = learning gap (1 − mastery)
 * R = prerequisite importance (how many planned topics depend on it)
 * D = urgency (how soon the topic's exam is, relative to the plan horizon)
 */
import { addDays, dateRange, diffDays, weekday } from "./dates.js";

export type MasteryKind = "measured" | "estimated" | "unknown";
export type Coverage = "not_started" | "taught" | "missed" | "self_studied";

export interface PlannerTopic {
  id: string;
  title: string;
  chapterTitle: string;
  subjectId: string;
  difficulty: number; // 1..5
  estimatedMinutes: number; // nominal time to learn from scratch
  prerequisiteIds: string[];
  mastery: number | null; // 0..1
  masteryKind: MasteryKind;
  weightage: number | null; // verified exam weightage 0..1, null = unknown
  examDate: string; // YYYY-MM-DD; topic must be finished before this day
  coverage: Coverage;
  completedLearnMinutes?: number; // progress carried over from earlier plan versions
}

export interface PlannerExam {
  id: string;
  subjectId: string;
  title: string;
  examDate: string;
}

export interface Availability {
  defaultMinutes: number;
  weekdayMinutes?: Partial<Record<number, number>>; // 0 = Sunday
  dateOverrides?: Record<string, number>; // disruptions, extra-time days
}

export interface PlannerWeights {
  weightage: number;
  gap: number;
  prerequisite: number;
  urgency: number;
}

export interface PlannerSettings {
  sessionMinutes: number;
  minPieceMinutes: number;
  maxDailyMinutes: number;
  masteryThreshold: number;
  unknownMastery: number;
  practiceMinutes: number;
  revisionMinutes: number;
  revisionGapDays: number;
  mockTestMinutes: number;
}

export interface PlannerInput {
  startDate: string;
  topics: PlannerTopic[];
  exams: PlannerExam[];
  availability: Availability;
  weights?: Partial<PlannerWeights>;
  settings?: Partial<PlannerSettings>;
}

export type TaskType = "learn" | "practice" | "revision" | "mock_test";

export interface PlannedTask {
  date: string;
  type: TaskType;
  topicId: string | null;
  subjectId: string;
  title: string;
  minutes: number;
  priority: number | null;
}

export interface TopicScore {
  topicId: string;
  title: string;
  priority: number;
  effectivePriority: number;
  components: { W: number; G: number; R: number; D: number };
  weightageEstimated: boolean;
  masteryKind: MasteryKind;
  requiredMinutes: { learn: number; practice: number; revision: number };
}

export interface UnscheduledTopic {
  topicId: string;
  title: string;
  requiredMinutes: number;
  reason: "insufficient_time" | "prerequisite_unscheduled" | "exam_passed";
  explanation: string;
}

export interface PlanAlternative {
  kind: "increase_daily_time" | "reduced_depth";
  description: string;
  dailyMinutes?: number;
  topicsCovered: number;
  topicsTotal: number;
}

export interface PlanResult {
  tasks: PlannedTask[];
  unscheduled: UnscheduledTopic[];
  scores: TopicScore[];
  summary: {
    feasible: boolean;
    startDate: string;
    endDate: string;
    studyDays: number;
    availableMinutes: number;
    requiredMinutes: number;
    scheduledMinutes: number;
    gapMinutes: number;
    priorityEstimated: boolean;
    explanations: string[];
  };
  alternatives: PlanAlternative[];
}

export const DEFAULT_WEIGHTS: PlannerWeights = { weightage: 0.3, gap: 0.35, prerequisite: 0.15, urgency: 0.2 };

export const DEFAULT_SETTINGS: PlannerSettings = {
  sessionMinutes: 30,
  minPieceMinutes: 10,
  maxDailyMinutes: 360,
  masteryThreshold: 0.8,
  unknownMastery: 0.3,
  practiceMinutes: 20,
  revisionMinutes: 15,
  revisionGapDays: 2,
  mockTestMinutes: 60,
};

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const roundUp5 = (n: number) => Math.ceil(n / 5) * 5;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function normalizeWeights(w?: Partial<PlannerWeights>): PlannerWeights {
  const merged = { ...DEFAULT_WEIGHTS, ...w };
  const values = Object.values(merged);
  if (values.some((v) => v < 0 || !Number.isFinite(v))) throw new Error("Planner weights must be non-negative numbers");
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new Error("Planner weights must not all be zero");
  return {
    weightage: merged.weightage / sum,
    gap: merged.gap / sum,
    prerequisite: merged.prerequisite / sum,
    urgency: merged.urgency / sum,
  };
}

/** Minutes of each kind a topic still needs, from difficulty, mastery and class coverage. */
export function requiredMinutes(topic: PlannerTopic, s: PlannerSettings) {
  const mastery = topic.mastery ?? s.unknownMastery;
  if (mastery >= s.masteryThreshold) return { learn: 0, practice: 0, revision: s.revisionMinutes };
  const difficultyFactor = 0.8 + 0.1 * (clamp(topic.difficulty, 1, 5) - 1); // 0.8 .. 1.2
  const coverageFactor = topic.coverage === "taught" || topic.coverage === "self_studied" ? 0.75 : 1;
  const raw = topic.estimatedMinutes * difficultyFactor * (1 - mastery) * coverageFactor;
  const remaining = Math.max(0, raw - (topic.completedLearnMinutes ?? 0));
  const learn = remaining <= 0 ? 0 : Math.max(s.minPieceMinutes * 1.5, roundUp5(remaining));
  return { learn, practice: s.practiceMinutes, revision: s.revisionMinutes };
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

export function scoreTopics(input: PlannerInput, weights: PlannerWeights, s: PlannerSettings): TopicScore[] {
  const ids = new Set(input.topics.map((t) => t.id));
  // Transitive dependents within the planned set.
  const dependents = new Map<string, Set<string>>();
  for (const t of input.topics) dependents.set(t.id, new Set());
  const directDeps = new Map<string, string[]>(); // prereq -> direct dependents
  for (const t of input.topics) {
    for (const p of t.prerequisiteIds) {
      if (!ids.has(p)) continue;
      directDeps.set(p, [...(directDeps.get(p) ?? []), t.id]);
    }
  }
  for (const t of input.topics) {
    const seen = dependents.get(t.id)!;
    const stack = [...(directDeps.get(t.id) ?? [])];
    while (stack.length) {
      const d = stack.pop()!;
      if (seen.has(d) || d === t.id) continue;
      seen.add(d);
      stack.push(...(directDeps.get(d) ?? []));
    }
  }
  const maxDependents = Math.max(0, ...[...dependents.values()].map((d) => d.size));
  const horizon = Math.max(1, ...input.topics.map((t) => diffDays(input.startDate, t.examDate)));

  const scores = input.topics.map((t): TopicScore => {
    const W = t.weightage ?? 0.5;
    const G = 1 - clamp01(t.mastery ?? s.unknownMastery);
    const R = maxDependents === 0 ? 0 : dependents.get(t.id)!.size / maxDependents;
    const daysLeft = Math.max(0, diffDays(input.startDate, t.examDate));
    const D = clamp01(1 - daysLeft / (horizon + 1));
    const priority = weights.weightage * W + weights.gap * G + weights.prerequisite * R + weights.urgency * D;
    return {
      topicId: t.id,
      title: t.title,
      priority: round4(priority),
      effectivePriority: round4(priority),
      components: { W: round4(W), G: round4(G), R: round4(R), D: round4(D) },
      weightageEstimated: t.weightage == null,
      masteryKind: t.masteryKind,
      requiredMinutes: requiredMinutes(t, s),
    };
  });

  // Priority inheritance: a prerequisite is at least as urgent as anything that depends on it,
  // so a high-priority topic pulls its foundations forward instead of skipping them.
  const byId = new Map(scores.map((x) => [x.topicId, x]));
  for (const x of scores) {
    for (const d of dependents.get(x.topicId)!) {
      x.effectivePriority = Math.max(x.effectivePriority, byId.get(d)!.priority);
    }
  }
  return scores;
}

/** Topological order (prerequisites first); among ready topics, highest effective priority first. */
export function orderTopics(topics: PlannerTopic[], scores: TopicScore[]): { order: string[]; cycleBroken: boolean } {
  const ids = new Set(topics.map((t) => t.id));
  const score = new Map(scores.map((s) => [s.topicId, s.effectivePriority]));
  const examOf = new Map(topics.map((t) => [t.id, t.examDate]));
  const indegree = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const t of topics) {
    const prereqs = t.prerequisiteIds.filter((p) => ids.has(p) && p !== t.id);
    indegree.set(t.id, prereqs.length);
    for (const p of prereqs) out.set(p, [...(out.get(p) ?? []), t.id]);
  }
  const better = (a: string, b: string) => {
    const ea = examOf.get(a)!;
    const eb = examOf.get(b)!;
    if (ea !== eb) return ea < eb ? -1 : 1; // earlier exam first
    const d = score.get(b)! - score.get(a)!;
    return d !== 0 ? d : a < b ? -1 : 1;
  };
  const ready = topics.filter((t) => indegree.get(t.id) === 0).map((t) => t.id);
  const order: string[] = [];
  let cycleBroken = false;
  const remaining = new Set(ids);
  while (remaining.size) {
    if (ready.length === 0) {
      // Prerequisite cycle in source data: break it at the highest-priority remaining topic.
      cycleBroken = true;
      ready.push([...remaining].sort(better)[0]);
    }
    ready.sort(better);
    const next = ready.shift()!;
    if (!remaining.has(next)) continue;
    remaining.delete(next);
    order.push(next);
    for (const d of out.get(next) ?? []) {
      indegree.set(d, indegree.get(d)! - 1);
      if (indegree.get(d) === 0 && remaining.has(d)) ready.push(d);
    }
  }
  return { order, cycleBroken };
}

export function dailyCapacity(date: string, a: Availability, s: PlannerSettings): number {
  const override = a.dateOverrides?.[date];
  const base = override ?? a.weekdayMinutes?.[weekday(date)] ?? a.defaultMinutes;
  return Math.max(0, Math.min(s.maxDailyMinutes, Math.floor(base)));
}

export function generatePlan(input: PlannerInput, opts: { computeAlternatives?: boolean } = {}): PlanResult {
  const s: PlannerSettings = { ...DEFAULT_SETTINGS, ...input.settings };
  const weights = normalizeWeights(input.weights);
  const explanations: string[] = [];

  const lastExam = [...input.exams.map((e) => e.examDate), ...input.topics.map((t) => t.examDate)].sort().at(-1) ?? input.startDate;
  // Study on days strictly before the final exam.
  const days = diffDays(input.startDate, lastExam) > 0 ? dateRange(input.startDate, addDays(lastExam, -1)) : [];
  const capacity = new Map(days.map((d) => [d, dailyCapacity(d, input.availability, s)]));
  const availableMinutes = [...capacity.values()].reduce((a, b) => a + b, 0);
  const tasks: PlannedTask[] = [];

  const place = (date: string, minutes: number) => {
    capacity.set(date, (capacity.get(date) ?? 0) - minutes);
  };

  // 1. Reserve a mock test / final revision slot the day before each exam.
  let mockMinutes = 0;
  for (const exam of [...input.exams].sort((a, b) => (a.examDate < b.examDate ? -1 : 1))) {
    const eve = addDays(exam.examDate, -1);
    const free = capacity.get(eve) ?? 0;
    const minutes = Math.min(s.mockTestMinutes, free);
    mockMinutes += s.mockTestMinutes;
    if (minutes >= s.minPieceMinutes * 2) {
      place(eve, minutes);
      tasks.push({ date: eve, type: "mock_test", topicId: null, subjectId: exam.subjectId, title: `Mock test & final revision: ${exam.title}`, minutes, priority: null });
    } else if (diffDays(input.startDate, exam.examDate) > 0) {
      explanations.push(`No time is available on ${eve} for a mock test before "${exam.title}".`);
    }
  }

  // 2. Score and order topics.
  const scores = scoreTopics(input, weights, s);
  const scoreById = new Map(scores.map((x) => [x.topicId, x]));
  const topicById = new Map(input.topics.map((t) => [t.id, t]));
  const { order, cycleBroken } = orderTopics(input.topics, scores);
  if (cycleBroken) explanations.push("The syllabus data contains a prerequisite cycle; it was broken at the highest-priority topic. Please review the curriculum.");

  const unscheduled: UnscheduledTopic[] = [];
  const learnDoneOn = new Map<string, string>(); // topic -> last learning day
  const unscheduledIds = new Set<string>();

  for (const id of order) {
    const topic = topicById.get(id)!;
    const sc = scoreById.get(id)!;
    const need = sc.requiredMinutes;
    const total = need.learn + need.practice + need.revision;
    const deadlineDays = days.filter((d) => d < topic.examDate);

    if (deadlineDays.length === 0) {
      unscheduled.push({ topicId: id, title: topic.title, requiredMinutes: total, reason: "exam_passed", explanation: `The exam for "${topic.title}" is on or before the plan start date.` });
      unscheduledIds.add(id);
      continue;
    }
    const blockedBy = topic.prerequisiteIds.find((p) => unscheduledIds.has(p));
    if (blockedBy) {
      const pre = topicById.get(blockedBy)!;
      unscheduled.push({
        topicId: id,
        title: topic.title,
        requiredMinutes: total,
        reason: "prerequisite_unscheduled",
        explanation: `"${topic.title}" depends on "${pre.title}", which could not be scheduled, so it was not scheduled either.`,
      });
      unscheduledIds.add(id);
      continue;
    }

    // Earliest day: after every planned prerequisite has finished its learning.
    const earliest = topic.prerequisiteIds.map((p) => learnDoneOn.get(p)).filter((d): d is string => !!d).sort().at(-1) ?? days[0];
    const pending: PlannedTask[] = [];
    const snapshot = new Map(capacity);

    // 2a. Learning, split into sessions; pieces may spill into the next day.
    let learnLeft = need.learn;
    let lastLearnDay: string | null = null;
    for (const d of deadlineDays) {
      if (learnLeft <= 0) break;
      if (d < earliest) continue;
      let free = capacity.get(d) ?? 0;
      while (learnLeft > 0 && free >= Math.min(s.minPieceMinutes, learnLeft)) {
        const piece = Math.min(s.sessionMinutes, learnLeft, free);
        const prev = pending.at(-1);
        if (piece < s.minPieceMinutes && prev && prev.date === d && prev.type === "learn") {
          // Fold a short remainder into the session just before it instead of a 5-minute task.
          prev.minutes += piece;
          place(d, piece);
          free -= piece;
          learnLeft -= piece;
          continue;
        }
        pending.push({ date: d, type: "learn", topicId: id, subjectId: topic.subjectId, title: `Learn: ${topic.title}`, minutes: piece, priority: sc.priority });
        place(d, piece);
        free -= piece;
        learnLeft -= piece;
        lastLearnDay = d;
      }
    }

    // 2b. Practice right after learning; 2c. spaced revision a couple of days later.
    const afterLearn = lastLearnDay ?? earliest;
    const placeSingle = (type: TaskType, minutes: number, from: string, title: string) => {
      if (minutes <= 0) return true;
      const d = deadlineDays.find((day) => day >= from && (capacity.get(day) ?? 0) >= minutes);
      if (!d) return false;
      pending.push({ date: d, type, topicId: id, subjectId: topic.subjectId, title, minutes, priority: sc.priority });
      place(d, minutes);
      return true;
    };
    const practiceOk = learnLeft <= 0 && placeSingle("practice", need.practice, afterLearn, `Practice questions: ${topic.title}`);
    let revisionOk = false;
    if (practiceOk) {
      revisionOk =
        placeSingle("revision", need.revision, addDays(afterLearn, need.learn > 0 ? s.revisionGapDays : 0), `Revise: ${topic.title}`) ||
        placeSingle("revision", need.revision, afterLearn, `Revise: ${topic.title}`);
    }

    if (learnLeft > 0 || !practiceOk || !revisionOk) {
      // Roll back: never half-schedule a topic and present it as covered.
      for (const [k, v] of snapshot) capacity.set(k, v);
      unscheduled.push({
        topicId: id,
        title: topic.title,
        requiredMinutes: total,
        reason: "insufficient_time",
        explanation: `"${topic.title}" needs about ${total} minutes before ${topic.examDate}, but not enough study time is left after higher-priority topics.`,
      });
      unscheduledIds.add(id);
      continue;
    }
    tasks.push(...pending);
    learnDoneOn.set(id, lastLearnDay ?? earliest);
  }

  // Stable sort: within a day, revision first, then the order topics were scheduled in.
  tasks.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : taskRank(a.type) - taskRank(b.type)));

  const requiredMinutesTotal = scores.reduce((a, x) => a + x.requiredMinutes.learn + x.requiredMinutes.practice + x.requiredMinutes.revision, 0) + mockMinutes;
  const scheduledMinutes = tasks.reduce((a, t) => a + t.minutes, 0);
  const gapMinutes = unscheduled.reduce((a, u) => a + u.requiredMinutes, 0);
  const priorityEstimated = scores.some((x) => x.weightageEstimated);

  if (priorityEstimated) {
    explanations.push("Verified exam weightage is not available for some topics, so their priority uses a neutral estimate.");
  }
  const unknownMastery = scores.filter((x) => x.masteryKind === "unknown").length;
  if (unknownMastery > 0) {
    explanations.push(`${unknownMastery} topic(s) have no assessment evidence yet; a diagnostic test will make the plan more accurate.`);
  }
  if (unscheduled.length === 0) {
    explanations.push(`All ${input.topics.length} topic(s) fit into ${scheduledMinutes} of ${availableMinutes} available minutes.`);
  } else {
    explanations.push(`${unscheduled.length} topic(s) (about ${gapMinutes} minutes) do not fit into the available study time. See the alternatives below.`);
  }

  const result: PlanResult = {
    tasks,
    unscheduled,
    scores,
    summary: {
      feasible: unscheduled.length === 0,
      startDate: input.startDate,
      endDate: days.at(-1) ?? input.startDate,
      studyDays: days.filter((d) => dailyCapacity(d, input.availability, s) > 0).length,
      availableMinutes,
      requiredMinutes: requiredMinutesTotal,
      scheduledMinutes,
      gapMinutes,
      priorityEstimated,
      explanations,
    },
    alternatives: [],
  };

  if (opts.computeAlternatives !== false && unscheduled.length > 0) {
    result.alternatives = computeAlternatives(input, s);
  }
  return result;
}

function taskRank(t: TaskType) {
  return { revision: 0, learn: 1, practice: 1, mock_test: 2 }[t];
}

/** Offer realistic options instead of silently overloading the student. */
function computeAlternatives(input: PlannerInput, s: PlannerSettings): PlanAlternative[] {
  const total = input.topics.length;
  const alternatives: PlanAlternative[] = [];

  // A: smallest uniform daily time (in 15-minute steps) that covers everything.
  const covers = (minutes: number) => {
    const r = generatePlan(
      {
        ...input,
        availability: { defaultMinutes: minutes, weekdayMinutes: {}, dateOverrides: zeroOverrides(input.availability) },
        settings: { ...s, maxDailyMinutes: Math.max(s.maxDailyMinutes, minutes) },
      },
      { computeAlternatives: false },
    );
    return r.unscheduled.length === 0;
  };
  const cap = 480;
  if (covers(cap)) {
    let lo = 15;
    let hi = cap;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2 / 15) * 15;
      if (mid <= lo) break;
      if (covers(mid)) hi = mid;
      else lo = mid;
    }
    const daily = covers(lo) ? lo : hi;
    alternatives.push({
      kind: "increase_daily_time",
      dailyMinutes: daily,
      description: `Studying about ${daily} minutes every available day would cover the full syllabus before the exam.`,
      topicsCovered: total,
      topicsTotal: total,
    });
  } else {
    alternatives.push({
      kind: "increase_daily_time",
      description: "Even 8 hours a day would not cover every topic before the exam; consider prioritising or speaking to a teacher.",
      topicsCovered: 0,
      topicsTotal: total,
    });
  }

  // B: lighter depth — shorter practice and no separate revision blocks.
  const light = generatePlan(
    { ...input, settings: { ...s, practiceMinutes: 10, revisionMinutes: 0, mockTestMinutes: 30 } },
    { computeAlternatives: false },
  );
  alternatives.push({
    kind: "reduced_depth",
    description: `A lighter plan (10-minute practice, no separate revision, 30-minute mock test) covers ${total - light.unscheduled.length} of ${total} topics with your current availability.`,
    topicsCovered: total - light.unscheduled.length,
    topicsTotal: total,
  });
  return alternatives;
}

/** Keep blocked days (illness, travel) blocked when testing more daily time. */
function zeroOverrides(a: Availability): Record<string, number> {
  return Object.fromEntries(Object.entries(a.dateOverrides ?? {}).filter(([, v]) => v === 0));
}
