import { Router } from "express";
import { z } from "zod";
import { audit, withTenant } from "../../database/pool.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { resolveStudent } from "../../lib/student-access.js";
import { requirePermission } from "../../middleware/authorization.js";

export const hostelRouter = Router();

const TODAY = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const hostelSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["boys", "girls", "coed"]).default("coed"),
  wardenId: z.string().uuid().nullish(),
  phone: z.string().trim().max(20).nullish(),
  address: z.string().trim().max(300).nullish(),
});

/** Every hostel with occupancy, and its rooms with current residents. */
hostelRouter.get(
  "/",
  requirePermission("hostel.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const hostels = (
        await db.query(
          `SELECT h.*, w.name AS warden,
                  (SELECT count(*)::int FROM hostel_rooms r WHERE r.hostel_id = h.id) AS rooms,
                  (SELECT COALESCE(sum(r.capacity), 0)::int FROM hostel_rooms r WHERE r.hostel_id = h.id) AS beds,
                  (SELECT count(*)::int FROM hostel_allocations a JOIN hostel_rooms r ON r.id = a.room_id WHERE r.hostel_id = h.id AND a.end_date IS NULL) AS occupied
             FROM hostels h LEFT JOIN users w ON w.id = h.warden_id ORDER BY h.name`,
        )
      ).rows;
      const rooms = (
        await db.query(
          `SELECT r.*, COALESCE(json_agg(json_build_object('allocation_id', a.id, 'student_id', sp.id, 'name', u.name, 'since', a.start_date) ORDER BY u.name)
                         FILTER (WHERE a.id IS NOT NULL), '[]') AS residents
             FROM hostel_rooms r
             LEFT JOIN hostel_allocations a ON a.room_id = r.id AND a.end_date IS NULL
             LEFT JOIN student_profiles sp ON sp.id = a.student_id LEFT JOIN users u ON u.id = sp.user_id
            GROUP BY r.id ORDER BY r.floor, r.room_no`,
        )
      ).rows;
      return { hostels: hostels.map((h) => ({ ...h, roomList: rooms.filter((r) => r.hostel_id === h.id) })) };
    });
    res.json(data);
  }),
);

hostelRouter.post(
  "/",
  requirePermission("hostel.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const b = parse(hostelSchema, req.body);
    const row = await withTenant(tenant.id, async (db) => {
      if ((await db.query(`SELECT 1 FROM hostels WHERE lower(name) = lower($1)`, [b.name])).rowCount) throw conflict(`${b.name} already exists`);
      return (
        await db.query(`INSERT INTO hostels (tenant_id, name, kind, warden_id, phone, address) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [
          tenant.id,
          b.name,
          b.kind,
          b.wardenId ?? null,
          b.phone ?? null,
          b.address ?? null,
        ])
      ).rows[0];
    });
    res.status(201).json({ hostel: row });
  }),
);

hostelRouter.patch(
  "/:id",
  requirePermission("hostel.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const b = parse(hostelSchema.partial(), req.body);
    const row = await withTenant(tenant.id, async (db) => {
      const h = (
        await db.query(
          `UPDATE hostels SET name = COALESCE($2, name), kind = COALESCE($3, kind), warden_id = CASE WHEN $7 THEN $4::uuid ELSE warden_id END,
                  phone = COALESCE($5, phone), address = COALESCE($6, address) WHERE id = $1 RETURNING *`,
          [req.params.id, b.name ?? null, b.kind ?? null, b.wardenId ?? null, b.phone ?? null, b.address ?? null, b.wardenId !== undefined],
        )
      ).rows[0];
      if (!h) throw notFound("Hostel");
      return h;
    });
    res.json({ hostel: row });
  }),
);

hostelRouter.delete(
  "/:id",
  requirePermission("hostel.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    await withTenant(tenant.id, async (db) => {
      const n = (await db.query(`SELECT count(*)::int AS n FROM hostel_allocations a JOIN hostel_rooms r ON r.id = a.room_id WHERE r.hostel_id = $1 AND a.end_date IS NULL`, [req.params.id])).rows[0].n;
      if (n) throw conflict(`${n} students live here; vacate them first`);
      const r = await db.query(`DELETE FROM hostels WHERE id = $1`, [req.params.id]);
      if (!r.rowCount) throw notFound("Hostel");
    });
    res.json({ ok: true });
  }),
);

hostelRouter.post(
  "/:id/rooms",
  requirePermission("hostel.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const b = parse(
      z.object({ roomNo: z.string().trim().min(1).max(20), floor: z.number().int().min(0).max(50).default(0), capacity: z.number().int().min(1).max(20), roomType: z.string().trim().max(40).default("standard") }),
      req.body,
    );
    const row = await withTenant(tenant.id, async (db) => {
      if (!(await db.query(`SELECT 1 FROM hostels WHERE id = $1`, [req.params.id])).rowCount) throw notFound("Hostel");
      if ((await db.query(`SELECT 1 FROM hostel_rooms WHERE hostel_id = $1 AND lower(room_no) = lower($2)`, [req.params.id, b.roomNo])).rowCount) throw conflict(`Room ${b.roomNo} already exists`);
      return (
        await db.query(`INSERT INTO hostel_rooms (tenant_id, hostel_id, room_no, floor, capacity, room_type) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [
          tenant.id,
          req.params.id,
          b.roomNo,
          b.floor,
          b.capacity,
          b.roomType,
        ])
      ).rows[0];
    });
    res.status(201).json({ room: row });
  }),
);

