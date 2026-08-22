ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_conversation_id_conversations_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_audit_log_id_audit_logs_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_conversation_id_conversations_id_fk"
  FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_audit_log_id_audit_logs_id_fk"
  FOREIGN KEY ("audit_log_id") REFERENCES "public"."audit_logs"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_global_order"
  ON "audit_logs" USING btree ("created_at", "id");
