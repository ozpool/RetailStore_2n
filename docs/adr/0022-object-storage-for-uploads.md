# 22. Object storage for uploads, and what it unblocks

- **Status:** Accepted
- **Recorded:** 2026-09-02
- **Fulfils:** the seam promised in [ADR 0010](0010-strip-image-metadata.md) and
  [ADR 0011](0011-avatars-in-object-storage.md)

## Context

`lib/storage.ts` has always written to local disk behind a three-function seam,
with both earlier records describing the swap as future work — ADR 0011 said it
would be "swapped for S3/R2/Cloudinary by reimplementing two functions".

Two things made it stop being future work.

**It was the last thing preventing a second replica.** Rate limits and the cache
moved to Redis ([ADR 0018](0018-redis-for-shared-ephemeral-state.md),
[ADR 0019](0019-cache-tiering-rule.md)); the refresh race moved to Postgres
([ADR 0021](0021-refresh-race-grace-window.md)). After those, every piece of
cross-instance state was either shared or made unnecessary except this one — and
two API containers with separate disks serve different sets of photos, so an
image loads or 404s depending on which replica answered. Every scaling claim the
demo scripts make was true of one tier and quietly false of the storage layer.

**And it was already broken under Compose.** The browser loaded photos from
`localhost:4000` — reachable from the host, not from inside the web container.
The README admitted it as a known limitation: the frontend rendered the page
perfectly and every seller photo 404'd.

## Decision

Two drivers behind the existing interface, chosen by `STORAGE_DRIVER`.

| Driver | Used by | Public URL |
| --- | --- | --- |
| `disk` | `npm run dev`, the test suite | the API's own `/uploads` route |
| `s3` | Compose, and anywhere real | the bucket, direct to the browser |

S3-compatible via `@aws-sdk/client-s3`, so the same code runs against MinIO
locally and S3, R2 or Spaces with only an endpoint change. `forcePathStyle`
because MinIO addresses buckets as a path; real S3 accepts that too, so it is
the portable setting rather than a MinIO concession.

### Keys are driver-independent, deliberately

URLs are stored in the database. If changing driver changed how a key is
recovered from a URL, every existing row would become unresolvable — the
migration would silently orphan every photo ever uploaded. So `newKey` and
`keyFromUrl` are shared, and the suite asserts that a key round-trips through
*both* drivers' URL formats.

### The server's address is not the browser's address

The single most important detail, and the one that produces a bug with no error
message. Inside Compose the API writes to `http://minio:9000` — a hostname that
exists only on the container network. The URL stored on the row has to be the
one a browser can resolve, `http://localhost:9000/<bucket>`.

Conflate them and the upload succeeds, the row looks correct, and the page shows
a broken image: the same failure this phase set out to fix, one layer further
along. `S3_ENDPOINT` and `S3_PUBLIC_BASE` are therefore separate variables, and
`tests/api/storage.ts` asserts the stored URL is not the container address.

### The static route is mounted only for the disk driver

Under object storage it would serve an empty directory — answering 404 for
images that exist, which reads as a broken upload rather than a misconfiguration.

### Anonymous GetObject, and not by the obvious means

The bucket grants unauthenticated `s3:GetObject` and nothing else. Public read
is right for the contents: listing photos and avatars on a public marketplace,
already visible to anyone who can load a product page. Serving them unsigned is
also what allows a CDN to cache them — presigned URLs would put an expiring
signature in every `<img>` tag, defeating caching and making a stored URL
something that stops working.

**The obvious one-liner was wrong.** `mc anonymous set download` — which is what
every tutorial reaches for — also grants `s3:ListBucket` to `*`:

```json
{"Action":["s3:GetBucketLocation","s3:ListBucket"],
 "Principal":{"AWS":["*"]},"Resource":["arn:aws:s3:::retailstore-2n-uploads"]}
```

That makes the bucket enumerable by anyone: every photo and every avatar any
user has uploaded, walkable from a browser. The argument for unsigned public
reads is that keys are 128 bits of randomness and therefore unguessable — and an
index hands that away for free. Replaced with an explicit GetObject-only policy.

It was caught by an assertion written on the assumption it would pass, and the
comments in two files claimed the opposite of what the policy did.

## Consequences

**Both API and frontend can now run more than one replica.** That completes the
horizontal-scaling story the three demo scripts were collectively claiming, and
it is the point at which Kubernetes becomes packaging rather than architecture.

**Seller photos work under Compose**, which they did not before. The README's
known limitation is gone rather than reworded.

**A new dependency, and it is not small.** `@aws-sdk/client-s3` pulls a
meaningful amount of code, so it is imported lazily rather than at module load:
the disk driver is the default and what the test suite uses, and twenty-four
suites should not pay for an SDK none of them touch.

**Uploads are no longer in a Docker volume.** The `retailstore-2n-uploads` volume is
gone; the bytes are in MinIO's volume instead. Anyone with local uploads they
care about should copy them into the bucket before deleting the old volume —
there is no migration script, because in this codebase the only such files are
test fixtures.

**Two more things to configure wrong.** The endpoint/public-base split is the
subtle one; a missing entry in `next.config.ts`'s `remotePatterns` is the other,
and it also renders as a broken image with the reason only in the server log.
Both hosts are listed there now, because both are reachable configurations.

**Object storage costs money per object, forever.** A failed delete is logged
loudly for that reason: on disk an orphan wastes a few kilobytes, in a bucket it
bills monthly until somebody notices.

## Alternatives considered

**Serve objects through the API rather than directly.** Keeps the bucket
private, and every image then costs an application round trip plus a stream
through Node — the exact access pattern ADR 0011 rejected for storing binary in
Postgres. It would also make the API a bandwidth bottleneck for a workload that
is entirely static assets.

**Presigned URLs.** Correct for private files, wrong for these. Every `<img>`
tag would carry an expiring signature, so nothing caches and a URL stored in the
database stops working. Worth having if this ever holds something private, in a
second bucket with its own policy.

**Keep the disk driver and use a shared volume (NFS, EFS).** Works, requires no
code change, and moves the problem: one shared filesystem, its own availability
story, and no CDN in front of it. Object storage is what the access pattern
actually wants — immutable, public, read constantly.

**A managed CDN-backed store from the start (Cloudinary, imgix).** Would also
have replaced the Sharp pipeline, which is deliberately ours because
[ADR 0010](0010-strip-image-metadata.md) is about re-encoding to strip metadata
rather than about resizing. Rejected to keep the processing decision separate
from the storage decision — which is what let this change touch one module.
