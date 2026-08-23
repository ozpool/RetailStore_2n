import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

/**
 * Where uploaded images live.
 *
 * Two drivers behind one interface — `put`, `remove`, and a public URL — chosen
 * by `STORAGE_DRIVER`. Everything above this module knows only those three
 * things, which is what [ADR 0011] promised when it said the seam would be
 * "swapped for S3/R2/Cloudinary by reimplementing two functions".
 *
 * WHY THIS STOPPED BEING OPTIONAL
 * Local disk is not merely a development shortcut. It is the last thing
 * preventing a second API replica: two containers with separate disks serve
 * different sets of photos, so a browser gets an image or a 404 depending on
 * which replica answered. Rate limits and the cache moved to Redis
 * (ADR 0018, ADR 0019) and the refresh race moved to Postgres (ADR 0021); this
 * was what remained.
 *
 * It also breaks the Compose stack outright: the browser loads photos from
 * `localhost:4000`, which the host can reach and the web container cannot, so
 * every seller photo 404s in a page the frontend renders perfectly.
 *
 * See docs/adr/0022-object-storage-for-uploads.md
 */

export type StorageDriver = "disk" | "s3";

export function storageDriver(): StorageDriver {
  return (process.env.STORAGE_DRIVER ?? "disk").trim().toLowerCase() === "s3" ? "s3" : "disk";
}

/* ------------------------------------------------------------------ *
 * Keys
 *
 * Shared by both drivers, deliberately: a key written by one has to be
 * readable by the other, so a deployment can change driver without every
 * existing URL in the database becoming unresolvable.
 * ------------------------------------------------------------------ */

/** Keys are server-generated, so a key that doesn't match is never ours. */
const KEY_PATTERN = /^[a-f0-9]{32}\.[a-z0-9]{2,5}$/;

export function newKey(ext: string): string {
  return `${crypto.randomBytes(16).toString("hex")}.${ext}`;
}

/** Recovers the storage key from a stored public URL, or null if not ours. */
export function keyFromUrl(url: string): string | null {
  const last = url.split("?")[0].split("/").pop();
  return last && KEY_PATTERN.test(last) ? last : null;
}

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
};

function contentTypeFor(key: string): string {
  return CONTENT_TYPES[key.split(".").pop() ?? ""] ?? "application/octet-stream";
}

/**
 * Immutable forever, because keys are random and never reused.
 *
 * A replaced avatar is a new key and a new URL, so nothing has to be purged
 * from a cache or a CDN — the old object is deleted and the old URL simply
 * stops being referenced.
 */
const CACHE_CONTROL = "public, max-age=31536000, immutable";

/* ------------------------------------------------------------------ *
 * Local disk
 * ------------------------------------------------------------------ */

export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(process.cwd(), "uploads");

const DISK_PUBLIC_BASE =
  process.env.PUBLIC_UPLOAD_BASE ?? `http://localhost:${process.env.PORT ?? 4000}/uploads`;

async function diskPut(key: string, data: Buffer): Promise<void> {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, key), data);
}

async function diskRemove(key: string): Promise<void> {
  await fs.rm(path.join(UPLOAD_DIR, key), { force: true });
}

/* ------------------------------------------------------------------ *
 * S3-compatible object storage
 *
 * MinIO locally, and unchanged against S3, R2, or Spaces — the only
 * differences are the endpoint and whether path-style addressing is needed.
 * ------------------------------------------------------------------ */

const BUCKET = process.env.S3_BUCKET ?? "retailstore-2n-uploads";

/**
 * Where the BROWSER fetches objects from, which is not where the server writes
 * them.
 *
 * Inside Compose the server reaches MinIO at `http://minio:9000` — a hostname
 * that exists only on the container network and means nothing to a browser.
 * Getting this wrong produces the exact bug this phase is fixing, one layer
 * further along: the upload succeeds, the row stores a URL nobody outside
 * Docker can resolve, and the page shows a broken image.
 */
const S3_PUBLIC_BASE = process.env.S3_PUBLIC_BASE ?? `http://localhost:9000/${BUCKET}`;

