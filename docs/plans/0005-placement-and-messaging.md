# Plan 0005 — Letting the platform choose, and letting a seller ask

- **Status:** all seven phases landed 2026-09-11.
- **Written:** 2026-09-11
- **Produces:** ADR 0033 (messaging), ADR 0034 (paid placement)

---

## 1. Where this stands today

Two gaps that turn out to be one feature.

**Nobody can choose what is on the homepage.** `page.tsx` derives all four
shelves — reduced, top rated, new arrivals, everything — and a moderator has no
say in any of them. `Listing.featured` exists, is indexed, carries a comment
explaining that it is hand-curation, and is written by nothing.

**A seller cannot talk to the platform.** All eleven notification types are
one-way. There is no reply path anywhere in the application, so "ask us about
appearing on the homepage" has no destination.

The second gap is why the first one cannot simply be an admin checkbox: the
feature the product actually wants is a seller *asking*, and somebody
*answering*.

## 2. What is being built

```
seller picks a listing, names a slot and an amount
        │
        ↓
PlacementRequest  ──────────────►  MessageThread  (the negotiation lives here)
  REQUESTED                              │
        │                                │  admin counters: amount, period, slot
        │◄───────────────────────────────┘
        ↓
  AGREED  ──(claim the slot)──►  LIVE  ──(period ends)──►  ENDED
        │                          │
        │                          └── listing sells → stops rendering, stays LIVE
        ↓
  DECLINED / WITHDRAWN
```

Money is **not** charged. The agreement is a record; settlement happens off
platform ([ADR 0034](../adr/0034-paid-homepage-placement.md)).

Everything on the homepage that is there because of an agreement carries a
**Promoted** label. That is a requirement of the feature, not a phase that can
slip.

## 3. Schema additions

Two enums and three tables. No changes to any existing table except
`Listing`, which gains a back-relation.

```prisma
enum PlacementSlot {
  HERO          /// One at a time: the banner at the top of the homepage.
  PICKED_SHELF  /// Four positions on the "Picked for you" shelf.
}

enum PlacementStatus {
  REQUESTED   /// The seller asked. Nobody has answered.
  COUNTERED   /// An admin proposed different terms. Back with the seller.
  AGREED      /// Both sides agreed. Not live yet.
  LIVE        /// On the homepage now. Claimed — see the partial unique index.
  ENDED       /// The period ran out. Terminal.
  DECLINED    /// An admin said no. Terminal.
  WITHDRAWN   /// The seller pulled it. Terminal.
}

enum ThreadKind { PLACEMENT  SUPPORT }
enum MessageAuthor { SELLER  ADMIN }

model MessageThread {
  id        String     @id @default(uuid())
  sellerId  String
  seller    SellerProfile @relation(fields: [sellerId], references: [id], onDelete: Cascade)
  kind      ThreadKind
  subject   String

  /// Denormalised so the thread list sorts without touching messages.
  lastMessageAt DateTime @default(now())
  closedAt      DateTime?

  /// Two counters, not a read-receipt table: there are exactly two sides and
  /// one of them is a role. ADR 0033 records what this costs.
  sellerUnread Int @default(0)
  adminUnread  Int @default(0)

  messages  Message[]
  placement PlacementRequest?

  @@index([sellerId, lastMessageAt])
  @@map("message_threads")
}

model Message {
  id       String        @id @default(uuid())
  threadId String
  thread   MessageThread @relation(fields: [threadId], references: [id], onDelete: Cascade)
  author   MessageAuthor

  /// No FK, deliberately: "an admin who has since been deleted wrote this"
  /// must stay answerable. Same reasoning as notification_deliveries.
  authorUserId String?

  body      String
  createdAt DateTime @default(now())

  @@index([threadId, createdAt])
  @@map("messages")
}

model PlacementRequest {
  id        String @id @default(uuid())
  listingId String
  listing   Listing @relation(fields: [listingId], references: [id], onDelete: Cascade)
  sellerId  String
  seller    SellerProfile @relation(fields: [sellerId], references: [id], onDelete: Cascade)

  slot     PlacementSlot
  /// 0 for HERO; 0-3 for the shelf. Part of the live-slot claim.
  position Int @default(0)

  /// Whole cents, like every other amount in this schema (ADR 0005).
  offeredCents Int
  agreedCents  Int?

  startsAt DateTime?
  endsAt   DateTime?

  status     PlacementStatus @default(REQUESTED)
  decidedById String?        /// no FK, same reasoning as Message.authorUserId
  decidedAt   DateTime?

  /// The conversation carrying the negotiation. One thread per request.
  threadId String        @unique
  thread   MessageThread @relation(fields: [threadId], references: [id])

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([status, slot, position])
  @@index([sellerId, status])
  @@map("placement_requests")
}
```

