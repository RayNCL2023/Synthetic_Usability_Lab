import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  url: text("url").notNull(),
  goal: text("goal").notNull(),
  status: text("status").notNull().default("queued"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  /** Kept as float so a 15-step run doesn't lose cents to per-step rounding. */
  totalCostCents: doublePrecision("total_cost_cents").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  abortReason: text("abort_reason"),
  /** Which models produced this run — makes the eval matrix sweep analysable. */
  modelConfig: jsonb("model_config"),
  /** Stable public slug for /demo/[slug] and shareable read-only URLs. */
  slug: text("slug"),
  /** Seeded demo runs are exempt from abuse gating and never expire. */
  isDemo: boolean("is_demo").notNull().default(false),
  createdByIp: text("created_by_ip"),
});

export const personaRuns = pgTable(
  "persona_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    personaKey: text("persona_key").notNull(),
    status: text("status").notNull().default("queued"),
    currentActionLabel: text("current_action_label"),
    stepCount: integer("step_count").notNull().default(0),
    outcome: text("outcome"),
    blockedReason: text("blocked_reason"),
  },
  (t) => ({
    byRun: index("persona_runs_run_id_idx").on(t.runId),
  }),
);

export const steps = pgTable(
  "steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personaRunId: uuid("persona_run_id")
      .notNull()
      .references(() => personaRuns.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    url: text("url").notNull(),
    screenshotKey: text("screenshot_key"),
    snapshotJson: jsonb("snapshot_json").notNull(),
    actionJson: jsonb("action_json").notNull(),
    narration: text("narration").notNull().default(""),
    reasoning: text("reasoning").notNull().default(""),
    latencyMs: integer("latency_ms").notNull().default(0),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    /** max_tokens (truncation) and a bad ref need opposite responses. */
    stopReason: text("stop_reason"),
    modelId: text("model_id").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byPersonaRun: uniqueIndex("steps_persona_run_index_idx").on(
      t.personaRunId,
      t.index,
    ),
  }),
);

export const observations = pgTable(
  "observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stepId: uuid("step_id")
      .notNull()
      .references(() => steps.id, { onDelete: "cascade" }),
    personaRunId: uuid("persona_run_id")
      .notNull()
      .references(() => personaRuns.id, { onDelete: "cascade" }),
    severity: text("severity").notNull(),
    category: text("category").notNull(),
    elementRef: text("element_ref").notNull(),
    elementDescription: text("element_description").notNull(),
    quote: text("quote").notNull(),
    viewportBox: jsonb("viewport_box"),
  },
  (t) => ({
    byStep: index("observations_step_id_idx").on(t.stepId),
    byPersonaRun: index("observations_persona_run_id_idx").on(t.personaRunId),
  }),
);

export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    severity: text("severity").notNull(),
    category: text("category").notNull(),
    rank: integer("rank").notNull(),
    recommendation: text("recommendation").notNull(),
  },
  (t) => ({
    byRun: index("issues_run_id_idx").on(t.runId),
  }),
);

export const issueObservations = pgTable(
  "issue_observations",
  {
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    observationId: uuid("observation_id")
      .notNull()
      .references(() => observations.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: uniqueIndex("issue_observations_pk").on(t.issueId, t.observationId),
  }),
);

/**
 * Append-only event log.
 *
 * `seq` is assigned by a single authority (see nextSeq in events.ts) rather than
 * a per-worker counter, because three persona workers emit concurrently. The
 * unique index on (run_id, seq) is the backstop that turns a sequencing bug
 * into a loud constraint violation instead of a silently reordered replay.
 */
export const runEvents = pgTable(
  "run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bySeq: uniqueIndex("run_events_run_id_seq_idx").on(t.runId, t.seq),
  }),
);

/** Per-run monotonic counter backing `run_events.seq`. */
export const runSeqCounters = pgTable("run_seq_counters", {
  runId: uuid("run_id")
    .primaryKey()
    .references(() => runs.id, { onDelete: "cascade" }),
  value: bigint("value", { mode: "number" }).notNull().default(0),
});
