# Tests

End-to-end suites that drive the real stack: Postgres, the Express API, the
Next.js BFF, and — for half of them — an actual browser.

```bash
npm test                  # everything (~6 minutes)
npm test -- api           # API suites only (~1 minute)
npm test -- browser       # browser suites only
npm test -- reviews       # any suite whose name matches
```

## Prerequisites

These are not unit tests. They need the stack running:

| | |
|---|---|
| Postgres | `docker compose up -d postgres redis` |
| Redis | same command — see below |
| API | `npm run dev` in `backend/` |
| Frontend | `npm run dev` in `frontend/` |
| Catalog | `npx prisma db seed` |

**Redis is optional but half of two suites depend on it.** Without `REDIS_URL`
the limiter falls back to per-process counters and the cache is disabled
entirely, so `ratelimit` and `cache` skip the sections that matter — the TTL,
the atomic increment, the failure policies, stale-while-revalidate. Set it for
BOTH the server and the test process, or the thing under test is not the thing
being asserted on:

```bash
REDIS_URL=redis://localhost:6379 npm run dev     # and again for npm test
```

**Kafka is optional and one suite is gated on it, the same way.** The pipeline
defaults to `NOTIFY_TRANSPORT=inline`, which hands events straight to the same
consumer functions in-process — so everything except the wire is under test
without a broker, and a fork's pull request needs no Kafka to go green. What a
broker alone can show is the tail of `retry-ladder`:

```bash
docker compose --profile messaging up -d
KAFKA_BROKERS=localhost:9092 npm test -- retry-ladder
```

Without it that section **skips loudly and names what went unproven**, rather
than passing quietly. A section that reports green for something nobody ran is
worse than no section, because it is believed.

It has now actually been run: 48 assertions with a broker against 38 without.
Worth saying because the first real run **failed** — the section produced its
messages after subscribing and lost a race with group assignment, which no
amount of sleeping would have fixed reliably. Gated code that has never
executed is not tested, it is only written.

**Start the API with `RELAY_IN_PROCESS=false` for a full run.**

```bash
RELAY_IN_PROCESS=false REDIS_URL=redis://localhost:6379 npm run dev
```

On the inline transport the API also runs the outbox relay. `outbox` drives
`relayOnce()` by hand and registers its spy consumer in the TEST process, so a
relay ticking in the API claims the same rows and hands them to its own
consumers — and the suite reports `one event published — 0`, which is true and
tells you nothing. Nothing else needs that relay; the delivery suites call the
consumers directly. The suite detects the clash and names it rather than
failing five assertions in a row.

**If you interrupt a run, put the catalogue back.** Cleanup is wired to
`SIGINT`, so Ctrl+C is handled — but a `SIGKILL`, an OOM kill, or a harness
stopping the process skips it, and the suites buy real listings. A listing left
`SOLD q=0` disappears from the shop, which is the failure this whole section
exists to prevent. Recovery, in order:

```bash
# 1. What was left behind?
#    Non-ACTIVE listings and rs2.* users are the two things that matter.
# 2. Delete the test accounts (this cascades their orders and reservations):
npx tsx -e 'import "dotenv/config"; import {purgeStaleTestData} from "./tests/lib/fixtures"; \
  purgeStaleTestData().then(n => console.log("purged", n))'
# 3. Restore any SEEDED listing left SOLD, by hand.
# 4. Drain the outbox by running the outbox suite once.
```

**Step 3 has no automatic fix, and two plausible ones do not work.**
`purgeStaleTestData()` deletes accounts only — it does not restore borrowed
listings, because the record of what they looked like beforehand lives in the
`Scope` of the process that died. And re-running `seed:scale` does not repair
them either: it uses `createMany({ skipDuplicates: true })`, so an existing row
is skipped rather than reset. Its deterministic PRNG makes re-runs generate
identical data; it does not make them heal mutated data. Restoring the original
stock level means replaying that PRNG, so in practice it is set back to
`ACTIVE` with quantity 1 and noted.

