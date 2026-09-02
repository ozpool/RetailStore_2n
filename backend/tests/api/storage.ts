import { requireServices } from "../lib/db";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";

/**
 * The storage seam, on both drivers.
 *
 * WHY THIS IS A LIBRARY SUITE
 * The property that matters is not "does an upload return 200" — it did that
 * while every image on the page was broken, which is the failure this phase
 * exists to fix. It is whether the bytes land somewhere a BROWSER can fetch
 * them from, which is a different address from the one the server writes to.
 *
 * The disk sections always run. The object-storage sections need MinIO:
 *
 *   docker compose up -d minio && docker compose up minio-init
 *   STORAGE_DRIVER=s3 S3_ENDPOINT=http://localhost:9000 \
 *     S3_ACCESS_KEY=retailstore-2n S3_SECRET_KEY=retailstore-2n-dev-secret \
 *     npm test -- storage
 *
 * See docs/adr/0022-object-storage-for-uploads.md
 */

wireInterrupt();

/** Written by the sections below, removed by the teardown either way. */
const written: string[] = [];
let driverForCleanup = "disk";

async function cleanup() {
  const before = process.env.STORAGE_DRIVER;
  process.env.STORAGE_DRIVER = driverForCleanup;
  const { removeFile, disconnectStorage } = await import("../../src/lib/storage");
  for (const key of written) await removeFile(key);
  // The SDK keeps sockets alive for reuse, which stops this process exiting —
  // on Windows it aborts in libuv, so the suite reported FAIL with every
  // assertion green.
  disconnectStorage();
  if (before === undefined) delete process.env.STORAGE_DRIVER;
  else process.env.STORAGE_DRIVER = before;
}

cleanupOnInterrupt(cleanup);

