import { Router } from "express";
import { withTenant } from "../../database/pool.js";
import { asyncHandler, requireAuth, requireTenant } from "../../lib/http.js";
import { round1, visibleClassesSql } from "./access.js";
import { ATTENDED_SQL, COUNTED_SQL } from "./attendance.js";

export const dashboardRouter = Router();

// Schools on the platform are in India; "today" follows IST.
const TODAY = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;
const ISO_DOW = `extract(isodow FROM now() AT TIME ZONE 'Asia/Kolkata')::int`;

const rate = (r: { attended: number; counted: number }) => (r.counted ? round1((r.attended / r.counted) * 100) : null);

/** One call for the home screen: each section appears only if the caller's role can see it. */
dashboardRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const p = tenant.permissions;
    const data = await withTenant(tenant.id, async (db) => {
      const out: Record<string, unknown> = {};

      if (p.has("members.manage") || p.has("reports.tenant")) {
        const people = (
          await db.query(
            `SELECT count(DISTINCT user_id) FILTER (WHERE role_id = 'student')::int AS students,
                    count(DISTINCT user_id) FILTER (WHERE role_id = 'teacher')::int AS teachers,
                    count(DISTINCT user_id) FILTER (WHERE role_id = 'parent')::int AS parents,
                    count(DISTINCT user_id) FILTER (WHERE role_id IN ('staff','tenant_admin','tenant_owner'))::int AS staff
               FROM tenant_memberships WHERE tenant_id = $1 AND status = 'active'`,
            [tenant.id],
          )
        ).rows[0];
        const classes = (await db.query(`SELECT count(*)::int AS n FROM classes`)).rows[0].n;
        const att = (await db.query(`SELECT ${ATTENDED_SQL}::int AS attended, ${COUNTED_SQL}::int AS counted FROM attendance_records WHERE date = ${TODAY}`)).rows[0];
        const week = await db.query(
          `SELECT date, ${ATTENDED_SQL}::int AS attended, ${COUNTED_SQL}::int AS counted FROM attendance_records
            WHERE date > ${TODAY} - 7 GROUP BY date ORDER BY date`,
        );
        const live = (await db.query(`SELECT count(*)::int AS n FROM live_sessions WHERE status = 'live'`)).rows[0].n;
        out.organization = {
          ...people,
          classes,
          liveNow: live,
          attendanceToday: rate(att),
          attendanceWeek: week.rows.map((r) => ({ date: r.date, rate: rate(r) })),
        };
      }

      if (p.has("classes.manage")) {
        const visible = visibleClassesSql(req, 1);
        const mine = await db.query(
          `SELECT c.id, c.name, (SELECT count(*)::int FROM class_enrollments e WHERE e.class_id = c.id) AS students
             FROM classes c WHERE c.id IN (${visible.sql}) ORDER BY c.name LIMIT 50`,
          visible.params,
        );
        const ids = mine.rows.map((c) => c.id);
        const today = await db.query(
          `SELECT t.id, c.name AS class_name, t.subject, t.room, to_char(t.start_time,'HH24:MI') AS start_time, to_char(t.end_time,'HH24:MI') AS end_time
             FROM timetable_slots t JOIN classes c ON c.id = t.class_id
            WHERE t.day_of_week = ${ISO_DOW} AND (t.class_id = ANY($1::uuid[]) OR t.teacher_id = $2) ORDER BY t.start_time`,
          [ids, userId],
        );
        const toGrade = (
          await db.query(
            `SELECT count(*)::int AS n FROM assignment_submissions s JOIN assignments a ON a.id = s.assignment_id
              WHERE s.graded_at IS NULL AND a.class_id = ANY($1::uuid[])`,
            [ids],
          )
        ).rows[0].n;
        const unmarked = await db.query(
          `SELECT c.id, c.name FROM classes c WHERE c.id = ANY($1::uuid[])
              AND EXISTS (SELECT 1 FROM class_enrollments e WHERE e.class_id = c.id)
              AND NOT EXISTS (SELECT 1 FROM attendance_records r WHERE r.class_id = c.id AND r.date = ${TODAY})`,
          [ids],
        );
        const sessions = await db.query(
          `SELECT ls.id, ls.title, ls.status, c.name AS class_name FROM live_sessions ls JOIN classes c ON c.id = ls.class_id
            WHERE ls.class_id = ANY($1::uuid[]) AND ls.status IN ('scheduled','live') ORDER BY ls.status = 'live' DESC, ls.created_at LIMIT 5`,
          [ids],
        );
        out.teaching = { classes: mine.rows, today: today.rows, toGrade, attendancePending: unmarked.rows, sessions: sessions.rows };
      }

      if (tenant.studentProfileId) {
        const sid = tenant.studentProfileId;
        const today = await db.query(
          `SELECT t.id, c.name AS class_name, t.subject, t.room, to_char(t.start_time,'HH24:MI') AS start_time, to_char(t.end_time,'HH24:MI') AS end_time
             FROM timetable_slots t JOIN classes c ON c.id = t.class_id JOIN class_enrollments e ON e.class_id = t.class_id AND e.student_id = $1
            WHERE t.day_of_week = ${ISO_DOW} ORDER BY t.start_time`,
          [sid],
        );
        const due = await db.query(
          `SELECT a.id, a.title, a.due_at, c.name AS class_name FROM assignments a JOIN classes c ON c.id = a.class_id
             JOIN class_enrollments e ON e.class_id = a.class_id AND e.student_id = $1
            WHERE a.status = 'published' AND NOT EXISTS (SELECT 1 FROM assignment_submissions s WHERE s.assignment_id = a.id AND s.student_id = $1)
            ORDER BY a.due_at NULLS LAST LIMIT 5`,
          [sid],
        );
        const att = (await db.query(`SELECT ${ATTENDED_SQL}::int AS attended, ${COUNTED_SQL}::int AS counted FROM attendance_records WHERE student_id = $1`, [sid])).rows[0];
        const live = await db.query(
          `SELECT ls.id, ls.title, ls.status, c.name AS class_name FROM live_sessions ls JOIN classes c ON c.id = ls.class_id
             JOIN class_enrollments e ON e.class_id = ls.class_id AND e.student_id = $1
            WHERE ls.status IN ('scheduled','live') ORDER BY ls.status = 'live' DESC LIMIT 5`,
          [sid],
        );
        out.student = { today: today.rows, due: due.rows, attendanceRate: rate(att), sessions: live.rows };
      }

      if (p.has("reports.children")) {
        const kids = await db.query(
          `SELECT sp.id AS student_id, u.name,
                  (SELECT ${ATTENDED_SQL}::int FROM attendance_records r WHERE r.student_id = sp.id) AS attended,
                  (SELECT ${COUNTED_SQL}::int FROM attendance_records r WHERE r.student_id = sp.id) AS counted,
                  (SELECT count(*)::int FROM assignments a JOIN class_enrollments e ON e.class_id = a.class_id AND e.student_id = sp.id
                    WHERE a.status = 'published' AND NOT EXISTS (SELECT 1 FROM assignment_submissions s WHERE s.assignment_id = a.id AND s.student_id = sp.id)) AS pending
             FROM parent_student_links l JOIN student_profiles sp ON sp.id = l.student_id JOIN users u ON u.id = sp.user_id
            WHERE l.parent_id = $1 AND l.consent_status = 'granted' ORDER BY u.name`,
          [userId],
        );
        out.children = kids.rows.map(({ attended, counted, ...k }) => ({ ...k, attendanceRate: rate({ attended, counted }) }));
      }

      return out;
    });
    res.json(data);
  }),
);
