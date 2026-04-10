# High-Level Design

Scope: the whole system, its containers, and the cross-cutting concerns that
apply everywhere. For per-module detail see [lld.md](lld.md).

---

## 1. System context

```mermaid
flowchart TB
    subgraph people["People"]
        Buyer["Buyer<br/><i>browses, saves items</i>"]
        Seller["Seller<br/><i>lists items, verifies identity</i>"]
    end

    K["<b>RetailStore_2n</b><br/>Secondhand marketplace"]

    subgraph ext["External systems"]
        Pwned["Pwned Passwords API<br/><i>k-anonymity breach check</i>"]
        Mail["Email provider<br/><i>SMTP via nodemailer</i>"]
        Kyc["Stripe Identity<br/><i>test mode; stub behind a seam</i>"]
        Pay["Stripe Payments<br/><i>test mode; stub behind a seam</i>"]
        Sms["Twilio<br/><i>SMS; stub behind a seam</i>"]
        Push["Web Push services<br/><i>the browser vendors' own endpoints</i>"]
        CDN["Object storage<br/><i>S3-compatible; local disk is the other driver</i>"]
    end

    Buyer --> K
    Seller --> K
    K -->|"SHA-1 prefix only"| Pwned
    K -.-> Mail
    K -.-> Kyc
    K -.->|"intents, refunds, webhooks"| Pay
    K -.->|"verified numbers only"| Sms
    K -.-> Push
    K --> CDN
```

