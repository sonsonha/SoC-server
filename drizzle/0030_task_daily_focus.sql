-- Task Definition of Done + Daily Focus (date-scoped, not permanent boolean).

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "definition_of_done" text;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "daily_focus_date" text;

CREATE INDEX IF NOT EXISTS "tasks_user_id_daily_focus_date_idx"
  ON "tasks" ("user_id", "daily_focus_date");
