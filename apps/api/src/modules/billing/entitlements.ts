import type { Db } from "../../database/pool.js";
import { quotaExceeded } from "../../lib/errors.js";

export interface Entitlements {
  courses: "sample" | "catalog" | "licensed";
  ai_questions_per_month: number;
  avatar_lessons_per_month: number;
  avatar_live_minutes_per_month: number;
  practice_tests: "basic" | "expanded" | "institutional";
  progress_reports: "basic" | "detailed" | "institutional";
  teacher_tools: boolean;
  custom_branding: boolean;
  admin_analytics: "none" | "personal" | "institutional";
}

/** Applies when there is no active paid subscription (including after expiry). */
export const FREE_ENTITLEMENTS: Entitlements = {
  courses: "sample",
  ai_questions_per_month: 20,
  avatar_lessons_per_month: 2,
  avatar_live_minutes_per_month: 0,
  practice_tests: "basic",
  progress_reports: "basic",
  teacher_tools: false,
  custom_branding: false,
  admin_analytics: "none",
};

type QuotaKey = "ai_questions_per_month" | "avatar_lessons_per_month" | "avatar_live_minutes_per_month";

const USAGE_EVENT_FOR: Record<QuotaKey, string> = {
  ai_questions_per_month: "ai_question",
  avatar_lessons_per_month: "avatar_lesson_view",
  avatar_live_minutes_per_month: "avatar_live_minutes",
};

export interface ResolvedEntitlements {
  entitlements: Entitlements;
  planCode: string;
  subscriptionId: string | null;
  /** 'user' quotas count only this user's usage; 'tenant' quotas are pooled (institution contracts). */
  scope: "user" | "tenant";
}

/**
 * Server-side source of truth for what a user may do in a tenant. An active
 * or trialing subscription whose period has not ended applies; a personal
 * subscription takes precedence over a tenant-wide (institution) one.
 */
export async function resolveEntitlements(db: Db, tenantId: string, userId: string): Promise<ResolvedEntitlements> {
  const { rows } = await db.query(
    `SELECT s.id, s.user_id, p.code, p.entitlements
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.tenant_id = $1
        AND (s.user_id = $2 OR s.user_id IS NULL)
        AND s.status IN ('active','trialing')
        AND (s.period_end IS NULL OR s.period_end > now())
      ORDER BY (s.user_id IS NOT NULL) DESC, s.created_at DESC
      LIMIT 1`,
    [tenantId, userId],
  );
  const sub = rows[0];
  if (!sub) return { entitlements: FREE_ENTITLEMENTS, planCode: "free", subscriptionId: null, scope: "user" };
  return {
    entitlements: { ...FREE_ENTITLEMENTS, ...sub.entitlements },
    planCode: sub.code,
    subscriptionId: sub.id,
    scope: sub.user_id ? "user" : "tenant",
  };
}

export async function usageThisMonth(db: Db, tenantId: string, userId: string | null, eventType: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(quantity),0) AS used FROM usage_events
      WHERE tenant_id = $1 AND event_type = $2 AND ($3::uuid IS NULL OR user_id = $3)
        AND created_at >= date_trunc('month', now())`,
    [tenantId, eventType, userId],
  );
  return Number(rows[0].used);
}

/** Throws 402 when the quota is used up. Call inside the same transaction that records usage. */
export async function assertQuota(db: Db, tenantId: string, userId: string, key: QuotaKey, amount = 1) {
  const resolved = await resolveEntitlements(db, tenantId, userId);
  const limit = resolved.entitlements[key];
  // Serialise concurrent checks for the same quota bucket within this transaction.
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${tenantId}:${resolved.scope === "user" ? userId : "*"}:${key}`]);
  const used = await usageThisMonth(db, tenantId, resolved.scope === "user" ? userId : null, USAGE_EVENT_FOR[key]);
  if (used + amount > limit) throw quotaExceeded(key, limit);
  return { limit, used, resolved };
}

export async function recordUsage(
  db: Db,
  e: { tenantId: string; userId: string | null; eventType: string; quantity: number; costMicros?: number; metadata?: unknown },
) {
  await db.query(
    `INSERT INTO usage_events (tenant_id, user_id, event_type, quantity, cost_micros, metadata) VALUES ($1,$2,$3,$4,$5,$6)`,
    [e.tenantId, e.userId, e.eventType, e.quantity, e.costMicros ?? 0, JSON.stringify(e.metadata ?? {})],
  );
}
