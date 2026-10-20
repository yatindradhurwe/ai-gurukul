import { Router } from "express";
import { z } from "zod";
import { audit, withTenant, type Db } from "../../database/pool.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { resolveStudent } from "../../lib/student-access.js";
import { requirePermission } from "../../middleware/authorization.js";

export const transportRouter = Router();

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");
const phone = z.string().trim().max(20).nullish();

const STOP_COLUMNS = `s.id, s.route_id, s.name, s.landmark, s.sequence, to_char(s.pickup_time, 'HH24:MI') AS pickup_time, to_char(s.drop_time, 'HH24:MI') AS drop_time`;

async function routeDetail(db: Db, routeId: string) {
  const route = (
    await db.query(
      `SELECT r.id, r.name, r.vehicle_id, v.registration_no, v.label AS vehicle_label, v.capacity, v.driver_name, v.driver_phone,
              v.attendant_name, v.attendant_phone, v.status AS vehicle_status,
              (SELECT count(*)::int FROM transport_assignments a WHERE a.route_id = r.id) AS riders
         FROM transport_routes r LEFT JOIN transport_vehicles v ON v.id = r.vehicle_id WHERE r.id = $1`,
      [routeId],
    )
  ).rows[0];
  if (!route) throw notFound("Route");
  const stops = (await db.query(`SELECT ${STOP_COLUMNS} FROM transport_stops s WHERE s.route_id = $1 ORDER BY s.sequence`, [routeId])).rows;
  return { ...route, stops };
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------
const vehicleSchema = z.object({
  registrationNo: z.string().trim().min(2).max(20).transform((s) => s.toUpperCase()),
  label: z.string().trim().max(60).default(""),
  capacity: z.number().int().min(1).max(200),
  driverName: z.string().trim().max(120).default(""),
  driverPhone: phone,
  attendantName: z.string().trim().max(120).nullish(),
  attendantPhone: phone,
  status: z.enum(["active", "maintenance", "retired"]).default("active"),
});

transportRouter.get(
  "/vehicles",
  requirePermission("transport.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const rows = await withTenant(tenant.id, (db) =>
      db.query(
        `SELECT v.*, (SELECT string_agg(r.name, ', ') FROM transport_routes r WHERE r.vehicle_id = v.id) AS routes
           FROM transport_vehicles v ORDER BY v.label, v.registration_no`,
      ),
    );
    res.json({ vehicles: rows.rows });
  }),
);

