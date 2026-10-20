import { Router } from "express";
import { z } from "zod";
import { withTenant } from "../../database/pool.js";
import { badRequest } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { resolveStudent } from "../../lib/student-access.js";
import { requirePermission } from "../../middleware/authorization.js";
import { loadClass, roster, round1 } from "./access.js";

export const attendanceRouter = Router();

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const today = () => new Date().toISOString().slice(0, 10);

/** Present and late both count as attended; excused days are left out of the rate. */
export const ATTENDED_SQL = `count(*) FILTER (WHERE status IN ('present','late'))`;
export const COUNTED_SQL = `count(*) FILTER (WHERE status <> 'excused')`;

/** Roster for one class and day, with any status already marked. */
attendanceRouter.get(
  "/classes/:classId",
  requirePermission("classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(z.object({ date: date.optional() }), req.query);
    const day = q.date ?? today();
    const data = await withTenant(tenant.id, async (db) => {
      const { cls } = await loadClass(req, db, req.params.classId, { manage: true });
      const students = await roster(db, cls.id);
      const marks = await db.query(`SELECT student_id, status, note FROM attendance_records WHERE class_id = $1 AND date = $2`, [cls.id, day]);
      const byStudent = new Map(marks.rows.map((m) => [m.student_id, m]));
      return {
        class: cls,
        date: day,
        marked: marks.rowCount! > 0,
        students: students.map((s) => ({ ...s, status: byStudent.get(s.student_id)?.status ?? null, note: byStudent.get(s.student_id)?.note ?? null })),
      };
    });
    res.json(data);
  }),
);

attendanceRouter.post(
  "/classes/:classId",
  requirePermission("classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(
      z.object({
        date: date.optional(),
        records: z
          .array(z.object({ studentId: z.string().uuid(), status: z.enum(["present", "absent", "late", "excused"]), note: z.string().trim().max(500).nullish() }))
          .min(1)
          .max(500),
      }),
      req.body,
    );
    const day = body.date ?? today();
    if (day > today()) throw badRequest("Attendance cannot be marked for a future date");
    const saved = await withTenant(tenant.id, async (db) => {
      const { cls } = await loadClass(req, db, req.params.classId, { manage: true });
      const enrolled = new Set((await roster(db, cls.id)).map((s) => s.student_id));
      const stray = body.records.find((r) => !enrolled.has(r.studentId));
      if (stray) throw badRequest("Every student must be enrolled in this class");
      for (const r of body.records) {
        await db.query(
          `INSERT INTO attendance_records (tenant_id, class_id, student_id, date, status, note, marked_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (class_id, student_id, date) DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, marked_by = EXCLUDED.marked_by, marked_at = now()`,
          [tenant.id, cls.id, r.studentId, day, r.status, r.note ?? null, userId],
        );
      }
      return body.records.length;
    });
    res.json({ saved, date: day });
  }),
);

/** Per-student attendance rates for a class over a date range. */
attendanceRouter.get(
  "/classes/:classId/report",
  requirePermission("classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(z.object({ from: date.optional(), to: date.optional() }), req.query);
    const data = await withTenant(tenant.id, async (db) => {
      const { cls } = await loadClass(req, db, req.params.classId, { manage: true });
      const students = await roster(db, cls.id);
      const rows = await db.query(
        `SELECT student_id, ${ATTENDED_SQL}::int AS attended, ${COUNTED_SQL}::int AS counted,
                count(*) FILTER (WHERE status = 'absent')::int AS absent, count(*) FILTER (WHERE status = 'late')::int AS late
           FROM attendance_records WHERE class_id = $1 AND ($2::date IS NULL OR date >= $2) AND ($3::date IS NULL OR date <= $3)
          GROUP BY student_id`,
        [cls.id, q.from ?? null, q.to ?? null],
      );
      const days = await db.query(
        `SELECT count(DISTINCT date)::int AS n FROM attendance_records WHERE class_id = $1 AND ($2::date IS NULL OR date >= $2) AND ($3::date IS NULL OR date <= $3)`,
        [cls.id, q.from ?? null, q.to ?? null],
      );
      const by = new Map(rows.rows.map((r) => [r.student_id, r]));
      return {
        class: cls,
        days: days.rows[0].n,
        students: students.map((s) => {
          const r = by.get(s.student_id);
          return { ...s, attended: r?.attended ?? 0, absent: r?.absent ?? 0, late: r?.late ?? 0, rate: r?.counted ? round1((r.attended / r.counted) * 100) : null };
        }),
      };
    });
    res.json(data);
  }),
);

/** A student's own attendance (or a parent's / teacher's view of one student). */
attendanceRouter.get(
  "/students",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(z.object({ studentId: z.string().uuid().optional() }), req.query);
    const data = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db, q.studentId);
      const summary = (
        await db.query(
          `SELECT ${ATTENDED_SQL}::int AS attended, ${COUNTED_SQL}::int AS counted, count(*) FILTER (WHERE status = 'absent')::int AS absent,
                  count(*) FILTER (WHERE status = 'late')::int AS late, count(*) FILTER (WHERE status = 'excused')::int AS excused
             FROM attendance_records WHERE student_id = $1`,
          [student.id],
        )
      ).rows[0];
      const recent = await db.query(
        `SELECT r.date, r.status, r.note, c.name AS class_name FROM attendance_records r JOIN classes c ON c.id = r.class_id
          WHERE r.student_id = $1 ORDER BY r.date DESC, c.name LIMIT 60`,
        [student.id],
      );
      return {
        student: { id: student.id, name: student.name },
        summary: { ...summary, rate: summary.counted ? round1((summary.attended / summary.counted) * 100) : null },
        records: recent.rows,
      };
    });
    res.json(data);
  }),
);
