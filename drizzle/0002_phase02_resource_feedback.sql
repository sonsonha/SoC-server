CREATE TABLE IF NOT EXISTS "resource_feedback" (
  "id" uuid PRIMARY KEY NOT NULL,
  "preparation_id" uuid NOT NULL,
  "resource_id" uuid NOT NULL,
  "reason" text NOT NULL,
  "note" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_resource_feedback_preparation"
  ON "resource_feedback" ("preparation_id");

CREATE TABLE IF NOT EXISTS "resource_preferences" (
  "id" uuid PRIMARY KEY NOT NULL,
  "weights" jsonb NOT NULL DEFAULT '{}',
  "revision" integer NOT NULL DEFAULT 1,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz
);

CREATE TABLE IF NOT EXISTS "preparation_revisions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "preparation_id" uuid NOT NULL,
  "revision" integer NOT NULL,
  "snapshot" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_preparation_revisions_prep"
  ON "preparation_revisions" ("preparation_id");
