import sharp from "sharp";
import { WEB, prisma, requireServices } from "../lib/db";
import { Scope } from "../lib/fixtures";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";

/**
 * Seller photo upload, end to end.
 *
 * WHY THIS SUITE EXISTS
 * Nothing covered it. Every listing in every other suite is created directly
 * through Prisma with an Unsplash URL, so the actual upload route — multipart
 * parsing, magic-byte sniffing, the Sharp re-encode, the write to storage, and
 * the URL that ends up on the row — had no end-to-end coverage at all.
 *
 * Two documented promises rested on untested code:
 *
 *   ADR 0010 — uploads are re-encoded so EXIF, including GPS, cannot survive.
 *              Sellers photograph items inside their own homes; publishing the
 *              coordinates would leak a home address.
 *   ADR 0022 — the URL stored on the row is one a BROWSER can resolve, which is
 *              not the address the server wrote to.
 *
 * THROUGH THE BFF, NOT THE API DIRECTLY.
 * That hop is where this has broken before: the proxy once read request bodies
 * as text, which corrupts every multipart upload while leaving JSON requests
 * perfectly fine. A suite that posted straight to Express would not have caught
 * it, and there is a comment in tests/api/checkout-bff.ts saying so.
 *
 * DRIVER-AGNOSTIC. Runs against local disk or object storage — the assertions
 * are about what the row says and whether that URL serves the right bytes,
 * which is the same question either way.
 */

const scope = new Scope("uploads");
wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

/**
 * A JPEG carrying EXIF that must not survive.
 *
 * The marker goes in a text field rather than relying on Sharp's GPS writer,
 * because the assertion is then format-independent and absolute: this exact
 * string is either present in the stored bytes or it is not. A "no EXIF block"
 * check alone would pass against a re-encoder that dropped the block and kept
 * the comment.
 */
const EXIF_MARKER = "GPS 51.5074,-0.1278 HOME ADDRESS MUST NOT SURVIVE";

async function jpegWithExif(width = 1200, height = 800): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#8a5a2b" } })
    .withExif({ IFD0: { Copyright: EXIF_MARKER, Artist: "camera" } })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** POSTs one file to the seller photo endpoint, through the BFF. */
async function uploadPhoto(
  cookie: string,
  listingId: string,
  bytes: Buffer,
  opts: { filename?: string; contentType?: string } = {}
) {
  const form = new FormData();
  form.append(
    "image",
    new Blob([new Uint8Array(bytes)], { type: opts.contentType ?? "image/jpeg" }),
    opts.filename ?? "photo.jpg"
  );

  // No content-type header set by hand: fetch generates the multipart boundary,
  // and a hand-written header without a matching boundary is unparseable.
  const res = await fetch(`${WEB}/api/seller/listings/${listingId}/images`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });

  const text = await res.text();
  let json: Record<string, never> | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

function sniff(buf: Buffer): string {
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  return "unknown";
}

