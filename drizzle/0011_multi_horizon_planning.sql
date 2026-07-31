-- Multi-horizon planning + durable jobs + planning runs
-- Safe additive migration (does not overwrite user data)

ALTER TABLE goals ADD COLUMN IF NOT EXISTS parent_id text;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS success_criteria text NOT NULL DEFAULT '';
ALTER TABLE goals ADD COLUMN IF NOT EXISTS capacity_share real;

COMMENT ON COLUMN goals.horizon IS 'MISSION | YEAR | QUARTER | MONTH | WEEK | SHORT | LONG';

ALTER TABLE daily_plans ADD COLUMN IF NOT EXISTS weekly_plan_id text;
ALTER TABLE daily_plans ADD COLUMN IF NOT EXISTS review_state text NOT NULL DEFAULT 'UNREVIEWED';
ALTER TABLE daily_plans ADD COLUMN IF NOT EXISTS plan_state text NOT NULL DEFAULT 'GENERATED';
ALTER TABLE daily_plans ADD COLUMN IF NOT EXISTS goal_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE daily_plans ADD COLUMN IF NOT EXISTS first_action_title text;
ALTER TABLE daily_plans ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

COMMENT ON COLUMN daily_plans.review_state IS 'UNREVIEWED | REVIEWED | MANUALLY_ADJUSTED';
COMMENT ON COLUMN daily_plans.plan_state IS 'GENERATED | ACTIVE | SUPERSEDED | DRAFT';
COMMENT ON COLUMN daily_plans.status IS 'PROPOSED | ACCEPTED (activation for calendar sync)';

ALTER TABLE plan_blocks ADD COLUMN IF NOT EXISTS goal_id text;
ALTER TABLE plan_blocks ADD COLUMN IF NOT EXISTS weekly_outcome_id text;

CREATE TABLE IF NOT EXISTS weekly_plans (
  id text PRIMARY KEY,
  week_start text NOT NULL,
  season_id text,
  status text NOT NULL DEFAULT 'ACTIVE',
  review_state text NOT NULL DEFAULT 'UNREVIEWED',
  capacity_minutes integer NOT NULL DEFAULT 0,
  utilized_minutes integer NOT NULL DEFAULT 0,
  utilization_target real NOT NULL DEFAULT 0.7,
  buffer_minutes integer NOT NULL DEFAULT 180,
  summary text,
  conflict_notes text,
  calendar_sync_status text NOT NULL DEFAULT 'PENDING',
  accepted_at timestamptz,
  reviewed_at timestamptz,
  superseded_by text,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS weekly_plans_week_start_active_uidx
  ON weekly_plans (week_start)
  WHERE deleted_at IS NULL AND status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS weekly_outcomes (
  id text PRIMARY KEY,
  weekly_plan_id text NOT NULL REFERENCES weekly_plans(id),
  title text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  goal_id text,
  month_goal_id text,
  quarter_goal_id text,
  year_goal_id text,
  status text NOT NULL DEFAULT 'ACTIVE',
  success_criteria text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS planning_preferences (
  id text PRIMARY KEY DEFAULT 'default',
  timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  sunday_prep_local_time text NOT NULL DEFAULT '18:00',
  evening_prep_local_time text NOT NULL DEFAULT '21:00',
  morning_refresh_offset_minutes integer NOT NULL DEFAULT 45,
  wake_local_time text NOT NULL DEFAULT '07:00',
  capacity_utilization real NOT NULL DEFAULT 0.7,
  autonomy text NOT NULL DEFAULT 'COS_CALENDAR_WRITE',
  work_start_local text NOT NULL DEFAULT '09:00',
  work_end_local text NOT NULL DEFAULT '18:00',
  sleep_target_hours real NOT NULL DEFAULT 7.5,
  max_reschedules_before_decision integer NOT NULL DEFAULT 3,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO planning_preferences (id)
VALUES ('default')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS planning_runs (
  id text PRIMARY KEY,
  run_type text NOT NULL,
  target_period text NOT NULL,
  trigger text NOT NULL DEFAULT 'SCHEDULE',
  status text NOT NULL DEFAULT 'RUNNING',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  input_revision integer,
  output_plan_id text,
  output_revision integer,
  error text,
  retry_count integer NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS planning_runs_idempotency_uidx
  ON planning_runs (idempotency_key);

CREATE INDEX IF NOT EXISTS planning_runs_type_period_idx
  ON planning_runs (run_type, target_period);

CREATE TABLE IF NOT EXISTS durable_jobs (
  id text PRIMARY KEY,
  name text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS durable_jobs_pending_idx
  ON durable_jobs (status, run_after)
  WHERE status IN ('PENDING', 'FAILED');

CREATE TABLE IF NOT EXISTS plan_revisions (
  id text PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  revision integer NOT NULL,
  trigger text,
  summary text,
  diff jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plan_revisions_entity_idx
  ON plan_revisions (entity_type, entity_id, revision);