hostelRouter.patch(
  "/rooms/:roomId",
  requirePermission("hostel.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const b = parse(z.object({ capacity: z.number().int().min(1).max(20).optional(), roomType: z.string().trim().max(40).optional(), floor: z.number().int().min(0).max(50).optional() }), req.body);
    const row = await withTenant(tenant.id, async (db) => {
      const n = (await db.query(`SELECT count(*)::int AS n FROM hostel_allocations WHERE room_id = $1 AND end_date IS NULL`, [req.params.roomId])).rows[0].n;
      if (b.capacity !== undefined && b.capacity < n) throw badRequest(`${n} students live in this room`);
      const r = (
        await db.query(`UPDATE hostel_rooms SET capacity = COALESCE($2, capacity), room_type = COALESCE($3, room_type), floor = COALESCE($4, floor) WHERE id = $1 RETURNING *`, [
          req.params.roomId,
          b.capacity ?? null,
          b.roomType ?? null,
          b.floor ?? null,
        ])
      ).rows[0];
      if (!r) throw notFound("Room");
      return r;
    });
    res.json({ room: row });
  }),
);

hostelRouter.delete(
  "/rooms/:roomId",
  requirePermission("hostel.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    await withTenant(tenant.id, async (db) => {
      const n = (await db.query(`SELECT count(*)::int AS n FROM hostel_allocations WHERE room_id = $1 AND end_date IS NULL`, [req.params.roomId])).rows[0].n;
      if (n) throw conflict(`${n} students live in this room; vacate them first`);
      const r = await db.query(`DELETE FROM hostel_rooms WHERE id = $1`, [req.params.roomId]);
      if (!r.rowCount) throw notFound("Room");
    });
    res.json({ ok: true });
  }),
);

/** Students with their current room (if any), for allocation pickers. */
hostelRouter.get(
  "/students",
  requirePermission("hostel.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const rows = await withTenant(tenant.id, (db) =>
      db.query(
        `SELECT sp.id AS student_id, u.name, u.email,
                (SELECT string_agg(c.name, ', ') FROM class_enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = sp.id) AS classes,
                h.name AS hostel, r.room_no
           FROM student_profiles sp JOIN users u ON u.id = sp.user_id
           LEFT JOIN hostel_allocations a ON a.student_id = sp.id AND a.end_date IS NULL
           LEFT JOIN hostel_rooms r ON r.id = a.room_id LEFT JOIN hostels h ON h.id = r.hostel_id
          WHERE EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = sp.tenant_id AND m.user_id = sp.user_id AND m.role_id = 'student' AND m.status = 'active')
          ORDER BY u.name`,
      ),
    );
    res.json({ students: rows.rows });
  }),
);

/** People who can be named warden. */
hostelRouter.get(
  "/wardens",
  requirePermission("hostel.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const rows = await withTenant(tenant.id, (db) =>
      db.query(
        `SELECT DISTINCT u.id, u.name FROM tenant_memberships m JOIN users u ON u.id = m.user_id
          WHERE m.tenant_id = $1 AND m.status = 'active' AND m.role_id IN ('warden','staff','teacher','tenant_admin','tenant_owner') ORDER BY u.name`,
        [tenant.id],
      ),
    );
    res.json({ wardens: rows.rows });
  }),
);

