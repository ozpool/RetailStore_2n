# 11. Avatars in object storage, referenced by URL

- **Status:** Accepted
- **Recorded:** 2026-08-23

## Context

Users need profile pictures. There are three places the bytes could live: in a
Postgres column, on the application server's disk, or in dedicated object
storage.

Storing binary in the database is the tempting shortcut — one system, atomic
with the row, no second thing to configure. It is also the option every
production system moves away from, usually after it hurts:

- **Backups bloat.** A `pg_dump` grows by the size of every image ever
  uploaded, so restore time scales with avatars rather than with data.
- **Every read pays.** Binary flows through the connection pool, competing with
  queries for the resource Postgres is worst at scaling.
- **No CDN.** Images can't be edge-cached without an application round trip, so
  a 3KB avatar costs a database query on every page render.
- **Wrong access pattern.** Avatars are immutable, public, and read constantly.
  Object storage plus a CDN is built for exactly that; a relational database is
  built for the opposite.

## Decision

The image goes to object storage; the database stores only `User.avatarUrl`.

This reuses the storage seam already built for listing photos
([ADR 0010](0010-strip-image-metadata.md)) rather than introducing a second
mechanism: `lib/storage.ts` writes to local disk in development and is swapped
for S3/R2/Cloudinary by reimplementing two functions.

Processing differs from listing photos in ways that suit the use:

- **Cropped square, 512×512**, server-side. Avatars render in circles at ~36px;
  one canonical square asset means no surface has to guess how to fit a
  portrait into a circle.
- **5MB cap** rather than 8MB, and 10 uploads per user per hour.
- **Same safety properties**: magic-byte sniffing, a 50-megapixel decode cap,
  and a metadata-dropping re-encode to WebP that strips EXIF including GPS.

Two ordering rules matter:

- The **new URL is committed before the old file is deleted**, so a failed
  storage write never leaves someone with no picture at all.
- Replacing an avatar **deletes the previous object**, so storage doesn't
  accumulate orphans on every change.

`avatarUrl` is nullable, and null means fall back to generated initials — never
a generic silhouette, which reads as a broken image.

## Consequences

- Avatars are CDN-cacheable and cost the database a single short string.
- Keys are server-generated random hex, so a new upload is a new URL and caches
  never need busting.
- Deleting a user leaves their avatar object behind; storage cleanup is a
  separate concern from the row. Acceptable for now, and a lifecycle rule on the
  bucket is the standard answer.
- Local disk doesn't survive a container restart. This is exactly why the seam
  exists.
- Nothing prevents someone hotlinking a public avatar URL. Correct for a
  marketplace, where profile pictures are public by design.

## Alternatives considered

**`BYTEA` column in Postgres.** Atomic and simple, and the problems above are
well documented. Rejected.

**Application-server disk with no abstraction.** What the local driver does, but
hardcoding it means the eventual migration touches every call site instead of
one module.

**Gravatar or another external avatar service.** Free, no storage, no uploads to
handle — and it leaks a hash of the user's email to a third party on every page
render, and offers nothing to users who don't have an account there.

**Client-side cropping only.** Better UX for choosing the crop, and not a
substitute: anything enforced in the browser can be skipped by not using the
browser. A cropping UI could be added on top of the server-side guarantee.

**Presigned direct-to-bucket uploads.** The right pattern at scale — the file
never touches the application server. Rejected for now because it moves
validation to the edge: we would no longer see the bytes, so magic-byte checks
and EXIF stripping would have to become a post-upload job triggered by a storage
event. Worth revisiting when upload volume justifies the extra moving parts.
