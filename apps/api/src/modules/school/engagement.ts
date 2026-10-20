import { Router } from "express";
import { z } from "zod";
import { withTenant, type Db } from "../../database/pool.js";
import { asyncHandler, parse, requireTenant } from "../../lib/http.js";
import { resolveStudent } from "../../lib/student-access.js";

export const engagementRouter = Router();

/** XP per activity. Questions and doubts are capped per day so they can't be farmed. */
export const XP = { lesson: 20, quiz: 15, quizScoreBonus: 15, assignment: 25, task: 10, question: 5, doubt: 5, attendance: 10, book: 15, live: 15 } as const;
export const DAILY_QUESTION_CAP = 10;

const LEVEL_NAMES = ["Seedling", "Sprout", "Explorer", "Scholar", "Achiever", "Star", "Champion", "Genius", "Master", "Legend"];

/** XP needed to reach a level: 50·(level−1)² — 0, 50, 200, 450, 800 … */
export const xpForLevel = (level: number) => 50 * (level - 1) ** 2;

export function levelFor(xp: number) {
  const n = Math.floor(Math.sqrt(Math.max(0, xp) / 50)) + 1;
  const floor = xpForLevel(n);
  const next = xpForLevel(n + 1);
  return { number: n, name: LEVEL_NAMES[Math.min(n, LEVEL_NAMES.length) - 1], floorXp: floor, nextXp: next, progress: Math.round(((xp - floor) / (next - floor)) * 100) };
}

/**
 * Every XP-earning event for the given students, newest first. Built from the records
 * the platform already keeps, so XP can never drift from what actually happened.
 */
const ACTIVITY_SQL = `
  WITH questions AS (
    SELECT s.student_id, m.created_at AS at,
           row_number() OVER (PARTITION BY s.student_id, (m.created_at AT TIME ZONE 'Asia/Kolkata')::date ORDER BY m.created_at) AS n
      FROM tutor_messages m JOIN tutor_sessions s ON s.id = m.session_id
     WHERE m.role = 'student' AND s.student_id = ANY($1::uuid[])
  ), doubts AS (
    SELECT student_id, created_at AS at,
           row_number() OVER (PARTITION BY student_id, (created_at AT TIME ZONE 'Asia/Kolkata')::date ORDER BY created_at) AS n
      FROM live_questions WHERE status <> 'private' AND student_id = ANY($1::uuid[])
  )
  SELECT * FROM (
    SELECT student_id, completed_at AS at, ${XP.lesson} AS xp, 'lesson' AS kind FROM lesson_progress
     WHERE status = 'completed' AND completed_at IS NOT NULL AND student_id = ANY($1::uuid[])
    UNION ALL
    SELECT student_id, submitted_at, ${XP.quiz} + COALESCE(round(score / NULLIF(max_score, 0) * ${XP.quizScoreBonus}), 0)::int, 'quiz' FROM assessment_attempts
     WHERE submitted_at IS NOT NULL AND student_id = ANY($1::uuid[])
    UNION ALL
    SELECT student_id, submitted_at, ${XP.assignment}, 'assignment' FROM assignment_submissions WHERE student_id = ANY($1::uuid[])
    UNION ALL
    SELECT student_id, completed_at, ${XP.task}, 'task' FROM study_plan_tasks WHERE status = 'completed' AND completed_at IS NOT NULL AND student_id = ANY($1::uuid[])
    UNION ALL
    SELECT student_id, at, ${XP.question}, 'question' FROM questions WHERE n <= ${DAILY_QUESTION_CAP}
    UNION ALL
    SELECT student_id, at, ${XP.doubt}, 'doubt' FROM doubts WHERE n <= ${DAILY_QUESTION_CAP}
    UNION ALL
    SELECT student_id, (date + time '09:00') AT TIME ZONE 'Asia/Kolkata', ${XP.attendance}, 'attendance' FROM attendance_records
     WHERE status IN ('present','late') AND student_id = ANY($1::uuid[])
    UNION ALL
    SELECT sp.id, l.returned_at, ${XP.book}, 'book' FROM library_loans l JOIN student_profiles sp ON sp.user_id = l.user_id AND sp.tenant_id = l.tenant_id
     WHERE l.returned_at IS NOT NULL AND sp.id = ANY($1::uuid[])
    UNION ALL
    SELECT sp.id, a.joined_at, ${XP.live}, 'live' FROM live_attendance a JOIN student_profiles sp ON sp.user_id = a.user_id AND sp.tenant_id = a.tenant_id
     WHERE sp.id = ANY($1::uuid[])
  ) x WHERE at IS NOT NULL`;

