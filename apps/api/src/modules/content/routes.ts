import { Router } from "express";
import { z } from "zod";
import { audit, withTenant } from "../../database/pool.js";
import { notFound } from "../../lib/errors.js";
import { asyncHandler, parse, requireAuth, requireTenant } from "../../lib/http.js";
import { requirePermission } from "../../middleware/authorization.js";

export const contentRouter = Router();

const assetSchema = z.object({
  title: z.string().trim().min(1).max(200),
  topicId: z.string().uuid(),
  lessonId: z.string().uuid().optional(),
  type: z.literal("text").default("text"),
  // MVP ingests text (teacher notes, extracted textbook pages). PDF/video uploads
  // go to object storage via signed upload URLs and the same indexing job.
  text: z.string().min(20).max(200_000),
  license: z.object({ source: z.string(), licence: z.string() }),
});

/** Upload learning material. It is indexed by a background job and only becomes retrievable once approved. */
contentRouter.post(
  "/assets",
  requirePermission("content.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const body = parse(assetSchema, req.body);
    const asset = await withTenant(tenant.id, async (db) => {
      const a = (
        await db.query(
          `INSERT INTO content_assets (tenant_id, lesson_id, title, type, license_metadata) VALUES ($1,$2,$3,'text',$4)
           RETURNING id, title, processing_status, approval_status`,
          [tenant.id, body.lessonId ?? null, body.title, JSON.stringify(body.license)],
        )
      ).rows[0];
      // Transactional outbox: the job is enqueued atomically with the asset row.
      await db.query(`INSERT INTO outbox_events (tenant_id, topic, payload) VALUES ($1,'document.index',$2)`, [
        tenant.id,
        JSON.stringify({ assetId: a.id, topicId: body.topicId, text: body.text }),
      ]);
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "content.upload", resourceType: "content_asset", resourceId: a.id });
      return a;
    });
    res.status(202).json({ asset });
  }),
);

contentRouter.get(
  "/assets",
  requirePermission("content.manage", "content.review"),
  asyncHandler(async (req, res) => {
    const rows = await withTenant(requireTenant(req).id, (db) =>
      db.query(
        `SELECT a.id, a.title, a.type, a.processing_status, a.approval_status, a.license_metadata, a.created_at,
                (SELECT count(*)::int FROM document_chunks c WHERE c.asset_id = a.id) AS chunks
           FROM content_assets a WHERE a.tenant_id = current_tenant_id() ORDER BY a.created_at DESC LIMIT 100`,
      ),
    );
    res.json({ assets: rows.rows });
  }),
);

contentRouter.post(
  "/assets/:id/review",
  requirePermission("content.review", "tenant.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const { decision } = parse(z.object({ decision: z.enum(["approved", "rejected"]) }), req.body);
    const row = await withTenant(tenant.id, async (db) => {
      const r = await db.query(
        `UPDATE content_assets SET approval_status = $2 WHERE id = $1 AND tenant_id = current_tenant_id() RETURNING id, approval_status, processing_status`,
        [req.params.id, decision],
      );
      if (!r.rows[0]) throw notFound("Asset");
      await audit(db, { tenantId: tenant.id, actorId: userId, action: `content.${decision}`, resourceType: "content_asset", resourceId: req.params.id });
      return r.rows[0];
    });
    res.json({ asset: row });
  }),
);

const lessonSchema = z.object({
  topicId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(100_000),
});

contentRouter.post(
  "/lessons",
  requirePermission("content.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const body = parse(lessonSchema, req.body);
    const row = await withTenant(tenant.id, (db) =>
      db.query(`INSERT INTO lessons (tenant_id, topic_id, title, content, status) VALUES ($1,$2,$3,$4,'in_review') RETURNING id, title, status, version`, [
        tenant.id,
        body.topicId,
        body.title,
        body.content,
      ]),
    );
    res.status(201).json({ lesson: row.rows[0] });
  }),
);

contentRouter.post(
  "/lessons/:id/publish",
  requirePermission("content.review", "tenant.manage"),
  asyncHandler(async (req, res) => {
    const tenant = requireTenant(req);
    const { userId } = requireAuth(req);
    const row = await withTenant(tenant.id, async (db) => {
      const r = await db.query(
        `UPDATE lessons SET status = 'published', approved_by = $2, updated_at = now()
          WHERE id = $1 AND tenant_id = current_tenant_id() RETURNING id, status`,
        [req.params.id, userId],
      );
      if (!r.rows[0]) throw notFound("Lesson");
      await audit(db, { tenantId: tenant.id, actorId: userId, action: "lesson.publish", resourceType: "lesson", resourceId: req.params.id });
      return r.rows[0];
    });
    res.json({ lesson: row });
  }),
);