/** Give a student a bed. Moving rooms closes the previous allocation. */
hostelRouter.post(
  "/rooms/:roomId/allocations",
  requirePermission("hostel.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const b = parse(z.object({ studentId: z.string().uuid(), startDate: date.nullish(), notes: z.string().trim().max(300).nullish() }), req.body);
    const row = await withTenant(tenant.id, async (db) => {
      const room = (await db.query(`SELECT * FROM hostel_rooms WHERE id = $1 FOR UPDATE`, [req.params.roomId])).rows[0];
      if (!room) throw notFound("Room");
      if (!(await db.query(`SELECT 1 FROM student_profiles WHERE id = $1`, [b.studentId])).rowCount) throw notFound("Student");
      const current = (await db.query(`SELECT id, room_id FROM hostel_allocations WHERE student_id = $1 AND end_date IS NULL FOR UPDATE`, [b.studentId])).rows[0];
      if (current?.room_id === room.id) throw conflict("The student already lives in this room");
      const used = (await db.query(`SELECT count(*)::int AS n FROM hostel_allocations WHERE room_id = $1 AND end_date IS NULL`, [room.id])).rows[0].n;
      if (used >= room.capacity) throw conflict(`Room ${room.room_no} is full`);
      if (current) await db.query(`UPDATE hostel_allocations SET end_date = GREATEST(start_date, ${TODAY}) WHERE id = $1`, [current.id]);
      const a = (
        await db.query(
          `INSERT INTO hostel_allocations (tenant_id, room_id, student_id, start_date, notes, created_by) VALUES ($1,$2,$3,COALESCE($4::date, ${TODAY}),$5,$6) RETURNING *`,
          [tenant.id, room.id, b.studentId, b.startDate ?? null, b.notes ?? null, userId],
        )
      ).rows[0];
      await audit(db, { tenantId: tenant.id, actorId: userId, action: current ? "hostel.move" : "hostel.allocate", resourceType: "hostel_allocation", resourceId: a.id });
      return a;
    });
    res.status(201).json({ allocation: row });
  }),
);

hostelRouter.post(
  "/allocations/:id/vacate",
  requirePermission("hostel.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const row = await withTenant(tenant.id, async (db) => {
      const a = (await db.query(`UPDATE hostel_allocations SET end_date = GREATEST(start_date, ${TODAY}) WHERE id = $1 AND end_date IS NULL RETURNING *`, [req.params.id])).rows[0];
      if (!a) throw notFound("Current allocation");
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "hostel.vacate", resourceType: "hostel_allocation", resourceId: a.id });
      return a;
    });
    res.json({ allocation: row });
  }),
);

/** The caller's room (or a parent's child's), roommates and warden. */
hostelRouter.get(
  "/my",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(z.object({ studentId: z.string().uuid().optional() }), req.query);
    const data = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db, q.studentId);
      const a = (
        await db.query(
          `SELECT a.id, a.start_date, r.id AS room_id, r.room_no, r.floor, r.capacity, r.room_type, h.name AS hostel, h.kind, h.phone, h.address, w.name AS warden
             FROM hostel_allocations a JOIN hostel_rooms r ON r.id = a.room_id JOIN hostels h ON h.id = r.hostel_id LEFT JOIN users w ON w.id = h.warden_id
            WHERE a.student_id = $1 AND a.end_date IS NULL`,
          [student.id],
        )
      ).rows[0];
      if (!a) return { student: { id: student.id, name: student.name }, resident: false };
      const mates = (
        await db.query(
          `SELECT u.name FROM hostel_allocations x JOIN student_profiles sp ON sp.id = x.student_id JOIN users u ON u.id = sp.user_id
            WHERE x.room_id = $1 AND x.end_date IS NULL AND x.student_id <> $2 ORDER BY u.name`,
          [a.room_id, student.id],
        )
      ).rows.map((m) => m.name);
      return { student: { id: student.id, name: student.name }, resident: true, room: { ...a, roommates: mates } };
    });
    res.json(data);
  }),
);
