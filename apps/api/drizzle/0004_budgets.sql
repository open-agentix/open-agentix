CREATE TABLE "budget_alerts" (
	"tenant_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"scope_key" text DEFAULT '' NOT NULL,
	"month" date NOT NULL,
	"threshold_percent" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_alerts_tenant_id_scope_scope_key_month_threshold_percent_pk" PRIMARY KEY("tenant_id","scope","scope_key","month","threshold_percent")
);
--> statement-breakpoint
CREATE TABLE "use_case_budgets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL,
	"use_case" text NOT NULL,
	"monthly_budget_micros" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "use_case_budgets_tenant_uq" ON "use_case_budgets" USING btree ("tenant_id","use_case");