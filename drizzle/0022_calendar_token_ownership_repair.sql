-- Repair Batch C Calendar ownership persistence gaps.
-- 1) Ensure legacy provider-only uniqueness cannot block per-user rows.
-- 2) Note: assign NULL user_id rows via `npm run calendar:backfill-owner`
--    (or they are claimed on next successful OAuth callback for the connecting user).

DROP INDEX IF EXISTS integration_tokens_provider_uidx;

-- If a unique constraint was created under another name on provider alone, drop common leftovers.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'integration_tokens'
      AND indexdef ILIKE '%UNIQUE%'
      AND indexdef ILIKE '%(provider)%'
      AND indexdef NOT ILIKE '%user_id%'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', r.indexname);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS integration_tokens_user_provider_uidx
  ON integration_tokens (user_id, provider)
  WHERE user_id IS NOT NULL;
