import { Router } from "express";
import { z } from "zod";
import { audit, withTenant } from "../../database/pool.js";
import { forbidden, notFound } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { requirePermission } from "../../middleware/authorization.js";
import { publish } from "../../realtime/hub.js";
import { isOrgAdmin, loadClass, visibleClassesSql } from "./access.js";

export const announcementsRouter = Router();

const STAFF_ROLES = ["tenant_owner", "tenant_admin", "teacher", "staff", "content_reviewer"];

/** Audiences an announcement may target that include the caller. */
function audiencesFor(roles: string[]) {
  const a = ["all"];
  if (roles.some((r) => STAFF_ROLES.includes(r))) a.push("staff");
  if (roles.includes("student")) a.push("students");
  if (roles.includes("parent")) a.push("parents");
  return a;
}

announcementsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const manager = tenant.permissions.has("announcements.manage");
    const visible = visibleClassesSql(req, 4);
    const rows = await withTenant(tenant.id, (db) =>
      db.query(
        `SELECT a.id, a.title, a.body, a.audience, a.pinned, a.created_at, a.class_id, c.name AS class_name,
                u.name AS author, a.created_by = $1 AS mine,
                EXISTS (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id AND r.user_id = $1) AS read,
                (SELECT count(*)::int FROM announcement_reads r WHERE r.announcement_id = a.id) AS reads
           FROM announcements a JOIN users u ON u.id = a.created_by LEFT JOIN classes c ON c.id = a.class_id
          WHERE ($2::boolean OR a.audience = ANY($3::text[]))
            AND (a.class_id IS NULL OR a.class_id IN (${visible.sql}))
          ORDER BY a.pinned DESC, a.created_at DESC
          LIMIT 200`,
        [userId, manager, audiencesFor(tenant.roles), ...visible.params],
      ),
    );
    const announcements = rows.rows.map(({ reads, ...a }) => (manager ? { ...a, reads } : a));
    res.json({ announcements, unread: announcements.filter((a) => !a.read).length });
  }),
);

announcementsRouter.post(
  "/",
  requirePermission("announcements.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(
      z.object({
        title: z.string().trim().min(1).max(200),
        body: z.string().trim().min(1).max(5000),
        audience: z.enum(["all", "staff", "students", "parents"]).default("all"),
        classId: z.string().uuid().nullish(),
        pinned: z.boolean().default(false),
      }),
      req.body,
    );
    const row = await withTenant(tenant.id, async (db) => {
      if (body.classId) await loadClass(req, db, body.classId, { manage: true });
      else if (!isOrgAdmin(req)) throw forbidden("Only admins can post to the whole organization; choose a class");
      const a = (
        await db.query(
          `INSERT INTO announcements (tenant_id, class_id, title, body, audience, pinned, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [tenant.id, body.classId ?? null, body.title, body.body, body.audience, body.pinned, userId],
        )
      ).rows[0];
      await db.query(`INSERT INTO announcement_reads (tenant_id, announcement_id, user_id) VALUES ($1,$2,$3)`, [tenant.id, a.id, userId]);
      // Bells update live; each client re-reads the list, which applies audience and class rules.
      await publish(db, tenant.id, "all", { type: "notify", module: "announcements" });
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "announcement.create", resourceType: "announcement", resourceId: a.id });
      return a;
    });
    res.status(201).json({ announcement: row });
  }),
);

announcementsRouter.post(
  "/:id/read",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    await withTenant(tenant.id, async (db) => {
      const a = await db.query(`SELECT 1 FROM announcements WHERE id = $1`, [req.params.id]);
      if (!a.rowCount) throw notFound("Announcement");
      await db.query(
        `INSERT INTO announcement_reads (tenant_id, announcement_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [tenant.id, req.params.id, userId],
      );
    });
    res.json({ ok: true });
  }),
);

announcementsRouter.delete(
  "/:id",
  requirePermission("announcements.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    await withTenant(tenant.id, async (db) => {
      const a = (await db.query(`SELECT created_by FROM announcements WHERE id = $1`, [req.params.id])).rows[0];
      if (!a) throw notFound("Announcement");
      if (a.created_by !== userId && !isOrgAdmin(req)) throw forbidden("Only the author or an admin can delete this");
      await db.query(`DELETE FROM announcements WHERE id = $1`, [req.params.id]);
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "announcement.delete", resourceType: "announcement", resourceId: req.params.id });
    });
    res.json({ ok: true });
  }),
);