And one thing Prisma cannot express, added by hand to the migration:

```sql
CREATE UNIQUE INDEX placement_live_slot
  ON placement_requests (slot, position)
  WHERE status = 'LIVE';
```

That index **is** the concurrency guard. Activating is
`UPDATE … SET status='LIVE' WHERE id=$1 AND status='AGREED'`, and two admins
activating two hero agreements at once produce one success and one
unique-violation.

## 4. Phases

| # | What | Done when |
| --- | --- | --- |
| 0 | Decide. ADR 0033 and ADR 0034. | **Recorded 2026-09-11** |
| 1 | Schema + migration, including the hand-written partial unique index. | **Landed 2026-09-11** — see the note below |
| 2 | `lib/messaging.ts` — open a thread, post a message, mark read, close. Two new notification event types wired through the outbox. | **Landed 2026-09-11** — 38 assertions in `tests/api/messaging.ts` |
| 3 | `lib/placement.ts` — request, counter, agree, activate, end, decline, withdraw. Every transition a conditional `UPDATE`. | **Landed 2026-09-11** — 43 assertions, and the race proven to fail without the index |
| 4 | Seller routes: request placement, list threads, read, reply. Admin routes: the placement queue, counter, decide, activate. | **Landed 2026-09-11** — 45 assertions in `tests/api/placement-routes.ts` |
| 5 | Homepage reads live placements. **Promoted label on the hero and the shelf card.** Sold listings drop out. | **Landed 2026-09-11** — 21 assertions in `tests/api/promoted-homepage.ts`, against the rendered HTML |
| 6 | Seller and admin UI: a thread view, a placement request form, an admin merchandising screen. | **Landed 2026-09-11** — 16 assertions in `tests/browser/placement.ts`, the whole negotiation in Chromium |
| 7 | Sweeper: `AGREED` → `LIVE` when `startsAt` arrives, `LIVE` → `ENDED` when `endsAt` passes. Sixth in-process sweeper. | **Landed 2026-09-11** — proven on a timer in the suite, and against the running API |

### Phase 1, and what it cost

Three tables, two enums for placement, two for messaging, and 133 lines of
hand-written SQL. `migrate deploy` applied it clean as the 25th migration.

**The index was tested before anything was built on it**, because an untested
constraint is a comment. Two `AGREED` hero placements, then two activations:

```
UPDATE ... WHERE id='p1' AND status='AGREED'   →  UPDATE 1
UPDATE ... WHERE id='p2' AND status='AGREED'   →  ERROR: duplicate key value
                                                  violates unique constraint
                                                  "placement_live_slot"
                                                  Key (slot, "position")=(HERO, 0)
```

Then both rows to `ENDED` on the same slot — `UPDATE 2`, confirming the index
really is partial and terminal history is unconstrained.

**The typechecker found the consequence I had not planned for.** Adding two
`NotificationType` values broke `lib/channelPolicy.ts`, whose `POLICY` is a
`Record<NotificationType, Policy>` — exhaustive on purpose, so a new event
cannot ship without somebody deciding which channels it uses. That is the table
working as designed: it turned "I forgot the consent defaults" into a compile
error rather than an event that silently reaches nobody. Both new types are
`EMAIL: on, PUSH: on, SMS: off`; the SMS boundary from
[ADR 0027](../adr/0027-notification-consent.md) holds, since only money moving
unexpectedly earns a text.

