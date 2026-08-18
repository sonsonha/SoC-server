ALTER TABLE goals ADD COLUMN IF NOT EXISTS outcome_status text NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE goals ADD COLUMN IF NOT EXISTS achieved_at text;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS closed_at text;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS processes_json text NOT NULL DEFAULT '[]';
ALTER TABLE goals ADD COLUMN IF NOT EXISTS metric_observations_json text NOT NULL DEFAULT '[]';
ALTER TABLE goals ADD COLUMN IF NOT EXISTS reflection_json text NOT NULL DEFAULT '{}';
ALTER TABLE goals ADD COLUMN IF NOT EXISTS review_snapshot_json text NOT NULL DEFAULT '{}';

ALTER TABLE projects ADD COLUMN IF NOT EXISTS default_goal_process_id text;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS goal_id text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS goal_process_id text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at_epoch_ms bigint;
