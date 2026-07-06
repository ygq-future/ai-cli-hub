DROP INDEX IF EXISTS "idx_mem_user";--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "namespace" text DEFAULT 'global' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_mem_namespace" ON "memories" USING btree ("namespace","type");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_mem_tag" ON "memories" USING btree ("namespace","tag");--> statement-breakpoint
ALTER TABLE "memories" DROP COLUMN "user_id";
