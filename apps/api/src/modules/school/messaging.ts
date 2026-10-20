import type { Request } from "express";
import { Router } from "express";
import { z } from "zod";
import { withTenant, type Db } from "../../database/pool.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { STAFF_ROLES } from "../../lib/permissions.js";
import { requirePermission } from "../../middleware/authorization.js";

export const messagesRouter = Router();
export const ptmRouter = Router();

const isStaffMember = (roles: string[]) => roles.some((r) => STAFF_ROLES.includes(r));
const callerIsStaff = (req: Request) => isStaffMember(requireTenant(req).roles);

/** Teachers of the given students: class teachers plus anyone teaching them in the timetable. */
async function teachersOf(db: Db, studentIds: string[]) {
  if (!studentIds.length) return [] as string[];
  return (
    await db.query(
      `SELECT c.teacher_id AS id FROM class_enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = ANY($1::uuid[])
       UNION SELECT t.teacher_id FROM class_enrollments e JOIN timetable_slots t ON t.class_id = e.class_id WHERE e.student_id = ANY($1::uuid[]) AND t.teacher_id IS NOT NULL
       UNION SELECT cs.teacher_id FROM class_enrollments e JOIN class_subjects cs ON cs.class_id = e.class_id WHERE e.student_id = ANY($1::uuid[]) AND cs.teacher_id IS NOT NULL`,
      [studentIds],
    )
  ).rows.map((r) => r.id as string);
}

/** Children (student profile ids) the caller may speak for: their own profile, or consented children. */
async function myStudents(req: Request, db: Db) {
  const tenant = requireTenant(req);
  const { userId } = requireAuth(req);
  const kids = (await db.query(`SELECT student_id FROM parent_student_links WHERE parent_id = $1 AND consent_status = 'granted'`, [userId])).rows.map((r) => r.student_id as string);
  return tenant.studentProfileId ? [tenant.studentProfileId, ...kids] : kids;
}

/**
 * Who the caller may message. Staff may message any member. Students and parents may
 * message their (children's) teachers and the school office — never each other.
 */
async function contacts(req: Request, db: Db) {
  const tenant = requireTenant(req);
  const { userId } = requireAuth(req);
  const members = (
    await db.query(
      `SELECT u.id, u.name, array_agg(DISTINCT m.role_id) AS roles FROM tenant_memberships m JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 AND m.status = 'active' AND u.id <> $2 GROUP BY u.id ORDER BY u.name`,
      [tenant.id, userId],
    )
  ).rows as { id: string; name: string; roles: string[] }[];
  if (callerIsStaff(req)) return members;
  const teachers = new Set(await teachersOf(db, await myStudents(req, db)));
  const parentCaller = tenant.permissions.has("reports.children");
  return members.filter((m) => teachers.has(m.id) || (parentCaller && m.roles.some((r) => ["tenant_owner", "tenant_admin", "staff"].includes(r))));
}

async function loadConversation(req: Request, db: Db, id: string) {
  const { userId } = requireAuth(req);
  const c = (await db.query(`SELECT * FROM conversations WHERE id = $1`, [id])).rows[0];
  if (!c) throw notFound("Conversation");
  const member = await db.query(`SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`, [id, userId]);
  if (!member.rowCount) throw notFound("Conversation");
  return c;
}

messagesRouter.get(
  "/contacts",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const list = await contacts(req, db);
      const kids = await myStudents(req, db);
      const children = kids.length
        ? (await db.query(`SELECT sp.id, u.name FROM student_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.id = ANY($1::uuid[]) ORDER BY u.name`, [kids])).rows
        : [];
      return { contacts: list, children };
    });
    res.json(data);
  }),
);

messagesRouter.get(
  "/conversations",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const rows = await withTenant(tenant.id, (db) =>
      db.query(
        `SELECT c.id, c.subject, c.last_message_at, c.student_id, su.name AS student,
                (SELECT json_agg(json_build_object('id', u.id, 'name', u.name) ORDER BY u.name) FROM conversation_members om JOIN users u ON u.id = om.user_id
                  WHERE om.conversation_id = c.id AND om.user_id <> $1) AS others,
                (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
                (SELECT sender_id = $1 FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_mine,
                (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id AND m.sender_id <> $1 AND m.created_at > me.last_read_at) AS unread
           FROM conversations c JOIN conversation_members me ON me.conversation_id = c.id AND me.user_id = $1
           LEFT JOIN student_profiles sp ON sp.id = c.student_id LEFT JOIN users su ON su.id = sp.user_id
          ORDER BY c.last_message_at DESC LIMIT 200`,
        [userId],
      ),
    );
    res.json({ conversations: rows.rows, unread: rows.rows.reduce((t, c) => t + c.unread, 0) });
  }),
);

