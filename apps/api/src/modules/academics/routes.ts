import type { Request } from "express";
import { Router } from "express";
import { z } from "zod";
import { audit, withTenant, type Db } from "../../database/pool.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { resolveStudent } from "../../lib/student-access.js";
import { requirePermission } from "../../middleware/authorization.js";
import { holidaysBetween } from "./holidays.js";
import { planUnits, teachingDays, type Term } from "./planner.js";

export const academicsRouter = Router();

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const TODAY = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;
const todayIst = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const manage = requirePermission("academics.manage");

/** Per class subject: chapters, done, due by today, overdue and the chapter now being taught. */
const STATS_COLUMNS = `
  (SELECT count(*)::int FROM syllabus_plan_items p WHERE p.class_subject_id = cs.id) AS total,
  (SELECT count(*)::int FROM syllabus_plan_items p WHERE p.class_subject_id = cs.id AND p.status = 'completed') AS completed,
  (SELECT count(*)::int FROM syllabus_plan_items p WHERE p.class_subject_id = cs.id AND p.planned_end < ${TODAY}) AS due,
  (SELECT count(*)::int FROM syllabus_plan_items p WHERE p.class_subject_id = cs.id AND p.planned_end < ${TODAY} AND p.status <> 'completed') AS behind,
  (SELECT su.title FROM syllabus_plan_items p JOIN syllabus_units su ON su.id = p.unit_id
    WHERE p.class_subject_id = cs.id AND p.status <> 'completed' ORDER BY su.sequence LIMIT 1) AS current_unit,
  (SELECT p.planned_end FROM syllabus_plan_items p JOIN syllabus_units su ON su.id = p.unit_id
    WHERE p.class_subject_id = cs.id AND p.status <> 'completed' ORDER BY su.sequence LIMIT 1) AS current_due`;

const withStatus = (r: any) => ({
  ...r,
  state: !r.total ? "no_plan" : r.completed >= r.total ? "done" : r.behind > 0 ? "behind" : r.completed > r.due ? "ahead" : "on_track",
});

async function currentYear(db: Db, yearId?: string | null) {
  const y = yearId
    ? (await db.query(`SELECT * FROM academic_years WHERE id = $1`, [yearId])).rows[0]
    : (await db.query(`SELECT * FROM academic_years ORDER BY is_current DESC, start_date DESC LIMIT 1`)).rows[0];
  return y ?? null;
}

async function termsOf(db: Db, yearId: string): Promise<Term[]> {
  return (await db.query(`SELECT * FROM academic_terms WHERE year_id = $1 ORDER BY sequence`, [yearId])).rows.map((t) => ({
    seq: t.sequence,
    name: t.name,
    start: t.start_date,
    end: t.end_date,
    examStart: t.exam_start,
    examEnd: t.exam_end,
  }));
}

/** Holiday and exam dates on the school calendar that students don't have lessons. */
async function nonTeachingDates(db: Db, from: string, to: string) {
  const rows = await db.query(
    `SELECT d::date::text AS d FROM school_events e, generate_series(GREATEST(e.start_date, $1::date), LEAST(e.end_date, $2::date), interval '1 day') d
      WHERE e.kind IN ('holiday','exam') AND e.audience IN ('all','students') AND e.end_date >= $1 AND e.start_date <= $2`,
    [from, to],
  );
  return new Set(rows.rows.map((r) => r.d as string));
}

