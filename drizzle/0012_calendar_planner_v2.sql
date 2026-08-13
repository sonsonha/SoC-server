-- Calendar-first planner V2. Additive: legacy planning and Android remain intact.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS goal_id text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT '#705CF6';

CREATE TABLE IF NOT EXISTS time_blocks (
  id text PRIMARY KEY,
  task_id text REFERENCES tasks(id),
  project_id text REFERENCES projects(id),
  title text NOT NULL,
  start_epoch_ms bigint NOT NULL,
  end_epoch_ms bigint NOT NULL,
  color text NOT NULL DEFAULT '#705CF6',
  status text NOT NULL DEFAULT 'PLANNED',
  origin text NOT NULL DEFAULT 'PLANNER',
  calendar_id text,
  google_event_id text,
  google_etag text,
  sync_status text NOT NULL DEFAULT 'PENDING',
  reminder_minutes integer,
  recurrence_rule text,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS time_blocks_window_idx
  ON time_blocks (start_epoch_ms, end_epoch_ms)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS time_blocks_task_idx
  ON time_blocks (task_id)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS time_blocks_google_event_uidx
  ON time_blocks (google_event_id)
  WHERE google_event_id IS NOT NULL AND deleted_at IS NULL;
