-- AI Goal Structuring: per-user editable AI context (never shared across users).
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_context TEXT;
