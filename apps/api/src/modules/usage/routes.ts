import { Router } from "express";
import { withTenant } from "../../database/pool.js";
import { asyncHandler, requireAuth, requireTenant } from "../../lib/http.js";
import { resolveEntitlements, usageThisMonth } from "../billing/entitlements.js";

export const usageRouter = Router();

/** The caller's quotas vs usage this month; tenant-wide breakdown for admins with usage.read. */
usageRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const data = await withTenant(tenant.id, async (db) => {
      const resolved = await resolveEntitlements(db, tenant.id, userId);
      const scopeUser = resolved.scope === "user" ? userId : null;
      const quotas = {
        ai_questions: { limit: resolved.entitlements.ai_questions_per_month, used: await usageThisMonth(db, tenant.id, scopeUser, "ai_question") },
        avatar_lessons: { limit: resolved.entitlements.avatar_lessons_per_month, used: await usageThisMonth(db, tenant.id, scopeUser, "avatar_lesson_view") },
        avatar_live_minutes: { limit: resolved.entitlements.avatar_live_minutes_per_month, used: await usageThisMonth(db, tenant.id, scopeUser, "avatar_live_minutes") },
      };
      let tenantBreakdown = null;
      if (tenant.permissions.has("usage.read")) {
        tenantBreakdown = (
          await db.query(
            `SELECT event_type, sum(quantity) AS quantity, sum(cost_micros) AS cost_micros, count(DISTINCT user_id)::int AS users
               FROM usage_events WHERE created_at >= date_trunc('month', now()) GROUP BY event_type ORDER BY event_type`,
          )
        ).rows;
      }
      return { plan: resolved.planCode, scope: resolved.scope, quotas, tenantBreakdown };
    });
    res.json(data);
  }),
);
