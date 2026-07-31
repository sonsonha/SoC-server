-- Phase 11: learning curriculum tracks

CREATE TABLE IF NOT EXISTS learning_tracks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  life_area TEXT NOT NULL DEFAULT 'INTELLECTUAL',
  topic TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 3,
  target_per_week INTEGER NOT NULL DEFAULT 2,
  horizon TEXT NOT NULL DEFAULT 'WEEK',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  goal_id TEXT,
  skill_id TEXT,
  definition_of_progress TEXT NOT NULL DEFAULT '',
  recommendation_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS learning_tracks_status_idx
  ON learning_tracks (status) WHERE deleted_at IS NULL;
