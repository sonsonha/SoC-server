-- Phase 10: user model — goals, skills, profile status

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  life_area TEXT NOT NULL,
  season_id TEXT,
  description TEXT NOT NULL DEFAULT '',
  horizon TEXT NOT NULL DEFAULT 'SHORT',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  target_date TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS goals_status_idx ON goals (status) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS skill_levels (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS skill_levels_domain_uidx
  ON skill_levels (domain) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS profile_status (
  id TEXT PRIMARY KEY,
  chapter TEXT NOT NULL DEFAULT 'WORKING',
  summary TEXT NOT NULL DEFAULT '',
  usual_leave_home TEXT,
  preferred_countries TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
