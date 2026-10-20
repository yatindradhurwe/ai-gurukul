import type { Request } from "express";
import { Router } from "express";
import { z } from "zod";
import { audit, withSystem, withTenant, type Db } from "../../database/pool.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { STAFF_ROLES } from "../../lib/permissions.js";
import { requirePermission } from "../../middleware/authorization.js";
import { gradeFor, round1 } from "../lms/access.js";
import { ATTENDED_SQL, COUNTED_SQL } from "../lms/attendance.js";
import { summarise, type PaperRow } from "./exams.js";

/**
 * School directory for the principal and admins: every staff member with what
 * they teach, every class from Class 1 to 12, every student's profile with
 * attendance, marks and exam results, documents on student and staff profiles,
 * and co-curricular activities (sports, PT, clubs). Teachers see the same views
 * limited to the classes, subjects and activities they are in charge of.
 */
export const directoryRouter = Router();

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const canManage = (req: Request) => requireTenant(req).permissions.has("directory.manage");
const isTeacher = (req: Request) => requireTenant(req).permissions.has("classes.manage");

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
export const DEFAULT_CATEGORIES = ["Birth certificate", "Transfer certificate", "Report card", "ID proof", "Medical", "Photo", "Qualification", "Appointment letter", "Other"];

export interface DirectorySettings {
  teachersCanViewDocuments: boolean;
  teachersCanUploadDocuments: boolean;
  teachersCanSeeContacts: boolean;
  maxUploadMb: number;
  documentCategories: string[];
}

const DEFAULTS: DirectorySettings = {
  teachersCanViewDocuments: true,
  teachersCanUploadDocuments: false,
  teachersCanSeeContacts: true,
  maxUploadMb: 5,
  documentCategories: DEFAULT_CATEGORIES,
};

/** Hard ceiling on one file whatever the setting (the request body limit matches it). */
export const MAX_UPLOAD_MB = 10;

async function loadSettings(db: Db, tenantId: string): Promise<DirectorySettings> {
  const row = (await db.query(`SELECT settings -> 'directory' AS d FROM tenants WHERE id = $1`, [tenantId])).rows[0];
  return { ...DEFAULTS, ...(row?.d ?? {}) };
}

const settingsSchema = z.object({
  teachersCanViewDocuments: z.boolean(),
  teachersCanUploadDocuments: z.boolean(),
  teachersCanSeeContacts: z.boolean(),
  maxUploadMb: z.number().int().min(1).max(MAX_UPLOAD_MB),
  documentCategories: z.array(z.string().trim().min(1).max(60)).min(1).max(40),
});

directoryRouter.get(
  "/settings",
  requirePermission("directory.manage", "classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const settings = await withTenant(tenant.id, (db) => loadSettings(db, tenant.id));
    res.json({ settings, canManage: canManage(req) });
  }),
);

directoryRouter.put(
  "/settings",
  requirePermission("directory.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const b = parse(settingsSchema, req.body);
    const settings = { ...b, documentCategories: [...new Set(b.documentCategories)] };
    await withSystem(async (db) => {
      await db.query(`UPDATE tenants SET settings = jsonb_set(settings, '{directory}', $2::jsonb), updated_at = now() WHERE id = $1`, [tenant.id, JSON.stringify(settings)]);
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "directory.settings.update", metadata: settings });
    });
    res.json({ settings });
  }),
);

// ---------------------------------------------------------------------------
// Access helpers
// ---------------------------------------------------------------------------

/** Classes a teacher is in charge of: as class teacher or as a subject teacher. */
async function teacherClassIds(db: Db, userId: string): Promise<string[]> {
  const r = await db.query(
    `SELECT id FROM classes WHERE teacher_id = $1
     UNION SELECT class_id FROM class_subjects WHERE teacher_id = $1`,
    [userId],
  );
  return r.rows.map((x) => x.id);
}

async function assertClassAccess(req: Request, db: Db, classId: string) {
  if (canManage(req)) return;
  if (!isTeacher(req)) throw forbidden();
  const mine = await teacherClassIds(db, requireAuth(req).userId);
  if (!mine.includes(classId)) throw forbidden("You don't teach this class");
}

/** Who may open a student's profile: the principal / admins, or a teacher of one of the student's classes or activities. */
async function assertStudentAccess(req: Request, db: Db, studentId: string) {
  if (canManage(req)) return;
  if (!isTeacher(req)) throw forbidden();
  const { userId } = requireAuth(req);
  const r = await db.query(
    `SELECT 1 FROM class_enrollments e WHERE e.student_id = $1 AND e.class_id IN (
        SELECT id FROM classes WHERE teacher_id = $2 UNION SELECT class_id FROM class_subjects WHERE teacher_id = $2)
     UNION ALL
     SELECT 1 FROM activity_members m JOIN activities a ON a.id = m.activity_id WHERE m.student_id = $1 AND a.teacher_id = $2`,
    [studentId, userId],
  );
  if (!r.rowCount) throw forbidden("This student is not in your classes or activities");
}

/** Grade 1–12 from the class's grade ("Class 8", "8") or name ("8-A Science"); null otherwise (listed under "Other"). */
export function gradeNumber(grade: string | null, name: string): number | null {
  const m = (grade ?? "").match(/\d{1,2}/) ?? name.match(/^\s*(?:class\s*)?(\d{1,2})\b/i);
  const n = m ? Number(m[1] ?? m[0]) : NaN;
  return n >= 1 && n <= 12 ? n : null;
}

// ---------------------------------------------------------------------------
// Overview, staff
// ---------------------------------------------------------------------------
directoryRouter.get(
  "/summary",
  requirePermission("directory.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const r = (
        await db.query(
          `SELECT
             (SELECT count(DISTINCT user_id)::int FROM tenant_memberships WHERE tenant_id = $1 AND status = 'active' AND role_id = ANY($2::text[])) AS staff,
             (SELECT count(DISTINCT user_id)::int FROM tenant_memberships WHERE tenant_id = $1 AND status = 'active' AND role_id = 'teacher') AS teachers,
             (SELECT count(*)::int FROM student_profiles sp JOIN tenant_memberships m ON m.user_id = sp.user_id AND m.tenant_id = sp.tenant_id AND m.role_id = 'student' AND m.status = 'active') AS students,
             (SELECT count(*)::int FROM classes) AS classes,
             (SELECT count(*)::int FROM activities) AS activities,
             (SELECT count(*)::int FROM profile_documents) AS documents`,
          [tenant.id, STAFF_ROLES],
        )
      ).rows[0];
      return r;
    });
    res.json({ summary: data });
  }),
);

