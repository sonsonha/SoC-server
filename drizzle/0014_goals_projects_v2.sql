-- Goals & Projects V2 outcome model (additive, backwards compatible)

ALTER TABLE goals ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT '';
ALTER TABLE goals ADD COLUMN IF NOT EXISTS why text NOT NULL DEFAULT '';
ALTER TABLE goals ADD COLUMN IF NOT EXISTS metric text NOT NULL DEFAULT '';
ALTER TABLE goals ADD COLUMN IF NOT EXISTS focus_type text NOT NULL DEFAULT 'FOCUS';
ALTER TABLE goals ADD COLUMN IF NOT EXISTS current_milestone_id text;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS milestones_json text NOT NULL DEFAULT '[]';
ALTER TABLE goals ADD COLUMN IF NOT EXISTS systems_json text NOT NULL DEFAULT '[]';

ALTER TABLE projects ADD COLUMN IF NOT EXISTS target_date text;
