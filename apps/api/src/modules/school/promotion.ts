import { Router } from "express";
import { z } from "zod";
import { audit, withSystem, withTenant, type Db } from "../../database/pool.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { requirePermission } from "../../middleware/authorization.js";
import { round1 } from "../lms/access.js";
import { ATTENDED_SQL, COUNTED_SQL } from "../lms/attendance.js";
import { applyPromotion, gradeNumber } from "./directory.js";
import { summarise, type PaperRow } from "./exams.js";

/**
 * Promotion from a final (annual) exam's declared results:
 *   passed every subject           → promoted to the next class (Class 12 → passed out)
 *   failed up to N subjects        → supplementary re-exam in those subjects; stays until it's marked
 *   failed more, or below a minimum → stays in the same class (detained)
 * The principal can preview and change any outcome before running it, or let it
 * run automatically the moment final results are declared.
 */
export const promotionRouter = Router();
promotionRouter.use(requirePermission("directory.manage"));

export interface PromotionRules {
  autoPromote: boolean;
  maxSupplementarySubjects: number;
  minAttendance: number | null;
  minPercent: number | null;
}
const DEFAULT_RULES: PromotionRules = { autoPromote: false, maxSupplementarySubjects: 2, minAttendance: null, minPercent: null };

export async function loadRules(db: Db, tenantId: string): Promise<PromotionRules> {
  const row = (await db.query(`SELECT settings -> 'promotion' AS p FROM tenants WHERE id = $1`, [tenantId])).rows[0];
  return { ...DEFAULT_RULES, ...(row?.p ?? {}) };
}

export type Outcome = "promote" | "supplementary" | "detain" | "incomplete";

interface PaperResult {
  paperId: string;
  subject: string;
  max: number;
  pass: number | null;
  marks: number | null;
  passed: boolean | null;
}

/** One student's outcome from their final exam result, attendance and the school's rules. */
export function decide(r: { papers: PaperResult[]; percent: number | null }, attendance: number | null, rules: PromotionRules): { outcome: Outcome; reasons: string[]; failed: string[] } {
  const missing = r.papers.filter((p) => p.marks == null).map((p) => p.subject);
  if (!r.papers.length) return { outcome: "incomplete", reasons: ["No papers in this exam"], failed: [] };
  if (missing.length) return { outcome: "incomplete", reasons: [`Marks missing: ${missing.join(", ")}`], failed: [] };
  const failed = r.papers.filter((p) => p.passed === false).map((p) => p.subject);
  if (rules.minAttendance != null && attendance != null && attendance < rules.minAttendance)
    return { outcome: "detain", reasons: [`Attendance ${attendance}% is below the required ${rules.minAttendance}%`], failed };
  if (!failed.length) {
    if (rules.minPercent != null && r.percent != null && r.percent < rules.minPercent) return { outcome: "detain", reasons: [`Overall ${r.percent}% is below the required ${rules.minPercent}%`], failed };
    return { outcome: "promote", reasons: ["Passed every subject"], failed };
  }
  if (failed.length <= rules.maxSupplementarySubjects) return { outcome: "supplementary", reasons: [`Re-exam in ${failed.join(", ")}`], failed };
  return { outcome: "detain", reasons: [`Failed in ${failed.length} subjects (${failed.join(", ")})`], failed };
}

interface ClassRow {
  id: string;
  name: string;
  grade: string | null;
  section: string | null;
  board: string | null;
  academic_year_id: string | null;
  year_start: string | null;
  year_end: string | null;
}

/** The next grade's section: same section letter if there is one, the newest academic year first. */
function nextClass(all: (ClassRow & { n: number | null; ys: string | null })[], from: ClassRow & { n: number | null }) {
  if (from.n == null || from.n >= 12) return null;
  const options = all.filter((c) => c.n === from.n! + 1).sort((a, b) => (b.ys ?? "").localeCompare(a.ys ?? ""));
  return options.find((c) => (c.section ?? "").toLowerCase() === (from.section ?? "").toLowerCase()) ?? options[0] ?? null;
}

