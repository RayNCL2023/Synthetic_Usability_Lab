import { z } from "zod/v4";

/**
 * Boot-time configuration.
 *
 * Every service validates only the slice it needs and exits naming the missing
 * variable. No silent defaults for anything that costs money or touches a live
 * site — a run that quietly used the wrong model, or scanned a site without a
 * passcode, is worse than a service that refused to start.
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v === "true" || v === "1"));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().int());

export const DataEnv = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
});

export const StorageEnv = z.object({
  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: bool(true),
  S3_PRESIGN_TTL_SECONDS: int(3600),
});

export const ModelEnv = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  SUL_LOOP_MODEL: z.string().default("claude-sonnet-5"),
  SUL_LOOP_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  SUL_CLUSTER_MODEL: z.string().default("claude-opus-5"),
  SUL_CLUSTER_EFFORT: z
    .enum(["low", "medium", "high", "xhigh", "max"])
    .default("high"),
  SUL_LOOP_MAX_TOKENS: int(4096),
  SUL_CLUSTER_MAX_TOKENS: int(8192),
  SUL_CACHE_TTL: z.enum(["5m", "1h"]).default("5m"),
});

export const BudgetEnv = z.object({
  SUL_MAX_STEPS_PER_PERSONA: int(8),
  SUL_MAX_MODEL_CALLS_PER_RUN: int(40),
  SUL_MAX_WALL_CLOCK_MS: int(180_000),
  SUL_MAX_COST_CENTS: int(50),
});

export const BrowserEnv = z.object({
  SUL_HEADLESS: bool(true),
  SUL_NAV_TIMEOUT_MS: int(20_000),
  SUL_STEP_TIMEOUT_MS: int(45_000),
  SUL_USER_AGENT: z
    .string()
    .default(
      "SyntheticUsabilityLab/0.1 (+https://github.com/your-org/synthetic-usability-lab; automated usability testing)",
    ),
});

export const SafetyEnv = z.object({
  SUL_RESPECT_ROBOTS: bool(true),
  SUL_DOMAIN_DENYLIST: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  SUL_RUN_PASSCODE: z.string().optional().default(""),
  SUL_RATE_LIMIT_PER_IP_PER_HOUR: int(3),
  SUL_GLOBAL_DAILY_RUN_CAP: int(100),
});

export class ConfigError extends Error {
  constructor(issues: z.ZodIssue[]) {
    const lines = issues.map(
      (i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    super(
      `Invalid or missing configuration:\n${lines.join("\n")}\n\n` +
        `Copy .env.example to .env and fill in the values above.`,
    );
    this.name = "ConfigError";
  }
}

/** Parse or die, naming what is missing. */
export function loadEnv<T extends z.ZodTypeAny>(
  schema: T,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) throw new ConfigError(result.error.issues);
  return result.data;
}

export type DataConfig = z.infer<typeof DataEnv>;
export type StorageConfig = z.infer<typeof StorageEnv>;
export type ModelConfigEnv = z.infer<typeof ModelEnv>;
export type BudgetConfig = z.infer<typeof BudgetEnv>;
export type BrowserConfig = z.infer<typeof BrowserEnv>;
export type SafetyConfig = z.infer<typeof SafetyEnv>;
