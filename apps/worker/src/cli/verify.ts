import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  DecisionSchema,
  ModelEnv,
  computeCost,
  formatCents,
  loadEnv,
} from "@sul/shared";

/**
 * `pnpm verify` — contract verification against the real API.
 *
 * Proves the assumptions the cost model and the agent loop are built on, rather
 * than trusting that the SDK types match the wire. Everything here is cheap:
 * three small calls, no browser, no persistence.
 *
 * Checks:
 *   1. output_config.format + effort are accepted on a real request
 *   2. the raw usage block, dumped VERBATIM, with every field computeCost reads
 *      confirmed present under the name we assumed
 *   3. whether thinking tokens appear inside output_tokens
 *   4. a deliberate max_tokens truncation, to prove stop_reason fires
 */

function heading(s: string) {
  console.log(`\n${"─".repeat(72)}\n${s}\n${"─".repeat(72)}`);
}

async function main() {
  const env = loadEnv(ModelEnv);
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 });

  const format = zodOutputFormat(DecisionSchema);

  heading("1. Schema actually sent to the API (derived from DecisionSchema)");
  const asJson = JSON.stringify(format.schema);
  console.log(`enum kept as an enforced keyword : ${/"enum"\s*:/.test(asJson)}`);
  console.log(`enum demoted into description    : ${/\{enum:/.test(asJson)}`);
  console.log(`nullable rendered as anyOf       : ${/"anyOf"/.test(asJson)}`);

  heading("2. Live request with output_config { effort, format }");
  const started = Date.now();
  const res = await client.messages.create({
    model: env.SUL_LOOP_MODEL,
    max_tokens: env.SUL_LOOP_MAX_TOKENS,
    output_config: { effort: env.SUL_LOOP_EFFORT, format },
    system: [
      {
        type: "text",
        text:
          "You are testing an API contract. Respond with a finish action and no observations.",
        cache_control: { type: "ephemeral", ttl: env.SUL_CACHE_TTL },
      },
    ],
    messages: [
      {
        role: "user",
        content:
          "SNAPSHOT:\n  s0e1 button \"Continue\" [visible, in-viewport]\n\n" +
          "Finish immediately with outcome gave_up.",
      },
    ],
  });
  const latency = Date.now() - started;

  console.log(`accepted        : yes (HTTP 200)`);
  console.log(`model returned  : ${res.model}`);
  console.log(`stop_reason     : ${res.stop_reason}`);
  console.log(`latency         : ${latency}ms`);

  heading("3. Raw usage block, verbatim");
  console.log(JSON.stringify(res.usage, null, 2));

  const u = res.usage as unknown as Record<string, unknown>;
  const required = [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ];
  console.log("\nfields computeCost reads:");
  for (const f of required) {
    const present = f in u;
    console.log(`  ${present ? "OK  " : "MISSING"} ${f} = ${JSON.stringify(u[f])}`);
  }

  const thinking =
    (res.usage as { output_tokens_details?: { thinking_tokens?: number } })
      .output_tokens_details?.thinking_tokens ?? null;
  console.log(
    `\nthinking tokens : ${
      thinking === null
        ? "output_tokens_details absent — no thinking reported"
        : `${thinking} of ${res.usage.output_tokens} output tokens (output_tokens is the inclusive billed total)`
    }`,
  );

  const breakdown = (res.usage as { cache_creation?: unknown }).cache_creation;
  console.log(
    `cache_creation  : ${breakdown ? JSON.stringify(breakdown) : "null (nothing written this call)"}`,
  );

  heading("4. Cost for that call, through the real pricing table");
  const cost = computeCost(
    {
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
    },
    res.model,
    env.SUL_CACHE_TTL,
    new Date(),
  );
  console.log(`input       ${formatCents(cost.inputCents)}`);
  console.log(`output      ${formatCents(cost.outputCents)}`);
  console.log(`cache write ${formatCents(cost.cacheWriteCents)}`);
  console.log(`cache read  ${formatCents(cost.cacheReadCents)}`);
  console.log(`TOTAL       ${formatCents(cost.totalCents)}`);

  heading("5. Deliberate truncation — proving the stop_reason branch fires");
  // max_tokens far too small for a decision object plus any thinking.
  const trunc = await client.messages.create({
    model: env.SUL_LOOP_MODEL,
    max_tokens: 16,
    output_config: { effort: env.SUL_LOOP_EFFORT, format },
    messages: [
      {
        role: "user",
        content:
          "SNAPSHOT:\n  s0e1 button \"Continue\"\n\nDescribe at length, then finish.",
      },
    ],
  });
  console.log(`stop_reason     : ${trunc.stop_reason}`);
  console.log(
    `branch taken    : ${
      trunc.stop_reason === "max_tokens"
        ? "max_tokens -> raise budget, do NOT re-prompt"
        : `unexpected (${trunc.stop_reason}) — the loop would treat this differently`
    }`,
  );
  const truncText =
    trunc.content.find((b) => b.type === "text")?.type === "text"
      ? (trunc.content.find((b) => b.type === "text") as { text: string }).text
      : "";
  const parsed = DecisionSchema.safeParse(safeJson(truncText));
  console.log(
    `local safeParse : ${parsed.success ? "unexpectedly succeeded" : "correctly rejected the truncated object"}`,
  );

  console.log("\nAll contract checks completed.\n");
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

main().catch((err) => {
  console.error(`\nverification failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