/** Work out every student's outcome for an exam, class by class. Nothing is changed. */
export async function buildPlan(db: Db, tenantId: string, examId: string) {
  const exam = (await db.query(`SELECT * FROM exams WHERE id = $1`, [examId])).rows[0];
  if (!exam) throw notFound("Exam");
  const rules = await loadRules(db, tenantId);
  const all = (
    await db.query(
      `SELECT c.id, c.name, c.grade, c.section, c.board, c.academic_year_id, y.start_date AS year_start, y.end_date AS year_end
         FROM classes c LEFT JOIN academic_years y ON y.id = c.academic_year_id`,
    )
  ).rows.map((c: ClassRow) => ({ ...c, n: gradeNumber(c.grade, c.name), ys: c.year_start }));
  const current = (await db.query(`SELECT start_date, end_date FROM academic_years WHERE is_current LIMIT 1`)).rows[0] ?? null;
  const classIds = (await db.query(`SELECT DISTINCT class_id FROM exam_papers WHERE exam_id = $1`, [examId])).rows.map((r) => r.class_id);
  const classes = [];
  for (const cls of all.filter((c) => classIds.includes(c.id)).sort((a, b) => (b.n ?? 0) - (a.n ?? 0) || a.name.localeCompare(b.name))) {
    const papers: PaperRow[] = (await db.query(`SELECT id, subject, max_marks, pass_marks, grade_item_id FROM exam_papers WHERE exam_id = $1 AND class_id = $2 ORDER BY date, start_time`, [examId, cls.id])).rows;
    const students = (
      await db.query(
        `SELECT sp.id, u.name FROM class_enrollments e JOIN student_profiles sp ON sp.id = e.student_id JOIN users u ON u.id = sp.user_id WHERE e.class_id = $1 ORDER BY u.name`,
        [cls.id],
      )
    ).rows;
    const ids = students.map((s) => s.id);
    const scores = await db.query(`SELECT item_id, student_id, marks FROM grade_scores WHERE item_id = ANY($1::uuid[]) AND student_id = ANY($2::uuid[])`, [papers.map((p) => p.grade_item_id).filter(Boolean), ids]);
    const score = new Map(scores.rows.map((x) => [`${x.item_id}:${x.student_id}`, x.marks == null ? null : Number(x.marks)]));
    const from = cls.year_start ?? current?.start_date ?? null;
    const to = cls.year_end ?? current?.end_date ?? null;
    const att = await db.query(
      `SELECT student_id, ${ATTENDED_SQL}::int AS a, ${COUNTED_SQL}::int AS c FROM attendance_records
        WHERE class_id = $1 AND student_id = ANY($2::uuid[]) AND ($3::date IS NULL OR date BETWEEN $3 AND $4) GROUP BY student_id`,
      [cls.id, ids, from, to],
    );
    const rate = new Map(att.rows.map((r) => [r.student_id, r.c ? round1((r.a / r.c) * 100) : null]));
    // Students already handled for this exam (re-exam pending, or promoted already) are left alone.
    const handled = new Set(
      (
        await db.query(
          `SELECT student_id FROM supplementary_exams WHERE exam_id = $1 AND class_id = $2
           UNION SELECT student_id FROM student_year_records WHERE exam_id = $1 AND class_id = $2`,
          [examId, cls.id],
        )
      ).rows.map((r) => r.student_id),
    );
    const next = nextClass(all, cls);
    classes.push({
      class: { id: cls.id, name: cls.name, grade_number: cls.n },
      next: next && { id: next.id, name: next.name },
      lastGrade: cls.n === 12,
      students: students.map((s) => {
        const sum = summarise(papers, (p) => (p.grade_item_id ? (score.get(`${p.grade_item_id}:${s.id}`) ?? null) : null));
        const attendance = rate.get(s.id) ?? null;
        const d = handled.has(s.id) ? { outcome: "incomplete" as Outcome, reasons: ["Already decided for this exam"], failed: [] } : decide(sum, attendance, rules);
        if (d.outcome === "promote" && !next && cls.n !== 12) d.reasons = [...d.reasons, "No section of the next class yet"];
        return { studentId: s.id, name: s.name, percent: sum.percent, grade: sum.grade, attendance, failedSubjects: d.failed, outcome: d.outcome, reasons: d.reasons, handled: handled.has(s.id) };
      }),
    });
  }
  return { exam: { id: exam.id, name: exam.name, term: exam.term, status: exam.status, is_final: exam.is_final, promotion_run_at: exam.promotion_run_at }, rules, classes };
}