/** (Re)build the plan for one class subject. Completed chapters keep their dates; the rest are planned from today. */
export async function generatePlan(db: Db, tenantId: string, classSubjectId: string, opts: { from?: string } = {}) {
  const cs = (
    await db.query(`SELECT cs.*, c.academic_year_id FROM class_subjects cs JOIN classes c ON c.id = cs.class_id WHERE cs.id = $1`, [classSubjectId])
  ).rows[0];
  if (!cs) throw notFound("Class subject");
  const setWarning = (w: string | null) => db.query(`UPDATE class_subjects SET plan_warning = $2, plan_generated_at = now() WHERE id = $1`, [cs.id, w]);
  if (!cs.syllabus_id) return (await setWarning("No syllabus is linked to this subject yet"), { planned: 0, warnings: ["No syllabus linked"] });
  const year = await currentYear(db, cs.academic_year_id);
  if (!year) return (await setWarning("Set up the academic year first"), { planned: 0, warnings: ["No academic year"] });

  const units = (await db.query(`SELECT id, est_periods, term_sequence FROM syllabus_units WHERE syllabus_id = $1 ORDER BY sequence`, [cs.syllabus_id])).rows;
  await db.query(`DELETE FROM syllabus_plan_items WHERE class_subject_id = $1 AND unit_id <> ALL($2::uuid[])`, [cs.id, units.map((u) => u.id)]);
  const done = new Set(
    (await db.query(`SELECT unit_id FROM syllabus_plan_items WHERE class_subject_id = $1 AND status = 'completed'`, [cs.id])).rows.map((r) => r.unit_id),
  );
  const remaining = units.filter((u) => !done.has(u.id));

  // Periods per weekday: from the class timetable when it lists this subject, else spread evenly over Mon–Sat.
  const slots = (
    await db.query(
      `SELECT day_of_week, count(*)::int AS n FROM timetable_slots WHERE class_id = $1 AND lower(subject) LIKE lower($2) || '%' GROUP BY day_of_week`,
      [cs.class_id, cs.subject],
    )
  ).rows;
  const perDay = new Map(slots.map((s) => [s.day_of_week, s.n]));
  const capacityFor = (dow: number) => (perDay.size ? (perDay.get(dow) ?? 0) : cs.periods_per_week / 6);

  const terms = await termsOf(db, year.id);
  const from = opts.from ?? (todayIst() > year.start_date ? todayIst() : year.start_date);
  const days = teachingDays({ from, to: year.end_date, holidays: await nonTeachingDates(db, year.start_date, year.end_date), terms, capacityFor });
  const { allocations, warnings } = planUnits(
    remaining.map((u) => ({ id: u.id, est: u.est_periods, termSeq: u.term_sequence })),
    terms,
    days,
  );
  for (const a of allocations) {
    await db.query(
      `INSERT INTO syllabus_plan_items (tenant_id, class_subject_id, unit_id, term_sequence, planned_start, planned_end, planned_periods)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (class_subject_id, unit_id) DO UPDATE SET term_sequence = EXCLUDED.term_sequence, planned_start = EXCLUDED.planned_start,
         planned_end = EXCLUDED.planned_end, planned_periods = EXCLUDED.planned_periods, updated_at = now()`,
      [tenantId, cs.id, a.unitId, a.termSeq, a.start, a.end, a.periods],
    );
  }
  await setWarning(warnings.length ? warnings.join("; ") : null);
  return { planned: allocations.length, warnings };
}

// ---------------------------------------------------------------------------
// Academic years, terms and holidays
// ---------------------------------------------------------------------------
academicsRouter.get(
  "/years",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const years = (await db.query(`SELECT * FROM academic_years ORDER BY start_date DESC`)).rows;
      const terms = (await db.query(`SELECT * FROM academic_terms ORDER BY year_id, sequence`)).rows;
      const out = [];
      for (const y of years) {
        const yt = terms.filter((t) => t.year_id === y.id);
        const holidays = await nonTeachingDates(db, y.start_date, y.end_date);
        const days = teachingDays({
          from: y.start_date,
          to: y.end_date,
          holidays,
          terms: yt.map((t) => ({ seq: t.sequence, name: t.name, start: t.start_date, end: t.end_date, examStart: t.exam_start, examEnd: t.exam_end })),
          capacityFor: () => 1,
        });
        out.push({ ...y, terms: yt, teachingDays: days.length, holidayDays: holidays.size });
      }
      return { years: out };
    });
    res.json(data);
  }),
);

