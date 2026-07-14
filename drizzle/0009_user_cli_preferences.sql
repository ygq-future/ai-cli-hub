ALTER TABLE user_cli_cwds RENAME TO user_cli_preferences;
ALTER TABLE user_cli_preferences
  RENAME CONSTRAINT user_cli_cwds_pkey TO user_cli_preferences_pkey;
ALTER TABLE user_cli_preferences ADD COLUMN model_id text;
