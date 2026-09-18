/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import {
  DataEnv,
  loadEnv,
  type RunEvent,
} from "@sul/shared";
import {
  getDb,
  closeDb,
  issueObservations,
  issues,
  observations,
  personaRuns,
  runEvents,
  runs,
  runSeqCounters,
  steps,
} from "@sul/shared/db";
import { presignScreenshot, screenshotKey } from "../storage/s3.js";
import { loadEvents } from "../persistence/repository.js";

/**
 * Seeded demo runs.
 *
 * `export <runId> <slug>` freezes a completed real run into a committed JSON
 * fixture; `import` loads every fixture back into a database.
 *
 * This is the project's highest-value artifact: it is what makes /demo/[slug]
 * work with no API key, no worker, and no live browsing, and it is what
 * guarantees there is something to show even if everything downstream slips.
 * Screenshots are embedded as data URIs rather than S3 keys precisely so a
 * fixture is self-contained — a demo that depends on a live bucket is not a
 * fallback, it is another thing that can be down.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const SEED_DIR = path.resolve(here, "../../../../fixtures/seeded-runs");

interface SeededRun {
  slug: string;
  capturedAt: string;
  run: Record<string, unknown>;
  personaRuns: Array<Record<string, unknown>>;
  steps: Array<Record<string, unknown>>;
  observations: Array<Record<string, unknown>>;
  issues: Array<Record<string, unknown>>;
  issueObservations: Array<{ issueId: string; observationId: string }>;
  events: RunEvent[];
}

async function fetchAsDataUri(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

async function exportRun(runId: string, slug: string): Promise<void> {
  const env = loadEnv(DataEnv);
  const db = getDb(env.DATABASE_URL);

  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) throw new Error(`no run ${runId}`);

  const prs = await db.select().from(personaRuns).where(eq(personaRuns.runId, runId));
  const personaKeyById = new Map(prs.map((p) => [p.id, p.personaKey]));
  const prIds = new Set(prs.map((p) => p.id));

  const allSteps = (await db.select().from(steps)).filter((s) =>
    prIds.has(s.personaRunId),
  );
  const allObs = (await db.select().from(observations)).filter((o) =>
    prIds.has(o.personaRunId),
  );
  const allIssues = await db.select().from(issues).where(eq(issues.runId, runId));
  const issueIds = new Set(allIssues.map((i) => i.id));
  const allLinks = (await db.select().from(issueObservations)).filter((l) =>
    issueIds.has(l.issueId),
  );
  // Via loadEvents rather than a second query: a bare select returns physical
  // row order, which froze a scrambled log into all four fixtures. loadEvents
  // is the one reader that orders by seq, and fanout.test.ts holds it to that.
  const evs = await loadEvents(db, runId, 0);

  // Inline every screenshot so the fixture stands alone.
  let embedded = 0;
  const stepsOut = await Promise.all(
    allSteps.map(async (s) => {
      let dataUri: string | null = null;
      if (s.screenshotKey) {
        const url = await presignScreenshot(s.screenshotKey).catch(() => null);
        if (url) dataUri = await fetchAsDataUri(url);
        if (dataUri) embedded++;
      }
      return {
        ...s,
        // A run that was itself imported from a fixture carries its image in
        // screenshotKey (that is how the API serves a demo with no bucket).
        // Writing it back out would store the same bytes in two fields and
        // grow the fixture by a third on every round-trip, so the object key
        // is restored — derived by the same function the uploader used — and
        // the image lives in screenshotDataUri alone. Export is then
        // idempotent: re-exporting a fixture reproduces it byte for byte.
        screenshotKey: s.screenshotKey?.startsWith("data:")
          ? screenshotKey(runId, personaKeyById.get(s.personaRunId) ?? "unknown", s.index)
          : s.screenshotKey,
        screenshotDataUri: dataUri,
      };
    }),
  );

  // Rewrite presigned URLs inside the event payloads too — they expire, and a
  // seeded run must never depend on a credential.
  const stepByIndex = new Map(
    stepsOut.map((s) => [`${s.personaRunId}:${s.index}`, s.screenshotDataUri]),
  );
  const prByKey = new Map(prs.map((p) => [p.personaKey, p.id]));
  const eventsOut = evs
    .map((e) => {
      if (e.type === "persona.step" && e.screenshotUrl) {
        const prId = prByKey.get(e.personaKey);
        const uri = prId ? stepByIndex.get(`${prId}:${e.stepIndex}`) : null;
        return { ...e, screenshotUrl: uri ?? null };
      }
      return e;
    });

  const payload: SeededRun = {
    slug,
    capturedAt: new Date().toISOString(),
    run: { ...run, slug, isDemo: true },
    personaRuns: prs,
    steps: stepsOut,
    observations: allObs,
    issues: allIssues,
    issueObservations: allLinks,
    events: eventsOut,
  };

  fs.mkdirSync(SEED_DIR, { recursive: true });
  const file = path.join(SEED_DIR, `${slug}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));

  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log(
    `exported ${slug}: ${allSteps.length} steps, ${allObs.length} observations, ` +
      `${allIssues.length} issues, ${eventsOut.length} events, ${embedded} screenshots embedded (${kb} KB)`,
  );
  await closeDb();
}

async function importAll(): Promise<void> {
  const env = loadEnv(DataEnv);
  const db = getDb(env.DATABASE_URL);

  if (!fs.existsSync(SEED_DIR)) {
    console.log("no seeded runs to import");
    await closeDb();
    return;
  }
  const files = fs.readdirSync(SEED_DIR).filter((f) => f.endsWith(".json"));

  for (const f of files) {
    const seed = JSON.parse(
      fs.readFileSync(path.join(SEED_DIR, f), "utf8"),
    ) as SeededRun;
    const runRow = seed.run as Record<string, unknown>;
    const runId = runRow["id"] as string;

    // Idempotent: a re-import replaces the run wholesale, so the demo never
    // ends up with half of an old fixture and half of a new one.
    await db.delete(runs).where(eq(runs.id, runId));

    await db.insert(runs).values({
      ...(runRow as any),
      createdAt: new Date(runRow["createdAt"] as string),
      finishedAt: runRow["finishedAt"]
        ? new Date(runRow["finishedAt"] as string)
        : null,
      isDemo: true,
      slug: seed.slug,
    });
    await db
      .insert(runSeqCounters)
      .values({ runId, value: seed.events.length })
      .onConflictDoNothing();

    for (const p of seed.personaRuns) await db.insert(personaRuns).values(p as any);
    for (const s of seed.steps) {
      const { screenshotDataUri, createdAt, ...rest } = s as Record<string, unknown>;
      await db.insert(steps).values({
        ...(rest as any),
        createdAt: createdAt ? new Date(createdAt as string) : new Date(),
        // The data URI rides in screenshotKey so the API can serve it without
        // a bucket. Anything starting with `data:` is passed straight through.
        screenshotKey: (screenshotDataUri as string | null) ?? null,
      });
    }
    for (const o of seed.observations) await db.insert(observations).values(o as any);
    for (const i of seed.issues) await db.insert(issues).values(i as any);
    for (const l of seed.issueObservations)
      await db.insert(issueObservations).values(l).onConflictDoNothing();
    for (const e of seed.events) {
      await db.insert(runEvents).values({
        runId,
        seq: e.seq,
        type: e.type,
        payloadJson: e,
        ts: new Date(e.ts),
      });
    }
    console.log(`imported ${seed.slug} (${seed.events.length} events)`);
  }
  await closeDb();
}

/**
 * `reference <slug>` — plain context captures for unillustrated findings.
 *
 * The screen-reader persona receives no screenshot, by design and forever. A
 * run whose findings come only from it therefore has nothing for a reader to
 * look at. This captures the pages those findings are on, as ordinary page
 * screenshots, and stores them next to the run.
 *
 * It is NOT a re-run: no model is called, no agent loop executes, no
 * observation or issue is read, written or re-scored. It only adds pictures of
 * pages, stamped with their own capture date, and the UI labels them as
 * context rather than as anything a persona saw. Pages already covered by a
 * sighted persona's screenshot are skipped — real evidence wins.
 */
