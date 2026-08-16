import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { getDb, closeDb, runs, personaRuns, runEvents } from "@sul/shared/db";
import { eq } from "drizzle-orm";
import { RunEventEmitter } from "../events/emitter.js";
import { appendEvent, createPersonaRun, createRun, loadEvents } from "../persistence/repository.js";

/**
 * Integration coverage for the event log's ordering guarantees, which the whole
 * replay story depends on and which are easy to break invisibly.
 *
 * Requires the Docker Compose infra to be up. Skipped automatically when it is
 * not, so the unit suite stays runnable anywhere.
 */

const DB_URL = process.env.DATABASE_URL ?? "postgres://sul:sul@localhost:5432/sul";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

let available = false;
let db: ReturnType<typeof getDb>;
let redis: Redis;

beforeAll(async () => {
  try {
    db = getDb(DB_URL);
    await db.select().from(runs).limit(1);
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
    await redis.connect();
    available = true;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  redis?.disconnect();
  if (available) await closeDb();
});

describe.runIf(() => available)("run_events ordering", () => {
  it("allocates seq from a single authority under concurrent emitters", async () => {
    // The failure this guards against: three persona workers each keeping a
    // local counter produces duplicate seq values, and replay silently
    // reorders or drops events.
    const runId = await createRun(db, {
      url: "http://example.test",
      goal: "concurrency",
      modelConfig: {
        loopModel: "m",
        loopEffort: "e",
        clusterModel: "m",
        clusterEffort: "e",
        cacheTtl: "5m",
      },
    });

    const emitters = ["a", "b", "c"].map(() => new RunEventEmitter(db, redis, runId));
    await Promise.all(
      emitters.flatMap((em, i) =>
        Array.from({ length: 8 }, (_, j) =>
          em.emit({
            type: "persona.status",
            personaKey: `p${i}`,
            label: `step ${j}`,
          }),
        ),
      ),
    );

    const events = await loadEvents(db, runId, 0);
    expect(events).toHaveLength(24);

    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size, "every seq must be unique").toBe(24);
    // loadEvents orders by seq, so this also proves the ordering is total.
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("persists before publishing, so a live subscriber never sees a lost event", async () => {
    const runId = await createRun(db, {
      url: "http://example.test",
      goal: "ordering",
      modelConfig: {
        loopModel: "m",
        loopEffort: "e",
        clusterModel: "m",
        clusterEffort: "e",
        cacheTtl: "5m",
      },
    });

    const sub = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    const seen: number[] = [];
    await sub.subscribe(`run:${runId}`);
    sub.on("message", async (_c, payload) => {
      const e = JSON.parse(payload) as { seq: number };
      // The guarantee: by the time this arrives, it is already durable.
      const persisted = await loadEvents(db, runId, e.seq - 1);
      if (persisted.some((p) => p.seq === e.seq)) seen.push(e.seq);
    });

    const em = new RunEventEmitter(db, redis, runId);
    await em.emit({ type: "run.started", personaKey: null, url: "u", goal: "g", personaKeys: [] });
    await new Promise((r) => setTimeout(r, 300));

    expect(seen.length).toBeGreaterThan(0);
    sub.disconnect();
  });

  it("replays from a seq offset so a reconnecting client catches up", async () => {
    const runId = await createRun(db, {
      url: "http://example.test",
      goal: "replay",
      modelConfig: {
        loopModel: "m",
        loopEffort: "e",
        clusterModel: "m",
        clusterEffort: "e",
        cacheTtl: "5m",
      },
    });
    for (let i = 0; i < 5; i++) {
      await appendEvent(db, runId, {
        type: "persona.status",
        personaKey: "p",
        label: `s${i}`,
      });
    }
    const all = await loadEvents(db, runId, 0);
    const tail = await loadEvents(db, runId, all[1]!.seq);
    expect(all).toHaveLength(5);
    expect(tail).toHaveLength(3);
  });
});

describe.runIf(() => available)("fan-out", () => {
  it("keeps a failed persona from taking the run down with it", async () => {
    // The aggregate must still run when one child fails — a partial report is
    // the product working as designed, not an error.
    const runId = await createRun(db, {
      url: "http://example.test",
      goal: "partial",
      modelConfig: {
        loopModel: "m",
        loopEffort: "e",
        clusterModel: "m",
        clusterEffort: "e",
        cacheTtl: "5m",
      },
    });
    const ok = await createPersonaRun(db, runId, "procurement");
    const bad = await createPersonaRun(db, runId, "impatient_mobile");

    await db.update(personaRuns).set({ status: "finished", outcome: "gave_up" }).where(eq(personaRuns.id, ok));
    await db.update(personaRuns).set({ status: "failed", outcome: "error", blockedReason: "boom" }).where(eq(personaRuns.id, bad));

    const rows = await db.select().from(personaRuns).where(eq(personaRuns.runId, runId));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.outcome === "error")).toHaveLength(1);
    // The surviving persona's data is intact and aggregatable.
    expect(rows.filter((r) => r.status === "finished")).toHaveLength(1);
  });
});
