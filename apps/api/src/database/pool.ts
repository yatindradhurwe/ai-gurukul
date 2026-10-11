import pg from "pg";
import { env } from "../config/env.js";

// Return DATE columns as 'YYYY-MM-DD' strings, not JS Dates shifted by timezone.
pg.types.setTypeParser(1082, (v) => v);
// NUMERIC -> number (values here are small scores/marks, safe in float64).
pg.types.setTypeParser(1700, (v) => Number(v));
// BIGINT -> number for paise amounts (well below 2^53).
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });

export type Db = pg.PoolClient;

/**
 * Superusers (and BYPASSRLS users) ignore row-level security, so for them
 * tenant transactions switch to the restricted gurukul_app role. Ordinary
 * database users — the normal case on managed hosting — are already subject
 * to the FORCEd policies and need no role switch (or CREATEROLE privilege).
 */
let roleSwitch: Promise<boolean> | null = null;
function needsRoleSwitch(client: pg.PoolClient): Promise<boolean> {
  roleSwitch ??= client
    .query(
      `SELECT (r.rolsuper OR r.rolbypassrls) AS bypasses,
              EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gurukul_app') AS has_app_role
         FROM pg_roles r WHERE r.rolname = current_user`,
    )
    .then(({ rows }) => {
      const { bypasses, has_app_role } = rows[0];
      if (bypasses && !has_app_role) {
        console.warn("WARNING: the database user bypasses row-level security and the gurukul_app role is missing; connect as a non-superuser for database-enforced tenant isolation.");
      }
      return Boolean(bypasses && has_app_role);
    })
    .catch((err) => {
      roleSwitch = null;
      throw err;
    });
  return roleSwitch;
}

/**
 * Run `fn` in a transaction scoped to one tenant. PostgreSQL RLS enforces
 * isolation even if a query forgets its tenant filter.
 */
export async function withTenant<T>(tenantId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    if (await needsRoleSwitch(client)) await client.query("SET LOCAL ROLE gurukul_app");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Trusted cross-tenant work (auth, tenant resolution, webhooks, workers).
 * Callers are responsible for carrying and re-checking tenant context.
 */
export async function withSystem<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await enterSystemContext(client);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function audit(
  db: Db,
  entry: { tenantId?: string | null; actorId?: string | null; action: string; resourceType?: string; resourceId?: string; metadata?: unknown },
) {
  await db.query(
    `INSERT INTO audit_logs (tenant_id, actor_id, action, resource_type, resource_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [entry.tenantId ?? null, entry.actorId ?? null, entry.action, entry.resourceType ?? null, entry.resourceId ?? null, JSON.stringify(entry.metadata ?? {})],
  );
}

/** Opt the current transaction out of tenant RLS (trusted system code only). */
export async function enterSystemContext(db: Db) {
  await db.query("SELECT set_config('app.system', 'on', true)");
}
