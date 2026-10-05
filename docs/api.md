# API Reference

Express API, default `http://localhost:4000`.

The browser does not call these directly. It calls the matching BFF path under
`/api/*` on the Next.js server, which forwards them
([ADR 0002](adr/0002-bff-proxy.md)). `POST /auth/login` in this document is
`POST /api/auth/login` from the browser.

---

## Conventions

**Auth.** Session state travels in two `httpOnly` cookies. Requests marked
🔒 need a valid access token; 🏪 additionally requires a seller profile;
👮 requires a *separate* short-lived admin session obtained by step-up, which
the ordinary login cookie does not grant — see [Admin](#admin--admin-).

**Errors.** Consistent JSON:

```json
{ "error": "Human-readable message.", "code": "MACHINE_CODE", "field": "priceCents" }
```

`field` appears when one input is at fault, so the UI can render the message
against that input. `code` is stable; `error` text is not.

| Status | Meaning here |
| --- | --- |
| 400 | Validation failed |
| 401 | No or expired session |
| 403 | Authenticated but not permitted (`NOT_A_SELLER`, `PAYOUTS_LOCKED`) |
| 404 | Not found — **also returned for records owned by someone else** |
| 409 | Conflict with current state (`ALREADY_VERIFIED`, `SESSION_CLOSED`, `IDEMPOTENCY_IN_PROGRESS`) |
| 422 | An `Idempotency-Key` reused for a different request (`IDEMPOTENCY_KEY_REUSED`) |
| 429 | Rate limited; includes `retryAfterSeconds` |
| 500 | Server error; details are logged, not returned |

**Money** is integer minor units (`priceCents`) in bodies. The one exception is
`/catalog/listings`, whose `minPrice`/`maxPrice` are whole currency units
because that is what a price filter collects.

**Idempotency.** Endpoints marked 🔁 accept an optional `Idempotency-Key`
header — any 1–255 printable characters with no spaces; a UUID is ideal. The
first request with a key runs; a retry with the same key gets the first
request's status and body back with `Idempotent-Replayed: true`, instead of
running again. Keys are scoped to the signed-in user and honoured for 24 hours.
→ [ADR 0035](adr/0035-idempotency-keys-at-the-api-boundary.md)

| Situation | Answer |
| --- | --- |
| Same key, same request, finished | The stored answer, replayed — including a 4xx |
| Same key, same request, still running | `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After` |
| Same key, different method, path or body | `422 IDEMPOTENCY_KEY_REUSED` |
| Malformed key | `400 INVALID_IDEMPOTENCY_KEY` |
| First request failed with a 5xx or a 429 | Not stored — retry with the same key |

Without the header nothing changes. The BFF does not forward it yet, so today
it is for direct API clients.

---

## Health

### `GET /health`

```json
{ "status": "ok", "service": "retailstore-2n-backend" }
```

### `GET /health/lag`

Is anyone actually *receiving* notifications. Separate from `/health` because it
talks to a broker over the network, and a load balancer's liveness probe must
not depend on that.

**503 when unhealthy**, so a monitor does not have to parse a body to know.

```json
{
  "transport": "kafka",
  "healthy": true,
  "groups": [
    { "group": "email-worker", "lag": 0, "byTopic": {}, "uncommitted": 0 },
    { "group": "sms-worker", "lag": 140, "byTopic": { "retailstore-2n.notifications.v1": 140 }, "uncommitted": 30 }
  ],
  "dlqDepth": 0,
  "thresholds": { "lag": 5000, "dlq": 100 }
}
```

Lag covers **every rung of the retry ladder**, not just the main topic: a group
stalled on `retry.15m` is a real failure that main-topic lag reports as zero.

`uncommitted` is partitions the group has never committed. Their whole retained
backlog is counted in `lag` — because that is what the group still owes — but
the count is separate so "never started" stays distinguishable from "fallen
behind", which matters for the few seconds after a deploy.

On the inline transport it answers `{ "transport": "inline", "healthy": true,
"detail": … }`. **It does not alert.** There is no alerting stack here, and the
thresholds are returned so that whatever does alert need not encode them.

---

## Auth — `/auth`

### `POST /auth/signup`

```json
{ "name": "Ada Lovelace", "email": "ada@example.com", "password": "at least 12 chars" }
```

Password must be ≥ 12 characters and is checked against Pwned Passwords
([ADR 0004](adr/0004-password-policy.md)).

> **Email verification is currently switched off.** The account is created
> already verified and signed in: `201` → `{ "user": { ... } }`, sets both
> cookies, and no verification email is sent. The original code is commented
> out in `backend/src/routes/auth.ts`. The rest of this section describes the
> behaviour with verification on.

With verification on, no session is created — the account must be verified
first, and `201` → `{ "message": "...", "email": "ada@example.com" }`.

| Failure | Code | `field` |
| --- | --- | --- |
| Password too short | `INVALID_INPUT` | `password` |
| Password found in breach corpora | `PASSWORD_BREACHED` | `password` |
| Email already registered **and verified** | `EMAIL_IN_USE` | `email` |

Signing up again on an *unverified* email is not an error: it re-sends the link
and updates the stored password hash.

> Delivery is controlled by `MAIL_TRANSPORT` (nodemailer):
> `console` (default) prints the link to the backend terminal and sends nothing;
> `ethereal` really sends to a throwaway inbox and logs a URL where the rendered
> message can be read; `smtp` uses a real server and the process refuses to
> start unless `SMTP_HOST`, `SMTP_USER`, and `SMTP_PASS` are all set.
>
> A send failure does **not** fail the signup — the account and token are already
> committed, so a transient SMTP error would otherwise 500 an account that
> exists. It is logged loudly instead, and the recovery path is
> `POST /auth/resend-verification`.

### `POST /auth/verify-email`

```json
{ "token": "<from the emailed link>" }
```

Single-use, 24-hour expiry. `200` → `{ "user": { ... } }` and a session is
established.

### `POST /auth/resend-verification`

```json
{ "email": "ada@example.com" }
```

Always `200` — it does not reveal whether the address is registered.

### `POST /auth/login`

```json
{ "email": "ada@example.com", "password": "..." }
```

`200` → `{ "user": { ... } }`, sets both cookies.

| Status | Failure | Code |
| --- | --- | --- |
| 401 | Wrong email or password | `INVALID_CREDENTIALS` |
| 403 | Account suspended | `ACCOUNT_SUSPENDED` |
| 403 | Email not verified (only while verification is on) | `EMAIL_NOT_VERIFIED` |
| 429 | Too many attempts for this address | `RATE_LIMITED` |

With verification on, login is hard-blocked until verified — no partial session.
While it is switched off, an unverified account can log in.

**Rate limited to 10 attempts per 15 minutes per address**, and the counter is
cleared the moment a correct password is given, so ordinary mistyping never
accumulates. The 429 carries `retryAfterSeconds`.

The counter is keyed on the submitted address rather than on a user row, so an
address with no account throttles identically — a 429 says nothing about whether
the account exists. Same reason the 401 uses one message for a wrong address and
a wrong password.

There is deliberately **no per-IP limit** on this endpoint, unlike
`/auth/password/forgot`. See [SECURITY.md](../SECURITY.md#known-gaps) for why,
and for the denial-of-service the per-address limit knowingly accepts.

### `POST /auth/refresh`

Rotates the refresh token and issues a new access token. `204` with new
cookies.

Presenting an already-rotated token revokes the entire token family: reuse
means the credential leaked. → [ADR 0001](adr/0001-access-and-refresh-tokens.md)

**With one exception, for the ten seconds after rotation.** Access tokens expire
in batches, so several requests routinely retry with the same refresh cookie —
the only one the browser has. A token superseded that recently gets a new access
token and **no new refresh cookie**, leaving the one the winning request already
set. Rotation itself is an atomic claim, so exactly one of N concurrent requests
rotates however many arrive together.

Tokens revoked by logout or a password change are never graced, and outside the
window a replay still revokes everything.
→ [ADR 0021](adr/0021-refresh-race-grace-window.md)

### `POST /auth/password/change` 🔒

```json
{ "currentPassword": "...", "newPassword": "at least 12 chars" }
```

The current password is required **even though the caller is authenticated**.
A stolen session must not be enough to take the account permanently.

Revokes every **other** refresh token — the calling tab stays signed in, because
signing you out for good security hygiene is hostile. Outstanding reset links
are burned too, so a compromise-driven change does not leave a working link in
an inbox somebody else may be reading.

`200` → `{ "ok": true, "otherSessionsEnded": 2, "message": "..." }`

| Failure | Code | `field` |
| --- | --- | --- |
| Current password wrong | `WRONG_PASSWORD` (401) | `currentPassword` |
| Under 12 characters | `INVALID_INPUT` | `newPassword` |
| Same as the current one | `SAME_PASSWORD` | `newPassword` |
| Found in breach corpora | `PASSWORD_BREACHED` | `newPassword` |

Rate limited to 10 per 15 minutes — the current-password check is a password
oracle for anyone holding a stolen session and guessing.

### `POST /auth/password/forgot`

```json
{ "email": "ada@example.com" }
```

**Always `200`, with an identical body**, whether the address is registered,
unregistered, or malformed — and identical again when rate limited. Anything
else makes this an account-enumeration oracle, and the list it produces is
exactly what a credential-stuffing run wants.

Rate limited **per address** (3/hour, so the endpoint cannot be used to flood
somebody's inbox) **and per caller** (20/hour, so one caller cannot do that to a
long list of addresses). Neither limit changes the response.

Asking again invalidates any previous unused link: two live links means the
older one — the more likely to have leaked — still works.

### `POST /auth/password/reset`

```json
{ "token": "<from the emailed link>", "newPassword": "at least 12 chars" }
```

Single-use, **one hour**. A verification link only proves an inbox exists; a
reset link *is* the account until it is used, which is why it does not get the
24 hours verification does. Only the hash is stored.

Unknown, expired and already-used tokens all return the **same**
`INVALID_TOKEN` message. Saying "expired" would confirm the token was real.

Rate limited to 100/hour per caller — a courtesy cap rather than a guessing
control. The token is 256 bits, so the endpoint cannot be brute forced at any
limit, and an invalid one costs a hash plus an indexed lookup and returns before
any bcrypt or breach-list call. A tighter cap would mostly punish shared egress
addresses.

Revokes **every** session — there is none to preserve, and if the account was
taken over then the intruder's is among them. Also sets `emailVerified`:
redeeming the link proves inbox control, which is what verification asks, so an
unverified account is not left locked out for a reason it has already satisfied.

**No session is issued.** The response sends you to sign in with the password
you just chose. Doing otherwise would make a reset link a one-click login, and
links leak — forwarded mail, shared screens, scanners that follow URLs.

> A reset deliberately does **not** clear an admin's TOTP enrolment. Mail access
> must not strip a second factor, since the inbox is precisely where the reset
> link lands.

### `POST /auth/logout`

Revokes the refresh token and clears cookies. `204`.

### `GET /auth/me` 🔒

```json
{ "user": { "id": "…", "name": "Ada Lovelace", "email": "ada@example.com",
            "isSeller": false, "emailVerified": true, "createdAt": "…" } }
```

### `POST /auth/become-seller` 🔒

Sets `isSeller` and creates the `SellerProfile` in one transaction. Idempotent.
`200` → `{ "user": { ... } }`

---

## Profile — `/profile` 🔒

### `POST /profile/avatar`

`multipart/form-data`, field name `avatar`. JPEG, PNG, or WebP; max 5 MB; 10
uploads per user per hour.

Validated by **magic bytes**, cropped to a 512×512 square, and re-encoded to
WebP — which strips EXIF including GPS. The image is written to object storage
and only its URL is stored on the user row
([ADR 0011](adr/0011-avatars-in-object-storage.md)).

Replacing an existing picture deletes the previous object, but only after the
new URL is committed — so a failed write never leaves an account with no
picture.

`200` → `{ "user": { ..., "avatarUrl": "https://…/uploads/<key>.webp" } }`

| Failure | Code |
| --- | --- |
| Not a real image | `INVALID_IMAGE` |
| Over 5 MB / unreadable upload | `UPLOAD_FAILED` |
| Nothing attached | `NO_FILE` |
| Hourly cap hit | `RATE_LIMITED` |

### `DELETE /profile/avatar`

Clears `avatarUrl` and deletes the stored object. The UI falls back to generated
initials.

`200` → `{ "user": { ..., "avatarUrl": null } }`

---

## Catalog — `/catalog` (public)

Only listings with `status = ACTIVE` and `deletedAt IS NULL` are ever returned.

### `GET /catalog/categories`

```json
{ "categories": [
  { "id": "…", "slug": "furniture-home", "title": "Furniture & Home",
    "description": "…", "coverImage": "https://…", "listingCount": 3 }
] }
```

`listingCount` counts visible listings only.

### `GET /catalog/promoted`

What is on the homepage because a seller agreed to pay for it
([ADR 0034](adr/0034-paid-homepage-placement.md)).

```json
{
  "hero": { "id": "…", "slug": "…", "title": "…", "promoted": true, "…": "…" },
  "shelf": [ { "id": "…", "promoted": true, "…": "…" } ]
}
```

Listings are the ordinary catalog shape plus **`promoted: true`**. That flag is
what the card and the banner render their "Promoted" label from, and it travels
with the data rather than being inferred by the page — a client cannot
accidentally render a paid placement as an editorial pick.

**Not cached**, unlike the rest of this section. A placement going live is a
window somebody bought, and a sixty-second cache spends the first minute of it.

Only live placements on listings that are still `ACTIVE` appear, so a promoted
item that sells drops out immediately. An error answers `{"hero": null,
"shelf": []}` rather than a 500: the homepage has four other shelves.

### `GET /catalog/listings`

| Param | Type | Notes |
| --- | --- | --- |
| `q` | string | Case-insensitive substring of title or description |
| `category` | slug | |
| `condition` | enum | `LIKE_NEW` \| `GOOD` \| `WELL_LOVED` \| `NEEDS_REPAIR` |
| `minPrice`, `maxPrice` | number | **Whole currency units** |
| `featured` | `true` \| `false` | |
| `sort` | enum | `newest` (default), `price_asc`, `price_desc` |
| `page` | int | Default 1 |
| `limit` | int | Default 24, max 48 |

Empty-string params are treated as absent, so an untouched filter form is a
valid request.

```json
{
  "listings": [ { /* listing */ } ],
  "total": 13, "page": 1, "limit": 24, "pageCount": 1
}
```

Listing object:

```json
{
  "id": "…", "slug": "brown-leather-jacket",
  "title": "Brown leather jacket", "description": "…",
  "condition": "LIKE_NEW", "conditionNote": "Like new",
  "priceCents": 12000, "originalPriceCents": 15000, "currency": "USD",
  "quantity": 1, "featured": false, "createdAt": "2026-08-19T…",
  "category": { "slug": "clothing-accessories", "title": "Clothing & Accessories" },
  "seller":   { "shopName": "RetailStore_2n Collection", "verified": true },
  "images":   [ { "url": "https://…", "alt": "…", "position": 0 } ],
  "rating":   { "average": 4.8, "count": 5 }
}
```

`rating.average` is `null` when there are no reviews — not `0`.
`seller.verified` is derived from KYC status and exposes no verification detail.

`400 INVALID_PRICE_RANGE` when `minPrice > maxPrice`.

### `GET /catalog/listings/:slug`

Adds `reviews` to the listing (newest 20) and a sibling `related` array (up to
4 from the same category).

```json
{
  "listing": { "…": "…", "reviews": [
    { "id": "…", "rating": 5, "body": "…", "createdAt": "…", "authorName": "Noah Brenner" }
  ] },
  "related": [ { /* listing */ } ]
}
```

`404 NOT_FOUND` if the slug is unknown, unpublished, or soft-deleted.

---

## Reservations — `/reservations` 🔒

A short-lived hold on stock, taken before checkout exists to convert it. This is
where the oversell race is prevented: availability is decided inside a
transaction holding `SELECT … FOR UPDATE` on the listing row, so two buyers can
never both claim the same unique item.
→ [ADR 0012](adr/0012-row-locking-for-reservations.md)

### `GET /reservations`

Your live holds, newest first, plus `holdMinutes` (currently 15).

### `POST /reservations` 🔁

```json
{ "listingId": "<id>", "quantity": 1 }
```

`201` → `{ "reservation": { "id", "listingId", "quantity", "expiresAt", "remainingQuantity" } }`

Stock is decremented and the listing flips to `RESERVED` once it reaches zero —
distinct from `SOLD`, because no money has moved.

| Failure | Code | Status |
| --- | --- | --- |
| Nothing left | `INSUFFICIENT_STOCK` | 409 |
| Sold, draft, or removed | `UNAVAILABLE` | 409 |
| You already hold it | `ALREADY_HELD` | 409 |
| It's your own listing | `OWN_LISTING` | 400 |
| Unknown listing | `NOT_FOUND` | 404 |

**Losing a race is a 409, not a 500.** Contention is an expected outcome.

### `DELETE /reservations/:id`

Releases the hold and returns the stock, flipping the listing back to `ACTIVE`.
`204`.

Holds also expire on their own after 15 minutes, and expired stock is reclaimed
lazily the next time someone tries to reserve that listing — so correctness
doesn't depend on a background job.

---

## Seller — `/seller` 🔒🏪

Non-sellers receive `403 NOT_A_SELLER`.

Every route is scoped to the caller's own records. **A listing owned by another
seller returns 404, not 403** — a 403 would confirm the id exists.

### `GET /seller/me`

```json
{ "seller": { "id": "…", "shopName": "…", "bio": null,
              "kycStatus": "UNSTARTED", "payoutsEnabled": false, "createdAt": "…" },
  "counts": { "DRAFT": 2, "ACTIVE": 5 } }
```

### `GET /seller/listings`

All of the caller's listings, any status, newest-updated first. Excludes
soft-deleted.

### `GET /seller/listings/:id`

### `POST /seller/listings`

```json
{
  "title": "Walnut side table",
  "description": "At least 10 characters.",
  "categoryId": "<uuid>",
  "condition": "GOOD",
  "conditionNote": "Water ring",
  "priceCents": 8500,
  "originalPriceCents": 11000,
  "quantity": 1,
  "currency": "USD"
}
```

Constraints: `title` 3–120, `description` 10–4000, `conditionNote` ≤ 60,
`priceCents` ≥ 1, `quantity` 1–999, and `originalPriceCents` must exceed
`priceCents`.

Created as `DRAFT`. `slug` is derived from the title and fixed thereafter.

`201` → `{ "listing": { ... } }`

### `PATCH /seller/listings/:id`

Accepts any subset of the create body. The `slug` is **not** regenerated when
the title changes. `409 LISTING_SOLD` if the listing is sold.

### `POST /seller/listings/:id/publish`

`DRAFT` → `ACTIVE`.

| Failure | Code |
| --- | --- |
| No photos | `NEEDS_PHOTO` |
| Already sold | `LISTING_SOLD` |

Deliberately **not** gated on identity verification
([ADR 0007](adr/0007-verification-gates-payouts.md)).

### `POST /seller/listings/:id/unpublish`

`ACTIVE` → `DRAFT`.

### `DELETE /seller/listings/:id`

Soft delete: sets `deletedAt` and `status = REMOVED`. `204`.

### `POST /seller/listings/:id/images`

`multipart/form-data`, field name `image`. JPEG, PNG, or WebP; max 8 MB; max 8
images per listing; 30 uploads per user per hour.

The file is validated by **magic bytes** (not extension or `Content-Type`) and
re-encoded to WebP, which strips EXIF including GPS.

`201` → `{ "image": { "id": "…", "url": "…", "alt": "…", "position": 0 } }`

| Failure | Code |
| --- | --- |
| Not a real image | `INVALID_IMAGE` |
| Over 8 MB / unreadable upload | `UPLOAD_FAILED` |
| Nothing attached | `NO_FILE` |
| Already 8 images | `TOO_MANY_IMAGES` |
| Hourly cap hit | `RATE_LIMITED` |

### `DELETE /seller/listings/:id/images/:imageId`

`204`. Returns `400 NEEDS_PHOTO` when removing the only photo of a published
listing.

---

## Verification & payouts — `/seller` 🔒🏪

### `GET /seller/verification`

```json
{
  "verification": {
    "status": "REJECTED", "provider": "stub",
    "documentType": "drivers_license", "country": "GB",
    "verifiedAt": null,
    "rejectionReason": "The document image couldn't be read clearly.",
    "payoutsEnabled": false,
    "isStub": true
  },
  "attempts": [ { "id": "…", "provider": "stub", "providerSessionId": "…",
                  "status": "REJECTED", "documentType": "drivers_license",
                  "country": "GB", "rejectionReason": "…",
                  "createdAt": "…", "completedAt": "…" } ]
}
```

`isStub` is exposed so the UI can say no real check occurred. Up to 10 attempts
are returned, newest first.

### `POST /seller/verification`

Starts a session, or resumes an in-flight one rather than creating a duplicate.
Max 5 per hour.

`201` → `{ "session": { "providerSessionId": "…", "redirectUrl": "…" }, "resumed": false }`
`200` → same shape with `"resumed": true` when an open session already exists.

`409 ALREADY_VERIFIED` once verified.

### `POST /seller/verification/:sessionId/submit`

```json
{ "documentType": "passport", "country": "US", "documentNumber": "…" }
```

`documentType` ∈ `passport` | `drivers_license` | `national_id`; `country` is a
2-letter code (normalised to uppercase); `documentNumber` is 6–40 characters.

> **`documentNumber` is never stored.** It is evaluated and discarded — not
> persisted, not logged, not returned.
> → [ADR 0006](adr/0006-kyc-store-reference-not-document.md)

Stub outcomes: number ending `0000` → rejected (unreadable), `0001` → rejected
(name mismatch), anything else → verified.

`200` → `{ "outcome": "VERIFIED", "rejectionReason": null, "payoutsEnabled": true }`

| Failure | Code |
| --- | --- |
| Unknown session, or another seller's | `NOT_FOUND` (404) |
| Session already resolved | `SESSION_CLOSED` (409) |

With a real provider this transition would arrive as a signature-verified
webhook rather than a client submission.

---

## Payouts — `/seller/payouts` 🔒🏪

Buyers pay the platform; the platform pays sellers afterwards. Separate charges
and transfers, never destination charges — [ADR 0029](adr/0029-payouts-separate-transfers-not-destination-charges.md).

**Every route here returns `403 PAYOUTS_LOCKED`** (with `kycStatus`) until the
seller's identity is verified. That gate predates the pipeline
([ADR 0007](adr/0007-verification-gates-payouts.md)) and covers onboarding as
well as payment: creating a connected account is a real account at a real
provider under somebody's name, and doing that before checking who they are is
the wrong order.

`PAYOUT_PROVIDER=stub|stripe_connect`. Under `stub` nothing reaches Stripe and
no money moves; responses carry `isStub: true` so the UI can say so.

### `GET /seller/payouts`

Everything the seller page needs in one request.

```json
{
  "summary": {
    "currency": "USD",
    "paidCents": 12000, "payableCents": 5000, "heldCents": 3000,
    "heldUntil": "2026-09-15T00:00:00.000Z",
    "withheldCents": 0, "inFlightCents": 0,
    "notEarnedCents": 2000, "debtCents": 0,
    "gates": { "payoutsEnabled": true, "payoutsReady": true, "onboarded": true }
  },
  "holdDays": 7,
  "payable": [
    { "orderItemId": "…", "orderId": "…", "title": "A mended plate",
      "amountCents": 5000, "deliveredAt": "2026-08-20T…" }
  ],
  "history": [
    { "id": "…", "amountCents": 12000, "nettedCents": 0, "currency": "USD",
      "status": "PAID", "failureReason": null,
      "createdAt": "…", "completedAt": "…",
      "items": [{ "orderItemId": "…", "amountCents": 12000, "reversedAt": null }] }
  ],
  "isStub": true
}
```

The figures are separate because they are different things for the seller to do
about them — [ADR 0030](adr/0030-payout-eligibility-and-hold.md):

| Figure | Means | What the seller does |
| --- | --- | --- |
| `payableCents` | delivered, past the hold, unrefunded, unclaimed | request a payout |
| `heldCents` | delivered, still inside the `holdDays` return window | wait |
| `withheldCents` | owed, but the payout account cannot receive it | finish onboarding |
| `inFlightCents` | sold and paid for, but not yet delivered | ship it, and wait for the buyer to confirm |
| `notEarnedCents` | refunded to the buyer, or a line the seller could not send | nothing — shown so the figures add up |
| `debtCents` | refunded after being paid out | nothing — netted off next payout |

`payable` is the exact line list behind `payableCents`, so "why is this $84?"
has an answer on screen rather than a total to trust.

**Money inside a `PENDING` payout is in none of those figures.** It has left
`payableCents` — its lines are claimed — and has not reached `paidCents`, which
counts settled payouts only. It appears in `history` with `status: "PENDING"`.
Both the seller page and the admin log surface it from there rather than adding
a fifth figure that is almost always zero.

### `POST /seller/payouts/account`

Starts Connect onboarding. Reuses an existing `connectAccountId` rather than
creating a second one — Stripe has no delete worth relying on, and a seller who
refreshes mid-onboarding must not end up with two accounts.

`201` → `{ "url": "…", "external": true, "expiresAt": "…" }`

`external: false` means the stub, which has no hosted page to redirect to.

Rate limited to **6 per hour per seller**: each call can create a real account.

### `POST /seller/payouts/account/refresh`

Re-reads the account from the provider and updates `payoutsReady`.

`200` → `{ "payoutsReady": true, "detailsSubmitted": true, "pending": [] }`

The `account.updated` webhook is the primary path. This exists so a seller
returning from onboarding does not wait on a webhook to see the padlock open,
and so a missed webhook is recoverable without a database console.

| Failure | Code |
| --- | --- |
| No account connected yet | `NO_ACCOUNT` (409) |

### `POST /seller/payouts/account/stub-complete`

Stands in for Stripe's hosted onboarding. **`404` under `stripe_connect`** — an
endpoint that can mark an account ready to receive money must not exist on a
real deployment, whatever it is guarded by. The identity stub takes the same
position.

### `POST /seller/payouts/run`

Claims the payable lines and transfers them. **The claim is committed before the
provider is called**, and `payout_items.orderItemId` is unique, so a second
concurrent run collides on the constraint instead of double-paying — the same
claim-then-act shape as `POST /orders/:id/pay`.

`201` → `{ "paid": true, "payoutId": "…", "amountCents": 5000 }`

`200` → `{ "paid": false, "code": "NOTHING_PAYABLE", … }` — the ordinary answer,
not an error.

| Failure | Code |
| --- | --- |
| No payout account connected | `NO_ACCOUNT` (409) |
| Identity not approved | `NOT_VERIFIED` (409) |
| Account not finished at the provider | `NOT_READY` (409) |
| Another run claimed the same lines | `ALREADY_RUNNING` (409) |
| Provider refused the transfer | `PROVIDER_REFUSED` (502) |
| Provider unreachable — payout stays claimed | `RETRY_LATER` (503) |

`RETRY_LATER` leaves a `PENDING` payout with its lines still claimed. Nothing
schedules the retry; `sendPendingPayouts()` finishes it and has to be invoked.

Rate limited to **10 per hour per seller**. The limit is the cheap guard; the
claim is what actually makes a double-click safe.

### `GET /seller/payouts/:id`

One past payout with the items it covered. Scoped to the requesting seller —
another seller's payout id is a `404`, not a `403`.

---

## Messages — `/seller/messages` 🔒🏪

Conversations with the platform ([ADR 0033](adr/0033-seller-admin-messaging.md)).
A thread has this seller on one side and the moderator **role** on the other —
there is no admin user id on it, because moderation is a shift rather than an
assignment.

Another seller's thread answers **404, not 403**, so an id cannot be used to ask
whether somebody else's conversation exists.

### `GET /seller/messages`

```json
{ "threads": [
  { "id": "…", "kind": "PLACEMENT", "subject": "Homepage placement — …",
    "lastMessageAt": "…", "closedAt": null, "unread": 1,
    "placement": { "id": "…", "status": "COUNTERED", "slot": "HERO" } }
], "unreadThreads": 1 }
```

### `GET /seller/messages/:id`

The thread with its messages, oldest first. **Reading it clears this side's
unread counter** — a deliberate side effect on a GET, because the alternative is
a client that must remember to post a read receipt and a badge that never
clears when it forgets.

### `POST /seller/messages`

Opens a `SUPPORT` thread. `{ subject, body }`. Capped at **5 per hour** — a new
thread is a new entry in somebody's queue.

### `POST /seller/messages/:id/reply`

`{ body }`. Capped at **30 per hour**. A closed thread answers
`409 THREAD_CLOSED` rather than silently reopening: a moderator who closed a
resolved conversation should not find it back in the queue with no record of why.

---

## Placement — `/seller/placements` 🔒🏪

Asking to appear on the homepage
([ADR 0034](adr/0034-paid-homepage-placement.md)).

**No money moves through any of this.** `agreedCents` is what both sides settled
on; there is no seller-to-platform charge in this application and the ADR
records why that boundary was drawn rather than crossed.

### `GET /seller/placements/slots`

```json
{
  "slots": [
    { "slot": "HERO", "positions": 1, "label": "Homepage hero banner" },
    { "slot": "PICKED_SHELF", "positions": 4, "label": "Picked for you shelf" }
  ],
  "disclosure": "Paid placements are labelled “Promoted” wherever they appear."
}
```

`disclosure` is in the API, not only in the UI. A seller agreeing to pay is
entitled to know the placement will be labelled **before** they agree, and a
client that forgets to render it should not be the only thing standing between
them and a surprise.

### `POST /seller/placements`

`{ listingId, slot, position?, offeredCents, startsAt?, endsAt?, note }`.
Creates the request **and** the thread that will carry its negotiation, in one
transaction.

| Refusal | Why |
| --- | --- |
| `404 NOT_FOUND` | no such listing — **or** somebody else's, answered identically |
| `409 LISTING_NOT_ACTIVE` | a draft or sold listing would spend a slot on nothing buyable |
| `400 INVALID_INPUT` (`position`) | the hero has one position; the shelf has four |
| `409 ALREADY_OPEN` | one open request per listing |
| `429 RATE_LIMITED` | 10 requests per day |

### `POST /seller/placements/:id/accept`

Accepts a counter-offer, reaching `AGREED`. `409 WRONG_STATE` if there is no
counter waiting.

### `POST /seller/placements/:id/withdraw`

Terminal, and allowed even after agreeing.

---

## Addresses — `/addresses` 🔒

Where orders get delivered. Checkout requires one.

Deleted entries are soft-deleted, and **past orders never reference these rows at
all** — an order copies the fields onto itself at checkout. Editing or deleting
an address must not change where a past parcel was sent.

### `GET /addresses`
Your addresses, default first then newest.

### `POST /addresses`
```json
{ "fullName": "…", "line1": "…", "line2": null, "city": "…",
  "region": null, "postcode": "…", "country": "GB", "phone": null,
  "isDefault": false }
```
`country` is ISO 3166-1 alpha-2. Everything else is deliberately loose —
address formats differ enough between countries that strict validation rejects
more real addresses than it catches bad ones.

The **first** address saved becomes the default whether or not `isDefault` was
sent, so checkout always has something to preselect.

`409 TOO_MANY` past 20 addresses.

### `PATCH /addresses/:id` · `DELETE /addresses/:id`
Scoped to the owner; someone else's address is a **404, not a 403**.
Deleting the default promotes the next most recent, rather than leaving a buyer
with addresses but no default.

### `POST /addresses/:id/default`
Exactly one default at a time, swapped inside a transaction.

---

## Orders — `/orders` 🔒

→ [ADR 0013](adr/0013-payment-provider-seam.md)

### `POST /orders` 🔁
Converts live holds into an order and opens a payment intent.

```json
{ "addressId": "uuid" }   // optional — omitted means "use my default"
```

`400 NO_ADDRESS` if the buyer has none. The UI treats this as a missing step and
routes to the address form rather than showing an error.

The response order carries `shipTo` — the address **as it was that day**.

### `GET /orders` · `GET /orders/:id`
Scoped to the buyer. Someone else's order is a 404.

Each item carries its own `fulfilment`, `carrier`, `trackingNumber`,
`shippedAt`, `deliveredAt`, and `fulfilmentNote`. Fulfilment is per line because
a basket can span several sellers, and two sellers cannot share one parcel —
so "your order has shipped" is not something that can honestly be said about a
whole order.

### `POST /orders/:id/pay` 🔁
```json
{ "cardNumber": "4242424242424242" }
```
Claims the order atomically before contacting the provider. Concurrent calls get
`409 PAYMENT_IN_PROGRESS` or `409 ALREADY_PAID` — never a second charge. With an
`Idempotency-Key`, a retry of the *same* attempt is told that attempt's outcome
instead; the claim is still what prevents the second charge.

### `GET /orders/refunds` 🔒

Every refund this buyer has received, newest first (max 100).

```json
{ "refunds": [ {
  "id": "…", "amountCents": 3200, "currency": "USD",
  "status": "SUCCEEDED", "trigger": "SELLER_UNFULFILLABLE",
  "reason": "Cracked while I was packing it.",
  "createdAt": "…", "completedAt": "…",
  "orderId": "…", "orderReference": "RS2-W9ABBM",
  "itemTitle": "Cast iron skillet"
} ] }
```

Declared **before** `/:id` in the router — Express matches in order, so swapped
it would read as an order whose id is the string `refunds`.

`itemTitle` comes from the line's snapshot, so it survives the listing being
deleted — a likely outcome for something a seller could not send.

### Returns

A buyer asking for their money back on one line. A **request** the seller
answers, not a refund — approving one produces an ordinary `Refund` with the
`BUYER_RETURN` trigger, so the over-refund guard, the provider call, webhook
settlement and the payout reversal all apply unchanged.
[ADR 0031](adr/0031-buyer-initiated-returns.md).

```
OPEN ──approve──> APPROVED (a Refund exists)
     ──refuse───> REFUSED ──escalate──> ESCALATED ──> APPROVED | REJECTED
     ──withdraw─> WITHDRAWN
```

The window derives from `PAYOUT_HOLD_DAYS` unless `RETURN_WINDOW_DAYS` overrides
it. A window longer than the payout hold means every late return lands on money
already transferred, so the two are consistent by default and the boot banner
says so when they are not.

#### `GET /orders/items/:itemId/return`

Whether the line can be returned. **`eligible: false` is a 200**, because "the
window closed on the 14th" is an answer rather than an error — the page shows it
instead of offering a button that would fail.

```json
{ "eligible": true, "title": "A mended plate", "amountCents": 6400,
  "deadline": "2026-09-16T…", "windowDays": 7 }
```

| Refusal | Code |
| --- | --- |
| Order never paid | `ORDER_NOT_PAID` |
| Buyer hasn't confirmed delivery | `NOT_DELIVERED` |
| Past the window (carries `deadline`) | `WINDOW_CLOSED` |
| Already refunded — including a fully refunded order | `ALREADY_REFUNDED` |
| A request already exists | `ALREADY_REQUESTED` |

Somebody else's line is a **404**, not a refusal: distinguishing them turns an
id into a way to ask what another person bought.

#### `POST /orders/items/:itemId/return` 🔁

```json
{ "reason": "The rim is chipped and it wasn't in the photos.",
  "notAsDescribed": true }
```

`reason` needs 10 characters — the seller reads it verbatim and has to be able
to act on it. `notAsDescribed` is recorded because it is what would decide who
pays return postage; nothing acts on it yet.

`201` → `{ "id": "…", "deadline": "…" }`

The insert is the claim: `return_requests.orderItemId` is unique, so a double
tap collides on the constraint rather than opening two rival requests against
one line. Rate limited to **20 per hour per buyer** — each one is a message a
seller has to read.

#### `POST /orders/returns/:id/withdraw` · `POST /orders/returns/:id/escalate`

Withdraw works only from `OPEN`; once somebody has answered, withdrawing would
erase their answer. Escalate works only from `REFUSED` — it is not a way past
the seller, who has to have said no first. **Nothing escalates on a timer**:
there is no scheduler here, so a seller's silence is answered by the buyer
pressing this rather than by a deadline.

Another buyer's return is a `404`. Wrong state is `409 WRONG_STATE`.

#### `GET /orders/returns`

Every return this buyer has asked for, with the item named, the buyer's own
words, and the answer verbatim if there is one. Also returns `windowDays`, so
nothing in the UI hardcodes it.

---

### `POST /orders/:id/cancel`
Only while `PENDING_PAYMENT`. A `PROCESSING` order returns
`409 PAYMENT_IN_PROGRESS`, because returning stock while a charge may complete
risks selling an item someone has paid for.

### `POST /orders/items/:itemId/delivered`
The **buyer** confirms arrival. Deliberately not the seller's call: a seller
marking their own parcel delivered is not evidence of anything — and this is
what releasing money hangs on, because `deliveredAt` starts the seven-day payout
hold ([ADR 0030](adr/0030-payout-eligibility-and-hold.md)). A seller who could
call this would be starting their own payment clock. Idempotent.

---

## Sales — `/seller/sales` 🔒🏪

What a seller has sold. Previously impossible to ask: order lines carried a
`sellerName` *string* and nothing queryable, so a seller could never see their
own orders.

### `GET /seller/sales?filter=all|to_send|sent`

Only `PAID` orders appear. An unpaid checkout is never shown — sellers should
not pack parcels for carts that get abandoned, and the buyer's address is
released at the same moment, not before.

```json
{ "sales": [ { "id": "…", "title": "…", "order": { "reference": "RS2-…" },
              "fulfilment": "UNFULFILLED", "shipTo": { "line1": "…" } } ],
  "summary": { "toSend": 1, "shipped": 0, "delivered": 0, "grossCents": 4200 } }
```

`grossCents` is named gross on purpose, and it stayed that way once payouts
were built. It is the total of what sold, before the hold and before any
refund — so it is not what the seller is owed. What they are owed, line by
line, is [`GET /seller/payouts`](#get-sellerpayouts), and calling this one
earnings would put two different numbers under one word.

### `POST /seller/sales/:id/ship`
```json
{ "carrier": "Royal Mail", "trackingNumber": "RM…" }
```
Both optional — plenty of secondhand sales are handed over in person or posted
without a trackable service, and demanding a number pushes sellers into
inventing one. Idempotent: shipping twice updates the tracking rather than
erroring.

### `POST /seller/sales/:id/cannot-send`
```json
{ "reason": "Broke while I was packing it, sorry." }
```
Refunds that line automatically, for exactly what was paid for it — not the
whole order, since a basket can span sellers and one seller failing to post says
nothing about the others. The refund is attributed to the seller rather than to
a moderator, carries their stated reason, and notifies the buyer that the money
is on its way back. See [ADR 0016](adr/0016-refunds-claim-then-refund.md).

`200` → `{ "ok": true, "refunded": true, "refundCents": 4200,
"refundStatus": "SUCCEEDED", "refundError": null, "note": "…" }`

**The outcome is reported, not assumed.** A provider can still refuse, so the
seller is told which happened rather than reassured either way — `refunded:
false` with a `refundError` means the buyer was told and the money was not
sent, and the refund row is recorded for somebody to settle.

---

### `GET /seller/returns?filter=open`

Returns against this seller's own lines, with the buyer's words and whether they
called the item misdescribed. `filter=open` narrows to the ones still needing an
answer.

### `POST /seller/returns/:id/respond`

```json
{ "approve": true }
{ "approve": false, "note": "The chip is visible in the third photo." }
```

**A refusal requires a note**, and the buyer sees it verbatim — refusing in
silence would make escalating the only rational response every time.

Approving issues the refund. If the provider refuses, the request is **put back
to OPEN** and this answers `502 REFUND_FAILED`: a request left APPROVED with no
refund behind it would tell the buyer their money was coming when nothing was
owed to anyone.

| Failure | Code |
| --- | --- |
| Another seller's return, or none | `NOT_FOUND` (404) |
| Refusing with no note | `NOTE_REQUIRED` (400) |
| Already answered, or escalated to a moderator | `WRONG_STATE` (409) |
| The refund could not be issued — still open | `REFUND_FAILED` (502) |

A seller **cannot** answer an `ESCALATED` request. That is the point of
escalation, and only the admin route may.


## Wishlist — `/wishlist` 🔒

Saving is **inert**: it never reserves, hides, or changes what anyone else sees.
Two people can save the same one-of-a-kind chair and neither has claimed it.

- `GET /wishlist` — full entries. Sold items stay on the list, flagged `sold`,
  rather than vanishing.
- `GET /wishlist/ids` — ids only, for drawing a grid of hearts in one request.
- `PUT /wishlist/:listingId` — idempotent, via a unique index on
  `(userId, listingId)`. Six simultaneous saves produce one row.
- `DELETE /wishlist/:listingId` — removing something not saved is a success, not
  a 404.

---

## Reviews — `/reviews` 🔒

A review requires a **PAID order for that listing**. An open review box on a
marketplace is a reputation weapon — competitors bury each other, sellers
inflate themselves, and the stars that gate every buying decision stop meaning
anything.

- `GET /reviews/for/:listingId` — `{ canReview, code, reason, mine }`.
  `code` is `OK`, `NOT_PURCHASED`, `OWN_LISTING`, or `GONE`. Ownership is
  checked **before** purchase, so a seller is told they own it rather than being
  sent off to buy their own item.
- `POST /reviews` — `{ listingId, rating, body }`. An upsert: writing again
  edits the existing review. One per person per listing, by unique index.
- `PATCH /reviews/:id` · `DELETE /reviews/:id` — author only; 404 otherwise.

`GET /catalog/listings/:slug` returns `ratingBreakdown` and a per-review
`verified` flag. That flag is **computed against real paid orders**, not
assumed — seeded reviews have no order behind them, and a badge that isn't
earned devalues every badge on the site.

---

## Reports — `/reports` 🔒

Anyone signed in can report a listing, a review, or an account.

### `GET /reports/reasons`

The list the UI renders. Codes are stable; labels are not.

### `POST /reports`

```json
{ "targetType": "LISTING", "targetId": "uuid", "reason": "COUNTERFEIT", "detail": "optional" }
```

**409 `ALREADY_REPORTED`** if you have already reported that thing — one voice
per person, so a queue cannot be brigaded by one account clicking repeatedly.
**404** for a target that does not exist.

---

## Admin — `/admin` 🔒👮

Two separate gates, and being past the first does not get you past the second.

**👮 = a live admin session**, which is *not* the ordinary login cookie. It is a
distinct `retailstore_2n_admin` cookie, signed with a secret derived from
`JWT_SECRET`, lasting **30 minutes**. Obtaining one needs the password **again**
plus a TOTP code. See
[ADR 0006](adr/0006-kyc-store-reference-not-document.md) for the identity side;
the reasoning here is the same — a stolen shopping cookie must not carry the
power to suspend accounts.

`role: ADMIN` is granted **only by CLI** (`npm run admin:grant`). There is no
promotion endpoint, and adding one would defeat the arrangement: the whole
point is that granting admin needs shell access to the server, not a session in
a browser.

Failures return **401 `ADMIN_SESSION_REQUIRED`**, or **403 `ADMIN_REVOKED`** if
the role was withdrawn while a session was still live — the role is re-read
from the database on every request, so revocation takes effect immediately
rather than when the token expires.

### Step-up

| Route | Needs | Notes |
| --- | --- | --- |
| `GET /admin/session` | 🔒 | `{ isAdmin, needsTotpSetup }`. Plain `false` for non-admins, not a 403 — this decides whether to render a link. |
| `POST /admin/totp/setup` | 🔒 + password | Returns `{ qrDataUrl, secret }`. Stored unconfirmed. |
| `POST /admin/totp/confirm` | 🔒 + code | Sets `totpConfirmedAt`. Until then the enrolment does not count. |
| `POST /admin/session` | 🔒 + password + code | Mints the admin cookie. Rate limited to **8 per 15 min**. |
| `GET /admin/session/active` | 👮 | `{ active, secondsLeft }`, read from the token's own `exp`. |
| `POST /admin/session/end` | 🔒 | Clears the cookie. |

A wrong password and a wrong code return the **same** message. Distinguishing
them would tell an attacker which half they had already solved.

**Codes are single-use.** A valid code spans about 90 seconds here, because one
30-second step either side is accepted for clock drift — so without this the
same six digits keep working for that whole window, and a code seen over a
shoulder or relayed by a phishing proxy can be spent again by someone else.
`User.totpLastUsedAt` records the period last accepted, and anything from that
period or earlier is refused with the same generic message. The claim is an
atomic conditional UPDATE, so two requests carrying the same code cannot both
win a read-then-write race.

One consequence worth knowing: finishing enrolment spends a code, so the very
next step-up needs the *next* one. The panel says so rather than letting someone
retype the digits their app is still displaying.

### Dashboard — all read-only

| Route | Returns |
| --- | --- |
| `GET /admin/metrics?days=7\|30\|90` | Headline figures, a daily series, `attention`, `topSellers`, `recentOrders` |
| `GET /admin/orders?q=&status=&page=` | Paged orders; searches reference, buyer name, buyer email |
| `GET /admin/orders/:id` | One order: lines, ship-to snapshot, payment reference |
| `GET /admin/customers?q=&filter=&page=` | Paged accounts; `filter=ALL\|SELLERS\|SUSPENDED\|ADMINS` |
| `GET /admin/customers/:id` | One account: lifetime spend, recent orders, shop, reports against |
| `GET /admin/catalogue?q=&status=&page=` | Paged listings; `status` adds `REMOVED` for soft-deleted |
| `GET /admin/overview` | Bare counts, used for the sidebar badge |
| `GET /admin/reports?status=` | The moderation queue, **oldest first** |
| `GET /admin/audit` | Every moderation action, newest first |
| `GET /admin/deliveries?q=&channel=&status=&page=` | The delivery ledger. `q` takes an email address, a name, or an `eventId`; `channel=EMAIL\|PUSH\|SMS`; `status` adds `DEFERRED` and `PENDING`. Also returns `byStatus` for the whole filtered set |
| `GET /admin/payouts?q=&status=&page=` | Money sent to sellers. `q` takes a seller email or name, a payout id, or the provider's transfer id; `status=PENDING\|PAID\|FAILED`. Returns `byStatus` and `totals` (sent, netted off, outstanding seller debt) for the whole filtered set. **Read only — there is no retry here**, because a retry moves money and only the seller's claim-then-transfer path cannot double-pay |
| `GET /admin/returns?q=&status=&page=` | Return requests. `q` takes a buyer email or name, a request id, or an order reference; `status` covers all six states. **`ESCALATED` is why this exists** — a buyer asked, the seller refused, and only a moderator can see it, because a seller sees only their own and a buyer only theirs. Ordered so escalations come first |
| `POST /admin/returns/:id/decide` | Settles one. `{approve, note}`. A rejection here is **terminal** (`REJECTED`, not `REFUSED`) so the same request cannot be escalated to a second moderator. Approving issues the refund; a provider failure puts the request back and answers `502`. The audit trail is `decidedById` on the request plus `initiatedById` on the refund — the same arrangement as the admin refund route, rather than a duplicate moderation-log entry that could disagree with it |

Lists page at **25**, returning `{ rows, total, page, pages, pageSize }`.

`metrics` counts **only `PAID` orders**, and the figure is labelled *gross
sales*, never revenue: RetailStore_2n takes no cut, so none of it is the platform's.
Period-on-period deltas come back **`null`**, not `0` or `100`, when the prior
period had nothing to compare against.

The report queue returns `reporterName` and **never the reporter's email**.

`deliveries` answers "did the buyer get the refund email?" — a real support
question that previously needed a database console. Each row carries *why*, not
just what: `suppressReason` for a channel the recipient turned off,
`lastError` for a provider that refused, `notBefore` for something quiet hours
parked. `recipient` is **null** when the account has since been deleted, because
the ledger has no foreign key to `users` and a delivery record has to outlive
the account it was for.

**There is no message body in the response, and there is not meant to be.** The
ledger records that something was sent, not what it said
([ADR 0026](adr/0026-delivery-idempotency.md)), and this endpoint must not
become the place that leaks it.

### Actions — every one writes an audit row

| Route | Effect |
| --- | --- |
| `POST /admin/listings/:id/remove` | Soft delete. Orders containing it keep working. |
| `POST /admin/listings/:id/restore` | Returns it as **`DRAFT`**, never straight to live — republishing is the seller's call. |
| `POST /admin/reviews/:id/remove` | Soft delete. |
| `POST /admin/users/:id/suspend` | Blocks sign-in. Deletes nothing. |
| `POST /admin/users/:id/reinstate` | Lifts it. |
| `POST /admin/reports/:id/resolve` | Closes a report; `dismissed: true` records "looked, found nothing". |

All take `{ reason, reportId? }`. **`reason` is required** (3–1000 chars) and is
shown verbatim to the person affected — **400 `REASON_REQUIRED`** without one.
An audit row that reads only "suspended by X" is useless six months later, and
someone whose listing vanished is owed the reason.

**400** for suspending yourself, **403 `CANNOT_SUSPEND_ADMIN`** for suspending
another admin — revoke the role from the CLI first. Both are checked *before*
"already suspended", so the answer does not depend on the target's current
state.

---

### Merchandising — `/admin/placements`

Choosing what the homepage shows
([ADR 0034](adr/0034-paid-homepage-placement.md)). This is the first
**productive** admin power in the application — every other one removes
something — and the first where the platform has a commercial interest in the
outcome, which is why the terms live in a thread the seller can read back and
the label is not optional.

| Route | What it does |
| --- | --- |
| `GET /admin/placements?pending=1` | the queue plus `live`, the slots currently on the homepage. `pending=1` is everything **needing a moderator's hand** — `REQUESTED`, `COUNTERED` *and* `AGREED`, the last because an agreed placement is waiting to be made live |
| `GET /admin/placements/:id` | one request |
| `POST /admin/placements/:id/counter` | `{ agreedCents, slot?, position?, startsAt?, endsAt?, note }` — proposes terms and says so in the thread |
| `POST /admin/placements/:id/accept` | takes the seller's offer unchanged |
| `POST /admin/placements/:id/decline` | `{ note }` — **required**. A refusal with no reason forces the seller to guess, the same rule as refusing a return |
| `POST /admin/placements/:id/activate` | `AGREED → LIVE` |
| `POST /admin/placements/:id/end` | `LIVE → ENDED` |

`activate` answers **`409 SLOT_TAKEN`** when another placement holds that slot.
That is the partial unique index `placement_live_slot` refusing it, not an
error: the request stays `AGREED` and the sweeper starts it when the slot frees.
`409 WRONG_STATE` means somebody else answered first — reload rather than retry.

### Conversations — `/admin/messages`

| Route | What it does |
| --- | --- |
| `GET /admin/messages?unanswered=1` | the queue, unanswered first |
| `GET /admin/messages/:id` | one thread. **Clears the badge for every moderator**, because the admin side is one role with one counter ([ADR 0033](adr/0033-seller-admin-messaging.md)) |
| `POST /admin/messages/:id/reply` | `{ body }` |
| `POST /admin/messages/:id/close` | conditional — a second close answers `409` |
| `POST /admin/messages/:id/reopen` | the same, in reverse |

A message from a seller notifies **every non-suspended moderator**, one event
each. A reply notifies exactly the seller. Suspended admins are excluded, for
the reason `ACCOUNT_SUSPENDED` has no push channel: a notification whose link
leads to a login screen that refuses you is worse than silence.

---

## Webhooks — `/webhooks/stripe`

Signature-verified, raw body, mounted **before** `express.json()` — Stripe signs
the exact bytes, so a parsed and re-serialised body fails every time.

Handles `payment_intent.*`, `refund.*` / `charge.refund.updated`, and
`identity.verification_session.*`. Note that `requires_input` means both
"hasn't started" and "was refused"; only `last_error` separates them.

`charge.refunded` is deliberately **not** handled. It fires alongside the
refund-object events but carries a Charge, whose `refunds` list would need
separate unwrapping — two code paths for one fact, the second only ever
agreeing with the first.

Unknown events and unknown ids return **200**, because a non-2xx tells Stripe to
retry forever.

---

## Static files

### `GET /uploads/:key`

Processed seller images. Keys are server-generated (32 hex + extension) and
served immutable with a one-year cache, since they are never reused.

In development Next.js needs `images.dangerouslyAllowLocalIP` to optimise these,
because Next 16 blocks image optimisation from private IPs as SSRF protection.
It is scoped to development only — in production these come from object storage
on a public hostname.