type S3Module = typeof import("@aws-sdk/client-s3");
let s3Client: InstanceType<S3Module["S3Client"]> | null = null;
let s3Module: S3Module | null = null;

/**
 * Loaded on first use, not at import time.
 *
 * The disk driver is the default and the one the test suite uses, so a
 * top-level import would make every process pay for the AWS SDK — including
 * twenty-three test suites that never touch object storage.
 */
async function s3(): Promise<{ client: InstanceType<S3Module["S3Client"]>; mod: S3Module }> {
  if (!s3Module) s3Module = await import("@aws-sdk/client-s3");
  if (!s3Client) {
    const endpoint = process.env.S3_ENDPOINT;
    if (!endpoint) throw new Error("STORAGE_DRIVER is s3 but S3_ENDPOINT is not set");

    s3Client = new s3Module.S3Client({
      endpoint,
      region: process.env.S3_REGION ?? "us-east-1",
      // MinIO serves buckets as a path (`host/bucket/key`), not a subdomain.
      // Virtual-host style would resolve `bucket.minio` and fail; real S3
      // accepts path style too, so this is the portable choice.
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY ?? "",
        secretAccessKey: process.env.S3_SECRET_KEY ?? "",
      },
    });
  }
  return { client: s3Client, mod: s3Module };
}

async function s3Put(key: string, data: Buffer): Promise<void> {
  const { client, mod } = await s3();
  await client.send(
    new mod.PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: data,
      ContentType: contentTypeFor(key),
      CacheControl: CACHE_CONTROL,
    })
  );
}

async function s3Remove(key: string): Promise<void> {
  const { client, mod } = await s3();
  await client.send(new mod.DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

/* ------------------------------------------------------------------ *
 * The interface everything above this module uses
 * ------------------------------------------------------------------ */

export function publicUrl(key: string): string {
  const base = storageDriver() === "s3" ? S3_PUBLIC_BASE : DISK_PUBLIC_BASE;
  return `${base}/${key}`;
}

export async function putFile(key: string, data: Buffer): Promise<string> {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(`Refusing to write malformed storage key: ${key}`);
  }

  if (storageDriver() === "s3") await s3Put(key, data);
  else await diskPut(key, data);

  return publicUrl(key);
}

/**
 * Best-effort delete. A missing file is not an error — the DB row is the source
 * of truth, and a leftover orphan is harmless compared to failing the request.
 */
export async function removeFile(key: string): Promise<void> {
  if (!KEY_PATTERN.test(key)) return;

  try {
    if (storageDriver() === "s3") await s3Remove(key);
    else await diskRemove(key);
  } catch (err) {
    // Logged rather than thrown, and louder for s3 than disk: a failed delete
    // against object storage costs money every month until somebody notices.
    console.error(`[storage] could not delete ${key}: ${(err as Error).message}`);
  }
}

/**
 * Closes the S3 client so a process can exit.
 *
 * The SDK keeps HTTP connections alive for reuse, which is right for a server
 * and fatal for a short-lived script: the handles outlive the work, and on
 * Windows the process aborts in libuv rather than exiting — `Assertion failed:
 * !(handle->flags & UV_HANDLE_CLOSING)`. Every assertion in the storage suite
 * passed and the suite still reported FAIL, on an exit code alone.
 *
 * Mirrors disconnectRateLimitStore. Safe to call when the driver is disk, or
 * when nothing ever connected.
 */
export function disconnectStorage(): void {
  s3Client?.destroy();
  s3Client = null;
}

/**
 * Checked at startup so the banner can say where uploads go — and so a
 * misconfigured bucket is a clear line at boot rather than a broken image
 * discovered by a seller.
 */
export async function assertStorage(): Promise<string> {
  if (storageDriver() === "disk") {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    return `local disk (${UPLOAD_DIR}) — not shared between replicas`;
  }

  const { client, mod } = await s3();
  // HeadBucket fails distinctly for "no such bucket" and "bad credentials",
  // which are the two ways this is misconfigured.
  await client.send(new mod.HeadBucketCommand({ Bucket: BUCKET }));
  return `s3 (${process.env.S3_ENDPOINT}/${BUCKET}) — shared, browser reads ${S3_PUBLIC_BASE}`;
}
