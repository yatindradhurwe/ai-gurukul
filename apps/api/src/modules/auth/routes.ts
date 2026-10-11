import { Router } from "express";
import { z } from "zod";
import { audit, withSystem } from "../../database/pool.js";
import { hashPassword, sha256, verifyPassword } from "../../lib/crypto.js";
import { conflict, unauthorized } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth } from "../../lib/http.js";
import { requireAuthentication } from "../../middleware/authentication.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { issueTokens, rotateRefreshToken, slugify } from "./service.js";

export const authRouter = Router();
const authLimiter = rateLimit({ name: "auth", windowMs: 15 * 60_000, max: 50 });

const registerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(200),
  phone: z.string().trim().max(20).optional(),
  // Individual sign-ups get a personal workspace. A student studies there;
  // a parent manages children there.
  accountType: z.enum(["student", "parent"]).default("student"),
});

authRouter.post(
  "/register",
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = parse(registerSchema, req.body);
    const result = await withSystem(async (db) => {
      const exists = await db.query(`SELECT 1 FROM users WHERE lower(email) = $1`, [body.email]);
      if (exists.rowCount) throw conflict("An account with this email already exists");
      const user = (
        await db.query(
          `INSERT INTO users (name, email, phone, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, name, email, is_platform_admin`,
          [body.name, body.email, body.phone ?? null, await hashPassword(body.password)],
        )
      ).rows[0];
      const workspaceName = body.accountType === "parent" ? `${body.name}'s family` : `${body.name}'s workspace`;
      const tenant = (
        await db.query(`INSERT INTO tenants (name, type, slug) VALUES ($1,'personal',$2) RETURNING id, name, slug, type`, [
          workspaceName,
          slugify(body.name),
        ])
      ).rows[0];
      await db.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role_id) VALUES ($1,$2,'tenant_owner')`, [tenant.id, user.id]);
      await db.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role_id) VALUES ($1,$2,$3)`, [tenant.id, user.id, body.accountType]);
      if (body.accountType === "student") {
        const cv = (await db.query(`SELECT id FROM curriculum_versions WHERE approval_status = 'approved' ORDER BY created_at LIMIT 1`)).rows[0];
        await db.query(`INSERT INTO student_profiles (tenant_id, user_id, curriculum_version_id) VALUES ($1,$2,$3)`, [tenant.id, user.id, cv?.id ?? null]);
      }
      await audit(db, { tenantId: tenant.id, actorId: user.id, action: "auth.register" });
      const tokens = await issueTokens(db, user);
      return { user: { id: user.id, name: user.name, email: user.email }, tenant, ...tokens };
    });
    const { refreshTokenId: _ignored, ...payload } = result;
    res.status(201).json(payload);
  }),
);

const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) });

authRouter.post(
  "/login",
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = parse(loginSchema, req.body);
    const result = await withSystem(async (db) => {
      const user = (await db.query(`SELECT * FROM users WHERE lower(email) = $1`, [body.email])).rows[0];
      // Same error for unknown email and wrong password.
      if (!user || user.status !== "active" || !(await verifyPassword(body.password, user.password_hash))) {
        throw unauthorized("Incorrect email or password");
      }
      const tokens = await issueTokens(db, user);
      return { user: { id: user.id, name: user.name, email: user.email }, ...tokens };
    });
    const { refreshTokenId: _ignored, ...payload } = result;
    res.json(payload);
  }),
);

authRouter.post(
  "/refresh",
  authLimiter,
  asyncHandler(async (req, res) => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(10) }), req.body);
    const result = await withSystem((db) => rotateRefreshToken(db, refreshToken));
    if ("reuseDetected" in result) throw unauthorized("Refresh token reuse detected; please sign in again");
    const { refreshTokenId: _ignored, ...tokens } = result;
    res.json(tokens);
  }),
);

authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(10) }), req.body);
    await withSystem((db) =>
      db.query(
        `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1) AND revoked_at IS NULL`,
        [sha256(refreshToken)],
      ),
    );
    res.status(204).end();
  }),
);

authRouter.get(
  "/me",
  requireAuthentication,
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const data = await withSystem(async (db) => {
      const user = (await db.query(`SELECT id, name, email, phone, is_platform_admin FROM users WHERE id = $1`, [userId])).rows[0];
      const memberships = await db.query(
        `SELECT t.id AS tenant_id, t.name, t.slug, t.type, t.settings, array_agg(m.role_id ORDER BY m.role_id) AS roles
           FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id
          WHERE m.user_id = $1 AND m.status = 'active' AND t.status = 'active'
          GROUP BY t.id ORDER BY t.created_at`,
        [userId],
      );
      return { user, memberships: memberships.rows };
    });
    res.json(data);
  }),
);
