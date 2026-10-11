import { Router } from "express";
import { z } from "zod";
import { audit, withSystem } from "../../database/pool.js";
import { notFound } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth } from "../../lib/http.js";
import { requireAuthentication } from "../../middleware/authentication.js";
import { requirePlatformAdmin } from "../../middleware/authorization.js";

/** Platform super-admin: narrow, and every access is itself audited. */
export const adminRouter = Router();
adminRouter.use(requireAuthentication, requirePlatformAdmin);

adminRouter.get(
  "/tenants",
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const rows = await withSystem(async (db) => {
      await audit(db, { actorId: userId, action: "admin.list_tenants" });
      return db.query(
        `SELECT t.id, t.name, t.type, t.slug, t.status, t.created_at,
                (SELECT count(*)::int FROM tenant_memberships m WHERE m.tenant_id = t.id AND m.status = 'active') AS members
           FROM tenants t ORDER BY t.created_at DESC LIMIT 200`,
      );
    });
    res.json({ tenants: rows.rows });
  }),
);

adminRouter.patch(
  "/tenants/:id",
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const { status, reason } = parse(z.object({ status: z.enum(["active", "suspended", "closed"]), reason: z.string().min(3).max(500) }), req.body);
    const row = await withSystem(async (db) => {
      const r = await db.query(`UPDATE tenants SET status = $2, updated_at = now() WHERE id = $1 RETURNING id, status`, [req.params.id, status]);
      if (!r.rows[0]) throw notFound("Tenant");
      await audit(db, { tenantId: req.params.id, actorId: userId, action: "admin.tenant_status", metadata: { status, reason } });
      return r.rows[0];
    });
    res.json({ tenant: row });
  }),
);

adminRouter.get(
  "/audit-logs",
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const { tenantId } = parse(z.object({ tenantId: z.string().uuid().optional() }), req.query);
    const rows = await withSystem(async (db) => {
      await audit(db, { tenantId: tenantId ?? null, actorId: userId, action: "admin.read_audit_logs" });
      return db.query(`SELECT * FROM audit_logs WHERE ($1::uuid IS NULL OR tenant_id = $1) ORDER BY created_at DESC LIMIT 200`, [tenantId ?? null]);
    });
    res.json({ logs: rows.rows });
  }),
);

adminRouter.get(
  "/usage-costs",
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const rows = await withSystem(async (db) => {
      await audit(db, { actorId: userId, action: "admin.usage_costs" });
      return db.query(
        `SELECT t.name AS tenant, u.event_type, sum(u.quantity) AS quantity, sum(u.cost_micros) AS cost_micros
           FROM usage_events u JOIN tenants t ON t.id = u.tenant_id
          WHERE u.created_at >= date_trunc('month', now()) GROUP BY t.name, u.event_type ORDER BY cost_micros DESC LIMIT 500`,
      );
    });
    res.json({ usage: rows.rows });
  }),
);