/** A one-pixel PNG. Real bytes, so content-type and length mean something. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000a49444154789c6300010000050001" +
    "0d0a2db40000000049454e44ae426082",
  "hex"
);

async function withDriver<T>(driver: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env.STORAGE_DRIVER;
  process.env.STORAGE_DRIVER = driver;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = before;
  }
}

void main(
  "storage seam",
  async (t) => {
    await requireServices({ api: false, web: false, db: false });

    const storage = await import("../../src/lib/storage");
    const { newKey, keyFromUrl, publicUrl, putFile, storageDriver } = storage;

    /* ============================================================ *
     * 1. Keys, shared by both drivers.
     * ============================================================ */
    t.section("1 - keys are server-generated and driver-independent");

    const key = newKey("png");
    t.check(/^[a-f0-9]{32}\.png$/.test(key), "128 bits of randomness plus an extension", key);

    t.check(
      keyFromUrl(publicUrl(key)) === key,
      "a key survives a round trip through its public URL"
    );

    /**
     * THE SAME KEY MUST RESOLVE ON EITHER DRIVER.
     *
     * URLs are stored in the database. If changing driver changed how a key is
     * derived from a URL, every existing row would become unresolvable — the
     * migration would silently orphan every photo ever uploaded.
     */
    const diskUrl = await withDriver("disk", async () => publicUrl(key));
    const s3Url = await withDriver("s3", async () => publicUrl(key));
    t.check(diskUrl !== s3Url, "the two drivers serve different URLs", `${diskUrl} vs ${s3Url}`);
    t.check(
      keyFromUrl(diskUrl) === key && keyFromUrl(s3Url) === key,
      "yet both resolve back to the same key — a driver change cannot orphan stored rows"
    );

    t.check(keyFromUrl("https://images.unsplash.com/photo-1465385076216") === null,
      "a URL that is not ours returns null rather than a plausible-looking key");

    /* ---- malformed keys are refused, not sanitised ---- */
    let refused = false;
    try {
      await putFile("../../etc/passwd", PNG);
    } catch {
      refused = true;
    }
    t.check(refused, "a traversal-shaped key is REFUSED, not cleaned up and written");

    /* ============================================================ *
     * 2. Local disk.
     * ============================================================ */
    t.section("2 - local disk");

    await withDriver("disk", async () => {
      driverForCleanup = "disk";
      const k = newKey("png");
      const url = await putFile(k, PNG);
      written.push(k);

      t.check(url.endsWith(`/uploads/${k}`), "the URL is served by the API itself", url);

      const fs = await import("fs/promises");
      const path = await import("path");
      const stat = await fs.stat(path.join(storage.UPLOAD_DIR, k));
      t.check(stat.size === PNG.length, "the bytes are on disk, unmodified", stat.size);
    });

    /* ============================================================ *
     * 3. Object storage.
     * ============================================================ */
    const endpoint = process.env.S3_ENDPOINT?.trim();

    if (!endpoint) {
      t.section("3 - object storage");
      t.note("S3_ENDPOINT is not set — the object-storage sections are skipped.");
      t.note("Start it with: docker compose up -d minio && docker compose up minio-init");
      return;
    }

    t.section("3 - object storage, and the address the browser uses");

    await withDriver("s3", async () => {
      driverForCleanup = "s3";
      t.check(storageDriver() === "s3", "the s3 driver is selected");

      const summary = await storage.assertStorage();
      t.check(summary.startsWith("s3 ("), "the bucket exists and the credentials work", summary);

      const k = newKey("png");
      const url = await putFile(k, PNG);
      written.push(k);

      /**
       * THE ASSERTION THIS SUITE EXISTS FOR.
       *
       * The server writes to `http://minio:9000`, a hostname that exists only
       * on the container network. The URL stored in the database has to be the
       * one a BROWSER can resolve. Getting this wrong is not a crash: the
       * upload succeeds, the row looks fine, and the page shows a broken image
       * — which is precisely the bug that was live under Compose before this.
       */
      t.check(
        !url.includes("minio:9000"),
        "the stored URL is NOT the container-network address",
        url
      );

      /* ---- and it is genuinely fetchable, unauthenticated ---- */
      const res = await fetch(url);
      t.check(res.status === 200, "an anonymous GET of that URL succeeds", res.status);
      t.check(
        res.headers.get("content-type") === "image/png",
        "with the right content type — derived from the key, not guessed by the browser",
        res.headers.get("content-type")
      );
      t.check(
        (res.headers.get("cache-control") ?? "").includes("immutable"),
        "and an immutable cache header, since keys are never reused",
        res.headers.get("cache-control")
      );

      const body = Buffer.from(await res.arrayBuffer());
      t.check(body.equals(PNG), "the bytes come back byte-for-byte", `${body.length}b`);
    });

    /* ---- the bucket must not be listable ---- */
    t.section("4 - anonymous read does not mean anonymous everything");

    const bucket = process.env.S3_BUCKET ?? "retailstore-2n-uploads";

    const listing = await fetch(`${endpoint}/${bucket}/`);
    t.check(
      listing.status === 403,
      "listing the bucket anonymously is forbidden — objects are readable, the index is not",
      listing.status
    );

    const forged = newKey("png");
    const write = await fetch(`${endpoint}/${bucket}/${forged}`, { method: "PUT", body: PNG });
    t.check(
      write.status === 403,
      "and an anonymous PUT is refused — writes still need the credentials",
      write.status
    );

    /* ---- deletion actually deletes ---- */
    t.section("5 - removal");

    await withDriver("s3", async () => {
      const k = newKey("png");
      const url = await putFile(k, PNG);
      t.check((await fetch(url)).status === 200, "written");

      await storage.removeFile(k);
      const gone = await fetch(url);
      t.check(gone.status === 404, "and removed from the bucket, not just from the row", gone.status);

      // Best-effort by contract: a second delete must not throw.
      await storage.removeFile(k);
      t.check(true, "deleting something already gone is a no-op, not an error");
    });
  },
  async () => {
    await cleanup();
  }
);
