ALTER TABLE "agents" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "disabled_by" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "disabled_reason" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_disabled_reason_len" CHECK (char_length("agents"."disabled_reason") <= 500);