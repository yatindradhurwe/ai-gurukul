import { Router } from "express";
import { withTenant } from "../../database/pool.js";
import { asyncHandler, requireAuth, requireTenant } from "../../lib/http.js";
import { round1, visibleClassesSql } from "./access.js";
import { ATTENDED_SQL, COUNTED_SQL } from "./attendance.js";
import { INVOICE_COLUMNS, INVOICE_STATE } from "../school/fees.js";
import { reviewableSql } from "../school/leave.js";

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
            WHERE date > ${TODAY} - 7 AND date <= ${TODAY} GROUP BY date ORDER BY date`,
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
        const exams = await db.query(
          `SELECT p.id, e.id AS exam_id, e.name AS exam, p.subject, p.date, to_char(p.start_time,'HH24:MI') AS start_time, p.room
             FROM exam_papers p JOIN exams e ON e.id = p.exam_id JOIN class_enrollments en ON en.class_id = p.class_id AND en.student_id = $1
            WHERE e.status = 'published' AND p.date >= ${TODAY} ORDER BY p.date, p.start_time LIMIT 5`,
          [sid],
        );
        const fees = (
          await db.query(
            `SELECT COALESCE(sum(GREATEST(balance_paise, 0)), 0)::bigint AS due, count(*) FILTER (WHERE state = 'overdue')::int AS overdue
               FROM (SELECT ${INVOICE_COLUMNS}, ${INVOICE_STATE} AS state FROM fee_invoices i WHERE i.student_id = $1 AND i.status = 'open') x`,
            [sid],
          )
        ).rows[0];
        const books = (
          await db.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE due_date < ${TODAY})::int AS overdue FROM library_loans WHERE user_id = $1 AND returned_at IS NULL`, [userId])
        ).rows[0];
        const bus = (
          await db.query(
            `SELECT r.name AS route, st.name AS stop, to_char(st.pickup_time,'HH24:MI') AS pickup_time, to_char(st.drop_time,'HH24:MI') AS drop_time, v.registration_no
               FROM transport_assignments a JOIN transport_routes r ON r.id = a.route_id JOIN transport_stops st ON st.id = a.stop_id
               LEFT JOIN transport_vehicles v ON v.id = r.vehicle_id WHERE a.student_id = $1`,
            [sid],
          )
        ).rows[0];
        const room = (
          await db.query(
            `SELECT h.name AS hostel, r.room_no FROM hostel_allocations a JOIN hostel_rooms r ON r.id = a.room_id JOIN hostels h ON h.id = r.hostel_id
              WHERE a.student_id = $1 AND a.end_date IS NULL`,
            [sid],
          )
        ).rows[0];
        out.student = {
          bus: bus ?? null,
          room: room ?? null,
          today: today.rows,
          due: due.rows,
          attendanceRate: rate(att),
          sessions: live.rows,
          exams: exams.rows,
          feesDuePaise: Number(fees.due),
          feesOverdue: fees.overdue,
          books,
        };
      }

      if (p.has("reports.children")) {
        const kids = await db.query(
          `SELECT sp.id AS student_id, u.name,
                  (SELECT ${ATTENDED_SQL}::int FROM attendance_records r WHERE r.student_id = sp.id) AS attended,
                  (SELECT ${COUNTED_SQL}::int FROM attendance_records r WHERE r.student_id = sp.id) AS counted,
                  (SELECT count(*)::int FROM assignments a JOIN class_enrollments e ON e.class_id = a.class_id AND e.student_id = sp.id
                    WHERE a.status = 'published' AND NOT EXISTS (SELECT 1 FROM assignment_submissions s WHERE s.assignment_id = a.id AND s.student_id = sp.id)) AS pending,
                  (SELECT COALESCE(sum(GREATEST(x.balance_paise, 0)), 0)::bigint
                     FROM (SELECT ${INVOICE_COLUMNS} FROM fee_invoices i WHERE i.student_id = sp.id AND i.status = 'open') x) AS fees_due_paise
             FROM parent_student_links l JOIN student_profiles sp ON sp.id = l.student_id JOIN users u ON u.id = sp.user_id
            WHERE l.parent_id = $1 AND l.consent_status = 'granted' ORDER BY u.name`,
          [userId],
        );
        // Promotion standing: current class, year results, open supplementary re-exams,
        // and final results declared but not yet decided.
        const ids = kids.rows.map((k) => k.student_id);
        const classes = (
          await db.query(`SELECT e.student_id, c.name FROM class_enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = ANY($1::uuid[]) ORDER BY c.name`, [ids])
        ).rows;
        const years = (
          await db.query(
            `SELECT student_id, year_name, class_name, result, promoted_to_class_name, remarks, created_at FROM student_year_records
              WHERE student_id = ANY($1::uuid[]) ORDER BY created_at DESC`,
            [ids],
          )
        ).rows;
        const supplementary = (
          await db.query(
            `SELECT x.student_id, x.subject, x.max_marks, x.pass_marks, x.original_marks, x.marks, x.status, x.exam_date, x.resolved,
                    e.name AS exam, c.name AS class_name, t.name AS target_class
               FROM supplementary_exams x JOIN exams e ON e.id = x.exam_id JOIN classes c ON c.id = x.class_id LEFT JOIN classes t ON t.id = x.target_class_id
              WHERE x.student_id = ANY($1::uuid[]) AND NOT x.resolved ORDER BY x.exam_date NULLS LAST, x.subject`,
            [ids],
          )
        ).rows;
        const awaiting = (
          await db.query(
            `SELECT DISTINCT ON (en.student_id) en.student_id, e.name AS exam
               FROM class_enrollments en JOIN exam_papers p ON p.class_id = en.class_id JOIN exams e ON e.id = p.exam_id
              WHERE en.student_id = ANY($1::uuid[]) AND e.is_final AND e.status = 'completed'
                AND NOT EXISTS (SELECT 1 FROM student_year_records r WHERE r.student_id = en.student_id AND r.exam_id = e.id)
                AND NOT EXISTS (SELECT 1 FROM supplementary_exams x WHERE x.student_id = en.student_id AND x.exam_id = e.id)
              ORDER BY en.student_id, e.end_date DESC NULLS LAST`,
            [ids],
          )
        ).rows;
        out.children = kids.rows.map(({ attended, counted, ...k }) => ({
          ...k,
          attendanceRate: rate({ attended, counted }),
          classes: classes.filter((c) => c.student_id === k.student_id).map((c) => c.name),
          promotions: years.filter((y) => y.student_id === k.student_id).map(({ student_id: _s, ...y }) => y),
          supplementary: supplementary.filter((x) => x.student_id === k.student_id).map(({ student_id: _s, ...x }) => x),
          awaitingPromotion: awaiting.find((a) => a.student_id === k.student_id)?.exam ?? null,
        }));
      }

      if (p.has("fees.manage")) {
        out.fees = (
          await db.query(
            `SELECT COALESCE(sum(GREATEST(balance_paise, 0)), 0)::bigint AS outstanding_paise,
                    count(DISTINCT student_id) FILTER (WHERE state = 'overdue')::int AS overdue_students,
                    (SELECT COALESCE(sum(amount_paise), 0)::bigint FROM fee_payments WHERE paid_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')) AS collected_month_paise
               FROM (SELECT ${INVOICE_COLUMNS}, ${INVOICE_STATE} AS state FROM fee_invoices i WHERE i.status = 'open') x`,
          )
        ).rows[0];
      }

      if (p.has("library.manage")) {
        out.library = (
          await db.query(
            `SELECT (SELECT count(*)::int FROM library_books) AS titles,
                    count(*) FILTER (WHERE returned_at IS NULL)::int AS on_loan,
                    count(*) FILTER (WHERE returned_at IS NULL AND due_date < ${TODAY})::int AS overdue
               FROM library_loans`,
          )
        ).rows[0];
      }

      if (p.has("transport.manage")) {
        out.transport = (
          await db.query(
            `SELECT (SELECT count(*)::int FROM transport_routes) AS routes, (SELECT count(*)::int FROM transport_assignments) AS riders,
                    (SELECT count(*)::int FROM transport_vehicles WHERE status = 'active') AS vehicles`,
          )
        ).rows[0];
      }

      if (p.has("hostel.manage")) {
        out.hostel = (
          await db.query(
            `SELECT (SELECT COALESCE(sum(capacity), 0)::int FROM hostel_rooms) AS beds,
                    (SELECT count(*)::int FROM hostel_allocations WHERE end_date IS NULL) AS occupied,
                    (SELECT count(*)::int FROM hostels) AS hostels`,
          )
        ).rows[0];
      }

      // Things waiting on the caller: leave to review, new enquiries, meetings today.
      const review = reviewableSql(req, 1);
      const attention = {
        leaveToReview: (await db.query(`SELECT count(*)::int AS n FROM leave_requests l WHERE l.status = 'pending' AND ${review.sql}`, review.params)).rows[0].n,
        newEnquiries: p.has("admissions.manage") ? (await db.query(`SELECT count(*)::int AS n FROM admission_applications WHERE status = 'enquiry'`)).rows[0].n : 0,
        meetingsToday: (
          await db.query(
            `SELECT count(*)::int AS n FROM ptm_slots WHERE (teacher_id = $1 OR booked_by = $1) AND booked_by IS NOT NULL
                AND (starts_at AT TIME ZONE 'Asia/Kolkata')::date = ${TODAY}`,
            [userId],
          )
        ).rows[0].n,
      };
      if (attention.leaveToReview || attention.newEnquiries || attention.meetingsToday) out.attention = attention;

      return out;
    });
    res.json(data);
  }),
);