transportRouter.post(
  "/vehicles",
  requirePermission("transport.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const b = parse(vehicleSchema, req.body);
    const row = await withTenant(tenant.id, async (db) => {
      const dup = await db.query(`SELECT 1 FROM transport_vehicles WHERE registration_no = $1`, [b.registrationNo]);
      if (dup.rowCount) throw conflict(`${b.registrationNo} is already registered`);
      return (
        await db.query(
          `INSERT INTO transport_vehicles (tenant_id, registration_no, label, capacity, driver_name, driver_phone, attendant_name, attendant_phone, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [tenant.id, b.registrationNo, b.label, b.capacity, b.driverName, b.driverPhone ?? null, b.attendantName ?? null, b.attendantPhone ?? null, b.status],
        )
      ).rows[0];
    });
    res.status(201).json({ vehicle: row });
  }),
);

transportRouter.patch(
  "/vehicles/:id",
  requirePermission("transport.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const b = parse(vehicleSchema.partial(), req.body);
    const row = await withTenant(tenant.id, async (db) => {
      const v = (await db.query(`SELECT * FROM transport_vehicles WHERE id = $1`, [req.params.id])).rows[0];
      if (!v) throw notFound("Vehicle");
      if (b.capacity !== undefined) {
        const most = (
          await db.query(`SELECT COALESCE(max(n), 0)::int AS n FROM (SELECT count(*) AS n FROM transport_assignments a JOIN transport_routes r ON r.id = a.route_id WHERE r.vehicle_id = $1 GROUP BY r.id) x`, [v.id])
        ).rows[0].n;
        if (b.capacity < most) throw badRequest(`A route on this vehicle already has ${most} riders`);
      }
      return (
        await db.query(
          `UPDATE transport_vehicles SET registration_no = COALESCE($2, registration_no), label = COALESCE($3, label), capacity = COALESCE($4, capacity),
                  driver_name = COALESCE($5, driver_name), driver_phone = COALESCE($6, driver_phone), attendant_name = COALESCE($7, attendant_name),
                  attendant_phone = COALESCE($8, attendant_phone), status = COALESCE($9, status) WHERE id = $1 RETURNING *`,
          [v.id, b.registrationNo ?? null, b.label ?? null, b.capacity ?? null, b.driverName ?? null, b.driverPhone ?? null, b.attendantName ?? null, b.attendantPhone ?? null, b.status ?? null],
        )
      ).rows[0];
    });
    res.json({ vehicle: row });
  }),
);

// ---------------------------------------------------------------------------
// Routes and stops
// ---------------------------------------------------------------------------
transportRouter.get(
  "/routes",
  requirePermission("transport.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const data = await withTenant(tenant.id, async (db) => {
      const ids = (await db.query(`SELECT id FROM transport_routes ORDER BY name`)).rows.map((r) => r.id);
      const routes = [];
      for (const id of ids) routes.push(await routeDetail(db, id));
      const summary = (
        await db.query(
          `SELECT (SELECT count(*)::int FROM transport_routes) AS routes, (SELECT count(*)::int FROM transport_vehicles WHERE status = 'active') AS vehicles,
                  (SELECT count(*)::int FROM transport_assignments) AS riders, (SELECT count(*)::int FROM transport_stops) AS stops`,
        )
      ).rows[0];
      return { routes, summary };
    });
    res.json(data);
  }),
);

transportRouter.post(
  "/routes",
  requirePermission("transport.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const b = parse(z.object({ name: z.string().trim().min(1).max(120), vehicleId: z.string().uuid().nullish() }), req.body);
    const row = await withTenant(tenant.id, async (db) => {
      if (b.vehicleId && !(await db.query(`SELECT 1 FROM transport_vehicles WHERE id = $1`, [b.vehicleId])).rowCount) throw notFound("Vehicle");
      const dup = await db.query(`SELECT 1 FROM transport_routes WHERE lower(name) = lower($1)`, [b.name]);
      if (dup.rowCount) throw conflict(`A route called ${b.name} already exists`);
      const r = (await db.query(`INSERT INTO transport_routes (tenant_id, name, vehicle_id) VALUES ($1,$2,$3) RETURNING *`, [tenant.id, b.name, b.vehicleId ?? null])).rows[0];
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "transport.route.create", resourceType: "transport_route", resourceId: r.id });
      return r;
    });
    res.status(201).json({ route: row });
  }),
);

transportRouter.patch(
  "/routes/:id",
  requirePermission("transport.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const b = parse(z.object({ name: z.string().trim().min(1).max(120).optional(), vehicleId: z.string().uuid().nullable().optional() }), req.body);
    const row = await withTenant(tenant.id, async (db) => {
      const r = await routeDetail(db, req.params.id);
      if (b.vehicleId) {
        const v = (await db.query(`SELECT capacity FROM transport_vehicles WHERE id = $1`, [b.vehicleId])).rows[0];
        if (!v) throw notFound("Vehicle");
        if (r.riders > v.capacity) throw badRequest(`This route has ${r.riders} riders but the vehicle seats ${v.capacity}`);
      }
      await db.query(`UPDATE transport_routes SET name = COALESCE($2, name), vehicle_id = CASE WHEN $4 THEN $3::uuid ELSE vehicle_id END WHERE id = $1`, [
        r.id,
        b.name ?? null,
        b.vehicleId ?? null,
        b.vehicleId !== undefined,
      ]);
      return routeDetail(db, r.id);
    });
    res.json({ route: row });
  }),
);

transportRouter.delete(
  "/routes/:id",
  requirePermission("transport.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    await withTenant(tenant.id, async (db) => {
      const r = await routeDetail(db, req.params.id);
      if (r.riders) throw conflict(`${r.riders} students ride this route; move them first`);
      await db.query(`DELETE FROM transport_routes WHERE id = $1`, [r.id]);
    });
    res.json({ ok: true });
  }),
);

transportRouter.post(
  "/routes/:id/stops",
  requirePermission("transport.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const b = parse(
      z.object({ name: z.string().trim().min(1).max(120), landmark: z.string().trim().max(160).nullish(), pickupTime: time, dropTime: time, sequence: z.number().int().min(1).optional() }),
      req.body,
    );
    const row = await withTenant(tenant.id, async (db) => {
      const r = await routeDetail(db, req.params.id);
      const seq = b.sequence ?? r.stops.length + 1;
      // Insert in the middle by shifting later stops down (two steps to respect the unique sequence).
      await db.query(`UPDATE transport_stops SET sequence = -sequence - 1 WHERE route_id = $1 AND sequence >= $2`, [r.id, seq]);
      await db.query(`UPDATE transport_stops SET sequence = -sequence WHERE route_id = $1 AND sequence < 0`, [r.id]);
      await db.query(
        `INSERT INTO transport_stops (tenant_id, route_id, name, landmark, sequence, pickup_time, drop_time) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [tenant.id, r.id, b.name, b.landmark ?? null, seq, b.pickupTime, b.dropTime],
      );
      return routeDetail(db, r.id);
    });
    res.status(201).json({ route: row });
  }),
);

