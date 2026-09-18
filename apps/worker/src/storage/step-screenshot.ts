import { isStorageConfigured, screenshotKey, uploadScreenshot } from "./s3.js";

/**
 * The one place a step's screenshot is written.
 *
 * Every producer of steps needs the same three decisions — is storage
 * configured, did this persona even take a picture, what key does it go under —
 * and each producer that reimplements them is a chance to drop one silently.
 * That is not hypothetical: the eval harness carried a copy that passed a
 * hardcoded null key, so every eval run persisted a complete trace with no
 * evidence attached to it.
 *
 * The sink is injected so the decisions are testable without an object store.
 */

export interface ScreenshotSink {
  /** False when the deployment has no object storage; uploads are skipped. */
  enabled: boolean;
  upload(key: string, body: Buffer): Promise<string>;
}

/** The real sink. Reads configuration at call time, as the S3 client does. */
export function s3Sink(): ScreenshotSink {
  return {
    enabled: isStorageConfigured(),
    upload: uploadScreenshot,
  };
}

export async function storeStepScreenshot(
  sink: ScreenshotSink,
  input: {
    runId: string;
    personaKey: string;
    stepIndex: number;
    /** Null or undefined for a persona that receives no screenshot. */
    screenshot: Buffer | null | undefined;
  },
): Promise<string | null> {
  if (!sink.enabled) return null;
  if (!input.screenshot) return null;

  const key = screenshotKey(input.runId, input.personaKey, input.stepIndex);
  await sink.upload(key, input.screenshot);
  return key;
}