**Running suites individually with the relay off leaves rows that break
`outbox` later, and it looks like a real failure.** Almost every suite emits
notifications, each of which writes an `outbox_events` row. With
`RELAY_IN_PROCESS=false` nothing publishes them, so they accumulate — and
`outbox` drains *everything* unpublished rather than only its own row, then
reports `one event published — 51`. True, and nothing to do with the outbox.
Drain them by running `outbox` once and discarding the result; the next run is
clean. Worth doing before any run whose numbers you intend to quote.

**One assertion in `payment-safety` was flaky in a full run, and the reason is
instructive.** Section 2 borrowed *any* listing with at least one in stock and
then asserted it had sold **out** — `SOLD`, quantity 0 — which is only true of
a single-stock listing. That held for as long as the seeded catalogue was
entirely quantity-1, and started failing about one run in six once
`seed:scale` began giving 15% of listings a quantity of 2-4: the assertion fired
on a listing that had been correctly left `ACTIVE`. `claimListing` now takes
`exactQuantity`, and section 2 asks for exactly one. Section 2b is where the
multi-stock case belongs, and its own comment had already warned that the older
tests only passed because they "happened to pick quantity-1 listings".

**A separate assertion in `payment-safety` scans too broadly, and that one is
still open.** Section 10 checks that no card data is persisted by scanning
*every* order and order item in the database for the test card numbers — and
also for their last four digits, `4242` and `0002`. The full-PAN checks are
sound. The four-digit ones are not scoped to this suite's own rows, so they can
match a UUID or a provider reference another suite left behind: one full run
failed on `no trace of 0002` while the same suite passed standalone. It is a
scoping problem in the assertion, not a leak.

**Run a new suite against the STUB providers before pushing, whatever your
`.env` says.** CI sets `PAYMENT_PROVIDER=stub` and `KYC_PROVIDER=stub`; a local
`.env` pointing at Stripe test mode is a *more permissive* environment, and a
suite can pass there and fail in CI.

The difference that bites is not the network, it is where state lives. The stub
payment provider keeps intents in an in-process `Map`. A payment taken over HTTP
therefore sits in the **API's** memory, and anything that tries to refund it
from the test process looks in an empty one — every refund comes back "could not
confirm with the provider". Under Stripe there is no map and any process can
refund, so the same code passes.

`fixtures.ts` documents this on `ownListing`, which exists because of it. It
happened again anyway, in `return-routes`: an approval was driven by importing
`approveReturn()` directly, on the reasonable-sounding argument that the TOTP
step-up was another suite's job. It passed locally and failed CI with four
`refund-failed`s. The rule that follows:

> **Anything that has to reach the payment provider must be driven through the
> server that took the payment.** If that means a TOTP step-up in your suite,
> do the step-up.

```bash
PAYMENT_PROVIDER=stub KYC_PROVIDER=stub PAYOUT_PROVIDER=stub npm test -- <suite>
```

The API has to be started with the same values, not just the test process.

**`browser-dashboard` can fail on `/admin/catalogue` for want of CPU, not
correctness.** It navigates with `waitUntil: "networkidle"`, and the
authenticated catalogue table renders twenty-five `next/image` thumbnails of
remote photos. On a machine where the optimiser takes more than thirty seconds
to work through them, `networkidle` is never reached and the suite dies with a
`page.goto` timeout mid-run — every assertion before it having passed. The same
page settles in under a second when the optimiser has nothing to do. Measured,
and confirmed unrelated to any application change by reverting to a clean build
and reproducing it. If this fails for you and nothing else does, that is what it
is.

**`seed:scale` is not optional for `browser-catalog`.** It asserts a full second
page and at least a hundred distinct photos, which the base seed's twenty-seven
listings cannot satisfy. It is a real assertion about pagination, so it fails
rather than skips — run `npm run seed:scale` first, as CI does.

