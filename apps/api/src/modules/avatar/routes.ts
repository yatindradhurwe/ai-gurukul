import { Router } from "express";
import { z } from "zod";
import { audit, withTenant } from "../../database/pool.js";
import { getAvatarProvider } from "../../integrations/avatar-provider/index.js";
import { signedUrl } from "../../integrations/object-storage/index.js";
import { notFound } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { requirePermission } from "../../middleware/authorization.js";
import { assertQuota, recordUsage } from "../billing/entitlements.js";

export const avatarRouter = Router();

/** Build timed captions from the lesson script (~150 words per minute narration). */
export function buildCaptions(script: string) {
  const sentences = script
    .replace(/[#*_`>]/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  let t = 0;
  return sentences.map((text) => {
    const seconds = Math.max(1.5, (text.split(/\s+/).length / 150) * 60);
    const cue = { start: Math.round(t * 10) / 10, end: Math.round((t + seconds) * 10) / 10, text };
    t += seconds;
    return cue;
  });
}

const renderSchema = z.object({
  avatarId: z.string().min(1).max(100).default("guru-default"),
  language: z.string().min(2).max(10).default("en"),
  idempotencyKey: z.string().min(8).max(100),
});

/** Queue a pre-rendered avatar lesson. Rendering runs in the worker, never in the request. */
avatarRouter.post(
  "/lessons/:lessonId/render",
  requirePermission("content.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(renderSchema, req.body);
    const job = await withTenant(tenant.id, async (db) => {
      const lesson = (await db.query(`SELECT id, content FROM lessons WHERE id = $1`, [req.params.lessonId])).rows[0];
      if (!lesson) throw notFound("Lesson");
      const existing = await db.query(`SELECT id, status FROM avatar_jobs WHERE idempotency_key = $1`, [body.idempotencyKey]);
      if (existing.rows[0]) return existing.rows[0];
      const j = (
        await db.query(
          `INSERT INTO avatar_jobs (tenant_id, lesson_id, provider, avatar_id, language, script, captions, idempotency_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, status`,
          [tenant.id, lesson.id, getAvatarProvider().name, body.avatarId, body.language, lesson.content, JSON.stringify(buildCaptions(lesson.content)), body.idempotencyKey],
        )
      ).rows[0];
      await db.query(`INSERT INTO outbox_events (tenant_id, topic, payload) VALUES ($1,'avatar.render',$2)`, [tenant.id, JSON.stringify({ jobId: j.id })]);
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "avatar.render_requested", resourceType: "lesson", resourceId: lesson.id });
      return j;
    });
    res.status(202).json({ job });
  }),
);

/**
 * Playback info for a lesson. Always succeeds when the lesson exists: if no
 * completed render is available (or the provider failed) the client falls
 * back to the text lesson with captions.
 */
avatarRouter.get(
  "/lessons/:lessonId",
  requirePermission("curriculum.read"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const data = await withTenant(tenant.id, async (db) => {
      const lesson = (await db.query(`SELECT id, content FROM lessons WHERE id = $1`, [req.params.lessonId])).rows[0];
      if (!lesson) throw notFound("Lesson");
      const job = (
        await db.query(
          `SELECT id, status, media_key, captions, avatar_id, language, error FROM avatar_jobs
            WHERE lesson_id = $1 ORDER BY (status = 'completed') DESC, created_at DESC LIMIT 1`,
          [lesson.id],
        )
      ).rows[0];
      const captions = job?.captions?.length ? job.captions : buildCaptions(lesson.content);
      if (job?.status === "completed" && job.media_key) {
        try {
          await assertQuota(db, tenant.id, userId, "avatar_lessons_per_month");
        } catch {
          return { mode: "text", reason: "avatar_quota_reached", captions, job: { status: job.status } };
        }
        await recordUsage(db, { tenantId: tenant.id, userId, eventType: "avatar_lesson_view", quantity: 1, metadata: { lessonId: lesson.id } });
        return { mode: "avatar", videoUrl: signedUrl(tenant.id, job.media_key), captions, job: { status: job.status, avatarId: job.avatar_id } };
      }
      return { mode: "text", reason: job ? `avatar_${job.status}` : "avatar_not_rendered", captions, job: job ? { status: job.status } : null };
    });
    res.json(data);
  }),
);

/** Live conversational avatar: short-lived client credentials minted server-side, metered per minute. */
avatarRouter.post(
  "/sessions",
  requirePermission("tutor.use"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(
      z.object({ avatarId: z.string().default("guru-default"), language: z.string().default("en"), contextId: z.string().uuid(), minutes: z.number().int().min(1).max(30).default(5) }),
      req.body,
    );
    const session = await withTenant(tenant.id, async (db) => {
      await assertQuota(db, tenant.id, userId, "avatar_live_minutes_per_month", body.minutes);
      const s = await getAvatarProvider().createSession(body);
      // Reserve the requested minutes up front; reconcile with provider usage reports later.
      await recordUsage(db, { tenantId: tenant.id, userId, eventType: "avatar_live_minutes", quantity: body.minutes, metadata: { sessionId: s.sessionId } });
      return s;
    });
    res.status(201).json({ session, fallback: "text" });
  }),
);
