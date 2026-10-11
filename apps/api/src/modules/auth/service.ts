import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import type { Db } from "../../database/pool.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import { unauthorized } from "../../lib/errors.js";
import { signAccessToken } from "../../middleware/authentication.js";

export async function issueTokens(db: Db, user: { id: string; is_platform_admin: boolean }, familyId: string = randomUUID()) {
  const refreshToken = randomToken(48);
  const row = await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
     VALUES ($1,$2,$3, now() + ($4 || ' days')::interval) RETURNING id`,
    [user.id, sha256(refreshToken), familyId, String(env.REFRESH_TOKEN_TTL_DAYS)],
  );
  return {
    accessToken: signAccessToken(user.id, user.is_platform_admin),
    refreshToken,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenId: row.rows[0].id as string,
  };
}

/**
 * Refresh-token rotation: each refresh token is single-use. Presenting a
 * token that was already rotated means it leaked, so the whole family is revoked.
 */
export async function rotateRefreshToken(db: Db, presented: string) {
  const row = (
    await db.query(
      `SELECT rt.*, u.is_platform_admin, u.status AS user_status FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
        WHERE rt.token_hash = $1 FOR UPDATE OF rt`,
      [sha256(presented)],
    )
  ).rows[0];
  if (!row) throw unauthorized("Invalid refresh token");
  if (row.revoked_at) {
    // Returned rather than thrown so the caller's transaction commits the revocation.
    await db.query(`UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE family_id = $1`, [row.family_id]);
    return { reuseDetected: true as const };
  }
  if (new Date(row.expires_at) < new Date() || row.user_status !== "active") throw unauthorized("Session expired");
  const tokens = await issueTokens(db, { id: row.user_id, is_platform_admin: row.is_platform_admin }, row.family_id);
  await db.query(`UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1`, [row.id, tokens.refreshTokenId]);
  return tokens;
}

export function slugify(name: string) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "org";
  return `${base}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}
