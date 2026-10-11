import type { Db } from "../database/pool.js";
import { getAvatarProvider } from "../integrations/avatar-provider/index.js";
import { chunkText } from "../modules/ai-tutor/retrieval.js";
import { recordUsage } from "../modules/billing/entitlements.js";

export interface OutboxEvent {
  id: number;
  tenant_id: string | null;
  topic: string;
  payload: any;
  attempts: number;
}

/** Not an error: progress is saved and the event is re-queued for another check shortly. */
export class RetryLater extends Error {}

/**
 * Index an uploaded document. Runs with the tenant context carried on the
 * event; the asset must still belong to that tenant when the job runs.
 */
async function indexDocument(db: Db, e: OutboxEvent) {
  const { assetId, topicId, text } = e.payload as { assetId: string; topicId: string; text: string };
  const asset = (await db.query(`SELECT id, tenant_id FROM content_assets WHERE id = $1 FOR UPDATE`, [assetId])).rows[0];
  if (!asset || asset.tenant_id !== e.tenant_id) return; // deleted or tenant mismatch: drop
  await db.query(`UPDATE content_assets SET processing_status = 'processing' WHERE id = $1`, [assetId]);
  const chunks = chunkText(text);
  if (chunks.length === 0) {
    await db.query(`UPDATE content_assets SET processing_status = 'failed' WHERE id = $1`, [assetId]);
    return;
  }
  await db.query(`DELETE FROM document_chunks WHERE asset_id = $1`, [assetId]);
  for (const [i, chunk] of chunks.entries()) {
    await db.query(`INSERT INTO document_chunks (tenant_id, asset_id, topic_id, chunk_text, page_number) VALUES ($1,$2,$3,$4,$5)`, [
      asset.tenant_id,
      assetId,
      topicId,
      chunk,
      i + 1,
    ]);
  }
  await db.query(`UPDATE content_assets SET processing_status = 'indexed' WHERE id = $1`, [assetId]);
}

async function renderAvatar(db: Db, e: OutboxEvent) {
  const job = (await db.query(`SELECT * FROM avatar_jobs WHERE id = $1 FOR UPDATE`, [e.payload.jobId])).rows[0];
  if (!job || job.tenant_id !== e.tenant_id || job.status === "completed" || job.status === "failed") return;
  const provider = getAvatarProvider();
  try {
    if (!job.provider_job_id) {
      const r = await provider.renderLesson({ script: job.script, avatarId: job.avatar_id, language: job.language });
      await db.query(`UPDATE avatar_jobs SET provider_job_id = $2, status = $3, updated_at = now() WHERE id = $1`, [job.id, r.jobId, r.status]);
      job.provider_job_id = r.jobId;
    }
    const status = await provider.getJobStatus(job.provider_job_id);
    if (status.status === "completed") {
      await db.query(`UPDATE avatar_jobs SET status = 'completed', media_key = $2, updated_at = now() WHERE id = $1`, [
        job.id,
        `${job.tenant_id}/avatar/${status.mediaKey}`,
      ]);
      await recordUsage(db, { tenantId: job.tenant_id, userId: null, eventType: "avatar_render", quantity: 1, metadata: { jobId: job.id, provider: provider.name } });
    } else if (status.status === "failed") {
      await db.query(`UPDATE avatar_jobs SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [job.id, status.error ?? "failed"]);
    } else {
      await db.query(`UPDATE avatar_jobs SET status = 'processing', updated_at = now() WHERE id = $1`, [job.id]);
      throw new RetryLater("render still processing");
    }
  } catch (err) {
    if (err instanceof RetryLater) throw err;
    if (e.attempts >= 4) {
      await db.query(`UPDATE avatar_jobs SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [job.id, String((err as Error).message).slice(0, 500)]);
      return;
    }
    throw err;
  }
}

export const handlers: Record<string, (db: Db, e: OutboxEvent) => Promise<void>> = {
  "document.index": indexDocument,
  "avatar.render": renderAvatar,
};
