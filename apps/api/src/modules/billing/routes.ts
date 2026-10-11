import express, { Router } from "express";
import { z } from "zod";
import { audit, withSystem, withTenant } from "../../database/pool.js";
import { badRequest, notFound, unauthorized } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { requireAuthentication } from "../../middleware/authentication.js";
import { requirePermission } from "../../middleware/authorization.js";
import { resolveTenant } from "../../middleware/tenant-context.js";
import { getPaymentProvider } from "../../integrations/payment-provider/index.js";
import { resolveEntitlements } from "./entitlements.js";

export const billingRouter = Router();

billingRouter.get(
  "/plans",
  asyncHandler(async (_req, res) => {
    const plans = await withSystem((db) =>
      db.query(`SELECT id, code, name, price_paise, billing_period, audience, entitlements FROM plans WHERE is_active ORDER BY price_paise`),
    );
    res.json({ plans: plans.rows });
  }),
);

billingRouter.get(
  "/subscription",
  requireAuthentication,
  resolveTenant,
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const result = await withTenant(tenant.id, async (db) => {
      const resolved = await resolveEntitlements(db, tenant.id, userId);
      const subs = await db.query(
        `SELECT s.id, s.status, s.seats, s.period_start, s.period_end, s.cancel_at_period_end, p.code, p.name
           FROM subscriptions s JOIN plans p ON p.id = s.plan_id
          WHERE s.user_id = $1 OR s.user_id IS NULL ORDER BY s.created_at DESC LIMIT 10`,
        [userId],
      );
      return { current: resolved, subscriptions: subs.rows };
    });
    res.json(result);
  }),
);

const checkoutSchema = z.object({
  planCode: z.string(),
  seats: z.number().int().min(1).max(100_000).default(1),
  idempotencyKey: z.string().min(8).max(100),
});

billingRouter.post(
  "/checkout",
  requireAuthentication,
  resolveTenant,
  requirePermission("tenant.billing"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(checkoutSchema, req.body);
    const provider = getPaymentProvider()!;

    const result = await withTenant(tenant.id, async (db) => {
      // Idempotent: the same key returns the same checkout instead of creating a second charge.
      const existing = await db.query(
        `SELECT p.provider_reference, p.subscription_id, p.amount_paise FROM payments p WHERE p.idempotency_key = $1`,
        [body.idempotencyKey],
      );
      if (existing.rows[0]) return { ...existing.rows[0], reused: true };

      const plan = (await db.query(`SELECT * FROM plans WHERE code = $1 AND is_active`, [body.planCode])).rows[0];
      if (!plan) throw notFound("Plan");
      if (plan.price_paise === 0) throw badRequest("The free plan does not need checkout");
      const isInstitution = plan.audience !== "student";
      const amount = plan.price_paise * (isInstitution ? body.seats : 1);
      const session = await provider.createCheckout({
        amountPaise: amount,
        currency: "INR",
        idempotencyKey: body.idempotencyKey,
        description: plan.name,
      });
      const sub = await db.query(
        `INSERT INTO subscriptions (tenant_id, user_id, plan_id, status, seats) VALUES ($1,$2,$3,'pending',$4) RETURNING id`,
        [tenant.id, isInstitution ? null : userId, plan.id, isInstitution ? body.seats : 1],
      );
      await db.query(
        `INSERT INTO payments (tenant_id, subscription_id, provider, provider_reference, idempotency_key, amount_paise, status)
         VALUES ($1,$2,$3,$4,$5,$6,'created')`,
        [tenant.id, sub.rows[0].id, provider.name, session.providerReference, body.idempotencyKey, amount],
      );
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "billing.checkout", resourceType: "subscription", resourceId: sub.rows[0].id });
      return { provider_reference: session.providerReference, subscription_id: sub.rows[0].id, amount_paise: amount, checkout_url: session.checkoutUrl, reused: false };
    });
    res.status(result.reused ? 200 : 201).json(result);
  }),
);

