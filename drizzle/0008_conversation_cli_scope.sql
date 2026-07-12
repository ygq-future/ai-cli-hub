-- 每个 Transport 用户可以同时保留各 CLI 的未关闭会话。
DROP INDEX IF EXISTS uniq_conv_open_scope;
DROP INDEX IF EXISTS idx_conv_scope_recent;

CREATE INDEX idx_conv_scope_recent
  ON conversations (platform, user_id, cli, updated_at);

CREATE UNIQUE INDEX uniq_conv_open_scope
  ON conversations (platform, user_id, cli)
  WHERE status <> 'closed';
