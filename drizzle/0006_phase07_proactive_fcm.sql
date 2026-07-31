-- Phase 07: proactive scan + FCM tokens

CREATE TABLE IF NOT EXISTS "device_fcm_tokens" (
  "device_id" uuid PRIMARY KEY NOT NULL,
  "token" text NOT NULL,
  "platform" text DEFAULT 'android' NOT NULL,
  "autonomy" text DEFAULT 'SUGGEST' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_log" (
  "id" text PRIMARY KEY NOT NULL,
  "device_id" uuid NOT NULL,
  "type" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "deep_link" text,
  "entity_type" text,
  "entity_id" text,
  "sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_log_device_day_idx"
  ON "notification_log" ("device_id", "sent_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proactive_scan_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "summary" jsonb
);