export interface RunOverride {
  studentId: string;
  classId: string;
  outcome: Outcome | "skip";
  toClassId?: string | null;
}

/** Carry out a plan: promote, arrange re-exams, or keep students back. Classes go from the top grade down. */
export async function runPlan(db: Db, tenantId: string, actorId: string, examId: string, overrides: RunOverride[] = []) {
  const plan = await buildPlan(db, tenantId, examId);
  if (plan.exam.status !== "completed") throw badRequest("Declare the exam's results before promoting students");
  const over = new Map(overrides.map((o) => [`${o.classId}:${o.studentId}`, o]));
  const summary = { promoted: 0, passedOut: 0, supplementary: 0, detained: 0, skipped: [] as { name: string; className: string; reason: string }[] };
  for (const c of plan.classes) {
    const moves: Parameters<typeof applyPromotion>[3]["students"] = [];
    for (const s of c.students) {
      if (s.handled) continue;
      const o = over.get(`${c.class.id}:${s.studentId}`);
      const outcome = o?.outcome ?? s.outcome;
      const target = o?.toClassId ?? c.next?.id ?? null;
      if (outcome === "skip" || outcome === "incomplete") {
        if (outcome === "incomplete") summary.skipped.push({ name: s.name, className: c.class.name, reason: s.reasons.join("; ") });
        continue;
      }
      if (outcome === "promote") {
        if (c.lastGrade && !o?.toClassId) {
          moves.push({ studentId: s.studentId, result: "passed_out", remarks: `Passed ${plan.exam.name}` });
          summary.passedOut++;
        } else if (!target) {
          summary.skipped.push({ name: s.name, className: c.class.name, reason: "No section of the next class yet" });
        } else {
          moves.push({ studentId: s.studentId, result: "promoted", toClassId: target, remarks: `Passed ${plan.exam.name}` });
          summary.promoted++;
        }
      } else if (outcome === "detain") {
        moves.push({ studentId: s.studentId, result: "detained", remarks: s.reasons.join("; ") });
        summary.detained++;
      } else if (outcome === "supplementary") {
        if (!c.lastGrade && !target) {
          summary.skipped.push({ name: s.name, className: c.class.name, reason: "No section of the next class yet" });
          continue;
        }
        const failed = (
          await db.query(
            `SELECT p.id, p.subject, p.max_marks, p.pass_marks, s.marks FROM exam_papers p LEFT JOIN grade_scores s ON s.item_id = p.grade_item_id AND s.student_id = $3
              WHERE p.exam_id = $1 AND p.class_id = $2 AND p.pass_marks IS NOT NULL AND COALESCE(s.marks, 0) < p.pass_marks`,
            [examId, c.class.id, s.studentId],
          )
        ).rows;
        // A principal may send a student to a re-exam even if they passed: then every paper is offered.
        const papers = failed.length ? failed : (await db.query(`SELECT p.id, p.subject, p.max_marks, p.pass_marks, NULL AS marks FROM exam_papers p WHERE p.exam_id = $1 AND p.class_id = $2`, [examId, c.class.id])).rows;
        for (const p of papers) {
          await db.query(
            `INSERT INTO supplementary_exams (tenant_id, student_id, exam_id, class_id, paper_id, subject, max_marks, pass_marks, original_marks, target_class_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (student_id, paper_id) DO NOTHING`,
            [tenantId, s.studentId, examId, c.class.id, p.id, p.subject, p.max_marks, p.pass_marks, p.marks, c.lastGrade ? null : target, actorId],
          );
        }
        summary.supplementary++;
      }
    }
    if (moves.length) {
      const r = await applyPromotion(db, tenantId, actorId, { fromClassId: c.class.id, examId, students: moves, skipExisting: true });
      for (const id of r.skipped) {
        const s = c.students.find((x) => x.studentId === id)!;
        summary.skipped.push({ name: s.name, className: c.class.name, reason: `Already has a ${r.year} record in ${c.class.name}` });
        const m = moves.find((x) => x.studentId === id)!;
        if (m.result === "promoted") summary.promoted--;
        else if (m.result === "passed_out") summary.passedOut--;
        else summary.detained--;
      }
    }
  }
  await db.query(`UPDATE exams SET promotion_run_at = now() WHERE id = $1`, [examId]);
  await audit(db, { tenantId, actorId, action: "promotion.run", resourceType: "exam", resourceId: examId, metadata: { ...summary, skipped: summary.skipped.length } });
  return summary;
}

