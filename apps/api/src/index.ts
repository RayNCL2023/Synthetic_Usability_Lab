import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  BrowserEnv,
  DataEnv,
  SafetyEnv,
  loadEnv,
  PERSONA_KEYS,
  PERSONAS,
  redisChannelForRun,
  type RunEvent,
} from "@sul/shared";
import {
  getDb,
  issueObservations,
  issues,
  observations,
  personaRuns,
  runs,
  steps,
} from "@sul/shared/db";
import { enqueueRun } from "@sul/worker/queue/run-service";
import { connectionFor, createRedis } from "@sul/worker/queue";
import { preflight } from "@sul/worker/safety/preflight";
import { buildModelClient } from "@sul/worker/model/factory";
import { loadEvents } from "@sul/worker/persistence";
import { presignScreenshot } from "@sul/worker/storage";

const data = loadEnv(DataEnv);
const safety = loadEnv(SafetyEnv);
const browserCfg = loadEnv(BrowserEnv);

const db = getDb(data.DATABASE_URL);
const redis = createRedis(data.REDIS_URL);
const connection = connectionFor(data.REDIS_URL);

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });
await app.register(websocket);

// ---------------------------------------------------------------------------
// Abuse gating
//
// This service fetches arbitrary URLs on demand, which makes it both attractive
// to misuse and capable of running up a bill. Three layers, and the daily cap
// FAILS CLOSED: when it is gone, live runs are refused and callers are pointed
// at the seeded demo, which costs nothing and always works.
// ---------------------------------------------------------------------------

async function runsInLastHourForIp(ip: string): Promise<number> {
  const since = new Date(Date.now() - 3_600_000);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(runs)
    .where(and(eq(runs.createdByIp, ip), gte(runs.createdAt, since), eq(runs.isDemo, false)));
  return row?.n ?? 0;
}

async function runsToday(): Promise<number> {
  const since = new Date(Date.now() - 86_400_000);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(runs)
    .where(and(gte(runs.createdAt, since), eq(runs.isDemo, false)));
  return row?.n ?? 0;
}

const CreateRunBody = z.object({
  url: z.string(),
  goal: z.string().min(3),
  personaKeys: z.array(z.string()).optional(),
  passcode: z.string().optional(),
  authorised: z.boolean(),
});

app.get("/health", async () => ({
  ok: true,
  personas: PERSONAS.map((p) => ({
    key: p.key,
    displayName: p.displayName,
    avatar: p.avatar,
    colour: p.colour,
    receivesScreenshot: p.harness.receivesScreenshot,
  })),
}));

