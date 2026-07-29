ALTER TYPE "public"."platform" RENAME VALUE 'websocket' TO 'web';
--> statement-breakpoint
UPDATE "user_cli_preferences"
SET "cwd" = regexp_replace("cwd", '-websocket$', '-web')
WHERE "platform" = 'web' AND "cwd" ~ '-websocket$';
--> statement-breakpoint
UPDATE "conversations"
SET "cwd" = regexp_replace("cwd", '-websocket$', '-web')
WHERE "platform" = 'web' AND "cwd" ~ '-websocket$';
