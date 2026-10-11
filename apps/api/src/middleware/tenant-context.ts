import type { NextFunction, Request, Response } from "express";
import { withSystem } from "../database/pool.js";
import { forbidden, notFound, unauthorized } from "../lib/errors.js";
import { ROLE_PERMISSIONS, type Permission } from "../lib/permissions.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves the tenant for this request and verifies the caller is an active
 * member. The client may *select* a tenant (X-Tenant-Id / X-Tenant-Slug) or it
 * is derived from a verified custom domain — but membership is always checked
 * server-side, so a client-supplied ID alone grants nothing.
 */
export async function resolveTenant(req: Request, _res: Response, next: NextFunction) {
  try {
    if (!req.auth) throw unauthorized();
    const headerId = req.header("x-tenant-id");
    const headerSlug = req.header("x-tenant-slug");
    const host = (req.header("x-forwarded-host") ?? req.hostname ?? "").toLowerCase();

    const ctx = await withSystem(async (db) => {
      let tenant: { id: string; type: string; slug: string; status: string } | undefined;
      if (headerId && UUID_RE.test(headerId)) {
        tenant = (await db.query("SELECT id, type, slug, status FROM tenants WHERE id = $1", [headerId])).rows[0];
      } else if (headerSlug) {
        tenant = (await db.query("SELECT id, type, slug, status FROM tenants WHERE slug = $1", [headerSlug])).rows[0];
      } else if (host) {
        tenant = (
          await db.query(
            `SELECT t.id, t.type, t.slug, t.status FROM tenant_domains d JOIN tenants t ON t.id = d.tenant_id
             WHERE lower(d.domain) = $1 AND d.verification_status = 'verified'`,
            [host],
          )
        ).rows[0];
      }
      if (!tenant) throw notFound("Tenant");
      if (tenant.status !== "active") throw forbidden("This organization is not active");

      const memberships = await db.query(
        `SELECT role_id FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`,
        [tenant.id, req.auth!.userId],
      );
      if (memberships.rowCount === 0) throw forbidden("You are not a member of this organization");
      const roles = memberships.rows.map((r) => r.role_id as string);
      const permissions = new Set<Permission>(roles.flatMap((r) => ROLE_PERMISSIONS[r] ?? []));
      const profile = await db.query(`SELECT id FROM student_profiles WHERE tenant_id = $1 AND user_id = $2`, [
        tenant.id,
        req.auth!.userId,
      ]);
      return { id: tenant.id, type: tenant.type, slug: tenant.slug, roles, permissions, studentProfileId: profile.rows[0]?.id ?? null };
    });
    req.tenant = ctx;
    next();
  } catch (err) {
    next(err);
  }
}
