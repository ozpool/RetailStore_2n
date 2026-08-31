# 10. Re-encode uploads to strip EXIF

- **Status:** Accepted
- **Recorded:** 2026-08-22

## Context

Sellers photograph items where the items are: their living rooms, kitchens,
garages. Phone cameras write EXIF metadata into those photos, and EXIF routinely
includes **GPS coordinates**, along with camera serial numbers and timestamps.

Serving an uploaded file back unmodified publishes all of it. A buyer — or
anyone scraping the site — could read a seller's home coordinates out of a photo
of a chair. Neither party would know it happened.

Separately, accepting user-supplied files raises the usual questions: is this
actually an image, how large can it be, and what stops a 200 KB file from
decoding to gigapixels.

## Decision

Uploads are never stored as received. Every file is validated and re-encoded.

**1. Magic-byte sniffing.** The file header is inspected to confirm JPEG, PNG,
or WebP. Filename extensions and the client's `Content-Type` are both
attacker-controlled and prove nothing — a shell script named `photo.jpg` is
rejected on its bytes.

**2. Re-encode through Sharp.**

```ts
sharp(buf, { limitInputPixels: 50_000_000 })
  .rotate()                                   // bake orientation in first
  .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
  .webp({ quality: 82 })
```

Sharp does not copy metadata unless explicitly asked, so encoding to a fresh
WebP drops EXIF — including GPS — as a property of the pipeline rather than as a
field-by-field scrub that could miss a tag.

`.rotate()` runs **before** the metadata disappears. EXIF carries an orientation
flag; discarding it without applying it first turns portrait photos sideways.

**3. Bounds.** 8 MB per file, 8 images per listing, 2000 px longest edge, a
50-megapixel decode cap against decompression bombs, and 30 uploads per user per
hour.

**4. Server-generated keys.** 16 random bytes as hex plus an extension,
validated against `/^[a-f0-9]{32}\.[a-z0-9]{2,5}$/` before any filesystem
operation. User input never reaches a path, so traversal is impossible by
construction rather than by sanitising.

## Consequences

- No upload can leak location data, because none is stored.
- Output format is uniform, so no branching on format downstream.
- WebP at 2000 px is smaller than typical phone JPEGs, cutting storage and
  transfer.
- Original files are gone. A seller cannot retrieve their full-resolution
  upload. Acceptable for listing photos; the alternative is retaining exactly
  what this decision exists to discard.
- CPU cost per upload, bounded by the rate limit and the pixel cap.
- Verified by test: a JPEG carrying 230 bytes of EXIF including a GPS block was
  uploaded, and the stored file read back with no EXIF — checked both directly
  against the API and end-to-end through the browser.

## Alternatives considered

**Store the original, strip on serve.** Keeps the source, but every read path
must remember to strip. One that forgets leaks, and the sensitive data is still
sitting at rest.

**`sharp().withMetadata()` minus GPS tags.** Preserves useful metadata like
colour profiles, and requires enumerating every sensitive tag correctly. An
allowlist that omits nothing is harder to get right than dropping everything.

**Validate `Content-Type` only.** One line, and trivially bypassed — the header
is whatever the client says it is.

**Client-side stripping before upload.** Saves server CPU, and is not a control:
anything enforced only in the browser can be skipped by not using the browser.