const STAFF_SQL = `
  SELECT u.id AS user_id, u.name, u.email, array_agg(DISTINCT m.role_id) AS roles,
         p.employee_code, p.designation, p.department, p.date_joined, p.phone, p.blood_group, COALESCE(p.status, 'active') AS status,
         COALESCE((SELECT json_agg(json_build_object('id', cs.id, 'classId', c.id, 'className', c.name, 'grade', c.grade, 'subject', cs.subject) ORDER BY c.name, cs.subject)
                     FROM class_subjects cs JOIN classes c ON c.id = cs.class_id WHERE cs.teacher_id = u.id), '[]') AS subjects,
         COALESCE((SELECT json_agg(json_build_object('id', c.id, 'name', c.name) ORDER BY c.name) FROM classes c WHERE c.teacher_id = u.id), '[]') AS class_teacher_of,
         COALESCE((SELECT json_agg(json_build_object('id', a.id, 'name', a.name, 'category', a.category) ORDER BY a.name) FROM activities a WHERE a.teacher_id = u.id), '[]') AS activities,
         (SELECT count(*)::int FROM profile_documents d WHERE d.staff_id = u.id) AS documents
    FROM tenant_memberships m JOIN users u ON u.id = m.user_id
    LEFT JOIN staff_profiles p ON p.user_id = u.id AND p.tenant_id = m.tenant_id
   WHERE m.tenant_id = $1 AND m.status = 'active' AND m.role_id = ANY($2::text[])`;

directoryRouter.get(
  "/staff",
  requirePermission("directory.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const rows = await withTenant(tenant.id, (db) => db.query(`${STAFF_SQL} GROUP BY u.id, p.id ORDER BY u.name`, [tenant.id, STAFF_ROLES]));
    res.json({ staff: rows.rows });
  }),
);

directoryRouter.get(
  "/staff/:userId",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const self = req.params.userId === userId;
    if (!canManage(req) && !self) throw forbidden();
    const data = await withTenant(tenant.id, async (db) => {
      const member = (await db.query(`${STAFF_SQL} AND u.id = $3 GROUP BY u.id, p.id`, [tenant.id, STAFF_ROLES, req.params.userId])).rows[0];
      if (!member) throw notFound("Staff member");
      const timetable = (
        await db.query(
          `SELECT t.day_of_week, t.start_time, t.end_time, t.subject, t.room, c.name AS class_name
             FROM timetable_slots t JOIN classes c ON c.id = t.class_id WHERE t.teacher_id = $1 ORDER BY t.day_of_week, t.start_time`,
          [req.params.userId],
        )
      ).rows;
      const documents = await listDocuments(db, { staffId: req.params.userId, adminView: canManage(req) });
      return { staff: member, timetable, documents };
    });
    res.json(data);
  }),
);

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------
directoryRouter.get(
  "/classes",
  requirePermission("directory.manage", "classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const all = canManage(req);
    const rows = await withTenant(tenant.id, async (db) => {
      const ids = all ? null : await teacherClassIds(db, userId);
      return (
        await db.query(
          `SELECT c.id, c.name, c.board, c.grade, c.section, c.teacher_id, u.name AS class_teacher,
                  (SELECT count(*)::int FROM class_enrollments e WHERE e.class_id = c.id) AS students,
                  COALESCE((SELECT json_agg(json_build_object('id', cs.id, 'subject', cs.subject, 'teacherId', cs.teacher_id, 'teacher', tu.name) ORDER BY cs.subject)
                              FROM class_subjects cs LEFT JOIN users tu ON tu.id = cs.teacher_id WHERE cs.class_id = c.id), '[]') AS subjects
             FROM classes c JOIN users u ON u.id = c.teacher_id
            WHERE $1::uuid[] IS NULL OR c.id = ANY($1::uuid[])
            ORDER BY c.name`,
          [ids],
        )
      ).rows;
    });
    const classes = rows.map((c) => ({ ...c, grade_number: gradeNumber(c.grade, c.name), i_am_class_teacher: c.teacher_id === userId }));
    classes.sort((a, b) => (a.grade_number ?? 99) - (b.grade_number ?? 99) || (a.section ?? a.name).localeCompare(b.section ?? b.name));
    res.json({ classes, canManage: all });
  }),
);

/** Per-student attendance rate and gradebook percentage within a set of classes. */
async function studentStats(db: Db, studentIds: string[], classIds: string[] | null) {
  const att = await db.query(
    `SELECT student_id, ${ATTENDED_SQL}::int AS attended, ${COUNTED_SQL}::int AS counted
       FROM attendance_records WHERE student_id = ANY($1::uuid[]) AND ($2::uuid[] IS NULL OR class_id = ANY($2::uuid[])) GROUP BY student_id`,
    [studentIds, classIds],
  );
  const marks = await db.query(
    `SELECT s.student_id, sum(s.marks) AS got, sum(i.max_marks) AS max
       FROM grade_scores s JOIN grade_items i ON i.id = s.item_id
      WHERE s.student_id = ANY($1::uuid[]) AND s.marks IS NOT NULL AND ($2::uuid[] IS NULL OR i.class_id = ANY($2::uuid[]))
      GROUP BY s.student_id`,
    [studentIds, classIds],
  );
  const a = new Map(att.rows.map((r) => [r.student_id, r.counted ? round1((r.attended / r.counted) * 100) : null]));
  const m = new Map(marks.rows.map((r) => [r.student_id, Number(r.max) ? round1((Number(r.got) / Number(r.max)) * 100) : null]));
  return (id: string) => {
    const percent = m.get(id) ?? null;
    return { attendance_rate: a.get(id) ?? null, percent, grade: gradeFor(percent) };
  };
}

/** Results of every exam with papers in the given classes, for the given students. */
async function examResults(db: Db, classIds: string[], studentIds: string[]) {
  if (!classIds.length) return [];
  const papers = (
    await db.query(
      `SELECT p.id, p.exam_id, p.class_id, p.subject, p.max_marks, p.pass_marks, p.grade_item_id, e.name, e.term, e.status, e.start_date
         FROM exam_papers p JOIN exams e ON e.id = p.exam_id
        WHERE p.class_id = ANY($1::uuid[]) AND e.status <> 'draft'
        ORDER BY e.start_date NULLS LAST, p.date, p.start_time`,
      [classIds],
    )
  ).rows;
  const scores = await db.query(
    `SELECT item_id, student_id, marks FROM grade_scores WHERE item_id = ANY($1::uuid[]) AND student_id = ANY($2::uuid[])`,
    [papers.map((p) => p.grade_item_id).filter(Boolean), studentIds],
  );
  const enrol = await db.query(`SELECT class_id, student_id FROM class_enrollments WHERE class_id = ANY($1::uuid[]) AND student_id = ANY($2::uuid[])`, [classIds, studentIds]);
  const enrolled = new Set(enrol.rows.map((r) => `${r.class_id}:${r.student_id}`));
  const score = new Map(scores.rows.map((s) => [`${s.item_id}:${s.student_id}`, s.marks == null ? null : Number(s.marks)]));
  const exams = new Map<string, { id: string; name: string; term: string; status: string; start_date: string | null; papers: (PaperRow & { class_id: string })[] }>();
  for (const p of papers) {
    if (!exams.has(p.exam_id)) exams.set(p.exam_id, { id: p.exam_id, name: p.name, term: p.term, status: p.status, start_date: p.start_date, papers: [] });
    exams.get(p.exam_id)!.papers.push(p);
  }
  return [...exams.values()].map((e) => {
    const students = studentIds.map((sid) => {
      const mine = e.papers.filter((p) => enrolled.has(`${p.class_id}:${sid}`));
      return { student_id: sid, ...summarise(mine, (p) => (p.grade_item_id ? (score.get(`${p.grade_item_id}:${sid}`) ?? null) : null)) };
    }).filter((s) => s.papers.length);
    const scored = students.filter((s) => s.percent != null);
    return {
      id: e.id,
      name: e.name,
      term: e.term,
      status: e.status,
      start_date: e.start_date,
      subjects: [...new Set(e.papers.map((p) => p.subject))],
      students,
      summary: {
        students: students.length,
        passed: students.filter((s) => s.result === "pass").length,
        failed: students.filter((s) => s.result === "fail").length,
        average: scored.length ? round1(scored.reduce((t, s) => t + s.percent!, 0) / scored.length) : null,
        highest: scored.length ? Math.max(...scored.map((s) => s.percent!)) : null,
      },
    };
  });
}

