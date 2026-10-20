import { Router } from "express";
import { z } from "zod";
import { audit, withSystem } from "../../database/pool.js";
import { badRequest } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import {
  EDITABLE_PERMISSIONS,
  LOCKED_ROLES,
  ROLE_NAMES,
  ROLE_PERMISSIONS,
  permissionsFor,
  type AccessOverrides,
} from "../../lib/permissions.js";
import { requirePermission } from "../../middleware/authorization.js";
import { publish } from "../../realtime/hub.js";

/**
 * Role-based access per module, set by the principal for their organization.
 * Stored as grants and revocations against each role's defaults in
 * tenants.settings.access, and applied on every request by resolveTenant.
 */
export const accessRouter = Router();
accessRouter.use(requirePermission("tenant.manage"));

const EDITABLE = new Set<string>(EDITABLE_PERMISSIONS.map((p) => p.id));

async function load(tenantId: string) {
  return withSystem(async (db) => {
    const overrides: AccessOverrides = (await db.query(`SELECT settings -> 'access' AS a FROM tenants WHERE id = $1`, [tenantId])).rows[0]?.a ?? {};
    const counts = (await db.query(`SELECT role_id, count(*)::int AS n FROM tenant_memberships WHERE tenant_id = $1 AND status = 'active' GROUP BY role_id`, [tenantId])).rows;
    return { overrides, counts: Object.fromEntries(counts.map((c) => [c.role_id, c.n])) as Record<string, number> };
  });
}

function view(overrides: AccessOverrides, counts: Record<string, number>) {
  return {
    permissions: EDITABLE_PERMISSIONS,
    roles: Object.keys(ROLE_PERMISSIONS).map((id) => {
      const effective = new Set(permissionsFor(id, overrides));
      const defaults = new Set<string>(ROLE_PERMISSIONS[id]);
      return {
        id,
        name: ROLE_NAMES[id] ?? id,
        members: counts[id] ?? 0,
        locked: LOCKED_ROLES.includes(id),
        allowed: EDITABLE_PERMISSIONS.filter((p) => effective.has(p.id)).map((p) => p.id),
        defaults: EDITABLE_PERMISSIONS.filter((p) => defaults.has(p.id)).map((p) => p.id),
        customised: !!(overrides[id]?.grant?.length || overrides[id]?.revoke?.length),
      };
    }),
  };
}

async function save(tenantId: string, actorId: string, overrides: AccessOverrides, role: string) {
  await withSystem(async (db) => {
    await db.query(`UPDATE tenants SET settings = jsonb_set(settings, '{access}', $2::jsonb), updated_at = now() WHERE id = $1`, [tenantId, JSON.stringify(overrides)]);
    await audit(db, { tenantId, actorId, action: "access.update", metadata: { role, ...overrides[role] } });
    // Everyone's menus and pages follow the new rules without signing in again.
    await publish(db, tenantId, "all", { type: "notify", module: "access" });
  });
}

accessRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { overrides, counts } = await load(tenant.id);
    res.json(view(overrides, counts));
  }),
);

/** Set exactly which module permissions a role has. */
accessRouter.put(
  "/:role",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const role = req.params.role;
    if (!ROLE_PERMISSIONS[role]) throw badRequest("Unknown role");
    if (LOCKED_ROLES.includes(role)) throw badRequest("The principal's own access can't be changed");
    const b = parse(z.object({ permissions: z.array(z.string()).max(EDITABLE_PERMISSIONS.length) }), req.body);
    const unknown = b.permissions.filter((p) => !EDITABLE.has(p));
    if (unknown.length) throw badRequest(`These can't be set per role: ${unknown.join(", ")}`);
    const want = new Set(b.permissions);
    const defaults = new Set<string>(ROLE_PERMISSIONS[role].filter((p) => EDITABLE.has(p)));
    const { overrides, counts } = await load(tenant.id);
    const next: AccessOverrides = { ...overrides };
    const grant = [...want].filter((p) => !defaults.has(p));
    const revoke = [...defaults].filter((p) => !want.has(p));
    if (grant.length || revoke.length) next[role] = { grant, revoke };
    else delete next[role];
    await save(tenant.id, userId, next, role);
    res.json(view(next, counts));
  }),
);

/** Back to the built-in access for a role. */
accessRouter.delete(
  "/:role",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const { overrides, counts } = await load(tenant.id);
    const next = { ...overrides };
    delete next[req.params.role];
    await save(tenant.id, userId, next, req.params.role);
    res.json(view(next, counts));
  }),
);