**One thing that turned out to be free.** Notification content is passed in by
the caller — `notify({ type, title, body })` — rather than looked up from a
per-type template map, so there is no template table to extend. Phase 2 only
has to call it.

**Worth knowing before phase 2:** `npm run lint` is `--max-warnings 195` and the
repository currently sits at exactly 195. It passes, with nothing to spare, so
the next phase that adds an unhandled promise or an `any` will fail CI on the
ceiling rather than on its own merits.

### Phase 2, and what it cost

`lib/messaging.ts`, 393 lines, and a 38-assertion suite. Green, and so are the
three suites the work touched indirectly: returns 43, email-delivery 26,
outbox 28.

**The interesting decision was not to use `notify()`.** Every other caller in
the codebase does, and it is wrong here: `notify()` opens its own transaction
and swallows its own errors, which is correct when the notification is a side
effect of something more important. A message has nothing more important behind
it, so the message, the counters, the notification and the outbox event commit
in one transaction and a failure reaches the caller. `enqueue(tx, …)` takes a
transaction client precisely so this cannot be written as a dual write — the
signature is the enforcement.

**Implementation forced a decision the ADR had not made.** "The admin side is a
role" does not say who receives the notification, because a notification needs a
`userId`. Answer: every non-suspended `ADMIN`, one event each. Recorded in
ADR 0033 rather than left in the code, along with the two rejected alternatives
and the cost.

**The suite asserts against the real admin population**, not against the two
moderators it creates. Other suites and the seed leave admins behind, so
`liveAdminIds` is read from the database at fixture time and the fan-out is
compared to that. Hard-coding 2 would have passed today and broken the first
time somebody seeded another moderator.

**One cleanup taken rather than a third copy made.** `isUniqueViolation` existed
twice — in `deliveryLedger.ts` and `returns.ts` — and the two had already
drifted, one checking Postgres's `23505` as well as Prisma's `P2002` and the
other not. The placement work needs it a third time, so it is now
`lib/pgErrors.ts` with the union of both behaviours, and both original callers
import it. The drift mattered: the partial unique index on live placements is a
constraint Prisma does not know about, so it raises `23505`, which the narrower
copy would have rethrown as an unexpected error.

### Phase 3, and what it cost

`lib/placement.ts`, 560 lines, 43 assertions. The sweeper from phase 7 is
written here too, since it is two queries and the suite could prove it now.

**The race assertion was checked by breaking it.** A test that cannot fail is
decoration, so the index was dropped and the suite re-run:

```
[4. two agreements, one slot, activated in parallel]
  PASS  two agreements both reached AGREED for HERO position 0
  FAIL  exactly one activation won — 2 won
  FAIL  and the other was told the slot was taken — 0 reported slot-taken
  FAIL  one LIVE row in the database — found 2
```

Two live heroes, which is the exact bug ADR 0034 exists to prevent. Index
recreated, suite green again. **It also had to be `Promise.all`** — two
sequential `activate()` calls pass against an implementation with no constraint
at all, because the second one sees the first row already `LIVE`.

**The dedupe from phase 2 paid for itself here.** The partial index is a
constraint Prisma does not know about, so it raises Postgres's `23505` rather
than Prisma's `P2002`. The narrower copy of `isUniqueViolation` that used to
live in `returns.ts` would have rethrown it as an unexpected error, and the
loser of a slot race would have been a 500 instead of a queued placement.

**One decision the ADR had not made:** what the loser of a race gets. It returns
`slot-taken` and stays `AGREED` rather than failing, which is what makes queuing
work without anybody re-requesting — and is why `sweepPlacements()` activates
one row at a time rather than in a single `updateMany`, since a bulk update of
everything due would take the whole batch or none of it.

