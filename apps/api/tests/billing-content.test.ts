/** Subscriptions, quotas, webhooks and content indexing acceptance tests. */
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/database/pool.js";
import { hmacSha256Hex } from "../src/lib/crypto.js";
import { processOutboxBatch } from "../src/jobs/outbox.js";
import { api, app, dbAvailable, register, resetDb, type Session } from "./helpers.js";

const signed = (body: object) => {
  const raw = JSON.stringify(body);
  return { raw, signature: hmacSha256Hex("test-webhook-secret", raw) };
};

const webhook = (body: object, signature?: string) => {
  const s = signed(body);
  return request(app)
    .post("/api/v1/billing/webhooks/mock")
    .set("Content-Type", "application/json")
    .set("X-Signature", signature ?? s.signature)
    .send(s.raw);
};

describe.skipIf(!dbAvailable)("billing, quotas and webhooks", () => {
  let student: Session;
  let sessionId: string;

  beforeAll(async () => {
    await resetDb();
    student = await register("student", "Paying Student");
    sessionId = (await api.post(student, "/api/v1/ai/sessions", {}).expect(201)).body.session.id;
  });

  const ask = () => api.post(student, `/api/v1/ai/sessions/${sessionId}/messages`, { content: "What is friction?" });

  it("enforces the free plan's AI quota server-side", async () => {
    await pool.query(
      `INSERT INTO usage_events (tenant_id, user_id, event_type, quantity) SELECT $1, $2, 'ai_question', 1 FROM generate_series(1, 20)`,
      [student.tenantId, student.userId],
    );
    const res = await ask().expect(402);
    expect(res.body.error.code).toBe("quota_exceeded");
  });

  let providerReference: string;

  it("checkout is idempotent per key", async () => {
    const first = await api.post(student, "/api/v1/billing/checkout", { planCode: "student_pro_monthly", idempotencyKey: "checkout-key-001" }).expect(201);
    const second = await api.post(student, "/api/v1/billing/checkout", { planCode: "student_pro_monthly", idempotencyKey: "checkout-key-001" }).expect(200);
    expect(second.body.provider_reference).toBe(first.body.provider_reference);
    expect(first.body.amount_paise).toBe(29900);
    providerReference = first.body.provider_reference;
    const payments = await pool.query(`SELECT count(*)::int AS n FROM payments`);
    expect(payments.rows[0].n).toBe(1);
  });

  it("rejects webhooks with a bad signature", async () => {
    await webhook({ id: "evt_bad", type: "payment.captured", data: { provider_reference: providerReference } }, "00".repeat(32)).expect(401);
  });

  it("activates the subscription once, even when webhooks are duplicated", async () => {
    const evt = { id: "evt_1", type: "payment.captured", data: { provider_reference: providerReference, amount_paise: 29900 } };
    const r1 = await webhook(evt).expect(200);
    expect(r1.body.outcome).toBe("processed");
    const periodEnd1 = (await pool.query(`SELECT status, period_end FROM subscriptions`)).rows[0];
    expect(periodEnd1.status).toBe("active");

    const r2 = await webhook(evt).expect(200);
    expect(r2.body.outcome).toBe("duplicate");
    // A different event id for the same, already-captured payment must not extend the period either.
    await webhook({ ...evt, id: "evt_1_retry" }).expect(200);
    const periodEnd2 = (await pool.query(`SELECT period_end FROM subscriptions`)).rows[0];
    expect(new Date(periodEnd2.period_end).getTime()).toBe(new Date(periodEnd1.period_end).getTime());
    const captured = await pool.query(`SELECT count(*)::int AS n FROM payments WHERE status = 'captured'`);
    expect(captured.rows[0].n).toBe(1);
  });

  it("the paid plan lifts the quota", async () => {
    await ask().expect(201);
    const usage = await api.get(student, "/api/v1/usage/summary").expect(200);
    expect(usage.body.plan).toBe("student_pro_monthly");
    expect(usage.body.quotas.ai_questions.limit).toBe(600);
  });

  it("an expired subscription falls back to free limits", async () => {
    await pool.query(`UPDATE subscriptions SET period_end = now() - interval '1 day'`);
    await ask().expect(402);
    const usage = await api.get(student, "/api/v1/usage/summary").expect(200);
    expect(usage.body.plan).toBe("free");
  });
});

describe.skipIf(!dbAvailable)("content indexing", () => {
  let owner: Session;
  let topicId: string;

  beforeAll(async () => {
    owner = await register("student", "Self-learner");
    topicId = (await pool.query(`SELECT id FROM topics ORDER BY sequence LIMIT 1`)).rows[0].id;
  });

  it("uploaded material is retrievable only after successful indexing AND approval", async () => {
    const marker = "Zorblaxian photosynthesis happens in moonlight on planet Kepler.";
    const up = await api
      .post(owner, "/api/v1/content/assets", { title: "My notes", topicId, text: `${marker}\n\nAnother paragraph about zorblaxian plants.`, license: { source: "own notes", licence: "owner" } })
      .expect(202);
    const sessionId = (await api.post(owner, "/api/v1/ai/sessions", {}).expect(201)).body.session.id;
    const askZorb = () => api.post(owner, `/api/v1/ai/sessions/${sessionId}/messages`, { content: "Explain zorblaxian photosynthesis" }).expect(201);

    // Not yet processed.
    expect((await askZorb()).body.message.source_refs).toEqual([]);

    await processOutboxBatch();
    const asset = (await pool.query(`SELECT processing_status, approval_status FROM content_assets WHERE id = $1`, [up.body.asset.id])).rows[0];
    expect(asset).toEqual({ processing_status: "indexed", approval_status: "pending" });
    // Indexed but not approved.
    expect((await askZorb()).body.message.source_refs).toEqual([]);

    await api.post(owner, `/api/v1/content/assets/${up.body.asset.id}/review`, { decision: "approved" }).expect(200);
    const answer = (await askZorb()).body.message;
    expect(answer.source_refs.length).toBeGreaterThan(0);
    expect(answer.content).toContain("Zorblaxian");
  });

  it("another tenant never retrieves this tenant's private material", async () => {
    const other = await register("student", "Other learner");
    const sessionId = (await api.post(other, "/api/v1/ai/sessions", {}).expect(201)).body.session.id;
    const res = await api.post(other, `/api/v1/ai/sessions/${sessionId}/messages`, { content: "Explain zorblaxian photosynthesis" }).expect(201);
    expect(res.body.message.source_refs).toEqual([]);
  });
});
