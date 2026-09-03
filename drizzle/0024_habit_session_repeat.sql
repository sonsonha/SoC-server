-- Habit Projects + Session evidence + Repeat series linkage.
-- Systems remain in goals.systems_json for backward-compatible reads only.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "project_type" text DEFAULT 'STANDARD' NOT NULL;

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "repeat_series_id" text;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "carry_over_from_task_id" text;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "carry_over_note" text;

ALTER TABLE "time_blocks" ADD COLUMN IF NOT EXISTS "notes" text DEFAULT '' NOT NULL;
ALTER TABLE "time_blocks" ADD COLUMN IF NOT EXISTS "completed_at_epoch_ms" bigint;
ALTER TABLE "time_blocks" ADD COLUMN IF NOT EXISTS "repeat_series_id" text;

CREATE INDEX IF NOT EXISTS "projects_user_id_project_type_idx" ON "projects" ("user_id", "project_type");
CREATE INDEX IF NOT EXISTS "tasks_user_id_repeat_series_id_idx" ON "tasks" ("user_id", "repeat_series_id");
CREATE INDEX IF NOT EXISTS "time_blocks_user_id_repeat_series_id_idx" ON "time_blocks" ("user_id", "repeat_series_id");
