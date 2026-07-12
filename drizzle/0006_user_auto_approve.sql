ALTER TABLE user_preferences
ADD COLUMN IF NOT EXISTS auto_approve_enabled boolean NOT NULL DEFAULT false;