academicsRouter.post(
  "/years",
  manage,
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const b = parse(z.object({ name: z.string().trim().min(4).max(20), startDate: date, endDate: date, isCurrent: z.boolean().default(true) }), req.body);
    if (b.endDate <= b.startDate) throw badRequest("The year must end after it starts");
    const row = await withTenant(tenant.id, async (db) => {
      if ((await db.query(`SELECT 1 FROM academic_years WHERE name = $1`, [b.name])).rowCount) throw conflict(`${b.name} already exists`);
      if (b.isCurrent) await db.query(`UPDATE academic_years SET is_current = false WHERE is_current`);
      return (await db.query(`INSERT INTO academic_years (tenant_id, name, start_date, end_date, is_current) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [tenant.id, b.name, b.startDate, b.endDate, b.isCurrent])).rows[0];
    });
    res.status(201).json({ year: row });
  }),
);

academicsRouter.patch(
  "/years/:id",
  manage,
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const b = parse(z.object({ isCurrent: z.literal(true).optional(), startDate: date.optional(), endDate: date.optional() }), req.body);
    const row = await withTenant(tenant.id, async (db) => {
      if (b.isCurrent) await db.query(`UPDATE academic_years SET is_current = false WHERE is_current AND id <> $1`, [req.params.id]);
      const y = (
        await db.query(`UPDATE academic_years SET is_current = COALESCE($2, is_current), start_date = COALESCE($3, start_date), end_date = COALESCE($4, end_date) WHERE id = $1 RETURNING *`, [
          req.params.id,
          b.isCurrent ?? null,
          b.startDate ?? null,
          b.endDate ?? null,
        ])
      ).rows[0];
      if (!y) throw notFound("Academic year");
      if (y.end_date <= y.start_date) throw badRequest("The year must end after it starts");
      return y;
    });
    res.json({ year: row });
  }),
);

academicsRouter.post(
  "/years/:id/terms",
  manage,
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const b = parse(
      z.object({ name: z.string().trim().min(1).max(60), startDate: date, endDate: date, examStart: date.nullish(), examEnd: date.nullish() }),
      req.body,
    );
    if (b.endDate < b.startDate) throw badRequest("The term ends before it starts");
    if (b.examStart && (!b.examEnd || b.examStart < b.startDate || b.examEnd > b.endDate || b.examEnd < b.examStart)) throw badRequest("Exams must fall inside the term");
    const row = await withTenant(tenant.id, async (db) => {
      const y = (await db.query(`SELECT * FROM academic_years WHERE id = $1`, [req.params.id])).rows[0];
      if (!y) throw notFound("Academic year");
      if (b.startDate < y.start_date || b.endDate > y.end_date) throw badRequest("The term must fall inside the academic year");
      const overlap = await db.query(`SELECT name FROM academic_terms WHERE year_id = $1 AND start_date <= $3 AND end_date >= $2`, [y.id, b.startDate, b.endDate]);
      if (overlap.rowCount) throw conflict(`This overlaps ${overlap.rows[0].name}`);
      const seq = (await db.query(`SELECT count(*)::int + 1 AS n FROM academic_terms WHERE year_id = $1 AND start_date < $2`, [y.id, b.startDate])).rows[0].n;
      await db.query(`UPDATE academic_terms SET sequence = -sequence - 1 WHERE year_id = $1 AND sequence >= $2`, [y.id, seq]);
      await db.query(`UPDATE academic_terms SET sequence = -sequence WHERE year_id = $1 AND sequence < 0`, [y.id]);
      return (
        await db.query(`INSERT INTO academic_terms (tenant_id, year_id, name, sequence, start_date, end_date, exam_start, exam_end) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [
          tenant.id,
          y.id,
          b.name,
          seq,
          b.startDate,
          b.endDate,
          b.examStart ?? null,
          b.examEnd ?? null,
        ])
      ).rows[0];
    });
    res.status(201).json({ term: row });
  }),
);

academicsRouter.delete(
  "/terms/:id",
  manage,
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    await withTenant(tenant.id, async (db) => {
      const t = (await db.query(`DELETE FROM academic_terms WHERE id = $1 RETURNING year_id, sequence`, [req.params.id])).rows[0];
      if (!t) throw notFound("Term");
      await db.query(`UPDATE academic_terms SET sequence = sequence - 1 WHERE year_id = $1 AND sequence > $2`, [t.year_id, t.sequence]);
    });
    res.json({ ok: true });
  }),
);

/** National holidays (and approximate 2026-27 festival dates) the school can add to its calendar. */
academicsRouter.get(
  "/years/:id/holiday-suggestions",
  manage,
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const y = (await db.query(`SELECT * FROM academic_years WHERE id = $1`, [req.params.id])).rows[0];
      if (!y) throw notFound("Academic year");
      const existing = new Set((await db.query(`SELECT start_date::text || lower(title) AS k FROM school_events WHERE kind = 'holiday'`)).rows.map((r) => r.k));
      return { holidays: holidaysBetween(y.start_date, y.end_date).map((h) => ({ ...h, added: existing.has(h.date + h.name.toLowerCase()) })) };
    });
    res.json(data);
  }),
);

academicsRouter.post(
  "/years/:id/holidays",
  manage,
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const b = parse(z.object({ holidays: z.array(z.object({ date, name: z.string().trim().min(1).max(120), endDate: date.optional() })).min(1).max(100) }), req.body);
    const added = await withTenant(tenant.id, async (db) => {
      const y = (await db.query(`SELECT * FROM academic_years WHERE id = $1`, [req.params.id])).rows[0];
      if (!y) throw notFound("Academic year");
      let n = 0;
      for (const h of b.holidays) {
        const end = h.endDate ?? h.date;
        if (end < h.date) throw badRequest(`${h.name} ends before it starts`);
        const dup = await db.query(`SELECT 1 FROM school_events WHERE kind = 'holiday' AND start_date = $1 AND lower(title) = lower($2)`, [h.date, h.name]);
        if (dup.rowCount) continue;
        await db.query(`INSERT INTO school_events (tenant_id, title, kind, start_date, end_date, audience, created_by) VALUES ($1,$2,'holiday',$3,$4,'all',$5)`, [tenant.id, h.name, h.date, end, userId]);
        n++;
      }
      return n;
    });
    res.status(201).json({ added });
  }),
);

