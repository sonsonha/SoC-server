-- Session-level Daily Focus (source of truth moves from tasks.daily_focus_date).
-- Local focus date is derived from start_epoch_ms in Asia/Ho_Chi_Minh.

ALTER TABLE "time_blocks" ADD COLUMN IF NOT EXISTS "is_daily_focus" boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "time_blocks_user_id_is_daily_focus_idx"
  ON "time_blocks" ("user_id", "is_daily_focus");
