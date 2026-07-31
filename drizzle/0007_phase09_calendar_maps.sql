-- Phase 09: live Google Calendar + Maps Distance Matrix support

CREATE TABLE IF NOT EXISTS integration_tokens (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  expires_at TIMESTAMPTZ,
  scopes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS integration_tokens_provider_uidx
  ON integration_tokens (provider);

CREATE TABLE IF NOT EXISTS calendar_commitments (
  id TEXT PRIMARY KEY,
  external_calendar_event_id TEXT NOT NULL,
  title TEXT NOT NULL,
  start_epoch_ms BIGINT NOT NULL,
  end_epoch_ms BIGINT NOT NULL,
  location TEXT,
  calendar_id TEXT NOT NULL DEFAULT 'primary',
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS calendar_commitments_external_uidx
  ON calendar_commitments (external_calendar_event_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS calendar_commitments_window_idx
  ON calendar_commitments (start_epoch_ms, end_epoch_ms)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS calendar_sync_state (
  id TEXT PRIMARY KEY DEFAULT 'default',
  last_sync_at TIMESTAMPTZ,
  last_sync_token TEXT,
  last_replan_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO calendar_sync_state (id)
VALUES ('default')
ON CONFLICT (id) DO NOTHING;
