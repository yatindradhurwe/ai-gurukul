import { Router } from "express";
import { z } from "zod";
import { audit, withSystem, withTenant } from "../../database/pool.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { requireAuthentication } from "../../middleware/authentication.js";
import { requirePermission } from "../../middleware/authorization.js";
import { resolveTenant } from "../../middleware/tenant-context.js";
import { slugify } from "../auth/service.js";
import { assertStudentSeatAvailable } from "./service.js";

export const tenantsRouter = Router();
tenantsRouter.use(requireAuthentication);

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  type: z.enum(["school", "coaching", "white_label", "publisher", "enterprise"]),
});

/** Create an organization; the caller becomes its owner. */
tenantsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const body = parse(createSchema, req.body);
    const tenant = await withSystem(async (db) => {
      const t = (
        await db.query(`INSERT INTO tenants (name, type, slug) VALUES ($1,$2,$3) RETURNING id, name, slug, type, settings`, [
          body.name,
          body.type,
          slugify(body.name),
        ])
      ).rows[0];
      await db.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role_id) VALUES ($1,$2,'tenant_owner')`, [t.id, userId]);
      await audit(db, { tenantId: t.id, actorId: userId, action: "tenant.create" });
      return t;
    });
    res.status(201).json({ tenant });
  }),
);

tenantsRouter.get(
  "/current",
  resolveTenant,
  asyncHandler(async (req, res) => {
    const t = requireTenant(req);
    const row = await withSystem((db) => db.query(`SELECT id, name, slug, type, settings, status FROM tenants WHERE id = $1`, [t.id]));
    res.json({ tenant: row.rows[0], roles: t.roles, permissions: [...t.permissions], studentProfileId: t.studentProfileId });
  }),
);

const brandingSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  settings: z
    .object({
      logoUrl: z.string().url().optional(),
      primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      supportEmail: z.string().email().optional(),
      supportPhone: z.string().max(20).optional(),
      enabledFeatures: z.array(z.string()).optional(),
    })
    .optional(),
});

tenantsRouter.patch(
  "/current",
  resolveTenant,
  requirePermission("tenant.manage"),
  asyncHandler(async (req, res) => {
    const t = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(brandingSchema, req.body);
    const row = await withSystem(async (db) => {
      const r = await db.query(
        `UPDATE tenants SET name = COALESCE($2, name), settings = settings || $3::jsonb, updated_at = now()
          WHERE id = $1 RETURNING id, name, slug, type, settings`,
        [t.id, body.name ?? null, JSON.stringify(body.settings ?? {})],
      );
      await audit(db, { tenantId: t.id, actorId: userId, action: "tenant.update", metadata: body });
      return r.rows[0];
    });
    res.json({ tenant: row });
  }),
);

tenantsRouter.get(
  "/current/members",
  resolveTenant,
  requirePermission("members.manage", "reports.class"),
  asyncHandler(async (req, res) => {
    const t = requireTenant(req);
    const rows = await withSystem((db) =>
      db.query(
        `SELECT u.id, u.name, u.email, array_agg(m.role_id) AS roles, sp.id AS student_profile_id
           FROM tenant_memberships m JOIN users u ON u.id = m.user_id
           LEFT JOIN student_profiles sp ON sp.user_id = u.id AND sp.tenant_id = m.tenant_id
          WHERE m.tenant_id = $1 AND m.status = 'active' GROUP BY u.id, sp.id ORDER BY u.name`,
        [t.id],
      ),
    );
    res.json({ members: rows.rows });
  }),
);

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(["tenant_admin", "teacher", "staff", "accountant", "librarian", "transport_manager", "warden", "content_reviewer", "parent", "student"]),
});

tenantsRouter.post(
  "/:id/invitations",
  resolveTenant,
  requirePermission("members.manage"),
  asyncHandler(async (req, res) => {
    const t = requireTenant(req);
    if (req.params.id !== t.id) throw forbidden("Tenant mismatch");
    const { userId } = requireAuth(req);
    const body = parse(inviteSchema, req.body);
    const token = randomToken(24);
    const invitation = await withTenant(t.id, async (db) => {
      if (body.role === "student") await assertStudentSeatAvailable(db, t.id);
      const r = await db.query(
        `INSERT INTO tenant_invitations (tenant_id, email, role_id, token_hash, invited_by, expires_at)
         VALUES ($1,$2,$3,$4,$5, now() + interval '7 days') RETURNING id, email, role_id, expires_at`,
        [t.id, body.email, body.role, sha256(token), userId],
      );
      await audit(db, { tenantId: t.id, actorId: userId, action: "member.invite", metadata: { email: body.email, role: body.role } });
      return r.rows[0];
    });
    // In production the token is delivered by email/SMS only; it is returned here for the MVP flow.
    res.status(201).json({ invitation, token });
  }),
);

tenantsRouter.post(
  "/invitations/accept",
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const { token } = parse(z.object({ token: z.string().min(10) }), req.body);
    const result = await withSystem(async (db) => {
      const inv = (await db.query(`SELECT * FROM tenant_invitations WHERE token_hash = $1 FOR UPDATE`, [sha256(token)])).rows[0];
      if (!inv || inv.accepted_at || new Date(inv.expires_at) < new Date()) throw notFound("Invitation");
      const user = (await db.query(`SELECT email FROM users WHERE id = $1`, [userId])).rows[0];
      if (user.email.toLowerCase() !== inv.email.toLowerCase()) throw forbidden("This invitation was sent to a different email address");
      if (inv.role_id === "student") await assertStudentSeatAvailable(db, inv.tenant_id);
      await db.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role_id) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id, user_id, role_id) DO UPDATE SET status = 'active'`,
        [inv.tenant_id, userId, inv.role_id],
      );
      if (inv.role_id === "student") {
        await db.query(`INSERT INTO student_profiles (tenant_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [inv.tenant_id, userId]);
      }
      await db.query(`UPDATE tenant_invitations SET accepted_at = now() WHERE id = $1`, [inv.id]);
      await audit(db, { tenantId: inv.tenant_id, actorId: userId, action: "member.join", metadata: { role: inv.role_id } });
      return { tenantId: inv.tenant_id, role: inv.role_id };
    });
    res.json(result);
  }),
);

tenantsRouter.post(
  "/:id/domains",
  resolveTenant,
  requirePermission("tenant.manage"),
  asyncHandler(async (req, res) => {
    const t = requireTenant(req);
    if (req.params.id !== t.id) throw forbidden("Tenant mismatch");
    const { domain } = parse(z.object({ domain: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/) }), req.body);
    if (domain.endsWith(".aigurukul.in")) throw badRequest("Platform subdomains are assigned automatically");
    const row = await withTenant(t.id, (db) =>
      db.query(`INSERT INTO tenant_domains (tenant_id, domain) VALUES ($1,$2) RETURNING id, domain, verification_status, verification_token`, [t.id, domain]),
    );
    res.status(201).json({
      domain: row.rows[0],
      instructions: `Create a DNS TXT record _aigurukul.${domain} with value ${row.rows[0].verification_token}`,
    });
  }),
);
