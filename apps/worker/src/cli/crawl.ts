import { renderSnapshotTree, getPersona, PERSONA_KEYS } from "@sul/shared";
import { BrowserDriver } from "../browser/driver.js";
import { buildSnapshot } from "../browser/snapshot.js";
import { startFixtureServer } from "./fixture.js";
import { uploadScreenshot, presignScreenshot, isStorageConfigured } from "../storage/s3.js";

/**
 * `pnpm crawl [url] [--persona=key] [--no-upload]`
 *
 * Prints the snapshot tree a persona would actually see and, when storage is
 * configured, writes the screenshot to S3/MinIO and prints a presigned URL.
 * This is the phase-2 acceptance check and the fastest way to debug why a node
 * did or did not make it into the snapshot.
 */

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=");
}

async function main() {
  const personaKey = arg("persona") ?? "procurement";
  if (!PERSONA_KEYS.includes(personaKey)) {
    console.error(`Unknown persona "${personaKey}". Known: ${PERSONA_KEYS.join(", ")}`);
    process.exit(1);
  }
  const persona = getPersona(personaKey);
  const noUpload = process.argv.includes("--no-upload");

  const positional = process.argv.slice(2).find((a) => !a.startsWith("--"));
  let target = positional;
  let stopFixture: (() => Promise<void>) | null = null;

  if (!target) {
    const fixture = await startFixtureServer();
    target = fixture.url;
    stopFixture = fixture.close;
    console.log(`(no URL given — started the bundled fixture site at ${target})\n`);
  }

  const driver = new BrowserDriver({
    headless: process.env.SUL_HEADLESS !== "false",
    userAgent:
      process.env.SUL_USER_AGENT ??
      "SyntheticUsabilityLab/0.1 (+automated usability testing)",
    navTimeoutMs: Number(process.env.SUL_NAV_TIMEOUT_MS ?? 20000),
  });

  await driver.start();
  const session = await driver.createPersonaContext(persona);

  try {
    const nav = await session.goto(target);
    if (!nav.ok) {
      console.error(`navigation failed: ${nav.error}`);
      process.exitCode = 1;
      return;
    }

    const snapshot = await buildSnapshot(session.page, 0);

    console.log(`persona   ${persona.displayName} (${persona.key})`);
    console.log(`viewport  ${snapshot.viewport.width}x${snapshot.viewport.height}`);
    console.log(`url       ${snapshot.url}`);
    console.log(`title     ${snapshot.title}`);
    console.log(
      `nodes     ${snapshot.nodes.length} emitted of ${snapshot.totalDiscovered} discovered` +
        (snapshot.truncated ? " (truncated)" : ""),
    );
    console.log(
      `screenshot ${persona.harness.receivesScreenshot ? "yes" : "no — this persona is snapshot-only"}`,
    );
    console.log("");
    console.log(renderSnapshotTree(snapshot));

    if (persona.harness.receivesScreenshot && !noUpload && isStorageConfigured()) {
      const shot = await session.screenshot();
      const key = `crawl/${Date.now()}-${persona.key}.jpg`;
      await uploadScreenshot(key, shot);
      const url = await presignScreenshot(key);
      console.log(`\nscreenshot ${shot.byteLength} bytes -> ${key}`);
      console.log(url);
    } else if (persona.harness.receivesScreenshot && !noUpload) {
      console.log("\n(storage not configured — skipping screenshot upload)");
    }
  } finally {
    await session.close();
    await driver.stop();
    if (stopFixture) await stopFixture();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