directoryRouter.get(
  "/classes/:id",
  requirePermission("directory.manage", "classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const cls = (
        await db.query(
          `SELECT c.id, c.name, c.board, c.grade, c.section, c.teacher_id, u.name AS class_teacher, u.email AS class_teacher_email, y.name AS academic_year
             FROM classes c JOIN users u ON u.id = c.teacher_id LEFT JOIN academic_years y ON y.id = c.academic_year_id WHERE c.id = $1`,
          [req.params.id],
        )
      ).rows[0];
      if (!cls) throw notFound("Class");
      await assertClassAccess(req, db, cls.id);
      const subjects = await subjectDetails(db, cls);
      const students = (
        await db.query(
          `SELECT sp.id AS student_id, u.name, u.email, sp.admission_no, sp.guardian_name, sp.guardian_phone
             FROM class_enrollments e JOIN student_profiles sp ON sp.id = e.student_id JOIN users u ON u.id = sp.user_id
            WHERE e.class_id = $1 ORDER BY u.name`,
          [cls.id],
        )
      ).rows;
      const ids = students.map((s) => s.student_id);
      const stats = await studentStats(db, ids, [cls.id]);
      const att = (await db.query(`SELECT ${ATTENDED_SQL}::int AS attended, ${COUNTED_SQL}::int AS counted, count(DISTINCT date)::int AS days FROM attendance_records WHERE class_id = $1`, [cls.id])).rows[0];
      const items = (
        await db.query(
          `SELECT i.id, i.title, i.term, i.category, i.max_marks, i.date,
                  count(s.marks)::int AS scored, avg(s.marks) AS average, max(s.marks) AS highest
             FROM grade_items i LEFT JOIN grade_scores s ON s.item_id = i.id AND s.marks IS NOT NULL
            WHERE i.class_id = $1 GROUP BY i.id ORDER BY i.date NULLS LAST, i.created_at`,
          [cls.id],
        )
      ).rows.map((i) => ({ ...i, average_percent: i.average == null ? null : round1((Number(i.average) / Number(i.max_marks)) * 100) }));
      const hw = (
        await db.query(
          `SELECT count(DISTINCT a.id)::int AS total, count(s.id)::int AS submissions FROM assignments a
             LEFT JOIN assignment_submissions s ON s.assignment_id = a.id WHERE a.class_id = $1`,
          [cls.id],
        )
      ).rows[0];
      const exams = await examResults(db, [cls.id], ids);
      const roster = students.map((s) => ({ ...s, ...stats(s.student_id) }));
      const graded = roster.filter((s) => s.percent != null);
      return {
        class: { ...cls, grade_number: gradeNumber(cls.grade, cls.name) },
        subjects,
        students: roster,
        report: {
          attendance: { ...att, rate: att.counted ? round1((att.attended / att.counted) * 100) : null },
          average: graded.length ? round1(graded.reduce((t, s) => t + s.percent!, 0) / graded.length) : null,
          gradeItems: items,
          assignments: { total: hw.total, submissions: hw.submissions, expected: hw.total * students.length },
        },
        exams,
      };
    });
    res.json(data);
  }),
);

/** A class's subjects with teacher, prescribed books and syllabus chapters (with this class's plan status). */
async function subjectDetails(db: Db, cls: { id: string; board: string | null; grade: string | null }) {
  const subjects = (
    await db.query(
      `SELECT cs.id, cs.subject, cs.periods_per_week, cs.teacher_id, u.name AS teacher, cs.syllabus_id, sy.source AS syllabus_source,
              (SELECT count(*)::int FROM syllabus_plan_items i WHERE i.class_subject_id = cs.id) AS units,
              (SELECT count(*)::int FROM syllabus_plan_items i WHERE i.class_subject_id = cs.id AND i.status = 'completed') AS units_done
         FROM class_subjects cs LEFT JOIN users u ON u.id = cs.teacher_id LEFT JOIN syllabi sy ON sy.id = cs.syllabus_id
        WHERE cs.class_id = $1 ORDER BY cs.subject`,
      [cls.id],
    )
  ).rows;
  const units = (
    await db.query(
      `SELECT su.syllabus_id, su.id, su.sequence, su.title, su.topics, su.est_periods, su.term_sequence AS unit_term,
              p.class_subject_id, p.status, p.planned_start, p.planned_end, p.completed_on, p.term_sequence
         FROM syllabus_units su
         JOIN class_subjects cs ON cs.syllabus_id = su.syllabus_id AND cs.class_id = $1
         LEFT JOIN syllabus_plan_items p ON p.unit_id = su.id AND p.class_subject_id = cs.id
        ORDER BY su.sequence`,
      [cls.id],
    )
  ).rows;
  const books = cls.grade ? await booksFor(db, cls.board, cls.grade) : [];
  return subjects.map((sub) => ({
    ...sub,
    chapters: units.filter((u) => u.syllabus_id === sub.syllabus_id).map(({ syllabus_id: _s, class_subject_id: _c, ...u }) => ({ ...u, status: u.status ?? "planned" })),
    books: books.filter((b) => b.subject.toLowerCase() === sub.subject.toLowerCase()),
  }));
}