app.post("/runs", async (req, reply) => {
  const parsed = CreateRunBody.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: "invalid_request",
      message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    });
  }
  const body = parsed.data;

  if (!body.authorised) {
    return reply.code(400).send({
      error: "not_authorised",
      message: "You must confirm you are authorised to test this site.",
    });
  }

  // Passcode. An unset passcode disables live runs entirely rather than
  // leaving the endpoint open — failing closed is the safe default for a
  // public deployment.
  if (!safety.SUL_RUN_PASSCODE) {
    return reply.code(403).send({
      error: "live_runs_disabled",
      message: "Live runs are disabled on this deployment. Open a demo run instead.",
      demoAvailable: true,
    });
  }
  if (body.passcode !== safety.SUL_RUN_PASSCODE) {
    return reply.code(403).send({ error: "bad_passcode", message: "Incorrect passcode." });
  }

  const ip = (req.headers["x-forwarded-for"]?.toString().split(",")[0] ?? req.ip).trim();

  if ((await runsToday()) >= safety.SUL_GLOBAL_DAILY_RUN_CAP) {
    return reply.code(429).send({
      error: "daily_cap",
      message:
        "This deployment has hit its daily run cap. The demo runs are always available.",
      demoAvailable: true,
    });
  }
  if ((await runsInLastHourForIp(ip)) >= safety.SUL_RATE_LIMIT_PER_IP_PER_HOUR) {
    return reply.code(429).send({
      error: "rate_limited",
      message: `You can start ${safety.SUL_RATE_LIMIT_PER_IP_PER_HOUR} runs per hour. Try the demo runs meanwhile.`,
      demoAvailable: true,
    });
  }

  // Preflight BEFORE enqueueing: ~3s, zero model spend, and it converts the
  // most common failure into a legible message instead of three personas
  // discovering a bot wall independently a minute later.
  const pf = await preflight(body.url, {
    userAgent: browserCfg.SUL_USER_AGENT,
    respectRobots: safety.SUL_RESPECT_ROBOTS,
    denylist: safety.SUL_DOMAIN_DENYLIST,
  });
  if (!pf.ok) {
    return reply.code(422).send({
      error: "preflight_failed",
      message: pf.reason,
      status: pf.status,
      elapsedMs: pf.elapsedMs,
    });
  }

  const keys = (body.personaKeys ?? PERSONA_KEYS).filter((k) => PERSONA_KEYS.includes(k));
  const built = buildModelClient();
  const { runId } = await enqueueRun(db, connection, {
    url: pf.finalUrl ?? body.url,
    goal: body.goal,
    personaKeys: keys,
    modelConfig: built.config,
    createdByIp: ip,
  });

  return reply.code(201).send({ runId, personaKeys: keys, preflightMs: pf.elapsedMs });
});

/** Full run state — used by the report view and by a late-loading client. */
async function loadRun(runId: string) {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) return null;

  const prs = await db.select().from(personaRuns).where(eq(personaRuns.runId, runId));
  const issueRows = await db
    .select()
    .from(issues)
    .where(eq(issues.runId, runId))
    .orderBy(issues.rank);

  const links = issueRows.length
    ? await db
        .select({
          issueId: issueObservations.issueId,
          observationId: issueObservations.observationId,
          severity: observations.severity,
          category: observations.category,
          quote: observations.quote,
          elementRef: observations.elementRef,
          elementDescription: observations.elementDescription,
          viewportBox: observations.viewportBox,
          personaRunId: observations.personaRunId,
          stepId: observations.stepId,
        })
        .from(issueObservations)
        .innerJoin(observations, eq(observations.id, issueObservations.observationId))
        .where(
          sql`${issueObservations.issueId} in ${sql.raw(
            `(${issueRows.map((i) => `'${i.id}'`).join(",")})`,
          )}`,
        )
    : [];

  const stepRows = await db
    .select({
      id: steps.id,
      personaRunId: steps.personaRunId,
      index: steps.index,
      url: steps.url,
      screenshotKey: steps.screenshotKey,
      narration: steps.narration,
      actionJson: steps.actionJson,
    })
    .from(steps)
    .innerJoin(personaRuns, eq(personaRuns.id, steps.personaRunId))
    .where(eq(personaRuns.runId, runId))
    .orderBy(steps.index);

  const personaByRunId = new Map(prs.map((p) => [p.id, p.personaKey]));

  const stepsOut = await Promise.all(
    stepRows.map(async (s) => ({
      id: s.id,
      personaKey: personaByRunId.get(s.personaRunId) ?? "unknown",
      index: s.index,
      url: s.url,
      screenshotUrl: s.screenshotKey ? await presignScreenshot(s.screenshotKey) : null,
      narration: s.narration,
      action: s.actionJson,
    })),
  );

  return {
    run: {
      id: run.id,
      url: run.url,
      goal: run.goal,
      status: run.status,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      totalCostCents: run.totalCostCents,
      totalTokens: run.totalTokens,
      abortReason: run.abortReason,
      modelConfig: run.modelConfig,
      slug: run.slug,
      isDemo: run.isDemo,
    },
    personaRuns: prs.map((p) => ({
      personaKey: p.personaKey,
      status: p.status,
      outcome: p.outcome,
      stepCount: p.stepCount,
      blockedReason: p.blockedReason,
      currentActionLabel: p.currentActionLabel,
    })),
    steps: stepsOut,
    issues: issueRows.map((i) => {
      const mine = links.filter((l) => l.issueId === i.id);
      return {
        ...i,
        personaKeys: [
          ...new Set(mine.map((m) => personaByRunId.get(m.personaRunId) ?? "unknown")),
        ],
        observations: mine.map((m) => ({
          id: m.observationId,
          severity: m.severity,
          category: m.category,
          quote: m.quote,
          elementRef: m.elementRef,
          elementDescription: m.elementDescription,
          box: m.viewportBox,
          personaKey: personaByRunId.get(m.personaRunId) ?? "unknown",
          stepId: m.stepId,
        })),
      };
    }),
  };
}