// ---------------------------------------------------------------------------
// Syllabi
// ---------------------------------------------------------------------------
academicsRouter.get(
  "/syllabi",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const rows = await withTenant(tenant.id, (db) =>
      db.query(
        `SELECT s.*, y.name AS year, (SELECT count(*)::int FROM syllabus_units u WHERE u.syllabus_id = s.id) AS units,
                (SELECT COALESCE(sum(est_periods), 0)::int FROM syllabus_units u WHERE u.syllabus_id = s.id) AS periods,
                (SELECT count(*)::int FROM class_subjects cs WHERE cs.syllabus_id = s.id) AS used_by
           FROM syllabi s LEFT JOIN academic_years y ON y.id = s.academic_year_id ORDER BY s.board, s.grade, s.subject`,
      ),
    );
    res.json({ syllabi: rows.rows });
  }),
);

academicsRouter.get(
  "/syllabi/:id",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const s = (await db.query(`SELECT * FROM syllabi WHERE id = $1`, [req.params.id])).rows[0];
      if (!s) throw notFound("Syllabus");
      const units = (await db.query(`SELECT * FROM syllabus_units WHERE syllabus_id = $1 ORDER BY sequence`, [s.id])).rows;
      return { syllabus: s, units };
    });
    res.json(data);
  }),
);

const syllabusKey = z.object({
  board: z.string().trim().min(1).max(60),
  grade: z.string().trim().min(1).max(40),
  subject: z.string().trim().min(1).max(80),
  academicYearId: z.string().uuid().nullish(),
  source: z.string().trim().max(300).default(""),
});

async function createSyllabus(db: Db, tenantId: string, b: z.infer<typeof syllabusKey>) {
  const dup = await db.query(
    `SELECT 1 FROM syllabi WHERE lower(board) = lower($1) AND lower(grade) = lower($2) AND lower(subject) = lower($3) AND academic_year_id IS NOT DISTINCT FROM $4::uuid`,
    [b.board, b.grade, b.subject, b.academicYearId ?? null],
  );
  if (dup.rowCount) throw conflict(`A ${b.board} ${b.grade} ${b.subject} syllabus already exists`);
  return (
    await db.query(`INSERT INTO syllabi (tenant_id, board, grade, subject, academic_year_id, source) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [
      tenantId,
      b.board,
      b.grade,
      b.subject,
      b.academicYearId ?? null,
      b.source,
    ])
  ).rows[0];
}

/** Link any matching class subjects (same board, grade and subject) that have no syllabus yet. */
async function linkSyllabus(db: Db, s: { id: string; board: string; grade: string; subject: string }) {
  await db.query(
    `UPDATE class_subjects cs SET syllabus_id = $1 FROM classes c
      WHERE c.id = cs.class_id AND cs.syllabus_id IS NULL AND lower(c.board) = lower($2) AND lower(c.grade) = lower($3) AND lower(cs.subject) = lower($4)`,
    [s.id, s.board, s.grade, s.subject],
  );
}

academicsRouter.post(
  "/syllabi",
  manage,
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const b = parse(
      syllabusKey.extend({ units: z.array(z.object({ title: z.string().trim().min(1).max(200), estPeriods: z.number().int().min(1).max(200).default(6), term: z.number().int().min(1).nullish() })).max(100).default([]) }),
      req.body,
    );
    const row = await withTenant(tenant.id, async (db) => {
      const s = await createSyllabus(db, tenant.id, b);
      for (let i = 0; i < b.units.length; i++) {
        await db.query(`INSERT INTO syllabus_units (tenant_id, syllabus_id, title, sequence, est_periods, term_sequence) VALUES ($1,$2,$3,$4,$5,$6)`, [
          tenant.id,
          s.id,
          b.units[i].title,
          i + 1,
          b.units[i].estPeriods,
          b.units[i].term ?? null,
        ]);
      }
      await linkSyllabus(db, s);
      return s;
    });
    res.status(201).json({ syllabus: row });
  }),
);

/** Replace the chapter list. Existing chapters (by id) keep their progress; removed ones are deleted. */
academicsRouter.put(
  "/syllabi/:id/units",
  manage,
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const b = parse(
      z.object({
        units: z
          .array(z.object({ id: z.string().uuid().optional(), title: z.string().trim().min(1).max(200), estPeriods: z.number().int().min(1).max(200), term: z.number().int().min(1).nullish(), topics: z.string().trim().max(2000).default("") }))
          .max(100),
      }),
      req.body,
    );
    const units = await withTenant(tenant.id, async (db) => {
      const s = (await db.query(`SELECT id FROM syllabi WHERE id = $1`, [req.params.id])).rows[0];
      if (!s) throw notFound("Syllabus");
      const keep = b.units.map((u) => u.id).filter(Boolean) as string[];
      await db.query(`DELETE FROM syllabus_units WHERE syllabus_id = $1 AND id <> ALL($2::uuid[])`, [s.id, keep]);
      await db.query(`UPDATE syllabus_units SET sequence = -sequence WHERE syllabus_id = $1`, [s.id]);
      for (let i = 0; i < b.units.length; i++) {
        const u = b.units[i];
        if (u.id) {
          const r = await db.query(`UPDATE syllabus_units SET title = $3, sequence = $4, est_periods = $5, term_sequence = $6, topics = $7 WHERE id = $1 AND syllabus_id = $2`, [
            u.id,
            s.id,
            u.title,
            i + 1,
            u.estPeriods,
            u.term ?? null,
            u.topics,
          ]);
          if (!r.rowCount) throw notFound("Chapter");
        } else {
          await db.query(`INSERT INTO syllabus_units (tenant_id, syllabus_id, title, sequence, est_periods, term_sequence, topics) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
            tenant.id,
            s.id,
            u.title,
            i + 1,
            u.estPeriods,
            u.term ?? null,
            u.topics,
          ]);
        }
      }
      return (await db.query(`SELECT * FROM syllabus_units WHERE syllabus_id = $1 ORDER BY sequence`, [s.id])).rows;
    });
    res.json({ units });
  }),
);