async function booksFor(db: Db, board: string | null, grade: string) {
  return (
    await db.query(
      `SELECT b.*, lb.title AS library_title, lb.shelf AS library_shelf,
              (lb.total_copies - (SELECT count(*)::int FROM library_loans l WHERE l.book_id = lb.id AND l.returned_at IS NULL)) AS library_available
         FROM subject_books b LEFT JOIN library_books lb ON lb.id = b.library_book_id
        WHERE lower(b.grade) = lower($2) AND (b.board IS NULL OR $1::text IS NULL OR lower(b.board) = lower($1))
        ORDER BY b.subject, b.sequence, b.title`,
      [board, grade],
    )
  ).rows;
}

// ---------------------------------------------------------------------------
// Setting up Class 1–12 and their sections
// ---------------------------------------------------------------------------

/** A typical CBSE / state-board subject list for a grade; the principal can change it before creating. */
export function defaultSubjects(grade: number): string[] {
  if (grade <= 2) return ["English", "Hindi", "Mathematics"];
  if (grade <= 5) return ["English", "Hindi", "Mathematics", "EVS"];
  if (grade <= 8) return ["English", "Hindi", "Sanskrit", "Mathematics", "Science", "Social Science"];
  if (grade <= 10) return ["English", "Hindi", "Mathematics", "Science", "Social Science"];
  return ["English", "Physics", "Chemistry", "Mathematics", "Biology"];
}

directoryRouter.get(
  "/default-subjects",
  requirePermission("directory.manage"),
  (_req, res) => {
    res.json({ subjects: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, defaultSubjects(i + 1)])) });
  },
);

directoryRouter.post(
  "/classes/setup",
  requirePermission("directory.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const b = parse(
      z.object({
        grades: z.array(z.number().int().min(1).max(12)).min(1).max(12),
        sections: z.array(z.string().trim().min(1).max(10)).min(1).max(12),
        board: z.string().trim().max(60).default("CBSE"),
        classTeacherId: z.string().uuid().nullish(),
        subjects: z.record(z.string(), z.array(z.string().trim().min(1).max(80)).max(20)).default({}),
      }),
      req.body,
    );
    const result = await withTenant(tenant.id, async (db) => {
      await checkTeacher(db, tenant.id, b.classTeacherId);
      const year = (await db.query(`SELECT id FROM academic_years WHERE is_current LIMIT 1`)).rows[0]?.id ?? null;
      let created = 0;
      let subjectsAdded = 0;
      const skipped: string[] = [];
      for (const g of [...new Set(b.grades)].sort((x, y) => x - y)) {
        const grade = `Class ${g}`;
        for (const section of [...new Set(b.sections.map((x) => x.toUpperCase()))]) {
          const name = `${g}-${section}`;
          const exists = await db.query(`SELECT 1 FROM classes WHERE (lower(grade) = lower($1) AND lower(section) = lower($2)) OR lower(name) = lower($3)`, [grade, section, name]);
          if (exists.rowCount) {
            skipped.push(name);
            continue;
          }
          const c = (
            await db.query(`INSERT INTO classes (tenant_id, name, teacher_id, board, grade, section, academic_year_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [
              tenant.id, name, b.classTeacherId ?? userId, b.board || null, grade, section, year,
            ])
          ).rows[0];
          created++;
          for (const subject of [...new Set(b.subjects[String(g)] ?? defaultSubjects(g))]) {
            const syl = (
              await db.query(`SELECT id FROM syllabi WHERE lower(board) = lower($1) AND lower(grade) = lower($2) AND lower(subject) = lower($3) ORDER BY academic_year_id IS NULL LIMIT 1`, [b.board, grade, subject])
            ).rows[0]?.id;
            await db.query(`INSERT INTO class_subjects (tenant_id, class_id, subject, syllabus_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [tenant.id, c.id, subject, syl ?? null]);
            subjectsAdded++;
          }
        }
      }
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "classes.setup", metadata: { grades: b.grades, sections: b.sections, created } });
      return { created, subjects: subjectsAdded, skipped };
    });
    res.status(201).json(result);
  }),
);

directoryRouter.patch(
  "/classes/:id",
  requirePermission("directory.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const b = parse(z.object({ name: z.string().trim().min(1).max(80).optional(), classTeacherId: z.string().uuid().optional() }), req.body);
    const row = await withTenant(tenant.id, async (db) => {
      await checkTeacher(db, tenant.id, b.classTeacherId);
      const r = await db.query(`UPDATE classes SET name = COALESCE($2, name), teacher_id = COALESCE($3, teacher_id) WHERE id = $1 RETURNING id, name, teacher_id`, [req.params.id, b.name ?? null, b.classTeacherId ?? null]);
      if (!r.rowCount) throw notFound("Class");
      return r.rows[0];
    });
    res.json({ class: row });
  }),
);

/** Remove a section created by mistake; only while no students are enrolled. */
directoryRouter.delete(
  "/classes/:id",
  requirePermission("directory.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    await withTenant(tenant.id, async (db) => {
      const c = (await db.query(`SELECT id, name, (SELECT count(*)::int FROM class_enrollments e WHERE e.class_id = classes.id) AS students FROM classes WHERE id = $1`, [req.params.id])).rows[0];
      if (!c) throw notFound("Class");
      if (c.students) throw badRequest(`${c.name} has ${c.students} students; move them to another section first`);
      const used = await db.query(`SELECT 1 FROM live_sessions WHERE class_id = $1 UNION ALL SELECT 1 FROM exam_papers WHERE class_id = $1 UNION ALL SELECT 1 FROM grade_items WHERE class_id = $1 LIMIT 1`, [c.id]);
      if (used.rowCount) throw badRequest(`${c.name} already has lessons, exams or marks and can't be deleted`);
      await db.query(`DELETE FROM classes WHERE id = $1`, [c.id]);
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "class.delete", resourceType: "class", resourceId: c.id, metadata: { name: c.name } });
    });
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------------------
// Prescribed books per grade and subject
// ---------------------------------------------------------------------------
const bookSchema = z.object({
  board: z.string().trim().max(60).nullish(),
  grade: z.string().trim().min(1).max(40),
  subject: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(200),
  kind: z.enum(["textbook", "workbook", "reference", "lab_manual", "other"]).default("textbook"),
  author: z.string().trim().max(160).default(""),
  publisher: z.string().trim().max(160).default(""),
  isbn: z.string().trim().max(20).nullish(),
  note: z.string().trim().max(500).default(""),
  libraryBookId: z.string().uuid().nullish(),
  sequence: z.number().int().min(1).max(99).default(1),
});
const canEditBooks = requirePermission("directory.manage", "academics.manage");

directoryRouter.get(
  "/books",
  requirePermission("directory.manage", "classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(z.object({ grade: z.string().trim().max(40).optional() }), req.query);
    const rows = await withTenant(tenant.id, (db) =>
      q.grade ? booksFor(db, null, q.grade) : db.query(`SELECT * FROM subject_books ORDER BY grade, subject, sequence, title`).then((r) => r.rows),
    );
    res.json({ books: rows });
  }),
);