interface Activity {
  student_id: string;
  at: Date;
  xp: number;
  kind: string;
}

async function activities(db: Db, studentIds: string[]): Promise<Activity[]> {
  if (!studentIds.length) return [];
  return (await db.query(`${ACTIVITY_SQL} ORDER BY at DESC`, [studentIds])).rows.map((r) => ({ ...r, xp: Number(r.xp) }));
}

/** IST calendar day for a timestamp, as YYYY-MM-DD. */
const istDay = (d: Date) => new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

export function streaks(days: Set<string>, today: string) {
  // The streak survives until the end of today: yesterday's activity still counts.
  let start = days.has(today) ? today : addDays(today, -1);
  let current = 0;
  while (days.has(start)) {
    current++;
    start = addDays(start, -1);
  }
  let best = 0;
  for (const d of [...days].sort()) {
    if (days.has(addDays(d, -1))) continue;
    let run = 0;
    for (let x = d; days.has(x); x = addDays(x, 1)) run++;
    best = Math.max(best, run);
  }
  return { current, best: Math.max(best, current) };
}

interface BadgeDef {
  id: string;
  name: string;
  description: string;
  icon: string;
  target: number;
  value: (s: Stats) => number;
}

interface Stats {
  count: Record<string, number>;
  streakBest: number;
  bestQuizPercent: number;
  totalXp: number;
}

const BADGES: BadgeDef[] = [
  { id: "first-steps", name: "First steps", description: "Earn your first XP", icon: "sparkles", target: 1, value: (s) => (s.totalXp > 0 ? 1 : 0) },
  { id: "bookworm", name: "Bookworm", description: "Finish 3 lessons", icon: "book", target: 3, value: (s) => s.count.lesson ?? 0 },
  { id: "quiz-whiz", name: "Quiz whiz", description: "Complete 3 quizzes", icon: "target", target: 3, value: (s) => s.count.quiz ?? 0 },
  { id: "sharp-mind", name: "Sharp mind", description: "Score 90% or more in a quiz", icon: "award", target: 90, value: (s) => s.bestQuizPercent },
  { id: "curious", name: "Curious cat", description: "Ask the AI teacher 10 questions", icon: "sparkles", target: 10, value: (s) => (s.count.question ?? 0) + (s.count.doubt ?? 0) },
  { id: "homework-hero", name: "Homework hero", description: "Submit 5 assignments", icon: "clipboard", target: 5, value: (s) => s.count.assignment ?? 0 },
  { id: "regular", name: "Always there", description: "Attend 10 school days", icon: "checkSquare", target: 10, value: (s) => s.count.attendance ?? 0 },
  { id: "live-learner", name: "Live learner", description: "Join 3 live classes", icon: "video", target: 3, value: (s) => s.count.live ?? 0 },
  { id: "reader", name: "Reader", description: "Return 2 library books", icon: "book", target: 2, value: (s) => s.count.book ?? 0 },
  { id: "planner", name: "On track", description: "Finish 10 study-plan tasks", icon: "calendar", target: 10, value: (s) => s.count.task ?? 0 },
  { id: "on-fire", name: "On fire", description: "Learn 3 days in a row", icon: "trending", target: 3, value: (s) => s.streakBest },
  { id: "unstoppable", name: "Unstoppable", description: "Learn 7 days in a row", icon: "trending", target: 7, value: (s) => s.streakBest },
];