academicsRouter.delete(
  "/syllabi/:id",
  manage,
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    await withTenant(tenant.id, async (db) => {
      const r = await db.query(`DELETE FROM syllabi WHERE id = $1`, [req.params.id]);
      if (!r.rowCount) throw notFound("Syllabus");
    });
    res.json({ ok: true });
  }),
);

/** Built-in (platform) curricula a school can copy from. */
academicsRouter.get(
  "/library",
  manage,
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const rows = await withTenant(tenant.id, (db) =>
      db.query(
        `SELECT cv.id AS curriculum_version_id, b.name AS board, g.name AS grade, cv.academic_year, s.id AS subject_id, s.name AS subject, count(ch.id)::int AS chapters
           FROM curriculum_versions cv JOIN boards b ON b.id = cv.board_id JOIN grades g ON g.id = cv.grade_id
           JOIN chapters ch ON ch.curriculum_version_id = cv.id JOIN subjects s ON s.id = ch.subject_id
          WHERE cv.approval_status = 'approved' GROUP BY cv.id, b.name, g.name, s.id ORDER BY b.name, g.name, s.name`,
      ),
    );
    res.json({ library: rows.rows });
  }),
);

academicsRouter.post(
  "/syllabi/import",
  manage,
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const b = parse(z.object({ curriculumVersionId: z.string().uuid(), subjectId: z.string().uuid(), academicYearId: z.string().uuid().nullish() }), req.body);
    const row = await withTenant(tenant.id, async (db) => {
      const src = (
        await db.query(
          `SELECT b.name AS board, g.name AS grade, s.name AS subject, cv.source FROM curriculum_versions cv JOIN boards b ON b.id = cv.board_id JOIN grades g ON g.id = cv.grade_id, subjects s
            WHERE cv.id = $1 AND s.id = $2 AND cv.approval_status = 'approved'`,
          [b.curriculumVersionId, b.subjectId],
        )
      ).rows[0];
      if (!src) throw notFound("Library syllabus");
      const s = await createSyllabus(db, tenant.id, { board: src.board, grade: src.grade, subject: src.subject, academicYearId: b.academicYearId, source: `Built-in library: ${src.source}`.slice(0, 300) });
      const chapters = (
        await db.query(
          `SELECT ch.title, ch.sequence, (SELECT count(*)::int FROM topics t WHERE t.chapter_id = ch.id) AS topics,
                  (SELECT string_agg(t.title, '; ' ORDER BY t.sequence) FROM topics t WHERE t.chapter_id = ch.id) AS topic_titles
             FROM chapters ch WHERE ch.curriculum_version_id = $1 AND ch.subject_id = $2 ORDER BY ch.sequence`,
          [b.curriculumVersionId, b.subjectId],
        )
      ).rows;
      for (let i = 0; i < chapters.length; i++) {
        // A school period per topic is too tight; allow about three per topic (between 4 and 20 per chapter).
        const est = Math.min(20, Math.max(4, chapters[i].topics * 3));
        await db.query(`INSERT INTO syllabus_units (tenant_id, syllabus_id, title, sequence, est_periods, topics) VALUES ($1,$2,$3,$4,$5,$6)`, [
          tenant.id,
          s.id,
          chapters[i].title,
          i + 1,
          est,
          chapters[i].topic_titles ?? "",
        ]);
      }
      await linkSyllabus(db, s);
      return s;
    });
    res.status(201).json({ syllabus: row });
  }),
);