**Run `payouts` with `PAYOUT_PROVIDER=stub`, which is also the default.** The
suite claims payouts and issues transfers, and against `stripe_connect` those
would be real. It runs entirely below HTTP — no API needed — because what it is
about is the claim and the ledger rather than a route.

**Unset `KAFKA_BROKERS` unless a broker is actually up.** Pointing it at a dead
broker is a configuration mistake, not a reason to fail: `retry-ladder` skips
its broker section loudly and says which variable is stale.

The runner checks the rest before starting and prints one clear sentence if
something is missing, rather than producing forty confusing failures. That
matters — a stopped API once looked like a frontend bug for several minutes.

## Why they live here

They exercise the frontend as much as the backend, so `backend/tests` is a
slight misnomer. They are here because this is where the Prisma client and the
database credentials already are, and a third npm package for tests would cost
more than the naming inaccuracy does.

## Layout

```
lib/
  harness.ts        check(), suite runner, totals, exit codes
  db.ts             Prisma client, service preflight
  api.ts            HTTP client with a cookie jar
  fixtures.ts       accounts and listings, with cleanup that cannot forget
  browser.ts        Playwright helpers
  stripeWebhook.ts  correctly signed webhook delivery
  totp.ts           single-use authenticator codes
api/                fast, no browser
browser/            Playwright
run.ts              the runner
payment-safety.ts   concurrency and reconciliation; slow on purpose
```

## Cleanup is the part that matters

Every suite gets a `Scope`. It tracks the accounts and listings that suite
touched, restores exactly those, and its "is it clean?" check is scoped by
construction.

This is not tidiness. These suites buy real listings, and a bought listing is
marked `SOLD` and disappears from the shop. A half-finished run **silently
shrinks the catalog**, which happened three times during development — twice to
listings the site owner had created.

Two rules follow, and `Scope` exists to enforce them:

**Cleanup runs on every exit path.** It is in a `finally`, and wired to
`SIGINT`. It is not the last statement of the suite — a suite that throws
halfway is exactly when leftover data does damage, and Ctrl+C during the
60-second sweeper wait is the most likely way anyone will end a run early.

**Verification is scoped, never global.** Asking "are any listings SOLD?" or
"are there any orders?" reports a real user's genuine purchase as test residue.
That bug got written four separate times and sent me chasing a phantom leak
twice. There is deliberately no global variant of `verifyClean` to reach for,
because the global variant *is* the bug.

Test accounts all live under `rs2.<suite>.<name>@retailstore-2n.test`, a reserved
prefix, so the sweep at the start of each run can never match a real account.

## Conventions

**Call `main()` without `await`.** tsx compiles this project as CJS, where
top-level await is a hard transform error. `main()` exits the process itself.

**Assert what rendered, not what exists.** A suite once reported 20/20 green
while every image on the page was broken, because it checked that the `<img>`
element existed rather than that it had loaded. Use `brokenImages()`, which
checks `naturalWidth`.

**Put the actual value in the failure detail.** `check(ok, label, actual)` —
a failure that says only "expected true" costs a debugging round trip.

**Look at the screenshots.** Two real bugs were found this way and by nothing
else: a decline reason printed twice, and a "Verified purchase" badge on 1,792
reviews nobody had paid for. Both had passing text assertions over them.
Screenshots land in `tests/screenshots/` (gitignored).

## Slow environment looks exactly like test failure

The Next **dev** server is expensive here: measured at **1.1 GB and ~1.6s to
serve a warm `/search`** on a freshly started process, with a 900-listing
catalog. That is the floor, not degradation — it does get worse under sustained
load, but it starts slow.

That matters because a browser suite does twenty-odd navigations. One full run
took **1162s instead of 447s** and reported four failures; every one of them
passed when its suite was re-run alone, minutes later, against identical code.
The failures were `waitFor` timeouts and a hydration warning — both symptoms of
a struggling server, neither a code bug.

