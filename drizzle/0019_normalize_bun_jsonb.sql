UPDATE "messages"
SET "attachments" = ("attachments" #>> '{}')::jsonb
WHERE jsonb_typeof("attachments") = 'string';
--> statement-breakpoint
UPDATE "audit_logs"
SET "request" = ("request" #>> '{}')::jsonb
WHERE jsonb_typeof("request") = 'string';
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_attachments_array" CHECK (jsonb_typeof("attachments") = 'array');
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_request_object" CHECK (jsonb_typeof("request") = 'object');
