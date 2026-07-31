-- Phase 04: people, waiting, decisions

CREATE TABLE IF NOT EXISTS "people" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "relationship" text,
  "context_tags" jsonb DEFAULT '[]' NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "person_notes" (
  "id" text PRIMARY KEY NOT NULL,
  "person_id" text NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decisions" (
  "id" text PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "context" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'OPEN' NOT NULL,
  "deadline_at" timestamp with time zone,
  "resolved_option_id" text,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decision_options" (
  "id" text PRIMARY KEY NOT NULL,
  "decision_id" text NOT NULL,
  "label" text NOT NULL,
  "pros" text DEFAULT '' NOT NULL,
  "cons" text DEFAULT '' NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "waiting_items" (
  "id" text PRIMARY KEY NOT NULL,
  "task_id" text,
  "title" text NOT NULL,
  "waiting_on_person_id" text,
  "waiting_on_label" text,
  "follow_up_at" timestamp with time zone,
  "status" text DEFAULT 'ACTIVE' NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
