import {
  S3Client,
  PutObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { StorageEnv, loadEnv } from "@sul/shared";

/**
 * Screenshot storage. MinIO locally, S3/R2 in production — same code path, so
 * the presigned-URL behaviour the report depends on is exercised in dev.
 */

let client: S3Client | null = null;
let config: ReturnType<typeof loadEnv<typeof StorageEnv>> | null = null;

export function isStorageConfigured(): boolean {
  return Boolean(
    process.env.S3_ENDPOINT && process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID,
  );
}

function getClient(): { client: S3Client; bucket: string; ttl: number } {
  if (!client || !config) {
    config = loadEnv(StorageEnv);
    client = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      },
    });
  }
  return {
    client,
    bucket: config.S3_BUCKET,
    ttl: config.S3_PRESIGN_TTL_SECONDS,
  };
}

/** Idempotent; called once at worker boot so a missing bucket fails early. */
export async function ensureBucket(): Promise<void> {
  const { client: c, bucket } = getClient();
  try {
    await c.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await c.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

export async function uploadScreenshot(key: string, body: Buffer): Promise<string> {
  const { client: c, bucket } = getClient();
  await c.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "image/jpeg",
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
  return key;
}

export async function presignScreenshot(key: string): Promise<string> {
  const { client: c, bucket, ttl } = getClient();
  return getSignedUrl(c, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: ttl,
  });
}

export function screenshotKey(
  runId: string,
  personaKey: string,
  stepIndex: number,
): string {
  return `runs/${runId}/${personaKey}/${String(stepIndex).padStart(3, "0")}.jpg`;
}
