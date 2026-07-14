UPDATE "conversation_files" AS "cf"
SET "file_id" = CASE
  WHEN "c"."platform" = 'telegram' THEN "cf"."file_unique_id"
  ELSE NULL
END
FROM "conversations" AS "c"
WHERE "c"."id" = "cf"."conversation_id";
--> statement-breakpoint
ALTER TABLE "conversation_files" ALTER COLUMN "file_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "conversation_files" DROP COLUMN "file_unique_id";