messagesRouter.post(
  "/conversations",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const b = parse(
      z.object({ recipientId: z.string().uuid(), subject: z.string().trim().max(160).default(""), body: z.string().trim().min(1).max(5000), studentId: z.string().uuid().nullish() }),
      req.body,
    );
    if (b.recipientId === userId) throw badRequest("You can't message yourself");
    const id = await withTenant(tenant.id, async (db) => {
      if (!(await contacts(req, db)).some((c) => c.id === b.recipientId)) throw forbidden("You can't message this person");
      if (b.studentId && !callerIsStaff(req) && !(await myStudents(req, db)).includes(b.studentId)) throw forbidden("You can only write about your own child");
      // Continue the existing thread between the same two people about the same child.
      const existing = (
        await db.query(
          `SELECT c.id FROM conversations c
            WHERE c.student_id IS NOT DISTINCT FROM $3::uuid
              AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.user_id = $1)
              AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.user_id = $2)
              AND (SELECT count(*) FROM conversation_members m WHERE m.conversation_id = c.id) = 2
            LIMIT 1`,
          [userId, b.recipientId, b.studentId ?? null],
        )
      ).rows[0];
      const cid =
        existing?.id ??
        (await db.query(`INSERT INTO conversations (tenant_id, subject, student_id, created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [tenant.id, b.subject, b.studentId ?? null, userId])).rows[0].id;
      if (!existing) {
        await db.query(`INSERT INTO conversation_members (tenant_id, conversation_id, user_id) VALUES ($1,$2,$3), ($1,$2,$4)`, [tenant.id, cid, userId, b.recipientId]);
      }
      await db.query(`INSERT INTO messages (tenant_id, conversation_id, sender_id, body) VALUES ($1,$2,$3,$4)`, [tenant.id, cid, userId, b.body]);
      await db.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [cid]);
      await db.query(`UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2`, [cid, userId]);
      return cid;
    });
    res.status(201).json({ conversationId: id });
  }),
);

messagesRouter.get(
  "/conversations/:id",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const data = await withTenant(tenant.id, async (db) => {
      const c = await loadConversation(req, db, req.params.id);
      const members = (
        await db.query(
          `SELECT u.id, u.name, array_agg(DISTINCT tm.role_id) AS roles FROM conversation_members m JOIN users u ON u.id = m.user_id
             LEFT JOIN tenant_memberships tm ON tm.user_id = u.id AND tm.tenant_id = $2 WHERE m.conversation_id = $1 GROUP BY u.id`,
          [c.id, tenant.id],
        )
      ).rows;
      const msgs = await db.query(
        `SELECT m.id, m.sender_id, u.name AS sender, m.body, m.created_at, m.sender_id = $2 AS mine
           FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.conversation_id = $1 ORDER BY m.created_at LIMIT 500`,
        [c.id, userId],
      );
      await db.query(`UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2`, [c.id, userId]);
      const student = c.student_id ? (await db.query(`SELECT u.name FROM student_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.id = $1`, [c.student_id])).rows[0]?.name : null;
      return { conversation: { ...c, student }, members, messages: msgs.rows };
    });
    res.json(data);
  }),
);

messagesRouter.post(
  "/conversations/:id",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const b = parse(z.object({ body: z.string().trim().min(1).max(5000) }), req.body);
    const row = await withTenant(tenant.id, async (db) => {
      const c = await loadConversation(req, db, req.params.id);
      const m = (await db.query(`INSERT INTO messages (tenant_id, conversation_id, sender_id, body) VALUES ($1,$2,$3,$4) RETURNING *`, [tenant.id, c.id, userId, b.body])).rows[0];
      await db.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [c.id]);
      await db.query(`UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2`, [c.id, userId]);
      return m;
    });
    res.status(201).json({ message: row });
  }),
);

// ---------------------------------------------------------------------------
// Parent-teacher meetings
// ---------------------------------------------------------------------------
const SLOT_COLUMNS = `s.id, s.teacher_id, t.name AS teacher, s.starts_at, s.duration_minutes, s.location, s.booked_by, b.name AS booked_by_name,
  s.student_id, su.name AS student, s.note, s.booked_at`;
const SLOT_JOINS = `FROM ptm_slots s JOIN users t ON t.id = s.teacher_id LEFT JOIN users b ON b.id = s.booked_by
  LEFT JOIN student_profiles sp ON sp.id = s.student_id LEFT JOIN users su ON su.id = sp.user_id`;

/** A teacher publishes a block of slots, e.g. 10:00–12:00 in 15-minute meetings. */
ptmRouter.post(
  "/slots",
  requirePermission("classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const b = parse(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        minutes: z.number().int().min(5).max(120).default(15),
        location: z.string().trim().min(1).max(120).default("Classroom"),
      }),
      req.body,
    );
    if (b.endTime <= b.startTime) throw badRequest("End time must be after start time");
    const created = await withTenant(tenant.id, async (db) => {
      const r = await db.query(
        `INSERT INTO ptm_slots (tenant_id, teacher_id, starts_at, duration_minutes, location)
         SELECT $1, $2, g, $5, $6 FROM generate_series(($3::date + $4::time) AT TIME ZONE 'Asia/Kolkata',
                                                       ($3::date + $7::time) AT TIME ZONE 'Asia/Kolkata' - make_interval(mins => $5),
                                                       make_interval(mins => $5)) AS g
          WHERE g > now()
         ON CONFLICT (teacher_id, starts_at) DO NOTHING`,
        [tenant.id, userId, b.date, b.startTime, b.minutes, b.location, b.endTime],
      );
      return r.rowCount ?? 0;
    });
    res.status(201).json({ created });
  }),
);

ptmRouter.get(
  "/slots/mine",
  requirePermission("classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const rows = await withTenant(tenant.id, (db) => db.query(`SELECT ${SLOT_COLUMNS} ${SLOT_JOINS} WHERE s.teacher_id = $1 AND s.starts_at > now() - interval '1 day' ORDER BY s.starts_at`, [userId]));
    res.json({ slots: rows.rows });
  }),
);

ptmRouter.delete(
  "/slots/:id",
  requirePermission("classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    await withTenant(tenant.id, async (db) => {
      const r = await db.query(`DELETE FROM ptm_slots WHERE id = $1 AND teacher_id = $2`, [req.params.id, userId]);
      if (!r.rowCount) throw notFound("Slot");
    });
    res.json({ ok: true });
  }),
);

/** Slots a parent can book: upcoming, free slots of teachers who teach one of their children, plus their bookings. */
ptmRouter.get(
  "/available",
  requirePermission("reports.children"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const data = await withTenant(tenant.id, async (db) => {
      const kids = await myStudents(req, db);
      const teachers = await teachersOf(db, kids);
      const free = await db.query(`SELECT ${SLOT_COLUMNS} ${SLOT_JOINS} WHERE s.teacher_id = ANY($1::uuid[]) AND s.booked_by IS NULL AND s.starts_at > now() ORDER BY s.starts_at LIMIT 300`, [teachers]);
      const mine = await db.query(`SELECT ${SLOT_COLUMNS} ${SLOT_JOINS} WHERE s.booked_by = $1 AND s.starts_at > now() - interval '1 day' ORDER BY s.starts_at`, [userId]);
      return { available: free.rows, bookings: mine.rows };
    });
    res.json(data);
  }),
);

ptmRouter.post(
  "/slots/:id/book",
  requirePermission("reports.children"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const b = parse(z.object({ studentId: z.string().uuid(), note: z.string().trim().max(500).nullish() }), req.body);
    const row = await withTenant(tenant.id, async (db) => {
      if (!(await myStudents(req, db)).includes(b.studentId)) throw forbidden("You can only book for your own child");
      const slot = (await db.query(`SELECT teacher_id FROM ptm_slots WHERE id = $1`, [req.params.id])).rows[0];
      if (!slot) throw notFound("Slot");
      if (!(await teachersOf(db, [b.studentId])).includes(slot.teacher_id)) throw forbidden("This teacher doesn't teach your child");
      const already = await db.query(`SELECT 1 FROM ptm_slots WHERE booked_by = $1 AND teacher_id = $2 AND student_id = $3 AND starts_at > now()`, [userId, slot.teacher_id, b.studentId]);
      if (already.rowCount) throw conflict("You already have a meeting booked with this teacher for this child");
      const s = (
        await db.query(
          `UPDATE ptm_slots SET booked_by = $2, student_id = $3, note = $4, booked_at = now() WHERE id = $1 AND booked_by IS NULL AND starts_at > now() RETURNING id`,
          [req.params.id, userId, b.studentId, b.note ?? null],
        )
      ).rows[0];
      if (!s) throw conflict("Sorry, that slot was just taken — please pick another");
      return s;
    });
    res.json({ slot: row });
  }),
);

/** The booking parent or the teacher can release a booking. */
ptmRouter.post(
  "/slots/:id/cancel",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    await withTenant(tenant.id, async (db) => {
      const r = await db.query(
        `UPDATE ptm_slots SET booked_by = NULL, student_id = NULL, note = NULL, booked_at = NULL WHERE id = $1 AND booked_by IS NOT NULL AND (booked_by = $2 OR teacher_id = $2)`,
        [req.params.id, userId],
      );
      if (!r.rowCount) throw notFound("Booking");
    });
    res.json({ ok: true });
  }),
);
