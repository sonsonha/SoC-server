-- Phase 05: opportunities and exploration prep

CREATE TABLE IF NOT EXISTS "opportunities" (
  "id" text PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "deadline_epoch_ms" bigint,
  "last_touched_epoch_ms" bigint DEFAULT 0 NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "opportunity_requirements" (
  "id" text PRIMARY KEY NOT NULL,
  "opportunity_id" text NOT NULL,
  "label" text NOT NULL,
  "done" boolean DEFAULT false NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "source_url" text,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
