import type { Db } from "../../database/pool.js";

export interface RetrievedPassage {
  ref: string; // S1, S2... as cited in answers
  chunkId: string;
  assetId: string;
  assetTitle: string;
  topicId: string | null;
  pageNumber: number | null;
  text: string;
  score: number;
}

/**
 * Keyword (full-text) retrieval over approved, successfully indexed material
 * only. RLS limits results to the tenant's own content plus platform content.
 * When pgvector + an embedding model are configured, a semantic query can be
 * merged here (hybrid search) without changing callers.
 */
export async function retrievePassages(
  db: Db,
  question: string,
  opts: { topicId?: string | null; curriculumVersionId?: string | null; limit?: number } = {},
): Promise<RetrievedPassage[]> {
  const limit = opts.limit ?? 4;
  const { rows } = await db.query(
    `WITH q AS (SELECT websearch_to_tsquery('english', $1) AS tsq,
                       to_tsquery('simple', array_to_string(ARRAY(
                         SELECT quote_literal(l) FROM unnest(tsvector_to_array(to_tsvector('english', $1))) AS l), ' | ')) AS anyq)
     SELECT c.id, c.asset_id, a.title AS asset_title, c.topic_id, c.page_number, c.chunk_text,
            ts_rank_cd(c.search_tsv, q.anyq) + CASE WHEN c.search_tsv @@ q.tsq THEN 0.5 ELSE 0 END
              + CASE WHEN $2::uuid IS NOT NULL AND c.topic_id = $2 THEN 0.2 ELSE 0 END AS score
       FROM document_chunks c
       JOIN content_assets a ON a.id = c.asset_id
       LEFT JOIN topics t ON t.id = c.topic_id
       LEFT JOIN chapters ch ON ch.id = t.chapter_id, q
      WHERE a.approval_status = 'approved' AND a.processing_status = 'indexed'
        AND c.search_tsv @@ q.anyq
        AND ($3::uuid IS NULL OR ch.curriculum_version_id IS NULL OR ch.curriculum_version_id = $3)
      ORDER BY score DESC
      LIMIT $4`,
    [question, opts.topicId ?? null, opts.curriculumVersionId ?? null, limit],
  );
  return rows
    .filter((r) => r.score >= 0.05) // drop weak lexical coincidences
    .map((r, i) => ({
      ref: `S${i + 1}`,
      chunkId: r.id,
      assetId: r.asset_id,
      assetTitle: r.asset_title,
      topicId: r.topic_id,
      pageNumber: r.page_number,
      text: r.chunk_text,
      score: Number(r.score),
    }));
}

/** Split text into ~paragraph chunks of bounded size for indexing. */
export function chunkText(text: string, maxChars = 900): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const p of paragraphs) {
    if (p.length > maxChars) {
      if (current) chunks.push(current), (current = "");
      const sentences = p.split(/(?<=[.!?])\s+/);
      for (const s of sentences) {
        if ((current + " " + s).length > maxChars && current) chunks.push(current), (current = "");
        current = current ? `${current} ${s}` : s;
      }
      continue;
    }
    if ((current + "\n\n" + p).length > maxChars && current) chunks.push(current), (current = "");
    current = current ? `${current}\n\n${p}` : p;
  }
  if (current) chunks.push(current);
  return chunks;
}