const firstName = (name: string) => {
  const [first, last] = name.trim().split(/\s+/);
  return last ? `${first} ${last[0]}.` : first;
};

engagementRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(z.object({ studentId: z.string().uuid().optional() }), req.query);
    const data = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db, q.studentId);
      const acts = await activities(db, [student.id]);
      const today = istDay(new Date());
      const weekStart = addDays(today, -6);
      const totalXp = acts.reduce((t, a) => t + a.xp, 0);
      const days = new Set(acts.map((a) => istDay(new Date(a.at))));
      const streak = streaks(days, today);
      const count: Record<string, number> = {};
      for (const a of acts) count[a.kind] = (count[a.kind] ?? 0) + 1;
      const bestQuiz = (
        await db.query(`SELECT COALESCE(max(score / NULLIF(max_score, 0) * 100), 0)::float AS p FROM assessment_attempts WHERE student_id = $1 AND submitted_at IS NOT NULL`, [student.id])
      ).rows[0].p;
      const stats: Stats = { count, streakBest: streak.best, bestQuizPercent: Math.round(bestQuiz), totalXp };
      const badges = BADGES.map((b) => {
        const v = Math.min(b.value(stats), b.target);
        return { id: b.id, name: b.name, description: b.description, icon: b.icon, target: b.target, value: v, earned: v >= b.target };
      });

      const todays = acts.filter((a) => istDay(new Date(a.at)) === today);
      const todayXp = todays.reduce((t, a) => t + a.xp, 0);
      const goals = [
        { id: "xp", label: "Earn 50 XP today", value: Math.min(todayXp, 50), target: 50 },
        { id: "learn", label: "Finish a lesson, quiz or study task", value: todays.some((a) => ["lesson", "quiz", "task"].includes(a.kind)) ? 1 : 0, target: 1 },
        { id: "ask", label: "Ask the AI teacher a question", value: todays.some((a) => a.kind === "question" || a.kind === "doubt") ? 1 : 0, target: 1 },
      ];

      const week = Array.from({ length: 7 }, (_, i) => {
        const d = addDays(weekStart, i);
        return { date: d, xp: acts.filter((a) => istDay(new Date(a.at)) === d).reduce((t, a) => t + a.xp, 0) };
      });

      // Class leaderboard for this week: classmates in any of the student's classes.
      const mates = (
        await db.query(
          `SELECT DISTINCT sp.id, u.name FROM class_enrollments e JOIN class_enrollments mine ON mine.class_id = e.class_id AND mine.student_id = $1
             JOIN student_profiles sp ON sp.id = e.student_id JOIN users u ON u.id = sp.user_id`,
          [student.id],
        )
      ).rows;
      const weekActs = (await activities(db, mates.map((m) => m.id))).filter((a) => istDay(new Date(a.at)) >= weekStart);
      const leaderboard = mates
        .map((m) => ({ studentId: m.id, name: m.id === student.id ? "You" : firstName(m.name), xp: weekActs.filter((a) => a.student_id === m.id).reduce((t, a) => t + a.xp, 0), me: m.id === student.id }))
        .sort((a, b) => b.xp - a.xp || Number(b.me) - Number(a.me))
        .slice(0, 10)
        .map((r, i) => ({ ...r, rank: i + 1 }));

      return {
        student: { id: student.id, name: student.name },
        xp: totalXp,
        todayXp,
        weekXp: week.reduce((t, d) => t + d.xp, 0),
        level: levelFor(totalXp),
        streak,
        goals,
        badges,
        week,
        recent: acts.slice(0, 12).map((a) => ({ at: a.at, kind: a.kind, xp: a.xp })),
        leaderboard,
        rules: XP,
      };
    });
    res.json(data);
  }),
);