// ---------------------------------------------------------------------------
// Classes and their subjects
// ---------------------------------------------------------------------------
academicsRouter.get(
  "/classes",
  manage,
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const classes = (
        await db.query(
          `SELECT c.id, c.name, c.board, c.grade, c.section, c.academic_year_id, y.name AS year, u.name AS class_teacher,
                  (SELECT count(*)::int FROM class_enrollments e WHERE e.class_id = c.id) AS students
             FROM classes c JOIN users u ON u.id = c.teacher_id LEFT JOIN academic_years y ON y.id = c.academic_year_id ORDER BY c.grade NULLS LAST, c.section, c.name`,
        )
      ).rows;
      const subjects = (
        await db.query(
          `SELECT cs.id, cs.class_id, cs.subject, cs.teacher_id, t.name AS teacher, cs.periods_per_week, cs.syllabus_id, cs.plan_warning, cs.plan_generated_at, ${STATS_COLUMNS}
             FROM class_subjects cs LEFT JOIN users t ON t.id = cs.teacher_id ORDER BY cs.subject`,
        )
      ).rows.map(withStatus);
      return { classes: classes.map((c) => ({ ...c, subjects: subjects.filter((s) => s.class_id === c.id) })) };
    });
    res.json(data);
  }),
);

academicsRouter.patch(
  "/classes/:id",
  manage,
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const b = parse(
      z.object({ board: z.string().trim().max(60).nullish(), grade: z.string().trim().max(40).nullish(), section: z.string().trim().max(10).nullish(), academicYearId: z.string().uuid().nullish() }),
      req.body,
    );
    const row = await withTenant(tenant.id, async (db) => {
      const c = (
        await db.query(
          `UPDATE classes SET board = CASE WHEN $6 THEN $2 ELSE board END, grade = CASE WHEN $7 THEN $3 ELSE grade END,
                  section = CASE WHEN $8 THEN $4 ELSE section END, academic_year_id = CASE WHEN $9 THEN $5::uuid ELSE academic_year_id END WHERE id = $1 RETURNING *`,
          [req.params.id, b.board ?? null, b.grade ?? null, b.section ?? null, b.academicYearId ?? null, b.board !== undefined, b.grade !== undefined, b.section !== undefined, b.academicYearId !== undefined],
        )
      ).rows[0];
      if (!c) throw notFound("Class");
      // Link existing subjects to the matching syllabus for the new board and grade.
      if (c.board && c.grade) {
        await db.query(
          `UPDATE class_subjects cs SET syllabus_id = s.id FROM syllabi s
            WHERE cs.class_id = $1 AND cs.syllabus_id IS NULL AND lower(s.board) = lower($2) AND lower(s.grade) = lower($3) AND lower(s.subject) = lower(cs.subject)`,
          [c.id, c.board, c.grade],
        );
      }
      return c;
    });
    res.json({ class: row });
  }),
);

const subjectSchema = z.object({
  subject: z.string().trim().min(1).max(80),
  teacherId: z.string().uuid().nullish(),
  periodsPerWeek: z.number().int().min(1).max(48).default(6),
  syllabusId: z.string().uuid().nullish(),
});

async function assertTeacher(db: Db, tenantId: string, teacherId: string | null | undefined) {
  if (!teacherId) return;
  const m = await db.query(`SELECT 1 FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' AND role_id IN ('teacher','tenant_admin','tenant_owner')`, [tenantId, teacherId]);
  if (!m.rowCount) throw badRequest("That person is not a teacher in this school");
}

