-- Project context: PERSONAL (default) | WORK.
-- Work projects (e.g. Landfill Rover) stay outside the personal Goal hierarchy.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "project_context" text DEFAULT 'PERSONAL' NOT NULL;

CREATE INDEX IF NOT EXISTS "projects_user_id_project_context_idx"
  ON "projects" ("user_id", "project_context");
