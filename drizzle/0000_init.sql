-- pgvector 扩展：memories.embedding = vector(1536) 依赖之（手工前置，drizzle-kit 不为 customType 自动建扩展）。见 docs/04-Data-Model.md §2/§8。
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."approval_action" AS ENUM('approve', 'reject');--> statement-breakpoint
CREATE TYPE "public"."cli" AS ENUM('claude', 'codex', 'gemini');--> statement-breakpoint
CREATE TYPE "public"."memory_type" AS ENUM('episodic', 'semantic', 'preference');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('telegram', 'qq', 'websocket');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('user', 'assistant', 'system');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('idle', 'starting', 'running', 'waitingApproval', 'closing', 'closed');--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" "platform" NOT NULL,
	"user_id" text NOT NULL,
	"cli" "cli" NOT NULL,
	"cwd" text NOT NULL,
	"status" "session_status" DEFAULT 'idle' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"role" "role" NOT NULL,
	"content" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"command" text NOT NULL,
	"action" "approval_action" NOT NULL,
	"operator" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text,
	"type" "memory_type" NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1536),
	"source_message_id" text,
	"importance" real DEFAULT 0.5 NOT NULL,
	"access_count" integer DEFAULT 0 NOT NULL,
	"last_accessed_at" bigint,
	"tag" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_conv_active" ON "conversations" USING btree ("user_id","cli","cwd","status");--> statement-breakpoint
CREATE INDEX "idx_conv_archive" ON "conversations" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_msg_conv" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_conv" ON "audit_logs" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_mem_user" ON "memories" USING btree ("user_id","type");--> statement-breakpoint
CREATE INDEX "idx_mem_conv" ON "memories" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_mem_fts" ON "memories" USING gin (to_tsvector('simple', "content"));