academicsRouter.post(
  "/classes/:id/subjects",
  manage,
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const b = parse(subjectSchema, req.body);
    const row = await withTenant(tenant.id, async (db) => {
      const c = (await db.query(`SELECT * FROM classes WHERE id = $1`, [req.params.id])).rows[0];
      if (!c) throw notFound("Class");
      await assertTeacher(db, tenant.id, b.teacherId);
      if ((await db.query(`SELECT 1 FROM class_subjects WHERE class_id = $1 AND lower(subject) = lower($2)`, [c.id, b.subject])).rowCount) throw conflict(`${c.name} already has ${b.subject}`);
      const syllabusId =
        b.syllabusId ??
        (c.board && c.grade
          ? (await db.query(`SELECT id FROM syllabi WHERE lower(board) = lower($1) AND lower(grade) = lower($2) AND lower(subject) = lower($3) ORDER BY academic_year_id IS NULL LIMIT 1`, [c.board, c.grade, b.subject])).rows[0]?.id
          : null);
      return (
        await db.query(`INSERT INTO class_subjects (tenant_id, class_id, subject, teacher_id, periods_per_week, syllabus_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [
          tenant.id,
          c.id,
          b.subject,
          b.teacherId ?? null,
          b.periodsPerWeek,
          syllabusId ?? null,
        ])
      ).rows[0];
    });
    res.status(201).json({ subject: row });
  }),
);

academicsRouter.patch(
  "/class-subjects/:id",
  manage,
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const b = parse(subjectSchema.partial(), req.body);
    const row = await withTenant(tenant.id, async (db) => {
      await assertTeacher(db, tenant.id, b.teacherId);
      const cs = (
        await db.query(
          `UPDATE class_subjects SET subject = COALESCE($2, subject), teacher_id = CASE WHEN $6 THEN $3::uuid ELSE teacher_id END,
                  periods_per_week = COALESCE($4, periods_per_week), syllabus_id = CASE WHEN $7 THEN $5::uuid ELSE syllabus_id END WHERE id = $1 RETURNING *`,
          [req.params.id, b.subject ?? null, b.teacherId ?? null, b.periodsPerWeek ?? null, b.syllabusId ?? null, b.teacherId !== undefined, b.syllabusId !== undefined],
        )
      ).rows[0];
      if (!cs) throw notFound("Class subject");
      return cs;
    });
    res.json({ subject: row });
  }),
);

academicsRouter.delete(
  "/class-subjects/:id",
  manage,
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    await withTenant(tenant.id, async (db) => {
      const r = await db.query(`DELETE FROM class_subjects WHERE id = $1`, [req.params.id]);
      if (!r.rowCount) throw notFound("Class subject");
    });
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------
/** Admins manage every plan; a subject teacher manages their own. */
async function loadClassSubject(req: Request, db: Db, id: string, opts: { write?: boolean } = {}) {
  const tenant = requireTenant(req);
  const { userId } = requireAuth(req);
  const cs = (
    await db.query(
      `SELECT cs.*, c.name AS class_name, c.board, c.grade, c.section, c.teacher_id AS class_teacher_id, t.name AS teacher, s.board AS s_board, s.source AS syllabus_source
         FROM class_subjects cs JOIN classes c ON c.id = cs.class_id LEFT JOIN users t ON t.id = cs.teacher_id LEFT JOIN syllabi s ON s.id = cs.syllabus_id WHERE cs.id = $1`,
      [id],
    )
  ).rows[0];
  if (!cs) throw notFound("Class subject");
  const admin = tenant.permissions.has("academics.manage");
  const teaches = cs.teacher_id === userId;
  if (admin || teaches) return cs;
  if (opts.write) throw forbidden("Only this subject's teacher or an admin can change its plan");
  // Anyone who teaches in this class may read its other subjects' plans.
  const classTeacher =
    cs.class_teacher_id === userId || !!(await db.query(`SELECT 1 FROM class_subjects WHERE class_id = $1 AND teacher_id = $2`, [cs.class_id, userId])).rowCount;
  const member = await db.query(
    `SELECT 1 FROM class_enrollments e WHERE e.class_id = $1 AND (e.student_id = $2 OR e.student_id IN (SELECT student_id FROM parent_student_links WHERE parent_id = $3 AND consent_status = 'granted'))`,
    [cs.class_id, tenant.studentProfileId, userId],
  );
  if (!classTeacher && !member.rowCount) throw forbidden("You are not part of this class");
  return cs;
}

academicsRouter.post(
  "/class-subjects/:id/plan",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const result = await withTenant(tenant.id, async (db) => {
      await loadClassSubject(req, db, req.params.id, { write: true });
      const r = await generatePlan(db, tenant.id, req.params.id);
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "academics.plan", resourceType: "class_subject", resourceId: req.params.id });
      return r;
    });
    res.json(result);
  }),
);

/** Generate plans for every class subject in the school. */
academicsRouter.post(
  "/plans/generate",
  manage,
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const result = await withTenant(tenant.id, async (db) => {
      const ids = (await db.query(`SELECT id FROM class_subjects ORDER BY created_at`)).rows.map((r) => r.id);
      let planned = 0;
      let warnings = 0;
      for (const id of ids) {
        const r = await generatePlan(db, tenant.id, id);
        if (r.planned) planned++;
        if (r.warnings.length) warnings++;
      }
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "academics.plan.all", metadata: { subjects: ids.length, planned } });
      return { subjects: ids.length, planned, withWarnings: warnings };
    });
    res.json(result);
  }),
);

academicsRouter.get(
  "/class-subjects/:id/plan",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const data = await withTenant(tenant.id, async (db) => {
      const cs = await loadClassSubject(req, db, req.params.id);
      const items = (
        await db.query(
          `SELECT p.*, u.title, u.sequence, u.est_periods, u.topics, t.name AS term_name FROM syllabus_plan_items p JOIN syllabus_units u ON u.id = p.unit_id
             LEFT JOIN academic_terms t ON t.year_id = (SELECT COALESCE(c.academic_year_id, (SELECT id FROM academic_years ORDER BY is_current DESC, start_date DESC LIMIT 1)) FROM classes c WHERE c.id = $2)
                                       AND t.sequence = p.term_sequence
            WHERE p.class_subject_id = $1 ORDER BY u.sequence`,
          [cs.id, cs.class_id],
        )
      ).rows;
      const stats = withStatus(
        (await db.query(`SELECT ${STATS_COLUMNS} FROM class_subjects cs WHERE cs.id = $1`, [cs.id])).rows[0],
      );
      const canEdit = tenant.permissions.has("academics.manage") || cs.teacher_id === userId;
      return { subject: { ...cs, ...stats }, items, canEdit };
    });
    res.json(data);
  }),
);

academicsRouter.patch(
  "/plan-items/:id",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const b = parse(z.object({ status: z.enum(["planned", "in_progress", "completed"]).optional(), note: z.string().trim().max(500).nullish(), completedOn: date.nullish() }), req.body);
    const row = await withTenant(tenant.id, async (db) => {
      const p = (await db.query(`SELECT * FROM syllabus_plan_items WHERE id = $1`, [req.params.id])).rows[0];
      if (!p) throw notFound("Plan item");
      await loadClassSubject(req, db, p.class_subject_id, { write: true });
      return (
        await db.query(
          `UPDATE syllabus_plan_items SET status = COALESCE($2, status), note = CASE WHEN $4 THEN $3 ELSE note END,
                  completed_on = CASE WHEN COALESCE($2, status) = 'completed' THEN COALESCE($5::date, completed_on, ${TODAY}) ELSE NULL END,
                  updated_by = $6, updated_at = now() WHERE id = $1 RETURNING *`,
          [p.id, b.status ?? null, b.note ?? null, b.note !== undefined, b.completedOn ?? null, userId],
        )
      ).rows[0];
    });
    res.json({ item: row });
  }),
);

/** Principal's view: every class × subject with coverage against the plan. */
academicsRouter.get(
  "/overview",
  requirePermission("academics.manage", "reports.tenant"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const rows = (
        await db.query(
          `SELECT cs.id, cs.class_id, c.name AS class_name, c.board, c.grade, c.section, cs.subject, t.name AS teacher, cs.plan_warning, cs.syllabus_id, ${STATS_COLUMNS}
             FROM class_subjects cs JOIN classes c ON c.id = cs.class_id LEFT JOIN users t ON t.id = cs.teacher_id
            ORDER BY c.grade NULLS LAST, c.section, c.name, cs.subject`,
        )
      ).rows.map(withStatus);
      const subjects = [...new Set(rows.map((r) => r.subject))].sort();
      const classes = [...new Map(rows.map((r) => [r.class_id, { id: r.class_id, name: r.class_name, board: r.board, grade: r.grade, section: r.section }])).values()];
      const totals = rows.reduce((t, r) => ({ total: t.total + r.total, completed: t.completed + r.completed, due: t.due + r.due, behind: t.behind + (r.state === "behind" ? 1 : 0) }), { total: 0, completed: 0, due: 0, behind: 0 });
      return { classes, subjects, cells: rows, totals, year: await currentYear(db) };
    });
    res.json(data);
  }),
);

/** A teacher's own subjects with their progress. */
academicsRouter.get(
  "/my-subjects",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const rows = await withTenant(tenant.id, (db) =>
      db.query(
        `SELECT cs.id, cs.subject, cs.class_id, c.name AS class_name, c.board, c.grade, cs.periods_per_week, cs.plan_warning, cs.syllabus_id, ${STATS_COLUMNS}
           FROM class_subjects cs JOIN classes c ON c.id = cs.class_id WHERE cs.teacher_id = $1 ORDER BY c.name, cs.subject`,
        [userId],
      ),
    );
    res.json({ subjects: rows.rows.map(withStatus) });
  }),
);

/** A student's (or a parent's child's) subjects: what's being taught now and next. */
academicsRouter.get(
  "/student",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(z.object({ studentId: z.string().uuid().optional() }), req.query);
    const data = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db, q.studentId);
      const subjects = (
        await db.query(
          `SELECT cs.id, cs.subject, c.name AS class_name, t.name AS teacher, ${STATS_COLUMNS},
                  (SELECT json_agg(json_build_object('id', p.id, 'title', u.title, 'start', p.planned_start, 'end', p.planned_end, 'status', p.status) ORDER BY u.sequence)
                     FROM syllabus_plan_items p JOIN syllabus_units u ON u.id = p.unit_id WHERE p.class_subject_id = cs.id) AS units
             FROM class_subjects cs JOIN classes c ON c.id = cs.class_id LEFT JOIN users t ON t.id = cs.teacher_id
             JOIN class_enrollments e ON e.class_id = cs.class_id AND e.student_id = $1 ORDER BY cs.subject`,
          [student.id],
        )
      ).rows.map(withStatus);
      const today = todayIst();
      return {
        student: { id: student.id, name: student.name },
        subjects: subjects.map((s) => {
          const units: any[] = s.units ?? [];
          const now = units.find((u) => u.status !== "completed" && (!u.start || u.start <= today)) ?? units.find((u) => u.status !== "completed");
          const next = units.find((u) => u !== now && u.status !== "completed" && (!now || units.indexOf(u) > units.indexOf(now)));
          return { ...s, now: now ?? null, next: next ?? null };
        }),
      };
    });
    res.json(data);
  }),
);
