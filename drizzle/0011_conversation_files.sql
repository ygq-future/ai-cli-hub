CREATE TABLE "conversation_files" (
  "id" text PRIMARY KEY NOT NULL,
  "conversation_id" text NOT NULL,
  "sequence" integer NOT NULL,
  "kind" text NOT NULL,
  "file_id" text NOT NULL,
  "file_unique_id" text,
  "file_name" text,
  "mime_type" text,
  "file_size" bigint,
  "local_path" text NOT NULL,
  "created_at" bigint NOT NULL,
  CONSTRAINT "conversation_files_conversation_id_conversations_id_fk"
    FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id")
    ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_conversation_file_sequence"
  ON "conversation_files" USING btree ("conversation_id", "sequence");
--> statement-breakpoint
CREATE INDEX "idx_conversation_file_recent"
  ON "conversation_files" USING btree ("conversation_id", "created_at");
