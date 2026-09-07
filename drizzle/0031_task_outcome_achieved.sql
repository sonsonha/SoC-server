-- Explicit Task outcome confirmation (Definition of Done).
-- When definition_of_done is set, session completion alone does not mark Task DONE.

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "outcome_achieved_at_epoch_ms" bigint;
