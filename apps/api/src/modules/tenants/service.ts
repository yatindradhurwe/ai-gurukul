import type { Db } from "../../database/pool.js";
import { AppError } from "../../lib/errors.js";

/** Institution licenses are seat-based: adding a student must not exceed paid seats. */
export async function assertStudentSeatAvailable(db: Db, tenantId: string) {
  const sub = (
    await db.query(
      `SELECT s.seats FROM subscriptions s JOIN plans p ON p.id = s.plan_id
        WHERE s.tenant_id = $1 AND s.user_id IS NULL AND p.audience <> 'student'
          AND s.status IN ('active','trialing') AND (s.period_end IS NULL OR s.period_end > now())
        ORDER BY s.created_at DESC LIMIT 1`,
      [tenantId],
    )
  ).rows[0];
  if (!sub) return; // personal workspaces / unlicensed tenants are not seat-limited here
  const used = await db.query(
    `SELECT count(*)::int AS n FROM tenant_memberships WHERE tenant_id = $1 AND role_id = 'student' AND status = 'active'`,
    [tenantId],
  );
  if (used.rows[0].n >= sub.seats) {
    throw new AppError(402, "seat_limit_reached", `All ${sub.seats} student seats are in use. Add seats to invite more students.`);
  }
}
