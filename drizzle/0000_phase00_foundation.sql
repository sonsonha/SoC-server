CREATE TABLE IF NOT EXISTS "device_credentials" (
  "id" uuid PRIMARY KEY NOT NULL,
  "secret_hash" text NOT NULL,
  "label" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_cursors" (
  "device_id" uuid PRIMARY KEY NOT NULL,
  "cursor" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_mutations" (
  "mutation_id" uuid PRIMARY KEY NOT NULL,
  "device_id" uuid NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text NOT NULL,
  "operation" text NOT NULL,
  "payload" jsonb NOT NULL,
  "applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_device_id_device_credentials_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device_credentials"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "client_mutations" ADD CONSTRAINT "client_mutations_device_id_device_credentials_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device_credentials"("id") ON DELETE cascade ON UPDATE no action;
