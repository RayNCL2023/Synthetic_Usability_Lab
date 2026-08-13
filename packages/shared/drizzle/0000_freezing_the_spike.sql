CREATE TABLE "issue_observations" (
	"issue_id" uuid NOT NULL,
	"observation_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"severity" text NOT NULL,
	"category" text NOT NULL,
	"rank" integer NOT NULL,
	"recommendation" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"step_id" uuid NOT NULL,
	"persona_run_id" uuid NOT NULL,
	"severity" text NOT NULL,
	"category" text NOT NULL,
	"element_ref" text NOT NULL,
	"element_description" text NOT NULL,
	"quote" text NOT NULL,
	"viewport_box" jsonb
);
--> statement-breakpoint
CREATE TABLE "persona_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"persona_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"current_action_label" text,
	"step_count" integer DEFAULT 0 NOT NULL,
	"outcome" text,
	"blocked_reason" text
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_seq_counters" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"goal" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"total_cost_cents" double precision DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"abort_reason" text,
	"model_config" jsonb,
	"slug" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_by_ip" text
);
--> statement-breakpoint
CREATE TABLE "steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"persona_run_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"url" text NOT NULL,
	"screenshot_key" text,
	"snapshot_json" jsonb NOT NULL,
	"action_json" jsonb NOT NULL,
	"narration" text DEFAULT '' NOT NULL,
	"reasoning" text DEFAULT '' NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"stop_reason" text,
	"model_id" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_observations" ADD CONSTRAINT "issue_observations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_observations" ADD CONSTRAINT "issue_observations_observation_id_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."observations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_step_id_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_persona_run_id_persona_runs_id_fk" FOREIGN KEY ("persona_run_id") REFERENCES "public"."persona_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_runs" ADD CONSTRAINT "persona_runs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_seq_counters" ADD CONSTRAINT "run_seq_counters_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steps" ADD CONSTRAINT "steps_persona_run_id_persona_runs_id_fk" FOREIGN KEY ("persona_run_id") REFERENCES "public"."persona_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_observations_pk" ON "issue_observations" USING btree ("issue_id","observation_id");--> statement-breakpoint
CREATE INDEX "issues_run_id_idx" ON "issues" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "observations_step_id_idx" ON "observations" USING btree ("step_id");--> statement-breakpoint
CREATE INDEX "observations_persona_run_id_idx" ON "observations" USING btree ("persona_run_id");--> statement-breakpoint
CREATE INDEX "persona_runs_run_id_idx" ON "persona_runs" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_run_id_seq_idx" ON "run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "steps_persona_run_index_idx" ON "steps" USING btree ("persona_run_id","index");