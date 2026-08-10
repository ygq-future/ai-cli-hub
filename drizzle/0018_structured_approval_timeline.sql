CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected');
--> statement-breakpoint
CREATE TYPE "public"."message_type" AS ENUM('chat', 'approval');
--> statement-breakpoint
DELETE FROM "audit_logs";
--> statement-breakpoint
ALTER TABLE "audit_logs" DROP COLUMN "command";
--> statement-breakpoint
ALTER TABLE "audit_logs" DROP COLUMN "action";
--> statement-breakpoint
ALTER TABLE "audit_logs" ALTER COLUMN "operator" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "approval_id" text NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "request" jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "status" "approval_status" DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "automatic" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "message_type" "message_type" DEFAULT 'chat' NOT NULL;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "audit_log_id" text;
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_audit_log_id_audit_logs_id_fk" FOREIGN KEY ("audit_log_id") REFERENCES "public"."audit_logs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_audit_conversation_approval" ON "audit_logs" USING btree ("conversation_id", "approval_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_msg_audit_log" ON "messages" USING btree ("audit_log_id");
--> statement-breakpoint
DROP TYPE "public"."approval_action";
