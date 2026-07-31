-- Phase 06: social/date logistics prep

ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locations" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "latitude" double precision,
  "longitude" double precision,
  "opening_hours" text,
  "notes" text,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "travel_edges" (
  "id" text PRIMARY KEY NOT NULL,
  "from_location_id" text NOT NULL,
  "to_location_id" text NOT NULL,
  "typical_minutes" integer NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