directoryRouter.post(
  "/books",
  canEditBooks,
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const b = parse(bookSchema, req.body);
    const row = await withTenant(tenant.id, async (db) => {
      if (b.libraryBookId && !(await db.query(`SELECT 1 FROM library_books WHERE id = $1`, [b.libraryBookId])).rowCount) throw notFound("Library book");
      return (
        await db.query(
          `INSERT INTO subject_books (tenant_id, board, grade, subject, title, kind, author, publisher, isbn, note, library_book_id, sequence)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [tenant.id, b.board || null, b.grade, b.subject, b.title, b.kind, b.author, b.publisher, b.isbn || null, b.note, b.libraryBookId ?? null, b.sequence],
        )
      ).rows[0];
    });
    res.status(201).json({ book: row });
  }),
);

directoryRouter.put(
  "/books/:id",
  canEditBooks,
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const b = parse(bookSchema, req.body);
    const row = await withTenant(tenant.id, async (db) => {
      const r = await db.query(
        `UPDATE subject_books SET board = $2, grade = $3, subject = $4, title = $5, kind = $6, author = $7, publisher = $8, isbn = $9, note = $10, library_book_id = $11, sequence = $12
          WHERE id = $1 RETURNING *`,
        [req.params.id, b.board || null, b.grade, b.subject, b.title, b.kind, b.author, b.publisher, b.isbn || null, b.note, b.libraryBookId ?? null, b.sequence],
      );
      if (!r.rowCount) throw notFound("Book");
      return r.rows[0];
    });
    res.json({ book: row });
  }),
);

directoryRouter.delete(
  "/books/:id",
  canEditBooks,
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    await withTenant(tenant.id, async (db) => {
      const r = await db.query(`DELETE FROM subject_books WHERE id = $1`, [req.params.id]);
      if (!r.rowCount) throw notFound("Book");
    });
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------
directoryRouter.get(
  "/students",
  requirePermission("directory.manage", "classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const q = parse(z.object({ classId: z.string().uuid().optional(), q: z.string().trim().max(100).optional() }), req.query);
    const data = await withTenant(tenant.id, async (db) => {
      const ids = canManage(req) ? null : await teacherClassIds(db, userId);
      if (q.classId) await assertClassAccess(req, db, q.classId);
      const rows = (
        await db.query(
          `SELECT sp.id AS student_id, u.name, u.email, sp.admission_no, sp.date_of_birth, sp.guardian_name, sp.guardian_phone,
                  COALESCE(json_agg(json_build_object('id', c.id, 'name', c.name, 'grade', c.grade) ORDER BY c.name) FILTER (WHERE c.id IS NOT NULL), '[]') AS classes
             FROM student_profiles sp JOIN users u ON u.id = sp.user_id
             JOIN tenant_memberships m ON m.user_id = sp.user_id AND m.tenant_id = sp.tenant_id AND m.role_id = 'student' AND m.status = 'active'
             LEFT JOIN class_enrollments e ON e.student_id = sp.id
             LEFT JOIN classes c ON c.id = e.class_id
            WHERE ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM class_enrollments x WHERE x.student_id = sp.id AND x.class_id = $1))
              AND ($2::uuid[] IS NULL OR EXISTS (SELECT 1 FROM class_enrollments x WHERE x.student_id = sp.id AND x.class_id = ANY($2::uuid[])))
              AND ($3::text IS NULL OR u.name ILIKE '%' || $3 || '%' OR u.email ILIKE '%' || $3 || '%' OR sp.admission_no ILIKE '%' || $3 || '%')
            GROUP BY sp.id, u.id ORDER BY u.name LIMIT 1000`,
          [q.classId ?? null, ids, q.q || null],
        )
      ).rows;
      const stats = await studentStats(db, rows.map((r) => r.student_id), null);
      return rows.map((r) => ({ ...r, ...stats(r.student_id) }));
    });
    res.json({ students: data });
  }),
);

directoryRouter.get(
  "/students/:id",
  requirePermission("directory.manage", "classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const s = (
        await db.query(
          `SELECT sp.id, sp.user_id, u.name, u.email, sp.admission_no, sp.date_of_birth, sp.blood_group, sp.guardian_name, sp.guardian_phone,
                  sp.address, sp.admitted_on, sp.language, sp.created_at
             FROM student_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.id = $1`,
          [req.params.id],
        )
      ).rows[0];
      if (!s) throw notFound("Student");
      await assertStudentAccess(req, db, s.id);
      const settings = await loadSettings(db, tenant.id);
      const admin = canManage(req);
      const hideContacts = !admin && !settings.teachersCanSeeContacts;
      const parents = (
        await db.query(
          `SELECT u.id, u.name, u.email, l.relationship, l.consent_status FROM parent_student_links l JOIN users u ON u.id = l.parent_id
            WHERE l.student_id = $1 ORDER BY u.name`,
          [s.id],
        )
      ).rows.map((p) => (hideContacts ? { ...p, email: null } : p));
      const classes = (
        await db.query(
          `SELECT c.id, c.name, c.grade, c.section, u.name AS class_teacher,
                  COALESCE((SELECT json_agg(json_build_object('subject', cs.subject, 'teacher', tu.name) ORDER BY cs.subject)
                              FROM class_subjects cs LEFT JOIN users tu ON tu.id = cs.teacher_id WHERE cs.class_id = c.id), '[]') AS subjects
             FROM class_enrollments e JOIN classes c ON c.id = e.class_id JOIN users u ON u.id = c.teacher_id
            WHERE e.student_id = $1 ORDER BY c.name`,
          [s.id],
        )
      ).rows;
      const classIds = classes.map((c) => c.id);
      const att = (
        await db.query(
          `SELECT ${ATTENDED_SQL}::int AS attended, ${COUNTED_SQL}::int AS counted,
                  count(*) FILTER (WHERE status = 'absent')::int AS absent, count(*) FILTER (WHERE status = 'late')::int AS late
             FROM attendance_records WHERE student_id = $1`,
          [s.id],
        )
      ).rows[0];
      const recentAbsences = (
        await db.query(
          `SELECT a.date, a.status, a.note, c.name AS class_name FROM attendance_records a JOIN classes c ON c.id = a.class_id
            WHERE a.student_id = $1 AND a.status <> 'present' ORDER BY a.date DESC LIMIT 10`,
          [s.id],
        )
      ).rows;
      const items = (
        await db.query(
          `SELECT i.id, i.class_id, i.title, i.term, i.category, i.max_marks, i.date, sc.marks, sc.remarks
             FROM grade_items i LEFT JOIN grade_scores sc ON sc.item_id = i.id AND sc.student_id = $1
            WHERE i.class_id = ANY($2::uuid[]) ORDER BY i.date NULLS LAST, i.created_at`,
          [s.id, classIds],
        )
      ).rows;
      const marks = classes.map((c) => {
        const mine = items.filter((i) => i.class_id === c.id);
        const scored = mine.filter((i) => i.marks != null);
        const max = scored.reduce((t, i) => t + Number(i.max_marks), 0);
        const got = scored.reduce((t, i) => t + Number(i.marks), 0);
        const percent = max ? round1((got / max) * 100) : null;
        return { classId: c.id, name: c.name, items: mine, obtained: got, max, percent, grade: gradeFor(percent) };
      });
      const graded = marks.filter((m) => m.percent != null);
      const overall = graded.length ? round1(graded.reduce((t, m) => t + m.percent!, 0) / graded.length) : null;
      const exams = (await examResults(db, classIds, [s.id])).map(({ students, summary, ...e }) => ({ ...e, result: students[0] ?? null, classAverage: summary.average }));
      const hw = (
        await db.query(
          `SELECT count(a.*)::int AS total, count(sub.id)::int AS submitted,
                  avg(CASE WHEN sub.graded_at IS NOT NULL THEN sub.points / a.max_points END) AS avg_score
             FROM assignments a JOIN class_enrollments e ON e.class_id = a.class_id AND e.student_id = $1
             LEFT JOIN assignment_submissions sub ON sub.assignment_id = a.id AND sub.student_id = $1`,
          [s.id],
        )
      ).rows[0];
      const activities = (
        await db.query(
          `SELECT a.id, a.name, a.category, a.schedule, m.role, u.name AS teacher FROM activity_members m JOIN activities a ON a.id = m.activity_id
             LEFT JOIN users u ON u.id = a.teacher_id WHERE m.student_id = $1 ORDER BY a.name`,
          [s.id],
        )
      ).rows;
      const canSeeDocs = admin || settings.teachersCanViewDocuments;
      const documents = canSeeDocs ? await listDocuments(db, { studentId: s.id, adminView: admin }) : [];
      return {
        student: hideContacts ? { ...s, email: null, guardian_phone: null, address: null } : s,
        parents,
        classes,
        attendance: { ...att, rate: att.counted ? round1((att.attended / att.counted) * 100) : null, recent: recentAbsences },
        marks,
        overall: { percent: overall, grade: gradeFor(overall) },
        exams,
        assignments: { total: hw.total, submitted: hw.submitted, averagePercent: hw.avg_score == null ? null : round1(Number(hw.avg_score) * 100) },
        activities,
        documents,
        permissions: {
          edit: admin,
          viewDocuments: canSeeDocs,
          uploadDocuments: admin || settings.teachersCanUploadDocuments,
        },
      };
    });
    res.json(data);
  }),
);

directoryRouter.patch(
  "/students/:id",
  requirePermission("directory.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const b = parse(
      z.object({
        admissionNo: z.string().trim().max(40).nullish(),
        dateOfBirth: date.nullish(),
        bloodGroup: z.string().trim().max(5).nullish(),
        guardianName: z.string().trim().max(120).nullish(),
        guardianPhone: z.string().trim().max(20).nullish(),
        address: z.string().trim().max(500).nullish(),
        admittedOn: date.nullish(),
      }),
      req.body,
    );
    const row = await withTenant(tenant.id, async (db) => {
      const dup = b.admissionNo ? await db.query(`SELECT 1 FROM student_profiles WHERE admission_no = $1 AND id <> $2`, [b.admissionNo, req.params.id]) : null;
      if (dup?.rowCount) throw badRequest(`Admission number ${b.admissionNo} is already used`);
      const r = await db.query(
        `UPDATE student_profiles SET admission_no = $2, date_of_birth = $3, blood_group = $4, guardian_name = $5, guardian_phone = $6, address = $7, admitted_on = $8
          WHERE id = $1 RETURNING id, admission_no, date_of_birth, blood_group, guardian_name, guardian_phone, address, admitted_on`,
        [req.params.id, b.admissionNo || null, b.dateOfBirth ?? null, b.bloodGroup || null, b.guardianName || null, b.guardianPhone || null, b.address || null, b.admittedOn ?? null],
      );
      if (!r.rowCount) throw notFound("Student");
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "student.profile.update", resourceType: "student_profile", resourceId: req.params.id });
      return r.rows[0];
    });
    res.json({ student: row });
  }),
);

// ---------------------------------------------------------------------------
// A teacher's own load: classes, subjects and activities
// ---------------------------------------------------------------------------
directoryRouter.get(
  "/my-teaching",
  requirePermission("classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const data = await withTenant(tenant.id, async (db) => {
      const subjects = (
        await db.query(
          `SELECT cs.id, cs.subject, cs.periods_per_week, c.id AS class_id, c.name AS class_name, c.grade, c.section,
                  (SELECT count(*)::int FROM class_enrollments e WHERE e.class_id = c.id) AS students,
                  (SELECT count(*)::int FROM syllabus_plan_items i WHERE i.class_subject_id = cs.id) AS units,
                  (SELECT count(*)::int FROM syllabus_plan_items i WHERE i.class_subject_id = cs.id AND i.status = 'completed') AS units_done
             FROM class_subjects cs JOIN classes c ON c.id = cs.class_id WHERE cs.teacher_id = $1 ORDER BY c.name, cs.subject`,
          [userId],
        )
      ).rows.map((s) => ({ ...s, grade_number: gradeNumber(s.grade, s.class_name) }));
      const classTeacherOf = (
        await db.query(
          `SELECT c.id, c.name, c.grade, c.section, (SELECT count(*)::int FROM class_enrollments e WHERE e.class_id = c.id) AS students
             FROM classes c WHERE c.teacher_id = $1 ORDER BY c.name`,
          [userId],
        )
      ).rows.map((c) => ({ ...c, grade_number: gradeNumber(c.grade, c.name) }));
      const activities = (
        await db.query(
          `SELECT a.*, (SELECT count(*)::int FROM activity_members m WHERE m.activity_id = a.id) AS members FROM activities a WHERE a.teacher_id = $1 ORDER BY a.name`,
          [userId],
        )
      ).rows;
      return { subjects, classTeacherOf, activities };
    });
    res.json(data);
  }),
);

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------
const ALLOWED_TYPES: Record<string, string> = {
  "application/pdf": "PDF",
  "image/png": "Image",
  "image/jpeg": "Image",
  "image/webp": "Image",
  "image/gif": "Image",
  "text/plain": "Text",
  "application/msword": "Word",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
  "application/vnd.ms-excel": "Excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
};

async function listDocuments(db: Db, o: { studentId?: string; staffId?: string; adminView: boolean }) {
  return (
    await db.query(
      `SELECT d.id, d.title, d.category, d.file_name, d.mime_type, d.size_bytes, d.visibility, d.created_at, d.uploaded_by, u.name AS uploaded_by_name
         FROM profile_documents d JOIN users u ON u.id = d.uploaded_by
        WHERE ($1::uuid IS NULL OR d.student_id = $1) AND ($2::uuid IS NULL OR d.staff_id = $2) AND ($3::boolean OR d.visibility = 'staff')
        ORDER BY d.created_at DESC`,
      [o.studentId ?? null, o.staffId ?? null, o.adminView],
    )
  ).rows;
}

/** Load a document and check the caller may see it. */
async function loadDocument(req: Request, db: Db, id: string, withContent = false) {
  const d = (await db.query(`SELECT id, owner_type, student_id, staff_id, title, category, file_name, mime_type, size_bytes, visibility, uploaded_by${withContent ? ", content" : ""} FROM profile_documents WHERE id = $1`, [id])).rows[0];
  if (!d) throw notFound("Document");
  if (canManage(req)) return d;
  const { userId } = requireAuth(req);
  if (d.visibility !== "staff") throw notFound("Document");
  if (d.owner_type === "staff") {
    if (d.staff_id !== userId) throw forbidden();
    return d;
  }
  const settings = await loadSettings(db, requireTenant(req).id);
  if (!settings.teachersCanViewDocuments) throw forbidden("Your school has turned off document access for teachers");
  await assertStudentAccess(req, db, d.student_id);
  return d;
}

directoryRouter.get(
  "/documents",
  requirePermission("directory.manage", "classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(z.object({ studentId: z.string().uuid().optional(), staffId: z.string().uuid().optional() }), req.query);
    const docs = await withTenant(tenant.id, async (db) => {
      const admin = canManage(req);
      if (!q.studentId && !q.staffId) {
        if (!admin) throw badRequest("studentId or staffId is required");
        return (
          await db.query(
            `SELECT d.id, d.owner_type, d.student_id, d.staff_id, d.title, d.category, d.file_name, d.mime_type, d.size_bytes, d.visibility, d.created_at,
                    COALESCE(su.name, tu.name) AS owner_name, u.name AS uploaded_by_name
               FROM profile_documents d JOIN users u ON u.id = d.uploaded_by
               LEFT JOIN student_profiles sp ON sp.id = d.student_id LEFT JOIN users su ON su.id = sp.user_id
               LEFT JOIN users tu ON tu.id = d.staff_id
              ORDER BY d.created_at DESC LIMIT 500`,
          )
        ).rows;
      }
      if (q.studentId) {
        await assertStudentAccess(req, db, q.studentId);
        if (!admin && !(await loadSettings(db, tenant.id)).teachersCanViewDocuments) return [];
      }
      if (q.staffId && !admin && q.staffId !== requireAuth(req).userId) throw forbidden();
      return listDocuments(db, { studentId: q.studentId, staffId: q.staffId, adminView: admin });
    });
    res.json({ documents: docs });
  }),
);

directoryRouter.post(
  "/documents",
  requirePermission("directory.manage", "classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const b = parse(
      z.object({
        ownerType: z.enum(["student", "staff"]),
        ownerId: z.string().uuid(),
        title: z.string().trim().min(1).max(160),
        category: z.string().trim().min(1).max(60).default("Other"),
        visibility: z.enum(["admin", "staff"]).default("staff"),
        fileName: z.string().trim().min(1).max(200),
        mimeType: z.string().trim().max(120),
        data: z.string().min(1), // base64
      }),
      req.body,
    );
    if (!ALLOWED_TYPES[b.mimeType]) throw badRequest("Upload a PDF, image, Word, Excel or text file");
    const content = Buffer.from(b.data, "base64");
    if (!content.length) throw badRequest("The file is empty");
    const doc = await withTenant(tenant.id, async (db) => {
      const admin = canManage(req);
      const settings = await loadSettings(db, tenant.id);
      if (content.length > settings.maxUploadMb * 1024 * 1024) throw badRequest(`Files can be at most ${settings.maxUploadMb} MB`);
      if (!admin) {
        if (b.ownerType !== "student" || !settings.teachersCanUploadDocuments) throw forbidden("Only the principal or an admin can upload this document");
        await assertStudentAccess(req, db, b.ownerId);
      }
      if (b.ownerType === "student") {
        if (!(await db.query(`SELECT 1 FROM student_profiles WHERE id = $1`, [b.ownerId])).rowCount) throw notFound("Student");
      } else {
        const m = await db.query(`SELECT 1 FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' AND role_id = ANY($3::text[])`, [tenant.id, b.ownerId, STAFF_ROLES]);
        if (!m.rowCount) throw notFound("Staff member");
      }
      const r = (
        await db.query(
          `INSERT INTO profile_documents (tenant_id, owner_type, student_id, staff_id, title, category, file_name, mime_type, size_bytes, content, visibility, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING id, owner_type, student_id, staff_id, title, category, file_name, mime_type, size_bytes, visibility, created_at`,
          [
            tenant.id, b.ownerType, b.ownerType === "student" ? b.ownerId : null, b.ownerType === "staff" ? b.ownerId : null,
            b.title, b.category, b.fileName, b.mimeType, content.length, content, admin ? b.visibility : "staff", userId,
          ],
        )
      ).rows[0];
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "document.upload", resourceType: "profile_document", resourceId: r.id, metadata: { ownerType: b.ownerType, ownerId: b.ownerId } });
      return r;
    });
    res.status(201).json({ document: doc });
  }),
);

