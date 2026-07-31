-- Phase 01: vertical slice entities

CREATE TABLE IF NOT EXISTS "missions" (
  "id" text PRIMARY KEY NOT NULL,
  "north_star" text NOT NULL,
  "freedoms" jsonb NOT NULL,
  "career_hypotheses" jsonb NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "operating_principles" (
  "id" text PRIMARY KEY NOT NULL,
  "key" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seasons" (
  "id" text PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "narrative" text NOT NULL,
  "start_date" text NOT NULL,
  "end_date" text,
  "priority_goal_ids" jsonb NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "projects" (
  "id" text PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "life_area" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "learning_items" (
  "id" text PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "why" text DEFAULT '' NOT NULL,
  "source" text DEFAULT '' NOT NULL,
  "tier" text DEFAULT 'NEXT' NOT NULL,
  "estimated_minutes" integer DEFAULT 45 NOT NULL,
  "definition_of_done" text DEFAULT '' NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks" (
  "id" text PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "project_id" text,
  "life_area" text DEFAULT 'LEARNING' NOT NULL,
  "priority" integer DEFAULT 2 NOT NULL,
  "deadline_epoch_ms" bigint,
  "estimated_minutes" integer DEFAULT 30 NOT NULL,
  "actual_minutes" integer,
  "energy_requirement" integer DEFAULT 2 NOT NULL,
  "location_requirements" text DEFAULT '[]' NOT NULL,
  "dependency_ids" text DEFAULT '[]' NOT NULL,
  "preferred_time" text,
  "earliest_start_epoch_ms" bigint,
  "deadline_flexible" boolean DEFAULT true NOT NULL,
  "interruptible" boolean DEFAULT true NOT NULL,
  "deep_work" boolean DEFAULT false NOT NULL,
  "next_action" text,
  "reschedule_count" integer DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'TODO' NOT NULL,
  "verification_level" text DEFAULT 'SELF' NOT NULL,
  "is_anchor_candidate" boolean DEFAULT false NOT NULL,
  "estimate_bias_factor" real DEFAULT 1 NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_items" (
  "id" uuid PRIMARY KEY NOT NULL,
  "raw_text" text NOT NULL,
  "created_at_epoch_ms" bigint NOT NULL,
  "parse_status" text DEFAULT 'PARSED' NOT NULL,
  "linked_entity_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "parse_json" jsonb,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "daily_plans" (
  "id" text PRIMARY KEY NOT NULL,
  "date" text NOT NULL,
  "main_outcome" text,
  "anchor_task_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "briefing" text,
  "buffer_minutes" integer DEFAULT 30 NOT NULL,
  "hard_stop_notes" text,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "preparations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text NOT NULL,
  "status" text DEFAULT 'PENDING' NOT NULL,
  "scheduled_start_at" timestamp with time zone NOT NULL,
  "time_budget_minutes" integer NOT NULL,
  "goal" text DEFAULT '' NOT NULL,
  "practice_prompt" text DEFAULT '' NOT NULL,
  "done_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "selected_resource_id" uuid,
  "backup_resource_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "provenance" jsonb,
  "freshness_policy" text DEFAULT 'STATIC' NOT NULL,
  "last_prepared_at" timestamp with time zone,
  "failure_reason" text,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plan_blocks" (
  "id" text PRIMARY KEY NOT NULL,
  "daily_plan_id" text NOT NULL,
  "date" text NOT NULL,
  "start_epoch_ms" bigint NOT NULL,
  "end_epoch_ms" bigint NOT NULL,
  "type" text NOT NULL,
  "ownership" text DEFAULT 'COS' NOT NULL,
  "title" text NOT NULL,
  "task_id" text,
  "habit_id" text,
  "commitment_id" text,
  "location_id" text,
  "locked" boolean DEFAULT false NOT NULL,
  "preparation_id" uuid,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resources" (
  "id" uuid PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "url" text,
  "format" text DEFAULT 'ARTICLE' NOT NULL,
  "provider" text DEFAULT 'unknown' NOT NULL,
  "duration_minutes" integer,
  "notes" text,
  "learning_item_id" text,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resource_candidates" (
  "id" uuid PRIMARY KEY NOT NULL,
  "preparation_id" uuid NOT NULL,
  "title" text NOT NULL,
  "url" text,
  "snippet" text,
  "score" integer,
  "provider" text DEFAULT 'search' NOT NULL,
  "search_query" text,
  "created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "completions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "preparation_id" uuid,
  "task_id" text,
  "grade" text DEFAULT 'FULL' NOT NULL,
  "minutes" integer NOT NULL,
  "note" text,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "plan_blocks" ADD CONSTRAINT "plan_blocks_preparation_id_preparations_id_fk" FOREIGN KEY ("preparation_id") REFERENCES "public"."preparations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "preparations" ADD CONSTRAINT "preparations_selected_resource_id_resources_id_fk" FOREIGN KEY ("selected_resource_id") REFERENCES "public"."resources"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "resource_candidates" ADD CONSTRAINT "resource_candidates_preparation_id_preparations_id_fk" FOREIGN KEY ("preparation_id") REFERENCES "public"."preparations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "daily_plans_date_idx" ON "daily_plans" ("date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plan_blocks_date_idx" ON "plan_blocks" ("date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "preparations_target_idx" ON "preparations" ("target_type", "target_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_updated_at_idx" ON "tasks" ("updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "preparations_updated_at_idx" ON "preparations" ("updated_at");
