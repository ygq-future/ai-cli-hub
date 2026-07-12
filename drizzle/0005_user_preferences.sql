CREATE TABLE IF NOT EXISTS user_preferences (
  platform platform NOT NULL,
  user_id text NOT NULL,
  language text NOT NULL DEFAULT 'zh',
  default_cli cli NOT NULL DEFAULT 'claude',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CONSTRAINT user_preferences_pkey PRIMARY KEY (platform, user_id),
  CONSTRAINT user_preferences_language_check CHECK (language IN ('zh', 'en'))
);

CREATE TABLE IF NOT EXISTS user_cli_cwds (
  platform platform NOT NULL,
  user_id text NOT NULL,
  cli cli NOT NULL,
  cwd text NOT NULL,
  updated_at bigint NOT NULL,
  CONSTRAINT user_cli_cwds_pkey PRIMARY KEY (platform, user_id, cli)
);