async function captureReferences(slug: string): Promise<void> {
  const file = path.join(SEED_DIR, `${slug}.json`);
  if (!fs.existsSync(file)) throw new Error(`no fixture ${slug}`);
  const seed = JSON.parse(fs.readFileSync(file, "utf8")) as SeededRun & {
    references?: Array<{ url: string; capturedAt: string; screenshotUrl: string }>;
  };

  const personaKeyById = new Map(
    seed.personaRuns.map((p) => [p["id"] as string, p["personaKey"] as string]),
  );
  const stepById = new Map(seed.steps.map((s) => [s["id"] as string, s]));

  // Pages that a sighted persona already photographed need no reference.
  const covered = new Set(
    seed.steps
      .filter((s) => s["screenshotDataUri"])
      .map((s) => s["url"] as string),
  );

  const wanted = new Map<string, string>();
  for (const o of seed.observations) {
    const step = stepById.get(o["stepId"] as string);
    if (!step) continue;
    const url = step["url"] as string;
    if (covered.has(url)) continue;
    wanted.set(url, personaKeyById.get(o["personaRunId"] as string) ?? "unknown");
  }

  if (wanted.size === 0) {
    console.log(`${slug}: every finding is already illustrated — nothing to capture`);
    return;
  }

  const { BrowserDriver } = await import("../browser/driver.js");
  const { getPersona } = await import("@sul/shared");

  const references: Array<{ url: string; capturedAt: string; screenshotUrl: string }> = [];
  const driver = new BrowserDriver({
    headless: true,
    userAgent: process.env.SUL_USER_AGENT ?? "SyntheticUsabilityLab/0.1 (reference capture)",
    navTimeoutMs: 20_000,
  });
  await driver.start();
  try {
    for (const [url, personaKey] of wanted) {
      // Captured in the viewport of the persona that made the finding, so the
      // reference shows the same layout that persona was reasoning about.
      const session = await driver.createPersonaContext(getPersona(personaKey));
      try {
        await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
        const buf = await session.page.screenshot({ type: "jpeg", quality: 80, fullPage: false });
        references.push({
          url,
          capturedAt: new Date().toISOString(),
          screenshotUrl: `data:image/jpeg;base64,${buf.toString("base64")}`,
        });
        console.log(`  captured ${url} (${personaKey} viewport, ${Math.round(buf.length / 1024)} KB)`);
      } finally {
        await session.close();
      }
    }
  } finally {
    await driver.stop();
  }

  seed.references = references;
  fs.writeFileSync(file, JSON.stringify(seed, null, 2));
  console.log(`${slug}: ${references.length} reference view(s) stored`);
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "export") {
    if (!a || !b) throw new Error("usage: seed export <runId> <slug>");
    await exportRun(a, b);
  } else if (cmd === "import") {
    await importAll();
  } else if (cmd === "reference") {
    if (!a) throw new Error("usage: seed reference <slug>");
    await captureReferences(a);
  } else {
    console.error(
      "usage: seed export <runId> <slug> | seed import | seed reference <slug>",
    );
    process.exit(1);
  }
}

// Only when invoked as a command. Importing this module — to reuse SEED_DIR,
// as the fixture-integrity tests do — must not run the CLI and exit the host
// process.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