/** The file itself; `?download=1` saves it instead of opening it. */
directoryRouter.get(
  "/documents/:id/file",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const d = await withTenant(tenant.id, (db) => loadDocument(req, db, req.params.id, true));
    const name = String(d.file_name).replace(/["\\\r\n]/g, "_");
    res.setHeader("Content-Type", d.mime_type);
    res.setHeader("Content-Length", String(d.content.length));
    res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(d.file_name)}`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(d.content);
  }),
);

directoryRouter.patch(
  "/documents/:id",
  requirePermission("directory.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const b = parse(
      z.object({ title: z.string().trim().min(1).max(160).optional(), category: z.string().trim().min(1).max(60).optional(), visibility: z.enum(["admin", "staff"]).optional() }),
      req.body,
    );
    const row = await withTenant(tenant.id, async (db) => {
      const r = await db.query(
        `UPDATE profile_documents SET title = COALESCE($2, title), category = COALESCE($3, category), visibility = COALESCE($4, visibility)
          WHERE id = $1 RETURNING id, title, category, visibility`,
        [req.params.id, b.title ?? null, b.category ?? null, b.visibility ?? null],
      );
      if (!r.rowCount) throw notFound("Document");
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "document.update", resourceType: "profile_document", resourceId: req.params.id, metadata: b });
      return r.rows[0];
    });
    res.json({ document: row });
  }),
);

directoryRouter.delete(
  "/documents/:id",
  requirePermission("directory.manage", "classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    await withTenant(tenant.id, async (db) => {
      const d = await loadDocument(req, db, req.params.id);
      if (!canManage(req) && d.uploaded_by !== userId) throw forbidden("Only the principal, an admin or the uploader can delete this document");
      await db.query(`DELETE FROM profile_documents WHERE id = $1`, [d.id]);
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "document.delete", resourceType: "profile_document", resourceId: d.id, metadata: { title: d.title } });
    });
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------------------
// Co-curricular activities: sports, PT, clubs, arts, music
// ---------------------------------------------------------------------------
const activitySchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.enum(["sport", "pt", "club", "arts", "music", "other"]).default("sport"),
  teacherId: z.string().uuid().nullish(),
  schedule: z.string().trim().max(200).default(""),
  venue: z.string().trim().max(120).default(""),
  description: z.string().trim().max(2000).default(""),
});

async function checkTeacher(db: Db, tenantId: string, teacherId: string | null | undefined) {
  if (!teacherId) return;
  const m = await db.query(`SELECT 1 FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' AND role_id = ANY($3::text[])`, [tenantId, teacherId, STAFF_ROLES]);
  if (!m.rowCount) throw badRequest("The teacher in charge must be a staff member");
}

async function loadActivity(req: Request, db: Db, id: string, opts: { manage?: boolean } = {}) {
  const a = (await db.query(`SELECT a.*, u.name AS teacher FROM activities a LEFT JOIN users u ON u.id = a.teacher_id WHERE a.id = $1`, [id])).rows[0];
  if (!a) throw notFound("Activity");
  const coach = a.teacher_id === requireAuth(req).userId;
  if (!canManage(req) && !(opts.manage ? coach && isTeacher(req) : coach)) throw forbidden("Only the teacher in charge or an admin can do that");
  return a;
}

directoryRouter.get(
  "/activities",
  requirePermission("directory.manage", "classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const rows = await withTenant(tenant.id, (db) =>
      db.query(
        `SELECT a.*, u.name AS teacher, (SELECT count(*)::int FROM activity_members m WHERE m.activity_id = a.id) AS members
           FROM activities a LEFT JOIN users u ON u.id = a.teacher_id
          WHERE $1::boolean OR a.teacher_id = $2 ORDER BY a.category, a.name`,
        [canManage(req), userId],
      ),
    );
    res.json({ activities: rows.rows, canManage: canManage(req) });
  }),
);

