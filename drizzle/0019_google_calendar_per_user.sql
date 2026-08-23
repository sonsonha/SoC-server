-- Batch C phase 1: per-user Google Calendar ownership (nullable first).
-- Backfill: npm run calendar:backfill-owner
-- Enforce: npm run calendar:enforce-ownership-not-null

-- integration_tokens: one Google Calendar row per Personal OS user
ALTER TABLE integration_tokens ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE integration_tokens ADD COLUMN IF NOT EXISTS google_account_sub TEXT;
ALTER TABLE integration_tokens ADD COLUMN IF NOT EXISTS google_account_email TEXT;
ALTER TABLE integration_tokens ADD COLUMN IF NOT EXISTS write_calendar_id TEXT;
ALTER TABLE integration_tokens ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'connected';
ALTER TABLE integration_tokens ADD COLUMN IF NOT EXISTS last_error_code TEXT;
ALTER TABLE integration_tokens ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'integration_tokens_user_id_users_id_fk'
  ) THEN
    ALTER TABLE integration_tokens
      ADD CONSTRAINT integration_tokens_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT;
  END IF;
END $$;

-- Drop provider-only uniqueness (singleton) after backfill we enforce (user_id, provider)
DROP INDEX IF EXISTS integration_tokens_provider_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS integration_tokens_user_provider_uidx
  ON integration_tokens (user_id, provider)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS integration_tokens_user_id_idx ON integration_tokens (user_id);

-- calendar_commitments per user
ALTER TABLE calendar_commitments ADD COLUMN IF NOT EXISTS user_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'calendar_commitments_user_id_users_id_fk'
  ) THEN
    ALTER TABLE calendar_commitments
      ADD CONSTRAINT calendar_commitments_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT;
  END IF;
END $$;

DROP INDEX IF EXISTS calendar_commitments_external_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS calendar_commitments_user_external_uidx
  ON calendar_commitments (user_id, calendar_id, external_calendar_event_id)
  WHERE deleted_at IS NULL AND user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS calendar_commitments_user_id_idx ON calendar_commitments (user_id);
CREATE INDEX IF NOT EXISTS calendar_commitments_user_window_idx
  ON calendar_commitments (user_id, start_epoch_ms, end_epoch_ms)
  WHERE deleted_at IS NULL;

-- calendar_sync_state: migrate from id='default' to per-user rows (user_id PK after backfill)
ALTER TABLE calendar_sync_state ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE calendar_sync_state ADD COLUMN IF NOT EXISTS last_error_code TEXT;
ALTER TABLE calendar_sync_state ADD COLUMN IF NOT EXISTS reconnect_required BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'calendar_sync_state_user_id_users_id_fk'
  ) THEN
    ALTER TABLE calendar_sync_state
      ADD CONSTRAINT calendar_sync_state_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS calendar_sync_state_user_id_uidx
  ON calendar_sync_state (user_id)
  WHERE user_id IS NOT NULL;

-- One-time OAuth connection states (callback on Railway, session on Vercel)
CREATE TABLE IF NOT EXISTS oauth_connection_states (
  id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS oauth_connection_states_state_hash_uidx
  ON oauth_connection_states (state_hash);
CREATE INDEX IF NOT EXISTS oauth_connection_states_user_id_idx
  ON oauth_connection_states (user_id);
CREATE INDEX IF NOT EXISTS oauth_connection_states_expires_at_idx
  ON oauth_connection_states (expires_at);