void main(
  "seller photo upload",
  async (t) => {
    await requireServices({ api: true, web: true, db: true });

    const { seller, listing } = await scope.ownListing("owner");
    const cookie = seller.header();

    /* ============================================================ *
     * 1. It works at all, through the proxy.
     * ============================================================ */
    t.section("1 - a real photo, posted through the BFF");

    const original = await jpegWithExif();
    t.check(sniff(original) === "jpeg", "the fixture is a JPEG", `${original.length}b`);

    // If the fixture had no EXIF, section 2 would pass against a no-op.
    const originalMeta = await sharp(original).metadata();
    t.check(!!originalMeta.exif, "carrying an EXIF block", `${originalMeta.exif?.length ?? 0}b`);
    t.check(
      original.includes(Buffer.from(EXIF_MARKER, "latin1")),
      "and the marker is genuinely in the uploaded bytes"
    );

    const up = await uploadPhoto(cookie, listing.id, original);
    t.check(up.status === 201, "the upload succeeded", `${up.status} ${up.text.slice(0, 120)}`);

    const image = (up.json as { image?: { id: string; url: string; position: number } })?.image;
    t.check(!!image?.url, "and returned an image record with a URL", image?.url);

    /* ---- the row is what the browser will use ---- */
    const stored = await prisma.listingImage.findUniqueOrThrow({
      where: { id: image!.id },
      select: { url: true, listingId: true },
    });
    t.check(stored.listingId === listing.id, "attached to the right listing");
    t.check(
      !stored.url.includes("minio:9000") && !stored.url.includes("//api:"),
      "the stored URL is not a container-network address — ADR 0022",
      stored.url
    );

    /* ============================================================ *
     * 2. THE PROMISE IN ADR 0010.
     *
     * A seller's camera puts GPS in EXIF. Publishing it leaks where they
     * live. The re-encode is the only thing preventing that, and until now
     * nothing checked it through the real route.
     * ============================================================ */
    t.section("2 - EXIF cannot survive the round trip");

    const fetched = await fetch(stored.url);
    t.check(fetched.status === 200, "the stored URL serves the photo", fetched.status);

    const servedBuf = Buffer.from(await fetched.arrayBuffer());
    t.check(sniff(servedBuf) === "webp", "re-encoded to WebP, whatever went in", sniff(servedBuf));

    const servedMeta = await sharp(servedBuf).metadata();
    t.check(!servedMeta.exif, "the served image has NO EXIF block", `${servedMeta.exif?.length ?? 0}b`);

    t.check(
      !servedBuf.includes(Buffer.from(EXIF_MARKER, "latin1")),
      "and the marker is nowhere in the bytes — not merely out of the EXIF block"
    );

    t.check(
      !servedBuf.equals(original),
      "the file was re-encoded, not stored as received",
      `${original.length}b in, ${servedBuf.length}b out`
    );

    /* ============================================================ *
     * 3. Oversized dimensions are capped.
     * ============================================================ */
    t.section("3 - a huge photo is resized rather than refused");

    const huge = await jpegWithExif(4000, 3000);
    const hugeUp = await uploadPhoto(cookie, listing.id, huge);
    t.check(hugeUp.status === 201, "a 4000x3000 photo is accepted", hugeUp.status);

    const hugeUrl = (hugeUp.json as { image?: { url: string } })?.image?.url;
    const hugeMeta = await sharp(Buffer.from(await (await fetch(hugeUrl!)).arrayBuffer())).metadata();
    t.check(
      hugeMeta.width === 2000 && hugeMeta.height === 1500,
      "and comes back capped at 2000px on the long edge, aspect preserved",
      `${hugeMeta.width}x${hugeMeta.height}`
    );

    /* ============================================================ *
     * 4. What the bytes say beats what the request claims.
     *
     * The filename and the client's content-type are both attacker-supplied
     * and neither proves anything about the payload.
     * ============================================================ */
    t.section("4 - the content type is sniffed, not believed");

    const liar = await uploadPhoto(
      cookie,
      listing.id,
      Buffer.from("<?php system($_GET['c']); ?>", "utf8"),
      { filename: "innocent.png", contentType: "image/png" }
    );
    t.check(
      liar.status === 400,
      "a text payload claiming to be a PNG is refused",
      `${liar.status} ${liar.text.slice(0, 90)}`
    );

    const empty = await uploadPhoto(cookie, listing.id, Buffer.alloc(0));
    t.check(empty.status === 400, "and so is an empty file", empty.status);

    /* ============================================================ *
     * 5. Somebody else's listing.
     * ============================================================ */
    t.section("5 - a seller cannot add photos to another seller's listing");

    const intruder = await scope.seller("intruder");
    const theft = await uploadPhoto(intruder.header(), listing.id, await jpegWithExif(200, 200));
    t.check(
      theft.status === 404,
      "refused as NOT FOUND, which does not confirm the listing exists",
      theft.status
    );

    const untouched = await prisma.listingImage.count({ where: { listingId: listing.id } });
    t.check(untouched === 3, "and nothing was added", untouched);

    /* ============================================================ *
     * 6. The per-listing ceiling.
     *
     * Its own seller: the upload limit is 30 per hour per user, and this
     * section alone spends six.
     * ============================================================ */
    t.section("6 - a listing holds at most eight photos");

    const { seller: filler, listing: fillable } = await scope.ownListing("filler");
    const fillCookie = filler.header();

    // ownListing seeds one image, so seven more reach the ceiling.
    const small = await jpegWithExif(120, 90);
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      statuses.push((await uploadPhoto(fillCookie, fillable.id, small)).status);
    }

    t.check(
      statuses.slice(0, 7).every((s) => s === 201),
      "seven more are accepted, reaching eight",
      statuses.join(",")
    );
    t.check(statuses[7] === 400, "and the ninth is refused", statuses[7]);
    t.check(
      (await prisma.listingImage.count({ where: { listingId: fillable.id } })) === 8,
      "leaving exactly eight"
    );

    /* ============================================================ *
     * 7. Deletion reaches storage, not just the row.
     *
     * A delete that only removes the row leaves the object paid for and
     * publicly readable forever — and nothing in a response would show it.
     * ============================================================ */
    t.section("7 - deleting a photo removes the object too");

    const doomedUrl = stored.url;
    t.check((await fetch(doomedUrl)).status === 200, "the object is there to begin with");

    const del = await fetch(`${WEB}/api/seller/listings/${listing.id}/images/${image!.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    t.check(del.status === 204, "the photo is deleted", del.status);

    t.check(
      (await prisma.listingImage.count({ where: { id: image!.id } })) === 0,
      "the row is gone"
    );

    const afterDelete = await fetch(doomedUrl);
    t.check(
      afterDelete.status === 404 || afterDelete.status === 403,
      "and so is the stored object — not merely unreferenced",
      afterDelete.status
    );
  },
  async (t) => {
    await scope.cleanup();
    await scope.verifyClean(t);
  }
);