directoryRouter.post(
  "/activities",
  requirePermission("directory.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const b = parse(activitySchema, req.body);
    const row = await withTenant(tenant.id, async (db) => {
      await checkTeacher(db, tenant.id, b.teacherId);
      if ((await db.query(`SELECT 1 FROM activities WHERE lower(name) = lower($1)`, [b.name])).rowCount) throw badRequest(`An activity called ${b.name} already exists`);
      const r = (
        await db.query(
          `INSERT INTO activities (tenant_id, name, category, teacher_id, schedule, venue, description) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [tenant.id, b.name, b.category, b.teacherId ?? null, b.schedule, b.venue, b.description],
        )
      ).rows[0];
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "activity.create", resourceType: "activity", resourceId: r.id });
      return r;
    });
    res.status(201).json({ activity: row });
  }),
);

directoryRouter.patch(
  "/activities/:id",
  requirePermission("directory.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const b = parse(activitySchema, req.body);
    const row = await withTenant(tenant.id, async (db) => {
      await checkTeacher(db, tenant.id, b.teacherId);
      if ((await db.query(`SELECT 1 FROM activities WHERE lower(name) = lower($1) AND id <> $2`, [b.name, req.params.id])).rowCount) throw badRequest(`An activity called ${b.name} already exists`);
      const r = await db.query(
        `UPDATE activities SET name = $2, category = $3, teacher_id = $4, schedule = $5, venue = $6, description = $7 WHERE id = $1 RETURNING *`,
        [req.params.id, b.name, b.category, b.teacherId ?? null, b.schedule, b.venue, b.description],
      );
      if (!r.rowCount) throw notFound("Activity");
      return r.rows[0];
    });
    res.json({ activity: row });
  }),
);

directoryRouter.delete(
  "/activities/:id",
  requirePermission("directory.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    await withTenant(tenant.id, async (db) => {
      const r = await db.query(`DELETE FROM activities WHERE id = $1 RETURNING name`, [req.params.id]);
      if (!r.rowCount) throw notFound("Activity");
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "activity.delete", resourceType: "activity", resourceId: req.params.id, metadata: r.rows[0] });
    });
    res.status(204).end();
  }),
);

directoryRouter.get(
  "/activities/:id",
  requirePermission("directory.manage", "classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const activity = await loadActivity(req, db, req.params.id);
      const members = (
        await db.query(
          `SELECT m.student_id, m.role, m.joined_at, u.name, sp.admission_no,
                  (SELECT string_agg(c.name, ', ' ORDER BY c.name) FROM class_enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = m.student_id) AS classes
             FROM activity_members m JOIN student_profiles sp ON sp.id = m.student_id JOIN users u ON u.id = sp.user_id
            WHERE m.activity_id = $1 ORDER BY u.name`,
          [activity.id],
        )
      ).rows;
      return { activity, members };
    });
    res.json(data);
  }),
);

directoryRouter.post(
  "/activities/:id/members",
  requirePermission("directory.manage", "classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const b = parse(
      z.object({ studentIds: z.array(z.string().uuid()).max(500).default([]), classId: z.string().uuid().optional(), role: z.string().trim().min(1).max(40).default("member") }).refine((x) => x.studentIds.length || x.classId, "Choose students or a class"),
      req.body,
    );
    const added = await withTenant(tenant.id, async (db) => {
      const activity = await loadActivity(req, db, req.params.id, { manage: true });
      let ids = b.studentIds;
      if (b.classId) {
        await assertClassAccess(req, db, b.classId);
        ids = [...ids, ...(await db.query(`SELECT student_id FROM class_enrollments WHERE class_id = $1`, [b.classId])).rows.map((r) => r.student_id)];
      }
      const valid = (await db.query(`SELECT id FROM student_profiles WHERE id = ANY($1::uuid[])`, [ids])).rows.map((r) => r.id);
      if (!valid.length) throw badRequest("No matching students");
      const r = await db.query(
        `INSERT INTO activity_members (tenant_id, activity_id, student_id, role)
         SELECT $1, $2, unnest($3::uuid[]), $4 ON CONFLICT (activity_id, student_id) DO UPDATE SET role = EXCLUDED.role`,
        [tenant.id, activity.id, valid, b.role],
      );
      return r.rowCount;
    });
    res.status(201).json({ added });
  }),
);

directoryRouter.delete(
  "/activities/:id/members/:studentId",
  requirePermission("directory.manage", "classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    await withTenant(tenant.id, async (db) => {
      const activity = await loadActivity(req, db, req.params.id, { manage: true });
      await db.query(`DELETE FROM activity_members WHERE activity_id = $1 AND student_id = $2`, [activity.id, req.params.studentId]);
    });
    res.status(204).end();
  }),
);