So: **if a browser suite fails, re-run it alone before believing it.** If it
passes alone, the environment failed, not the code.

The runner measures `/search` before starting and warns when the median exceeds
1500ms. It warns rather than refusing, because slow is not broken.

A production build (`cd frontend && npm run build && npm start`) is far faster
and worth using for a full run — with one caveat worth knowing: it sets
`NODE_ENV=production`, which turns off `dangerouslyAllowLocalIP` in
`next.config.ts`. Seller-uploaded photos served from `localhost:4000/uploads`
stop being optimised. Seeded listings use Unsplash and are unaffected, so most
suites do not notice, but a suite asserting on an uploaded image would.

## Slow suites

Two suites wait on real timers rather than faking them, because the timers are
the thing under test:

- `payment-safety` waits ~60s for the reconciliation sweeper to settle an
  abandoned payment.
- `browser-cart-badge` waits ~30s for a hold to expire on its own, with no
  reload, to prove the badge re-arms from the server's `nextExpiresAt`.

## Every suite is on the shared harness

`payment-safety.ts` was the last holdout — its own `check()`, its own Prisma
client, its own HTTP client, its own teardown. It was left alone twice on the
grounds that it worked, and it broke twice in the interval, both times in the
duplicated plumbing rather than in anything it was testing. It is now on
`Scope` and `Suite` like everything else.

It still talks to the Express API directly rather than through the BFF, via
`Scope.apiBuyer()`. That is deliberate: most of its cases fire several requests
at once to prove the claim serialises them, and a proxy hop in front of each one
spreads them out in time — which makes the race less likely to happen at all. A
test that can only pass is not measuring anything.

## Shared state outlives what a suite creates

Five suites have now failed **only inside a full run**, passing when run alone.
Every one had the same shape, and it is worth recognising early because a full
run is all CI ever does.

**Writes that land after the call returns.** `notify()` is fire-and-forget so a
notification failure can never fail the sale that raised it — which means the
row commits shortly *after* the function returns. Reading the inbox on the next
line is a race that usually passes. Use `awaitNotifications()` or
`awaitNotificationsForUser()` from `lib/fixtures.ts`.

**Rate-limit counters keyed on something stable.** Limits now live in Redis
rather than in the server process, which makes this worse rather than better:
they survive a server restart as well as a run. Several are keyed by email
rather than user id — deliberately, since deleting an account must not reset an
attacker's allowance — and Scope addresses are deterministic
(`rs2.<tag>.<name>@retailstore-2n.test`), so a suite that exhausts a budget poisons
that address for the length of the window.

`Scope.cleanup()` now clears `login:{email}` for every address the scope
created, because otherwise a suite that tests login throttling cannot run twice
inside fifteen minutes — the *second* run fails during setup, with a 429 while
creating a fixture, which looks nothing like the thing being tested. That is
exactly how `api/ratelimit.ts` broke itself.

Nothing else is cleared. `forgot:{email}` in particular is not, so where a
suite needs several hits on another rate-limited endpoint, still give it a
per-run address: ``scope.buyer(`forgot-${Date.now()}`)``.

Both failure modes report as something else entirely — a wording bug, a missing
row, a token that was not stored — so the cause is rarely where the failure
points.

## Authenticator codes are single-use

Any suite that signs in to the admin panel has to cope with this: finishing
enrolment spends a code, and inside the same 30-second period an authenticator
app shows the *same* six digits. Use `freshCode()` from `lib/totp.ts` for the
second entry — `currentCode()` twice in a row fails with "That didn't work" on a
code that is provably correct, which is a miserable hour to debug.

## Coverage

**1,263 assertions across 35 suites, all passing, in 696 seconds** — on the
providers `.env.example` ships, which is also what CI runs. Measured with
Postgres, Redis, the API and a production frontend build all up, and the outbox
drained first (see above).

**The total depends on the environment, and two variables move it a lot.**

