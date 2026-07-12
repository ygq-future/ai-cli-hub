ALTER TABLE user_preferences
ADD COLUMN IF NOT EXISTS auto_approve_seconds integer NOT NULL DEFAULT 5;

ALTER TABLE user_preferences
DROP CONSTRAINT IF EXISTS user_preferences_auto_approve_seconds_check;

ALTER TABLE user_preferences
ADD CONSTRAINT user_preferences_auto_approve_seconds_check
CHECK (auto_approve_seconds BETWEEN 1 AND 300);
