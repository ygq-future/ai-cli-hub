-- 会话 scope 从历史 (user_id, cli, cwd) 收口为 (platform, user_id)。
-- 先保留每个 scope 最新的开放会话，关闭其余残留，再建立部分唯一索引保证并发安全。
WITH ranked_open_conversations AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY platform, user_id
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS row_number
  FROM conversations
  WHERE status <> 'closed'
)
UPDATE conversations AS conversation
SET
  status = 'closed',
  updated_at = floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
FROM ranked_open_conversations AS ranked
WHERE conversation.id = ranked.id
  AND ranked.row_number > 1;

DROP INDEX IF EXISTS idx_conv_active;
CREATE INDEX IF NOT EXISTS idx_conv_scope_recent ON conversations (platform, user_id, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_conv_open_scope
  ON conversations (platform, user_id)
  WHERE status <> 'closed';