/** When every re-exam of a student for an exam is marked: promote if all cleared, otherwise keep them back. */
async function resolveSupplementary(db: Db, tenantId: string, actorId: string, studentId: string, examId: string) {
  const rows = (await db.query(`SELECT * FROM supplementary_exams WHERE student_id = $1 AND exam_id = $2 AND NOT resolved`, [studentId, examId])).rows;
  if (!rows.length || rows.some((r) => r.status === "pending")) return null;
  const cls = (await db.query(`SELECT id, name, grade FROM classes WHERE id = $1`, [rows[0].class_id])).rows[0];
  const enrolled = cls && (await db.query(`SELECT 1 FROM class_enrollments WHERE class_id = $1 AND student_id = $2`, [cls.id, studentId])).rowCount;
  const cleared = rows.every((r) => r.status === "passed");
  const detail = rows.map((r) => `${r.subject} ${r.status === "absent" ? "absent" : `${r.marks}/${r.max_marks}`}`).join(", ");
  let result: string = cleared ? "promoted" : "detained";
  if (enrolled) {
    const lastGrade = gradeNumber(cls.grade, cls.name) === 12;
    if (cleared && (lastGrade || !rows[0].target_class_id)) result = "passed_out";
    await applyPromotion(db, tenantId, actorId, {
      fromClassId: cls.id,
      examId,
      students: [
        {
          studentId,
          result: result as "promoted" | "detained" | "passed_out",
          toClassId: result === "promoted" ? rows[0].target_class_id : null,
          remarks: `${cleared ? "Cleared" : "Did not clear"} supplementary exam: ${detail}`,
        },
      ],
    });
  }
  await db.query(`UPDATE supplementary_exams SET resolved = true, updated_at = now() WHERE student_id = $1 AND exam_id = $2`, [studentId, examId]);
  return result;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const rulesSchema = z.object({
  autoPromote: z.boolean(),
  maxSupplementarySubjects: z.number().int().min(0).max(10),
  minAttendance: z.number().min(0).max(100).nullable(),
  minPercent: z.number().min(0).max(100).nullable(),
});

promotionRouter.get(
  "/rules",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    res.json({ rules: await withTenant(tenant.id, (db) => loadRules(db, tenant.id)) });
  }),
);