transportRouter.delete(
  "/stops/:id",
  requirePermission("transport.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    await withTenant(tenant.id, async (db) => {
      const s = (await db.query(`SELECT id, route_id, sequence FROM transport_stops WHERE id = $1`, [req.params.id])).rows[0];
      if (!s) throw notFound("Stop");
      const riders = (await db.query(`SELECT count(*)::int AS n FROM transport_assignments WHERE stop_id = $1`, [s.id])).rows[0].n;
      if (riders) throw conflict(`${riders} students board at this stop; move them first`);
      await db.query(`DELETE FROM transport_stops WHERE id = $1`, [s.id]);
      await db.query(`UPDATE transport_stops SET sequence = sequence - 1 WHERE route_id = $1 AND sequence > $2`, [s.route_id, s.sequence]);
    });
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Riders
// ---------------------------------------------------------------------------
transportRouter.get(
  "/riders",
  requirePermission("transport.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(z.object({ routeId: z.string().uuid().optional() }), req.query);
    const rows = await withTenant(tenant.id, (db) =>
      db.query(
        `SELECT sp.id AS student_id, u.name, u.email,
                (SELECT string_agg(c.name, ', ') FROM class_enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = sp.id) AS classes,
                a.id AS assignment_id, a.direction, r.id AS route_id, r.name AS route, st.id AS stop_id, st.name AS stop,
                to_char(st.pickup_time, 'HH24:MI') AS pickup_time, to_char(st.drop_time, 'HH24:MI') AS drop_time
           FROM student_profiles sp JOIN users u ON u.id = sp.user_id
           LEFT JOIN transport_assignments a ON a.student_id = sp.id
           LEFT JOIN transport_routes r ON r.id = a.route_id LEFT JOIN transport_stops st ON st.id = a.stop_id
          WHERE EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.tenant_id = sp.tenant_id AND m.user_id = sp.user_id AND m.role_id = 'student' AND m.status = 'active')
            AND ($1::uuid IS NULL OR a.route_id = $1)
          ORDER BY (a.id IS NULL), r.name, st.sequence, u.name`,
        [q.routeId ?? null],
      ),
    );
    res.json({ students: rows.rows });
  }),
);

transportRouter.put(
  "/riders/:studentId",
  requirePermission("transport.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const b = parse(z.object({ stopId: z.string().uuid(), direction: z.enum(["both", "pickup", "drop"]).default("both") }), req.body);
    const row = await withTenant(tenant.id, async (db) => {
      const sp = await db.query(`SELECT 1 FROM student_profiles WHERE id = $1`, [req.params.studentId]);
      if (!sp.rowCount) throw notFound("Student");
      const stop = (await db.query(`SELECT id, route_id FROM transport_stops WHERE id = $1`, [b.stopId])).rows[0];
      if (!stop) throw notFound("Stop");
      // Serialise seat allocation per route so two assignments can't overfill the bus.
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1 || ':transport'))`, [stop.route_id]);
      const r = await routeDetail(db, stop.route_id);
      const already = await db.query(`SELECT route_id FROM transport_assignments WHERE student_id = $1`, [req.params.studentId]);
      const joining = already.rows[0]?.route_id !== r.id;
      if (joining && r.capacity != null && r.riders >= r.capacity) throw conflict(`${r.name} is full (${r.capacity} seats)`);
      const a = (
        await db.query(
          `INSERT INTO transport_assignments (tenant_id, student_id, route_id, stop_id, direction) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (student_id) DO UPDATE SET route_id = EXCLUDED.route_id, stop_id = EXCLUDED.stop_id, direction = EXCLUDED.direction
           RETURNING *`,
          [tenant.id, req.params.studentId, r.id, stop.id, b.direction],
        )
      ).rows[0];
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "transport.assign", resourceType: "transport_assignment", resourceId: a.id });
      return a;
    });
    res.json({ assignment: row });
  }),
);

transportRouter.delete(
  "/riders/:studentId",
  requirePermission("transport.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    await withTenant(tenant.id, (db) => db.query(`DELETE FROM transport_assignments WHERE student_id = $1`, [req.params.studentId]));
    res.json({ ok: true });
  }),
);

/** The caller's bus (or a parent's child's): route, vehicle, driver, every stop and theirs. */
transportRouter.get(
  "/my",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const q = parse(z.object({ studentId: z.string().uuid().optional() }), req.query);
    const data = await withTenant(tenant.id, async (db) => {
      const student = await resolveStudent(req, db, q.studentId);
      const a = (await db.query(`SELECT route_id, stop_id, direction FROM transport_assignments WHERE student_id = $1`, [student.id])).rows[0];
      if (!a) return { student: { id: student.id, name: student.name }, assigned: false };
      const route = await routeDetail(db, a.route_id);
      return { student: { id: student.id, name: student.name }, assigned: true, route, stopId: a.stop_id, direction: a.direction };
    });
    res.json(data);
  }),
);
