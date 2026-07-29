WITH grouped_messages AS (
  SELECT
    "id",
    "conversation_id",
    "role",
    "content",
    "context_eligible",
    SUM(CASE WHEN "role" = 'user' THEN 1 ELSE 0 END) OVER (
      PARTITION BY "conversation_id"
      ORDER BY "created_at", "id"
    ) AS "user_group"
  FROM "messages"
),
slash_command_groups AS (
  SELECT DISTINCT "conversation_id", "user_group"
  FROM grouped_messages
  WHERE "role" = 'user'
    AND "content" ~ '^[[:space:]]*/'
)
DELETE FROM "messages"
USING grouped_messages, slash_command_groups
WHERE "messages"."id" = grouped_messages."id"
  AND grouped_messages."conversation_id" = slash_command_groups."conversation_id"
  AND grouped_messages."user_group" = slash_command_groups."user_group"
  AND (
    grouped_messages."role" = 'user'
    OR (
      grouped_messages."role" = 'assistant'
      AND grouped_messages."context_eligible" = false
    )
  );