*Redis.* Without `REDIS_URL` the `ratelimit` and `cache` suites skip most of
their sections and report 10 and 8 instead of 25 and 44 — 51 assertions that
look like they ran and did not.

*The payment and identity providers.* Against Stripe test mode the same suites
report **1,293 in 901 seconds** — also measured, not extrapolated from the
first. `identity` gains 3, `identity-stale` 7 and `browser-identity` 20, because
the sections asserting real Stripe behaviour stop skipping.

A higher number is not a better run, it is a different one. The stub figure is
the one quoted everywhere else, because it is what a fresh checkout and CI
produce — and quoting a number a reader cannot reproduce is worse than quoting a
smaller one. That mistake was made here: the README carried 1,287 for a while,
which was a local Stripe-mode measurement at a time when `.env.example` shipped
stub.

| Suite | Covers |
|---|---|
| `outbox` | notification and event commit together or not at all; two relays claim disjoint rows; a failed publish keeps the row |
| `retry-ladder` | 5s/1m/15m delay topics then the DLQ; the broker section is gated on a broker being up |
| `email-delivery` | the ledger claim before the provider, and what a refused send leaves behind |
| `push-delivery` | a 410 from the push service unsubscribes rather than retrying forever |
| `sms-delivery` | consent, verified numbers, the daily cap, and quiet hours deferring rather than dropping |
| `operations` | the lag and DLQ health reports, outbox retention, and the stale-PENDING sweep |
| `payouts` | the five payability conditions separately; the concurrent claim; refund before and after payout; a failed reversal becoming a debt |
| `payout-routes` | the same six endpoints over HTTP: every one refused before verification, and the gate not leaking onto its neighbours |
| `returns` | the five eligibility conditions separately; six simultaneous requests opening one; six simultaneous answers producing one; an approval whose refund fails being reverted |
| `return-routes` | the buyer's whole route over HTTP — ask, refuse, escalate, settle — and the four parties who must be turned away |
| `wishlist` | saving is inert; idempotent under concurrency; cross-user isolation |
| `reviews` | verified-purchase gate; one review per person; the badge is earned |
| `checkout-bff` | the proxy path a browser actually takes |
| `addresses-sales` | address book, one default enforced, the seller's own sales view |
| `notifications` | every event reaches the right person; unread count; read-all |
| `refunds` | automatic and moderator-issued; over-refund guard; async webhook, forged and replayed |
| `passwords` | change and reset; no enumeration; sessions revoked; TOTP survives |
| `refresh` | rotation, the concurrency race, and the four ways a replay is still theft |
| `ratelimit` | shared counters, atomic increment, both failure policies, login throttling |
| `cache` | hit/miss, TTL, stale-while-revalidate, negative caching, invalidation over HTTP |
| `storage` | both drivers; the browser's URL is not the server's; the bucket is not listable |
| `uploads` | a real photo through the BFF: EXIF stripped, re-encoded, resized, deletion reaches storage |
| `identity` | Stripe Identity, signed webhooks, the payout gate |
| `identity-stale` | a stub session left pending across a provider switch |
| `admin` | CLI grant, TOTP step-up, single-use codes, dashboard reads, audit trail |
| `payment-safety` | concurrent double-charge, reconciliation, no card data stored |
| `browser-catalog` | pagination, photo variety, nothing broken at scale |
| `browser-checkout` | the full purchase, and two copy bugs it caught |
| `browser-fulfilment` | shipping, tracking, delivery confirmation, cannot-send |
| `browser-admin` | the panel end to end: moderation actions and what they notify |
| `browser-dashboard` | the numbers match the database; orders, customers, catalogue |
| `browser-wishlist` | the heart is real, and honest when signed out |
| `browser-reviews` | writing, editing, deleting; keyboard star picker |
| `browser-identity` | the local capture form must NOT render under a real provider |
| `browser-cart-badge` | the count survives checkout and expires on its own |
