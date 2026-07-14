DROP INDEX IF EXISTS "idx_mem_conv";
--> statement-breakpoint
ALTER TABLE "memories" DROP COLUMN IF EXISTS "conversation_id";
--> statement-breakpoint
ALTER TABLE "memories" DROP COLUMN IF EXISTS "source_message_id";