**One notification per action.** A counter-offer is both a message and a
commercial decision, and announcing it twice is how a channel gets muted. So
`writeMessage` gained an optional notification type and placement transitions
raise `PLACEMENT_DECIDED` in place of `MESSAGE_RECEIVED`, with the terms in the
message body — the thread reads as a negotiation rather than a status log.

### Phase 4, and what it cost

Two routers — `sellerMessaging.ts` (9 endpoints) and `adminPlacement.ts` (12) —
and a 45-assertion suite that drives the whole negotiation over HTTP: seller
asks, moderator counters, seller accepts, moderator activates, moderator ends.

**The admin routes are mounted INSIDE `admin.ts`, below
`adminRouter.use(requireAdmin)`.** Mounting them separately at `/admin` from
`index.ts` would have looked identical and been completely unguarded, because a
separate router does not inherit another router's middleware. The file says so
at the top, since it is the sort of thing that gets "tidied up" later.

**Both `use()` calls in the seller router name their path**, and the suite opens
by proving the neighbours still answer:

```
[1. the new router did not lock its neighbours out]
  PASS  GET /seller/sales still answers 200
  PASS  GET /seller/verification still answers 200 — the door an unverified seller needs
  PASS  GET /seller/listings still answers 200
```

That is not a theoretical risk. An unscoped `use()` in a router mounted at
`/seller` broke every sibling route with a 500 once already, and the feature's
own tests did not notice — `identity.ts` caught it. Both `identity` (44) and
`payout-routes` (62) were re-run here and are green.

**The lint ceiling moved, by the procedure the config documents.** 195 → 218,
with a note in `eslint.config.mjs` beside the existing one, because
`no-misused-promises` is a warning by deliberate choice and the ceiling exists
to make growth visible rather than to prevent it. All 23 are async Express
handlers, the same shape as the 133 before them. The check that mattered: zero
new warnings in `lib/messaging.ts`, `lib/placement.ts` or any of the three
suites. Route handlers growing the count is expected; anything else would mean
the pattern had spread.

**One thing the routes say out loud that the UI could have kept to itself.**
`GET /seller/placements/slots` returns a `disclosure` field —
*"Paid placements are labelled “Promoted” wherever they appear."* A seller
agreeing to pay is entitled to know that before they agree, and a client that
forgets to render it should not be the only thing standing between them and a
surprise.

**Authorisation, stated as the suite asserts it:** a signed-out request is 401;
a buyer reaching a seller route is refused; another seller asking about your
listing, thread or placement gets **404, never 403**, so an id cannot be used to
ask whether a rival's thing exists; and declining a request without a reason is
a 400, for the same reason refusing a return requires one.

### Phase 5, and what it cost

`GET /catalog/promoted` (uncached, deliberately — a placement going live is a
window somebody bought, and a sixty-second cache spends the first minute of it),
`getPromoted()` in the frontend catalog lib, the label on the banner and the
card, and a 21-assertion suite that reads the **server-rendered HTML** rather
than the endpoint. The endpoint saying `promoted: true` proves nothing about
what a viewer sees.

**The ADR was wrong about where the shelf was, and had to be amended.** It named
"the Picked for you shelf", which does not exist — that eyebrow sits on Best
Rated, a *derived* shelf that the ADR's own rule forbids putting paid placement
into. The slot now renders as its own row.

**Three assertions in this suite were too weak, and two of them passed while the
feature was broken.** Worth recording in full, because it is the same mistake
three times — asserting something adjacent to the claim instead of the claim:

1. *"the unpromoted listing is not in the hero"* — failed immediately, and the
   assertion was wrong rather than the code: a brand-new listing is the newest
   in the catalogue, so the hero's `discounted[0] ?? everything[0]` fallback
   shows it, unpromoted and unlabelled, which is correct.
2. *counting `/Promoted/`* — matched the word inside React's serialized props in
   the flight payload, so the baseline was never zero.
3. *counting `>Promoted<` and asserting "at least two"* — the promoted row's own
   **eyebrow** renders `>Promoted<` too, so hero + eyebrow satisfied it. Proven
   by disabling the card's label and watching the suite pass anyway.

