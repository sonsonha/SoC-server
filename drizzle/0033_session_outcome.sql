-- Optional Session Outcome progress (independent of Session Done + Task DoD).

ALTER TABLE "time_blocks" ADD COLUMN IF NOT EXISTS "session_outcome_type" text NOT NULL DEFAULT 'NONE';
ALTER TABLE "time_blocks" ADD COLUMN IF NOT EXISTS "session_outcome_items" jsonb;
ALTER TABLE "time_blocks" ADD COLUMN IF NOT EXISTS "session_outcome_target" integer;
ALTER TABLE "time_blocks" ADD COLUMN IF NOT EXISTS "session_outcome_actual" integer;
ALTER TABLE "time_blocks" ADD COLUMN IF NOT EXISTS "session_outcome_unit" text;