Dotted lines are **provider seams**: one interface with a real integration and a
stub behind it, selected by an environment variable. The stub is not a
placeholder for missing code — it is what CI runs against, so a pull request
from a fork gets a meaningful green run without any credentials. See
[§6 Deliberate stubs](#6-deliberate-stubs).

## 2. Containers

| Container | Runtime | Responsibility |
| --- | --- | --- |
| **Storefront + BFF** | Next.js 16, Node | Renders the UI; proxies all browser API traffic to Express |
| **API** | Express 4, Node | Business rules, persistence, authorisation, image processing |
| **Database** | PostgreSQL 16 | System of record |
| **Cache & counters** | Redis 7 | Rate-limit counters and read-through cache. Holds nothing that must survive a restart — see [ADR 0018](../adr/0018-redis-for-shared-ephemeral-state.md) |
| **Standby** *(opt-in)* | PostgreSQL 16 | A byte-for-byte streaming clone, ~11ms behind. Read-only, and nothing queries it — it exists to be promoted. `--profile ha`. See [ADR 0020](../adr/0020-replication-and-backups.md) |
| **Object storage** | MinIO (S3-compatible) | Processed photos and avatars, fetched by the browser directly. Anonymous read on objects only — see [ADR 0022](../adr/0022-object-storage-for-uploads.md) |
| **Broker** *(opt-in)* | Kafka 4 in KRaft mode | Fans one notification event out to the channel workers. Holds in-flight deliveries only — losing it loses no notification, because the outbox still has the row. `--profile messaging`. See [ADR 0025](../adr/0025-kafka-topics-and-partitioning.md) |
| **Relay** *(opt-in)* | Node | Publishes committed `outbox_events` rows to the broker. Safe to scale: the claim is `FOR UPDATE SKIP LOCKED`, so N relays divide the backlog rather than publishing it N times. Runs in-process under the inline transport instead |
| **Channel workers** *(opt-in)* | Node | One consumer group each for email, push and SMS, so a dead SMS provider cannot stall email. Scale independently of the API |

Two Node processes in the default setup, deliberately. The Next.js server holds no business logic —
it renders and forwards. Every rule is enforced in Express, so a client that
bypasses the UI gains nothing.

### Where rendering happens

| Route | Mode | Why |
| --- | --- | --- |
| `/`, `/search`, `/shop/[category]`, `/listing/[slug]` | Server-rendered per request | Inventory changes; must not be stale |
| `/seller/*`, `/account`, `/cart`, `/wishlist` | Client components | Need client auth state and interactivity |
| `/api/*` | Route handlers | The BFF |

Public catalog pages are fetched in server components that call Express
**directly**, not through `/api/*`. The Next server *is* the BFF, so routing a
server-side read through its own HTTP handler would add a hop for nothing. The
BFF exists for *browser* traffic.

## 3. Request lifecycle

A browser-initiated, authenticated call:

```mermaid
sequenceDiagram
    participant Br as Browser
    participant BFF as Next.js /api/*
    participant API as Express
    participant DB as PostgreSQL

    Br->>BFF: fetch("/api/seller/listings")<br/>cookies attached automatically
    BFF->>API: GET /seller/listings<br/>cookie header relayed
    API->>API: requireAuth → verify access token
    API->>DB: SELECT ... WHERE sellerId = :caller
    DB-->>API: rows
    API-->>BFF: 200 JSON
    BFF-->>Br: 200 JSON
```

When the access token has expired:

```mermaid
sequenceDiagram
    participant Br as Browser
    participant BFF as Next.js /api/*
    participant API as Express

    Br->>BFF: fetch("/api/seller/listings")
    BFF->>API: GET /seller/listings
    API-->>BFF: 401
    BFF->>API: POST /auth/refresh
    API-->>BFF: 204 + rotated cookies
    BFF->>API: retry original request with new cookies
    API-->>BFF: 200 JSON
    BFF-->>Br: 200 JSON + Set-Cookie
```

The retry is invisible to the caller. Endpoints that legitimately return 401 —
`/auth/login`, `/auth/signup`, `/auth/refresh`, `/auth/verify-email`,
`/auth/resend-verification` — are excluded, otherwise a wrong password would
trigger a refresh loop.

## 4. Security model

### Session handling

| Token | Form | Lifetime | Storage |
| --- | --- | --- | --- |
| Access | Signed JWT | 15 minutes | `httpOnly` cookie |
| Refresh | Opaque random string | 30 days | `httpOnly` cookie; **SHA-256 hash** in DB |

Cookies are `httpOnly`, `sameSite=lax`, and `secure` in production. No token is
readable by JavaScript, so XSS cannot exfiltrate a session.

Refresh tokens are stored hashed. A database leak yields hashes, not usable
sessions — the same reasoning as password hashing, applied to a credential
that is equally sufficient to impersonate someone.

**Rotation with reuse detection.** Each refresh issues a new token and marks
the old one replaced. Presenting an already-rotated token means it leaked, so
the whole family is revoked and the session dies. The legitimate user logs in
again; the attacker gains nothing lasting.

### Passwords

A 12-character minimum plus a breach check against Pwned Passwords, instead of
composition rules. `P@ssw0rd1` satisfies every "one upper, one digit, one
symbol" policy and is also in every breach corpus. Length and
known-compromise are the properties that correlate with real resistance.

The check sends the **first five characters of the SHA-1 hash** and filters the
returned range locally, so the password is never transmitted. The check fails
open: if the API is unreachable, signup proceeds rather than blocking
registration on a third party.
→ [ADR 0004](../adr/0004-password-policy.md)

### Authorisation

Authentication establishes *who*; it never establishes *what they may touch*.
Two middlewares compose:

- `requireAuth` — validates the access token, sets `req.userId`
- `requireSeller` — resolves the caller's `SellerProfile`, sets `req.sellerId`

Every seller query is then scoped by `sellerId`. A listing belonging to someone
else returns **404, not 403**: a 403 confirms the id exists and would let
someone enumerate other sellers' inventory.

### Uploads

Untrusted bytes get three treatments before storage:

1. **Magic-byte sniffing** — the header is inspected. Filename extensions and
   client `Content-Type` are attacker-controlled and prove nothing.
2. **Re-encode via Sharp** — output is a fresh WebP. Sharp does not copy
   metadata unless asked, which strips EXIF *including GPS*. Sellers photograph
   items inside their homes; publishing that metadata would leak home
   addresses. `.rotate()` runs first so orientation survives.
3. **Bounds** — 8 MB per file, 8 images per listing, 2000 px longest edge,
   a 50-megapixel decode cap against decompression bombs, and 30 uploads per
   user per hour.

### Identity data

No government ID is ever stored: no image, no document number, no date of
birth. Those values pass through memory and are discarded. What persists is a
provider session id, document *type*, issuing country, outcome, and timestamp.

Holding ID documents would make the database a high-value breach target and
pull it under special-category data rules (GDPR Art. 9-adjacent; India's DPDP
Act treats them similarly) for no product benefit.
→ [ADR 0006](../adr/0006-kyc-store-reference-not-document.md)

### Trust boundaries

```mermaid
flowchart TB
    subgraph untrusted["Untrusted"]
        Browser["Browser<br/><i>all input hostile</i>"]
    end
    subgraph edge["Edge — no business rules"]
        Next["Next.js server"]
    end
    subgraph trusted["Trusted — all rules enforced here"]
        Express["Express API"]
        DB[("PostgreSQL")]
    end

    Browser -->|"validated by Zod at the boundary"| Next
    Next --> Express
    Express --> DB
```

Because the BFF forwards without interpreting, it is not a security control.
Nothing is enforced only in Next.js or only in the UI. Disabled buttons are a
courtesy; the server re-checks. Publishing without a photo is rejected by the
API even though the button is greyed out.

## 5. Cross-cutting concerns

**Validation.** Zod parses every request body and query string at the route
boundary. Errors carry a machine-readable `code` and, where applicable, the
offending `field`, which the UI attaches to the specific input.

**Money.** Integer minor units (`priceCents`) everywhere. Write endpoints
accept cents so no float rounding is possible in transit; the search API accepts
whole currency units because that is what a price filter collects.
→ [ADR 0005](../adr/0005-money-as-integer-minor-units.md)

**Deletion.** Listings soft-delete (`deletedAt` + `status = REMOVED`). A
listing referenced by a past order must stay resolvable. All catalog reads
filter on `deletedAt: null` and `status: ACTIVE`.
→ [ADR 0008](../adr/0008-soft-delete-and-listing-status.md)

**Public URLs.** A listing's `slug` is generated once at creation and never
regenerated when the title changes, so existing links keep working.

**Errors.** Every route wraps its handler; failures log server-side with
context and return a generic message. Internal details are not sent to clients.

**Notifications.** No business module sends anything. They call `events.*`,
which writes the notification and an outbox row in the same transaction; a relay
publishes, and per-channel workers deliver. Every call site is `void`-ed and
swallows its own errors, deliberately: failing to tell someone their item sold
must not roll back the sale.
→ [ADR 0024](../adr/0024-outbox-not-dual-writes.md)

**Sweepers.** Five timers recover state nothing in the request path will reach
again: expired stock holds, unpaid orders, notifications parked by quiet hours,
deliveries claimed but never settled, and spent outbox rows. Each claims by
conditional `UPDATE`, so running several API replicas divides the work instead
of duplicating it.

## 6. Provider seams

Seven concerns sit behind an interface with two implementations — a real one
and a stub — selected by an environment variable. Each is a single module, so
changing provider means editing one file.

| Concern | Module | Real | Stub | Selected by |
| --- | --- | --- | --- | --- |
| Payments | `lib/paymentProvider.ts` | Stripe PaymentIntents + Refunds | In-process intents with test card numbers | `PAYMENT_PROVIDER` |
| Identity | `lib/kycProvider.ts` | Stripe Identity | Deterministic outcomes by document-number suffix | `KYC_PROVIDER` |
| Email | `lib/mailer.ts` | SMTP via nodemailer | Console, or Ethereal's throwaway inbox | `MAIL_TRANSPORT` |
| File storage | `lib/storage.ts` | S3-compatible object storage (MinIO locally) | Local disk | `STORAGE_DRIVER` |
| SMS | `lib/smsProvider.ts` | Twilio, over its REST API | In-memory; returns the code so the flow can be finished without a handset | `SMS_PROVIDER` |
| Notification transport | `lib/notifyTransport.ts` | Kafka, with the relay and workers as their own processes | The relay hands events straight to the same consumer functions, in-process | `NOTIFY_TRANSPORT` |
| Payouts | `lib/payoutProvider.ts` | Stripe Connect Express: accounts, onboarding links, transfers, reversals | In-memory accounts and deterministic transfer ids; records the transfer without sending it | `PAYOUT_PROVIDER` |

**The stubs are not placeholders for missing code.** They are what CI runs
against: the suite drives the whole purchase, refund and verification flow with
no credentials configured, which is why a pull request from a fork — unable to
read repository secrets — still gets a meaningful green run. The Stripe paths
are exercised separately against test mode.

The API reports `isStub: true` and the UI says so on screen. A stub that
silently looks real is worse than no stub.

`putFile`, `removeFile` and `publicUrl` are the whole storage surface, and both
drivers share the same key validation so a driver change cannot orphan a stored
URL. R2 or any other S3-compatible service drops in without touching a caller.

## 7. Known limitations

- **A placement fee can be agreed and cannot be collected.** Money moves in two
  directions here — buyer to platform, platform to seller. A seller-to-platform
  charge is a third, and it needs its own claim-then-charge guard, idempotency
  key, invoice, tax treatment and a refund path for placement paid for and never
  delivered. None of that is built: `agreedCents` is a record of what both sides
  settled on, and settlement happens outside the application. It also means the
  question "what if a promoted listing sells on day one" is answered by dropping
  it from the homepage with nothing owed back, which is only tenable because
  nothing was taken. [ADR 0034](../adr/0034-paid-homepage-placement.md).

- **Payouts have never run against Stripe Connect.** The path is built and
  exercised end to end — claim, transfer, reversal, debt netting, both screens —
  but only under `PAYOUT_PROVIDER=stub`. No connected account has been created,
  no transfer issued, and no `account.updated` webhook has ever arrived from
  Stripe, so what is proven is the claim ordering and the unique constraint
  rather than the provider's behaviour. Same position as payments and identity.
  [Plan 0002](../plans/0002-seller-payouts.md),
  [ADR 0029](../adr/0029-payouts-separate-transfers-not-destination-charges.md),
  [ADR 0030](../adr/0030-payout-eligibility-and-hold.md). Two questions the code
  cannot answer are recorded there: who pays Stripe's Connect fees on a platform
  that takes no cut, and how long the hold after delivery should be.
- **A return is approved on trust, not on the item coming back.** Nothing here
  tracks a parcel going the other way, because that needs the carrier
  integration the shipping page was rewritten to stop promising. Approval is the
  seller saying they are content; a seller who approves and receives nothing has
  been defrauded and support is their only route
  ([ADR 0031](../adr/0031-buyer-initiated-returns.md)).
- **A seller's silence on a return expires nothing.** There is no timer, so an
  unanswered request waits until the buyer escalates it. That is a button they
  press, not a deadline the system keeps — the same missing-scheduler gap as
  everything else on this list.
- **Under Compose, nothing calls `sendPendingPayouts`.** A payout claims its
  lines before the transfer, so a crash in between leaves money reserved and
  unsent, and Compose has no scheduler to finish it — an operator runs
  `node dist/jobs.js payouts:pending` by hand, or the money sits there.

  **Under Kubernetes it is a CronJob**, every fifteen minutes, and it is the one
  scheduled job in the system ([ADR 0032](../adr/0032-kubernetes-manifests.md)).
  The six recovery sweepers are *not* scheduled and never were: they run in the
  API process on every replica, claiming work with a conditional `UPDATE` so
  replicas divide it — the sixth, homepage placements, claims against a partial
  unique index instead, which divides the work the same way
  ([ADR 0034](../adr/0034-paid-homepage-placement.md)). This one is a Job because it calls a payment provider,
  which wants an exit code and a start time rather than a line in an
  application log.
- **Failover is manual under Compose, and automatic under Kubernetes.** Both
  tiers can run more than one replica — rate limits and the cache are in Redis
  ([ADR 0018](../adr/0018-redis-for-shared-ephemeral-state.md),
  [ADR 0019](../adr/0019-cache-tiering-rule.md)), the refresh race is settled in
  Postgres ([ADR 0021](../adr/0021-refresh-race-grace-window.md)), and uploads
  are in shared object storage
  ([ADR 0022](../adr/0022-object-storage-for-uploads.md)). What Compose has
  never had is anything that *notices* a dead instance and replaces it.

  [The manifests](../../k8s/) close that half:
  [ADR 0032](../adr/0032-kubernetes-manifests.md) runs Postgres as a
  CloudNativePG `Cluster`, and killing the primary on a kind cluster promoted a
  replica, after which a write succeeded through the BFF with **zero API
  restarts** — Prisma's pool followed the `-rw` Service to the new primary.
  Measured on one node with no spare memory, so the ~2.5 minutes it took is not
  a figure worth quoting.

  **Compose remains the development story and gains nothing from this.** A
  single `docker compose up` cannot promote anything, and that is still the
  right trade for a machine you are writing code on.
- **Search is substring matching** (`ILIKE '%q%'`), which cannot use a B-tree
  index, so every search is a sequential scan. Fine at this size; a Postgres
  `tsvector` index with ranking is the upgrade path.
- **Pagination is offset-based.** Simple and right for numbered result pages;
  deep offsets degrade.
- **Backups are still not scheduled or retained**, in either deployment. WAL
  archiving and point-in-time recovery work and the restore is rehearsed
  ([ADR 0020](../adr/0020-replication-and-backups.md)), but base backups are
  taken on demand and nothing expires old ones.
  [The Kubernetes manifests](../../k8s/) narrow this rather than close it: the
  CloudNativePG `Cluster` is where a `barmanObjectStore` with a
  `retentionPolicy` belongs — one block, doing scheduling, retention and
  verification — and `k8s/base/postgres-cluster.yaml` deliberately leaves it
  out, because it needs a bucket and credentials that differ per environment
  and no overlay here has them. So the mechanism has a home and no deployment
  uses it yet.
- **Nothing reads from the replica**, deliberately. Routing reads to a standby
  introduces read-your-writes bugs — a buyer landing on an order list that has
  not replayed their order — and the caching in
  [ADR 0019](../adr/0019-cache-tiering-rule.md) already absorbed the read volume
  a replica would have relieved.
- **Quiet hours use the server's timezone, not the recipient's.** Deferring
  works — a message caught at 3am is parked and sent when the window opens — but
  there is no timezone recorded against a person, so somebody abroad is quiet
  during the server's night rather than their own.
- **Exactly-once delivery is not claimed.** Kafka is at-least-once and the
  ledger makes delivery idempotent, which is a weaker guarantee: a provider that
  accepts a message and then fails to return an id can still produce a duplicate
  at the far end.
- **Aggregate ratings are computed per request.** One extra grouped query per
  page. Denormalising onto `Listing` is the optimisation, at the cost of
  keeping it consistent.
- **The suite needs the real stack, and takes about seventeen minutes.** Nothing
  is mocked — 1,418 assertions across 40 suites drive a real Postgres, the real
  Express API, and a production build of the storefront under a real browser. The
  cost of that choice is that `npm test` cannot run against nothing: it needs a
  database, a Redis, and both servers up. See
  [CONTRIBUTING.md](../../CONTRIBUTING.md#before-you-push) and
  [backend/tests/README.md](../../backend/tests/README.md).
