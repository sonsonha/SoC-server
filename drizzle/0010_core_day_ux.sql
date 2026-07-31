-- Core Day UX: plan accept status + COS calendar event mapping on blocks

ALTER TABLE daily_plans
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'PROPOSED';
--> statement-breakpoint
ALTER TABLE daily_plans
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
--> statement-breakpoint
ALTER TABLE plan_blocks
  ADD COLUMN IF NOT EXISTS external_calendar_event_id TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS plan_blocks_external_calendar_event_id_idx
  ON plan_blocks (external_calendar_event_id)
  WHERE external_calendar_event_id IS NOT NULL;