billingRouter.post(
  "/subscription/:id/cancel",
  requireAuthentication,
  resolveTenant,
  requirePermission("tenant.billing"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const row = await withTenant(tenant.id, async (db) => {
      const r = await db.query(
        `UPDATE subscriptions SET cancel_at_period_end = true, updated_at = now()
          WHERE id = $1 AND (user_id = $2 OR user_id IS NULL) AND status IN ('active','trialing') RETURNING id, period_end`,
        [req.params.id, userId],
      );
      if (!r.rows[0]) throw notFound("Subscription");
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "billing.cancel", resourceType: "subscription", resourceId: req.params.id });
      return r.rows[0];
    });
    res.json({ subscription: row, message: "Your subscription will not renew and stays active until the end of the current period." });
  }),
);

/**
 * Payment gateway webhooks. The raw body is verified with HMAC before parsing;
 * each provider event id is stored once, so retries/duplicates cannot activate
 * a subscription or record a payment twice.
 */
export const billingWebhookRouter = Router();
billingWebhookRouter.post(
  "/:provider",
  express.raw({ type: "*/*", limit: "256kb" }),
  asyncHandler(async (req, res) => {
    const provider = getPaymentProvider(req.params.provider);
    if (!provider) throw notFound("Payment provider");
    let event;
    try {
      event = provider.verifyWebhook(req.body as Buffer, req.header("x-signature"));
    } catch {
      throw unauthorized("Invalid webhook signature");
    }
    const outcome = await withSystem(async (db) => {
      const inserted = await db.query(
        `INSERT INTO payment_webhook_events (provider, event_id, event_type, payload)
         VALUES ($1,$2,$3,$4) ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
        [provider.name, event.id, event.type, JSON.stringify(event)],
      );
      if (inserted.rowCount === 0) return "duplicate";

      const payment = (
        await db.query(`SELECT * FROM payments WHERE provider = $1 AND provider_reference = $2 FOR UPDATE`, [
          provider.name,
          event.data.provider_reference,
        ])
      ).rows[0];
      if (!payment) return "unknown_payment";

      if (event.type === "payment.captured" && payment.status === "created") {
        if (event.data.amount_paise != null && event.data.amount_paise !== payment.amount_paise) {
          await audit(db, { tenantId: payment.tenant_id, action: "billing.amount_mismatch", resourceType: "payment", resourceId: payment.id, metadata: event });
          return "amount_mismatch";
        }
        await db.query(`UPDATE payments SET status = 'captured', updated_at = now() WHERE id = $1`, [payment.id]);
        const sub = (await db.query(`SELECT s.*, p.billing_period FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.id = $1 FOR UPDATE OF s`, [payment.subscription_id])).rows[0];
        const interval = sub.billing_period === "annual" ? "1 year" : "1 month";
        // Renewal extends from the later of now and the current period end.
        await db.query(
          `UPDATE subscriptions
              SET status = 'active',
                  period_start = COALESCE(period_start, now()),
                  period_end = GREATEST(COALESCE(period_end, now()), now()) + $2::interval,
                  updated_at = now()
            WHERE id = $1`,
          [sub.id, interval],
        );
        await audit(db, { tenantId: payment.tenant_id, action: "billing.payment_captured", resourceType: "payment", resourceId: payment.id });
      } else if (event.type === "payment.failed" && payment.status === "created") {
        await db.query(`UPDATE payments SET status = 'failed', updated_at = now() WHERE id = $1`, [payment.id]);
        await db.query(`UPDATE subscriptions SET status = CASE WHEN status = 'active' THEN 'past_due' ELSE status END, updated_at = now() WHERE id = $1`, [payment.subscription_id]);
      }
      await db.query(`UPDATE payment_webhook_events SET processed_at = now() WHERE id = $1`, [inserted.rows[0].id]);
      return "processed";
    });
    res.json({ received: true, outcome });
  }),
);
