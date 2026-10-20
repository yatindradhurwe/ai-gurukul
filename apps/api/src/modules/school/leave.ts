import type { Request } from "express";
import { Router } from "express";
import { z } from "zod";
import { audit, withTenant, type Db } from "../../database/pool.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { STAFF_ROLES } from "../../lib/permissions.js";
import { resolveStudent } from "../../lib/student-access.js";
import { requirePermission } from "../../middleware/authorization.js";
import { isOrgAdmin, visibleClassesSql } from "../lms/access.js";

export const leaveRouter = Router();
export const eventsRouter = Router();

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");
const MAX_DAYS = 60;

/** Yearly staff leave allowance, in days. */
export const LEAVE_POLICY = { casual: 12, sick: 10, earned: 15 } as const;

/** Days in a leave, counting Monday–Saturday (Sundays are already off). */
export const LEAVE_DAYS_SQL = (a: string) =>
  `(SELECT count(*)::int FROM generate_series(${a}.start_date, ${a}.end_date, interval '1 day') d WHERE extract(isodow FROM d) < 7)`;

const COLUMNS = `l.id, l.kind, l.leave_type, l.start_date, l.end_date, to_char(l.out_time,'HH24:MI') AS out_time, to_char(l.return_time,'HH24:MI') AS return_time,
  l.reason, l.status, l.review_note, l.reviewed_at, l.created_at, l.requester_id, rq.name AS requester, rv.name AS reviewer,
  l.student_id, su.name AS student, l.staff_id, st.name AS staff, ${LEAVE_DAYS_SQL("l")} AS days,
  (SELECT string_agg(c.name, ', ') FROM class_enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = l.student_id) AS classes`;
const JOINS = `FROM leave_requests l JOIN users rq ON rq.id = l.requester_id LEFT JOIN users rv ON rv.id = l.reviewed_by
  LEFT JOIN student_profiles sp ON sp.id = l.student_id LEFT JOIN users su ON su.id = sp.user_id LEFT JOIN users st ON st.id = l.staff_id`;

const isStaffMember = (req: Request) => requireTenant(req).roles.some((r) => STAFF_ROLES.includes(r));

/** SQL condition (on alias l) for requests the caller may review, with params from index p. */
export function reviewableSql(req: Request, p: number) {
  const tenant = requireTenant(req);
  const { userId } = requireAuth(req);
  return {
    sql: `(l.requester_id <> $${p} AND COALESCE(l.staff_id, '00000000-0000-0000-0000-000000000000') <> $${p} AND (
            (l.kind = 'staff' AND $${p + 1}::boolean)
         OR (l.kind = 'student' AND ($${p + 2}::boolean OR ($${p + 3}::boolean AND EXISTS (
               SELECT 1 FROM class_enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = l.student_id AND c.teacher_id = $${p}))))
         OR (l.kind = 'outpass' AND $${p + 4}::boolean)))`,
    params: [userId, tenant.permissions.has("leave.approve"), isOrgAdmin(req) && tenant.permissions.has("classes.manage"), tenant.permissions.has("classes.manage"), tenant.permissions.has("hostel.manage")],
  };
}

leaveRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const b = parse(
      z.object({
        kind: z.enum(["student", "staff", "outpass"]),
        studentId: z.string().uuid().optional(),
        leaveType: z.enum(["casual", "sick", "earned", "unpaid", "other"]).default("casual"),
        startDate: date,
        endDate: date,
        outTime: time.nullish(),
        returnTime: time.nullish(),
        reason: z.string().trim().min(3).max(1000),
      }),
      req.body,
    );
    if (b.endDate < b.startDate) throw badRequest("The leave ends before it starts");
    if ((Date.parse(b.endDate) - Date.parse(b.startDate)) / 86400000 + 1 > MAX_DAYS) throw badRequest(`A request can cover at most ${MAX_DAYS} days`);
    const row = await withTenant(tenant.id, async (db) => {
      let studentId: string | null = null;
      if (b.kind === "staff") {
        if (!isStaffMember(req)) throw forbidden("Only staff can request staff leave");
      } else {
        const s = await resolveStudent(req, db, b.studentId);
        if (s.access === "staff") throw forbidden("Leave for a student is requested by the student or their parent");
        studentId = s.id;
        if (b.kind === "outpass") {
          const resident = await db.query(`SELECT 1 FROM hostel_allocations WHERE student_id = $1 AND end_date IS NULL`, [s.id]);
          if (!resident.rowCount) throw badRequest("Out-passes are for hostel residents");
        }
      }
      const overlap = await db.query(
        `SELECT 1 FROM leave_requests WHERE kind = $1 AND status IN ('pending','approved') AND start_date <= $3 AND end_date >= $2
            AND (student_id IS NOT DISTINCT FROM $4::uuid) AND (staff_id IS NOT DISTINCT FROM $5::uuid) LIMIT 1`,
        [b.kind, b.startDate, b.endDate, studentId, b.kind === "staff" ? userId : null],
      );
      if (overlap.rowCount) throw conflict("There is already a request covering these dates");
      const l = (
        await db.query(
          `INSERT INTO leave_requests (tenant_id, kind, requester_id, student_id, staff_id, leave_type, start_date, end_date, out_time, return_time, reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [tenant.id, b.kind, userId, studentId, b.kind === "staff" ? userId : null, b.kind === "staff" ? b.leaveType : "other", b.startDate, b.endDate, b.outTime ?? null, b.returnTime ?? null, b.reason],
        )
      ).rows[0];
      return l;
    });
    res.status(201).json({ request: row });
  }),
);

/** Requests the caller made, or that concern them or their children. */
leaveRouter.get(
  "/mine",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const rows = await withTenant(tenant.id, (db) =>
      db.query(
        `SELECT ${COLUMNS} ${JOINS}
          WHERE l.requester_id = $1 OR l.staff_id = $1 OR l.student_id = $2
             OR l.student_id IN (SELECT student_id FROM parent_student_links WHERE parent_id = $1 AND consent_status = 'granted')
          ORDER BY l.start_date DESC LIMIT 200`,
        [userId, tenant.studentProfileId],
      ),
    );
    res.json({ requests: rows.rows });
  }),
);

leaveRouter.get(
  "/review",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(z.object({ status: z.enum(["pending", "approved", "rejected", "cancelled"]).optional() }), req.query);
    const r = reviewableSql(req, 2);
    const rows = await withTenant(tenant.id, (db) =>
      db.query(`SELECT ${COLUMNS} ${JOINS} WHERE ${r.sql} AND ($1::text IS NULL OR l.status = $1) ORDER BY (l.status = 'pending') DESC, l.start_date LIMIT 300`, [q.status ?? null, ...r.params]),
    );
    res.json({ requests: rows.rows, canReview: r.params.slice(1).some(Boolean) });
  }),
);

leaveRouter.post(
  "/:id/review",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const b = parse(z.object({ decision: z.enum(["approved", "rejected"]), note: z.string().trim().max(500).nullish() }), req.body);
    const r = reviewableSql(req, 2);
    const row = await withTenant(tenant.id, async (db) => {
      const l = (await db.query(`SELECT l.* FROM leave_requests l WHERE l.id = $1 AND ${r.sql}`, [req.params.id, ...r.params])).rows[0];
      if (!l) throw notFound("Leave request");
      if (l.status !== "pending") throw conflict(`This request is already ${l.status}`);
      const u = (
        await db.query(`UPDATE leave_requests SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 WHERE id = $1 RETURNING *`, [l.id, b.decision, userId, b.note ?? null])
      ).rows[0];
      if (b.decision === "approved") await applyApprovedLeave(db, tenant.id, userId, u);
      await audit(db, { tenantId: tenant.id, actorId: userId, action: `leave.${b.decision}`, resourceType: "leave_request", resourceId: l.id });
      return u;
    });
    res.json({ request: row });
  }),
);

/** Approved student leave excuses absences; approved staff leave is recorded in staff attendance. */
async function applyApprovedLeave(db: Db, tenantId: string, reviewerId: string, l: any) {
  if (l.kind === "student") {
    await db.query(
      `INSERT INTO attendance_records (tenant_id, class_id, student_id, date, status, note, marked_by)
       SELECT $1, e.class_id, e.student_id, d::date, 'excused', 'Approved leave', $5
         FROM class_enrollments e, generate_series($3::date, $4::date, interval '1 day') d
        WHERE e.student_id = $2 AND extract(isodow FROM d) < 7
       ON CONFLICT (class_id, student_id, date) DO UPDATE SET status = 'excused', note = 'Approved leave'
         WHERE attendance_records.status = 'absent'`,
      [tenantId, l.student_id, l.start_date, l.end_date, reviewerId],
    );
  } else if (l.kind === "staff") {
    await db.query(
      `INSERT INTO staff_attendance (tenant_id, user_id, date, status, marked_by)
       SELECT $1, $2, d::date, 'leave', $5 FROM generate_series($3::date, $4::date, interval '1 day') d WHERE extract(isodow FROM d) < 7
       ON CONFLICT (tenant_id, user_id, date) DO UPDATE SET status = 'leave', marked_by = EXCLUDED.marked_by, marked_at = now()`,
      [tenantId, l.staff_id, l.start_date, l.end_date, reviewerId],
    );
  }
}

leaveRouter.post(
  "/:id/cancel",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    await withTenant(tenant.id, async (db) => {
      const r = await db.query(`UPDATE leave_requests SET status = 'cancelled' WHERE id = $1 AND requester_id = $2 AND status = 'pending'`, [req.params.id, userId]);
      if (!r.rowCount) throw notFound("Pending request");
    });
    res.json({ ok: true });
  }),
);

/** Staff leave balance for the calendar year. */
leaveRouter.get(
  "/balance",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const q = parse(z.object({ userId: z.string().uuid().optional() }), req.query);
    const target = q.userId ?? userId;
    if (target !== userId && !tenant.permissions.has("leave.approve") && !tenant.permissions.has("payroll.manage")) throw forbidden();
    if (target === userId && !isStaffMember(req)) throw forbidden("Leave balances are for staff");
    const rows = await withTenant(tenant.id, (db) =>
      db.query(
        `SELECT l.leave_type, COALESCE(sum(${LEAVE_DAYS_SQL("l")}), 0)::int AS used FROM leave_requests l
          WHERE l.kind = 'staff' AND l.staff_id = $1 AND l.status = 'approved' AND extract(year FROM l.start_date) = extract(year FROM now())
          GROUP BY l.leave_type`,
        [target],
      ),
    );
    const used = Object.fromEntries(rows.rows.map((r) => [r.leave_type, r.used]));
    res.json({
      year: new Date().getFullYear(),
      balances: Object.entries(LEAVE_POLICY).map(([type, allowed]) => ({ type, allowed, used: used[type] ?? 0, left: Math.max(0, allowed - (used[type] ?? 0)) })),
      unpaidUsed: used.unpaid ?? 0,
    });
  }),
);

// ---------------------------------------------------------------------------
// School calendar
// ---------------------------------------------------------------------------
eventsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(z.object({ from: date, to: date }), req.query);
    const staffView = isStaffMember(req);
    const audiences = ["all", ...(staffView ? ["staff", "students", "parents"] : []), ...(tenant.roles.includes("student") ? ["students"] : []), ...(tenant.roles.includes("parent") ? ["parents"] : [])];
    const visible = visibleClassesSql(req, 4);
    const data = await withTenant(tenant.id, async (db) => {
      const events = await db.query(
        `SELECT e.*, u.name AS author FROM school_events e JOIN users u ON u.id = e.created_by
          WHERE e.start_date <= $2 AND e.end_date >= $1 AND e.audience = ANY($3::text[]) ORDER BY e.start_date, e.title`,
        [q.from, q.to, audiences],
      );
      const exams = await db.query(
        `SELECT p.id, p.date, p.subject, c.name AS class_name, x.name AS exam, x.id AS exam_id FROM exam_papers p JOIN exams x ON x.id = p.exam_id JOIN classes c ON c.id = p.class_id
          WHERE p.date BETWEEN $1 AND $2 AND x.status <> 'draft' AND ($3::boolean OR p.class_id IN (${visible.sql})) ORDER BY p.date`,
        [q.from, q.to, staffView, ...visible.params],
      );
      return { events: events.rows, exams: exams.rows };
    });
    res.json(data);
  }),
);

eventsRouter.post(
  "/",
  requirePermission("announcements.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const b = parse(
      z.object({
        title: z.string().trim().min(1).max(160),
        description: z.string().trim().max(2000).default(""),
        kind: z.enum(["holiday", "exam", "event", "meeting", "sports", "cultural"]).default("event"),
        startDate: date,
        endDate: date.optional(),
        audience: z.enum(["all", "staff", "students", "parents"]).default("all"),
      }),
      req.body,
    );
    const end = b.endDate ?? b.startDate;
    if (end < b.startDate) throw badRequest("The event ends before it starts");
    const row = await withTenant(tenant.id, async (db) =>
      (
        await db.query(`INSERT INTO school_events (tenant_id, title, description, kind, start_date, end_date, audience, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [
          tenant.id,
          b.title,
          b.description,
          b.kind,
          b.startDate,
          end,
          b.audience,
          userId,
        ])
      ).rows[0],
    );
    res.status(201).json({ event: row });
  }),
);

eventsRouter.delete(
  "/:id",
  requirePermission("announcements.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    await withTenant(tenant.id, async (db) => {
      const r = await db.query(`DELETE FROM school_events WHERE id = $1`, [req.params.id]);
      if (!r.rowCount) throw notFound("Event");
    });
    res.json({ ok: true });
  }),
);
