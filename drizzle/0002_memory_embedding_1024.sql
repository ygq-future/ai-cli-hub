ALTER TABLE "memories" ALTER COLUMN "embedding" TYPE vector(1024) USING NULL::vector(1024);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mem_vec" ON "memories" USING hnsw ("embedding" vector_cosine_ops);