The fix classifies each occurrence by the markup around it and asserts per
surface. Re-checked by disabling the card label again:

```
  PASS  the BANNER carries the label
  FAIL  and so does the CARD, separately — {"hero":1,"card":0,"eyebrow":1}
```

The label is the one part of this feature that is a legal requirement rather
than a product preference, and it is the easiest thing in it to lose silently —
the flag crosses a table, an endpoint, a fetch, a page, a shelf and a card, and
any one of them dropping it leaves a deceptive page with nothing red anywhere.

**Lint 218 → 219**, one handler, noted in the config as the procedure requires.

### Phase 6, and what it cost

Four pages — `/seller/messages`, `/seller/placements`, `/admin/messages`,
`/admin/placements` — one shared `ThreadView`, a `messagingApi` client, and
additions to `adminApi`. Both navs link to them, because a feature nobody can
find is indistinguishable from a feature that does not exist. Production build
clean; the browser suite drives the real sequence with two logged-in parties:
seller asks → moderator counters → seller accepts → moderator activates → the
label appears on the homepage.

**THE BROWSER TEST FOUND A REAL BUG, which is the entire reason for writing
one.** The moderator queue's default tab filtered to `REQUESTED | COUNTERED`,
and "Make it live" only renders on an `AGREED` row — so the filter hid exactly
the rows with the button. Every negotiation would have completed and then
stalled in a state nobody looks at. Nothing else caught it: the library suite
tested `placementQueue` against the filter it was given, and the route suite
never asked what a moderator would actually see.

The fix is a second constant, `NEEDS_ADMIN`, separate from the transition guard
`AWAITING_ADMIN`, because "what a moderator can answer" and "what needs a
moderator's hand" are genuinely different sets. The tab is now labelled
"Needs you".

**Three assertions of mine were wrong again, and the pattern is worth naming.**
All three asserted something adjacent to the claim:

- Looking for `LIVE` in the queue after activation. Activating moves the row
  *out* of that tab by design — it no longer needs anybody. The live-slots card
  at the top of the screen is what proves it, which is why that card is the
  first thing on the page.
- `/Promoted/` against `innerText`. Chromium returns the **rendered** text and
  both labels are `uppercase` in CSS, so the browser reports `PROMOTED`. A
  correctly-labelled page failed a case-sensitive match.
- Not naming the pre-login phase `pre-login`, which is the exact string
  `realFailures()` exempts — so the auth probe's expected 401 counted as a
  failed request.

**One environment lesson, twice.** The API runs as `tsx src/index.ts` with no
watcher, so editing a library and re-running a suite tests the OLD code. It cost
a confusing failure in phase 5 (`/catalog/promoted` returning HTML) and another
here (the queue still filtering the old way). Restart the API after touching
`src/`.

**One accommodation, stated so it is not mistaken for a fix.** The browser suite
warms `/seller/placements`, `/seller/messages` and both admin routes with a
plain fetch before opening Chromium. Against a dev server the first request to a
route compiles it — about sixty seconds here — which blew Playwright's 30s
navigation timeout on pages that work fine once built. The warm-up removes a
one-off compile from the middle of a journey the suite is trying to time; it is
not hiding a slow page.

### Phase 7, and what it cost

`startPlacementSweeper()`, every 60 seconds, started in `index.ts` beside the
other five. The logic already existed from phase 3, so this phase was the timer
and the proof that it runs.

**In-process on every replica, not a CronJob**, and the distinction is the one
[ADR 0032](../adr/0032-kubernetes-manifests.md) drew. The payout job is
scheduled because it *moves money to a third party* and wanted an exit code and
a record. This one changes a status on a row we own. Ending is a conditional
`updateMany` and activating is a claim against the partial unique index, so N
replicas sweeping at once produce one winner per slot and the losers report
`slot-taken` — nothing done twice, nothing done N times.

