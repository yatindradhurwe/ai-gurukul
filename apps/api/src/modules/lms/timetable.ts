import { Router } from "express";
import { z } from "zod";
import { withTenant } from "../../database/pool.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { requirePermission } from "../../middleware/authorization.js";
import { loadClass, visibleClassesSql } from "./access.js";

export const timetableRouter = Router();

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");

/** Weekly timetable for the caller's classes (or one class). Teachers also see slots assigned to them. */
timetableRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const q = parse(z.object({ classId: z.string().uuid().optional() }), req.query);
    const visible = visibleClassesSql(req, 3);
    const rows = await withTenant(tenant.id, (db) =>
      db.query(
        `SELECT t.id, t.class_id, c.name AS class_name, t.day_of_week, to_char(t.start_time, 'HH24:MI') AS start_time,
                to_char(t.end_time, 'HH24:MI') AS end_time, t.subject, t.room, t.teacher_id, COALESCE(tu.name, cu.name) AS teacher
           FROM timetable_slots t JOIN classes c ON c.id = t.class_id JOIN users cu ON cu.id = c.teacher_id
           LEFT JOIN users tu ON tu.id = t.teacher_id
          WHERE (t.class_id IN (${visible.sql}) OR t.teacher_id = $2) AND ($1::uuid IS NULL OR t.class_id = $1)
          ORDER BY t.day_of_week, t.start_time, c.name`,
        [q.classId ?? null, userId, ...visible.params],
      ),
    );
    res.json({ slots: rows.rows });
  }),
);

timetableRouter.post(
  "/",
  requirePermission("classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const body = parse(
      z.object({
        classId: z.string().uuid(),
        dayOfWeek: z.number().int().min(1).max(7),
        startTime: time,
        endTime: time,
        subject: z.string().trim().min(1).max(120),
        room: z.string().trim().max(60).nullish(),
        teacherId: z.string().uuid().nullish(),
      }),
      req.body,
    );
    if (body.endTime <= body.startTime) throw badRequest("End time must be after start time");
    const row = await withTenant(tenant.id, async (db) => {
      const { cls } = await loadClass(req, db, body.classId, { manage: true });
      if (body.teacherId) {
        const m = await db.query(
          `SELECT 1 FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 AND role_id IN ('teacher','tenant_admin','tenant_owner') AND status = 'active'`,
          [tenant.id, body.teacherId],
        );
        if (!m.rowCount) throw badRequest("teacherId is not a teacher in this organization");
      }
      const teacherId = body.teacherId ?? cls.teacher_id;
      const clash = await db.query(
        `SELECT c.name FROM timetable_slots t JOIN classes c ON c.id = t.class_id
          WHERE t.day_of_week = $1 AND t.start_time < $3::time AND t.end_time > $2::time
            AND (t.class_id = $4 OR COALESCE(t.teacher_id, c.teacher_id) = $5) LIMIT 1`,
        [body.dayOfWeek, body.startTime, body.endTime, cls.id, teacherId],
      );
      if (clash.rowCount) throw conflict(`This overlaps an existing period (${clash.rows[0].name})`);
      return (
        await db.query(
          `INSERT INTO timetable_slots (tenant_id, class_id, day_of_week, start_time, end_time, subject, room, teacher_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [tenant.id, cls.id, body.dayOfWeek, body.startTime, body.endTime, body.subject, body.room ?? null, body.teacherId ?? null],
        )
      ).rows[0];
    });
    res.status(201).json({ slot: row });
  }),
);

timetableRouter.delete(
  "/:id",
  requirePermission("classes.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    await withTenant(tenant.id, async (db) => {
      const slot = (await db.query(`SELECT class_id FROM timetable_slots WHERE id = $1`, [req.params.id])).rows[0];
      if (!slot) throw notFound("Timetable slot");
      await loadClass(req, db, slot.class_id, { manage: true });
      await db.query(`DELETE FROM timetable_slots WHERE id = $1`, [req.params.id]);
    });
    res.json({ ok: true });
  }),
);