app.get<{ Params: { id: string } }>("/runs/:id", async (req, reply) => {
  const out = await loadRun(req.params.id);
  if (!out) return reply.code(404).send({ error: "not_found" });
  return out;
});

/** Seeded demo runs, addressed by slug. No key, no worker, no live browsing. */
app.get<{ Params: { slug: string } }>("/demo/:slug", async (req, reply) => {
  const [row] = await db.select().from(runs).where(eq(runs.slug, req.params.slug));
  if (!row) return reply.code(404).send({ error: "not_found" });
  const out = await loadRun(row.id);
  return out;
});

app.get("/demo", async () => {
  const rows = await db
    .select()
    .from(runs)
    .where(eq(runs.isDemo, true))
    .orderBy(desc(runs.createdAt));
  return rows.map((r) => ({
    slug: r.slug,
    url: r.url,
    goal: r.goal,
    totalCostCents: r.totalCostCents,
    createdAt: r.createdAt,
  }));
});

/** The persisted event log, for replay at any speed. */
app.get<{ Params: { id: string }; Querystring: { from?: string } }>(
  "/runs/:id/events",
  async (req) => {
    const from = Number(req.query.from ?? 0);
    return loadEvents(db, req.params.id, Number.isFinite(from) ? from : 0);
  },
);

// ---------------------------------------------------------------------------
// Live stream with catch-up replay.
//
// On connect we replay the persisted log from `from` (default 0) and only THEN
// attach the live subscription. Clients dedupe by seq across the handover,
// because the window between "replay finished" and "subscription live" can
// legitimately deliver the same event twice — and dropping one is worse than
// seeing it twice.
// ---------------------------------------------------------------------------
app.get<{ Params: { id: string }; Querystring: { from?: string } }>(
  "/ws/runs/:id",
  { websocket: true },
  async (socket, req) => {
    const runId = req.params.id;
    const from = Number(req.query.from ?? 0);

    const sub = createRedis(data.REDIS_URL);
    let closed = false;
    socket.on("close", () => {
      closed = true;
      sub.disconnect();
    });

    // Subscribe first and buffer, so nothing emitted during replay is lost.
    const buffered: RunEvent[] = [];
    let replaying = true;
    await sub.subscribe(redisChannelForRun(runId));
    sub.on("message", (_channel, payload) => {
      if (closed) return;
      try {
        const event = JSON.parse(payload) as RunEvent;
        if (replaying) buffered.push(event);
        else socket.send(payload);
      } catch {
        /* ignore malformed */
      }
    });

    const replayed = await loadEvents(db, runId, Number.isFinite(from) ? from : 0);
    for (const e of replayed) {
      if (closed) return;
      socket.send(JSON.stringify(e));
    }

    // Flush anything that arrived during replay, then go live. Duplicates are
    // possible here by design; the client dedupes on seq.
    replaying = false;
    for (const e of buffered) {
      if (closed) return;
      socket.send(JSON.stringify(e));
    }
  },
);

const port = Number(process.env.API_PORT ?? 3001);
await app.listen({ port, host: "0.0.0.0" });
console.log(`api listening on :${port}`);