promotionRouter.put(
  "/rules",
  requirePermission("tenant.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const rules = parse(rulesSchema, req.body);
    await withSystem(async (db) => {
      await db.query(`UPDATE tenants SET settings = jsonb_set(settings, '{promotion}', $2::jsonb), updated_at = now() WHERE id = $1`, [tenant.id, JSON.stringify(rules)]);
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "promotion.rules.update", metadata: rules });
    });
    res.json({ rules });
  }),
);

/** Exams that can decide promotion, newest first. */
promotionRouter.get(
  "/exams",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const rows = await withTenant(tenant.id, (db) =>
      db.query(
        `SELECT e.id, e.name, e.term, e.status, e.is_final, e.promotion_run_at, e.start_date,
                (SELECT count(DISTINCT class_id)::int FROM exam_papers p WHERE p.exam_id = e.id) AS classes
           FROM exams e WHERE e.status <> 'draft' ORDER BY e.is_final DESC, COALESCE(e.start_date, e.created_at::date) DESC`,
      ),
    );
    res.json({ exams: rows.rows });
  }),
);

promotionRouter.get(
  "/preview",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(z.object({ examId: z.string().uuid() }), req.query);
    res.json(await withTenant(tenant.id, (db) => buildPlan(db, tenant.id, q.examId)));
  }),
);

promotionRouter.post(
  "/run",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const b = parse(
      z.object({
        examId: z.string().uuid(),
        overrides: z
          .array(z.object({ studentId: z.string().uuid(), classId: z.string().uuid(), outcome: z.enum(["promote", "supplementary", "detain", "incomplete", "skip"]), toClassId: z.string().uuid().nullish() }))
          .max(5000)
          .default([]),
      }),
      req.body,
    );
    res.status(201).json({ summary: await withTenant(tenant.id, (db) => runPlan(db, tenant.id, userId, b.examId, b.overrides)) });
  }),
);

promotionRouter.get(
  "/supplementary",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(z.object({ open: z.enum(["true", "false"]).default("true") }), req.query);
    const rows = await withTenant(tenant.id, (db) =>
      db.query(
        `SELECT x.*, u.name AS student, c.name AS class_name, t.name AS target_class, e.name AS exam
           FROM supplementary_exams x JOIN student_profiles sp ON sp.id = x.student_id JOIN users u ON u.id = sp.user_id
           JOIN classes c ON c.id = x.class_id LEFT JOIN classes t ON t.id = x.target_class_id JOIN exams e ON e.id = x.exam_id
          WHERE ($1::boolean = false OR NOT x.resolved) ORDER BY c.name, u.name, x.subject`,
        [q.open === "true"],
      ),
    );
    res.json({ supplementary: rows.rows });
  }),
);

/** Record a re-exam: marks (or absent). Once all of a student's re-exams are in, they are promoted or kept back. */
promotionRouter.put(
  "/supplementary/:id",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const b = parse(z.object({ marks: z.number().min(0).nullish(), absent: z.boolean().default(false), examDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish() }), req.body);
    const out = await withTenant(tenant.id, async (db) => {
      const x = (await db.query(`SELECT * FROM supplementary_exams WHERE id = $1`, [req.params.id])).rows[0];
      if (!x) throw notFound("Re-exam");
      if (x.resolved) throw badRequest("This student's result is already final");
      if (!b.absent && b.marks == null) throw badRequest("Enter the marks or mark the student absent");
      if (b.marks != null && b.marks > Number(x.max_marks)) throw badRequest(`Marks can't be more than ${x.max_marks}`);
      const status = b.absent ? "absent" : x.pass_marks == null || b.marks! >= Number(x.pass_marks) ? "passed" : "failed";
      await db.query(`UPDATE supplementary_exams SET marks = $2, status = $3, exam_date = COALESCE($4, exam_date), updated_at = now() WHERE id = $1`, [x.id, b.absent ? null : b.marks, status, b.examDate ?? null]);
      const result = await resolveSupplementary(db, tenant.id, userId, x.student_id, x.exam_id);
      return { status, result };
    });
    res.json(out);
  }),
);
