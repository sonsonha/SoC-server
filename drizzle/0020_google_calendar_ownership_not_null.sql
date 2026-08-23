-- Batch C phase 2: enforce NOT NULL after backfill.
-- Run: npm run calendar:enforce-ownership-not-null

DO $$
DECLARE
  null_tokens INTEGER;
  null_commitments INTEGER;
  null_sync INTEGER;
BEGIN
  SELECT COUNT(*) INTO null_tokens FROM integration_tokens WHERE user_id IS NULL;
  SELECT COUNT(*) INTO null_commitments FROM calendar_commitments WHERE user_id IS NULL;
  SELECT COUNT(*) INTO null_sync FROM calendar_sync_state WHERE id = 'default' OR user_id IS NULL;

  IF null_tokens > 0 OR null_commitments > 0 THEN
    RAISE EXCEPTION
      'Google Calendar ownership backfill incomplete: tokens=% commitments=% NULL user_id. Run calendar:backfill-owner',
      null_tokens, null_commitments;
  END IF;
END $$;

ALTER TABLE integration_tokens ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE calendar_commitments ALTER COLUMN user_id SET NOT NULL;

-- Remove legacy singleton sync row if still present without user
DELETE FROM calendar_sync_state WHERE id = 'default' AND user_id IS NULL;
