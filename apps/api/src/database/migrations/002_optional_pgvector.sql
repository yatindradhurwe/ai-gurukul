-- Semantic retrieval is optional: when the pgvector extension is installed
-- (e.g. the pgvector/pgvector Docker image) add an embedding column + index.
-- Without it, retrieval falls back to PostgreSQL full-text search.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
    ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS embedding vector(1536);
    CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx
      ON document_chunks USING hnsw (embedding vector_cosine_ops);
  ELSE
    RAISE NOTICE 'pgvector not available; using full-text retrieval only';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'No privilege to install pgvector; using full-text retrieval only';
END $$;