**Proven three ways, because "written but never invoked" is a mistake this
repository has already shipped once** — a sweeper existed, the README said it
ran, and nothing called it:

1. The suite starts it at a 300ms interval and polls: `AGREED → LIVE`, then
   `LIVE → ENDED` after the window is backdated, with nothing pressed.
2. It asserts `src/index.ts` actually contains `startPlacementSweeper()`. A
   blunt check, and the only one that fails when somebody deletes the call.
3. It stops cleanly — after `stop()`, three intervals pass and nothing moves,
   so a suite that starts one cannot leak a timer into the next.

And then the real thing: the API was restarted, an `AGREED` placement due an
hour ago was left in the database, and nobody touched it.

```
AGREED and due: b504ae89-2b39-49ad-8068-ce6988b529c0
THE RUNNING API ACTIVATED IT ON ITS OWN after at most 90s (status LIVE)
```

with the API's own log line confirming it from the other side:

```
Placements: 1 live, 0 ended, 0 waiting for a slot
```

`blocked` is in that line deliberately: a nonzero value is not a fault, it is a
placement queued behind a live one, and a reader seeing it should not have to
look that up.

**Lint 219 → 220**, one `setInterval` with an async tick — identical to the five
sweepers already in the count, and noted in the config as the procedure
requires.

## 5. What this deliberately does not do

Stated here so the next person does not go looking.

- **No card is charged.** The platform can agree a fee and cannot collect one.
  ADR 0034 records why, and this is the largest gap the feature ships with.
- **No buyer ↔ seller messaging.** ADR 0033 records why; abuse handling and
  contact-detail scrubbing are the real cost, not the table.
- **No realtime.** A reply arrives as a notification on the channels the
  recipient already consented to.
- **No overlapping-period booking.** Two agreements cannot be booked for
  consecutive future weeks on the same slot; the live claim is the only guard.
- **No assignment or SLA.** A thread is open or closed. This is not a support
  desk.
- **No auction.** Sellers negotiate, they do not bid against each other.

## 6. Counts this will move

The repository states its own size in several places, and adding two
notification event types makes every one of them stale:

| Claim | Before | After | Updated in |
| --- | --- | --- | --- |
| Notification event types | 11 | **13** | `channelPolicy.ts` is exhaustive, so the compiler insisted |
| Tables | 28 | **31** | `lld.md` |
| Decision records | 32 | **34** | `README.md`, `docs/adr/README.md` (both rows added) |
| Routers | 16 | **18** | `README.md` |
| In-process sweepers | 5 | **6** | `README.md`, `hld.md` |
| Assertions / suites | 1,263 / 35 | **1,418 / 40** | `README.md` ×3, `hld.md` |
| Suite runtime | ~13 min | **~17 min** | `hld.md` |

All measured in one clean run rather than added up:

```
1418 passed, 0 failed across 40 suites   1033s total
```

The first attempt at that run reported `1390 passed, 1 failed`, and the failure
was environmental rather than a defect: the `outbox` suite has a pre-flight
guard that detects a competing relay, and the API left running for the browser
suites had `RELAY_IN_PROCESS=true`, so its in-process relay was draining the
rows the suite wanted to claim. Restarted with `RELAY_IN_PROCESS=false` and
re-run whole, because 1,390 + the outbox suite's 28 from a different run is
arithmetic, not a measurement.

Two documentation gaps turned up while doing this, both worth more than the
numbers:

- **`docs/api.md` documents every router exhaustively**, so it was missing five
  endpoint families. Added, including why `disclosure` is in the API response
  and why `SLOT_TAKEN` is a 409 rather than a 500.
- **`lld.md` indexes every `lib/` module** and claimed `notifications.ts` has
  "eleven call sites" — wrong twice over. It now records that `lib/messaging.ts`
  deliberately does not use `notify()`, and there is a new
  "messaging and merchandising" group for the three new modules.

`README.md`, `docs/api.md`, `docs/architecture/lld.md`, `docs/architecture/hld.md`
and the published architecture reference all carry at least one of these.
