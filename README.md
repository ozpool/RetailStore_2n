# RetailStore_2n

[![CI](https://github.com/ozpool/RetailStore_2n/actions/workflows/ci.yml/badge.svg)](https://github.com/ozpool/RetailStore_2n/actions/workflows/ci.yml)

RetailStore_2n — repaired, not hidden. Wear and repairs are treated as part of
an item's history instead of something to hide.

A marketplace for secondhand furniture, clothing, and objects, where condition
is disclosed rather than hidden. Built as a full-stack TypeScript application:
a Next.js storefront, an Express API, and PostgreSQL.

## Stack

| Layer | Technology |
| --- | --- |
| Frontend | Next.js 16 (App Router), TypeScript, Tailwind CSS v4 |
| Backend | Node.js 24, Express 4, TypeScript, Zod |
| Database | PostgreSQL 16, Prisma 7 (driver adapters — no query engine binary) |
| Cache & counters | Redis 7 — rate limits and read-through caching |
| Auth | JWT access tokens + rotating opaque refresh tokens with reuse detection, bcrypt |
| Admin | CLI-granted role, TOTP step-up (`otplib`), separate short-lived session |
| Payments | Stripe PaymentIntents + Refunds, behind a provider seam with a stub |
| Identity | Stripe Identity, behind the same kind of seam |
| Payouts | Stripe Connect Express — separate transfers, behind the same kind of seam |
| Email | Nodemailer — console, Ethereal, or real SMTP |
| Notifications | Transactional outbox → Kafka (KRaft) → per-channel workers, behind an `inline`/`kafka` transport seam |
| Web push | VAPID / Web Push, with a service worker in the storefront |
| SMS | Twilio REST API, behind a provider seam with a stub |
| Images | Sharp (re-encode + metadata stripping) |
| Uploads | S3-compatible object storage (MinIO locally), or local disk |
| Backups | WAL archiving + base backups to object storage, PITR, a rehearsed restore |
| Delivery | Multi-stage Docker builds, Compose, Kustomize manifests with CloudNativePG, GitHub Actions CI |

## Quick start

**Prerequisites:** Node.js 20+ (developed on 24), Docker, npm.

### Everything, in one command

```bash
git clone https://github.com/ozpool/RetailStore_2n.git && cd RetailStore_2n
docker compose up --build
docker compose --profile tools run --rm seed   # 7 categories, 27 listings, reviews
```

The storefront is on http://localhost:3000, the API on http://localhost:4000, and
MinIO's console on http://localhost:9001 (`retailstore-2n` / `retailstore-2n-dev-secret`).

**If you browsed before seeding, the category shelf stays empty for a few
minutes.** Not a bug, and worth knowing before you go looking for one: the
category list is read through a Redis cache, and the seed writes straight to
Postgres — so nothing invalidates the entry that was cached while the database
was still empty. It expires on its own. `docker compose restart redis` clears it
immediately, or just seed first. Cache invalidation happens on writes *through
the API* ([ADR 0019](docs/adr/0019-cache-tiering-rule.md)), which a one-shot
seed job deliberately is not.

**Two of the seven containers exit immediately, and that is correct.** `migrate`
applies the migration history and `minio-init` creates the uploads bucket, both
running to completion before the API starts. Doing either at API startup is the
usual shortcut and it breaks the moment there is more than one replica —
several containers racing `migrate deploy`, or racing to set the same bucket
policy. Each maps directly onto a Kubernetes Job. A *running* migration
container would be the bug.

All images come from the single [`Dockerfile`](Dockerfile), selected by build
target — see [ADR 0023](docs/adr/0023-one-dockerfile-many-targets.md).

### Running the servers locally

Better for development — hot reload, and the test suite expects this.

```bash
docker compose up -d postgres redis   # just the datastores
```

```bash
cd backend
npm install
cp .env.example .env                  # then set JWT_SECRET
npx prisma migrate dev
npx prisma db seed
npm run dev                           # http://localhost:4000
```

```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev                           # http://localhost:3000
```

Sign up, and with the default `MAIL_TRANSPORT=console` the verification link is
printed to the **backend terminal** — paste it into your browser to activate the
account. Set `MAIL_TRANSPORT=ethereal` to have it delivered to a throwaway inbox
instead, or `smtp` with credentials to send for real.

## Testing

```bash
npm test                    # everything
npm test -- api             # only the API suites
npm test -- refunds         # any suite whose name matches
```

**1,418 assertions across 40 suites**, and they drive the actual stack — a real
Postgres, the real Express API, and a production build of the frontend under
Playwright. Nothing is mocked, because the bugs worth catching here live in the
seams between those pieces rather than inside any one of them.

Each suite runs as its own process, so one that hangs cannot take the others
with it. The interesting ones assert things a response cannot show you:

- **`payment-safety`** fires concurrent pay requests at one order and proves
  the card is charged once — the claim-then-charge conditional `UPDATE` either
  serialises them or it does not, and a 200 looks identical either way.
- **`ratelimit`** proves three instances enforce *one* shared limit of 10
  rather than three private limits totalling 30.
- **`cache`** writes through the API and then checks the key was **dropped**,
  not left to expire. A missing invalidation still returns correct-looking data
  for its whole TTL; it can only be caught by writing and reading again.
- **`refunds`** covers the async webhook path, including a forged signature and
  a redelivery.
- **`returns`** and **`return-routes`** cover the buyer's route to a refund: the
  five eligibility conditions separately, six simultaneous requests opening
  exactly one, six simultaneous answers producing exactly one, and an approval
  whose refund fails being reverted rather than left claiming money was on its
  way.
- **`payouts`** asserts each of the five payability conditions separately —
  including one whose only disqualification is that its order was never paid,
  which a query joining on delivery alone would happily hand a seller — then
  the concurrent claim, a refund before payout, a refund after payout, and a
  failed reversal becoming a debt the next payout nets off.

CI runs the whole thing on every push and pull request, against stub payment
and identity providers so that a PR from a fork — which cannot see repository
secrets — still gets a meaningful green run.

For a catalogue large enough to make pagination and search mean something:

```bash
npm run seed:scale          # 900 more listings across 30 sellers
```

### Measuring the infrastructure

Five scripts exist to make claims about scaling checkable rather than asserted.

```bash
REDIS_URL=redis://localhost:6379 npx tsx scripts/cache-demo.ts
```

Fires 120 requests across 120 distinct listing pages, cold then warm, against
the same process. Database transactions are counted from Postgres's own
`xact_commit` rather than by instrumenting the app — an app-side counter
measures what the code *believes* it did, and the question is whether the queries
reached the database at all.

|  | Cold | Warm |
| --- | --- | --- |
| p50 | 103ms | 8ms |
| p95 | 276ms | 23ms |
| Database transactions | 928 | 0 |

```bash
docker compose --profile ha up -d postgres-replica
npx tsx scripts/replication-demo.ts
```

Checks the four things that have to be true of a standby — a second Postgres
that starts without error is indistinguishable from an empty database nobody is
streaming to, since both are healthy and both answer queries. Then commits five
rows on the primary and times their arrival: **median 11.1ms**.

It also states what replication is *not*. A standby copies `DROP TABLE orders`
faithfully and in milliseconds — that is it working correctly. Surviving a
mistake is a different mechanism:

```bash
docker compose --profile tools run --rm base-backup   # once
npx tsx scripts/restore-drill.ts
```

Creates a table, fills it, notes the time, forces the WAL segment into object
storage, **drops the table**, then recovers to the instant before and counts
both databases:

```
                                            LIVE      RESTORED
  restore_drill.canary rows                 gone           500
  listings                                   927           927
```

The restore goes into a second container on port 5435, never over the live one —
a rehearsal that causes an outage is a rehearsal nobody performs, and one nobody
performs is worthless during an incident. Rehearsed three times consecutively,
clean each time, because the bar is not that a restore worked once but that it
is boring. See [ADR 0020](docs/adr/0020-replication-and-backups.md).

```bash
# three API instances, sharing nothing
for p in 4001 4002 4003; do PORT=$p npm start & done

npx tsx scripts/ratelimit-demo.ts \
  --targets http://localhost:4001,http://localhost:4002,http://localhost:4003
```

Spreads 40 password-change attempts round-robin across three API instances
against a stated limit of 10 per 15 minutes. Sharing nothing, **30 get through**
— each instance enforcing its own count correctly while the aggregate is wrong.
Sharing Redis, 10 do. See [ADR 0019](docs/adr/0019-cache-tiering-rule.md) and
[ADR 0018](docs/adr/0018-redis-for-shared-ephemeral-state.md).

```bash
docker compose --profile messaging up -d kafka
npm run build            # the consumers are the compiled build

NOTIFY_TRANSPORT=kafka KAFKA_BROKERS=localhost:9092 \
  npx tsx scripts/notification-throughput-demo.ts
```

Pushes 10,000 notifications to 500 distinct recipients through the real email
consumer group, at five consumer counts. The topic is drained onto the broker
before the clock starts, so these are consumer-side figures — the relay's own
rate is reported separately.

| Consumers | p50 | p95 | Events/sec | Assigned partitions |
| --- | --- | --- | --- | --- |
| 1 | 56.3s | 88.3s | 109 | 1/1 |
| 3 | 47.8s | 71.1s | 136 | 3/3 |
| 6 | 38.0s | 54.5s | 174 | 6/6 |
| 12 | 33.8s | 50.0s | 189 | 12/12 |
| 15 | 33.1s | 52.6s | **170** | **12/15** |

**Three results here are unflattering, and they are the interesting ones.**

*Twelve times the consumers buys 1.7x the throughput.* 109/sec to 189/sec.
Measured on 4 CPUs with each consumer a separate process, so past roughly four
they contend for cores — some of that flattening is the machine, not the design.

*The broker is nowhere near the bottleneck.* The relay publishes at
**3,400–4,600/sec** while the consumers drain at 109–189/sec: a gap of more than
twenty times. What is slow is the per-event database work inside the consumer,
which means the throughput half of the case for Kafka is the weakest half. At
this volume a table and a worker really would do — which is what
[plan 0001 §9](docs/plans/0001-multi-channel-notifications.md) already conceded.
Kafka earns its place on fan-out, failure isolation, and replay instead.

*Past 12 consumers the extra ones do nothing, and throughput gets worse.* At 15
the broker assigned main-topic partitions to **12 of 15** — three consumers idle
against a 12-partition topic — and the rate fell from 189 to 170. That figure
comes from asking the broker which member owns which partition, not from
inferring a ceiling from the curve, because a slow machine produces the same
curve for an entirely different reason.

```bash
NOTIFY_TRANSPORT=kafka KAFKA_BROKERS=localhost:9092 \
  npx tsx scripts/consumer-failure-demo.ts
```

SIGKILLs a consumer mid-batch — not SIGTERM, which is handled and therefore
uninteresting — and counts what it cost. Killed with **2,215 of 3,000 events
still outstanding**:

```
  duplicate deliveries                           0
  lost events                                    0
    of which stuck PENDING                       0
```

Both halves of one trade. The offset is committed *after* the handler returns,
so a consumer that dies mid-send redelivers rather than losing the work — and
that is only survivable because the ledger's unique constraint refuses the
second claim. Commit-first loses; no-constraint doubles.

The script also prints what the run did **not** prove: nothing was killed inside
the window between claiming a delivery and settling it, so no row was left
`PENDING`. That window is real, and the per-channel sweeper
[ADR 0026](docs/adr/0026-delivery-idempotency.md) specifies for it is still
unbuilt.

```bash
KAFKA_BROKERS=localhost:9092 npx tsx scripts/dlq-replay.ts           # report
KAFKA_BROKERS=localhost:9092 npx tsx scripts/dlq-replay.ts --commit  # replay
```

An operator tool rather than a demo, because a dead-letter queue nobody can
drain is a slower way of losing messages. It reports by channel and by reason,
checks each entry against the ledger — replayable, already sent since, or no row
at all — and does nothing without `--commit`.

Replay goes to the **5s retry rung, not the main topic**, and that detail is
load-bearing: a DLQ entry already has a `FAILED` ledger row, and the main topic
is consumed with the strict claim, so a message put back there collides with its
own row and is silently dropped while the logs show a successful replay. Only a
retry rung is consumed with reclaim. Verified end to end: replayed, picked up one
rung later, `SENT` with `attempts=2`.

```bash
PAYOUT_PROVIDER=stub npx tsx scripts/payout-safety-demo.ts
PAYOUT_PROVIDER=stub npx tsx scripts/payout-safety-demo.ts --lines 20 --racers 16
```

Kills a process in the gap between claiming a payout and transferring it. Not a
simulated failure — a child process claims the payout and then **SIGKILLs its
own pid**, so the row is committed by a process that no longer exists and gets
no chance to roll back, retry, or finish the transfer. It refuses to run unless
`PAYOUT_PROVIDER=stub`.

Three numbers that have to hold together, at 6 lines and at 20, with up to 16
concurrent payout attempts:

```
  paid twice              $0.00
  lost to the crash       $0.00
  left in limbo           0 payouts

  payout_items rows       21
  distinct order items    21
```

*Not paying twice is the easy half.* The claim is committed **before** the
provider is called, so a crash in between leaves money reserved and unsent —
owed rather than lost. That only works because something comes back for it:
`sendPendingPayouts()` finishes the stranded claim, and running it a second time
considers nothing, because nothing is left `PENDING`. Reverse the ordering and
you trade limbo for double-payment; drop the sweeper and you trade
double-payment for limbo. Both halves, or neither.

Of 16 simultaneous attempts on one payable line, **1 sent and 15 were refused**,
and the line appears in exactly one payout. `payout_items.orderItemId` is unique,
so the transaction that inserts first wins and every other one rolls back its
whole payout.

**Duplicates are counted without trusting the constraint that prevents them.**
The figure is `payout_items rows - distinct(orderItemId)`, so dropping the unique
index tomorrow would make this script report the duplicates it allows rather
than report zero because the index made the query impossible to fail. Same
reasoning as `consumer-failure-demo.ts`.

What it does **not** prove: nothing here reached Stripe. Every transfer above
was issued by the stub, so this demonstrates the claim ordering and the
constraint — not that Connect behaves as assumed.

```bash
./k8s/failover-demo.sh
```

Deletes the Postgres primary and counts what it cost. Verified on kind:

```
  promotion took           199s
  write after failover     HTTP 201
  rows found in the new primary  2 of 2  (one written before, one after)
  api restarts             0 -> 0
```

*Two of two is the number that matters.* A storefront returning 200 proves
nothing — a cached page does that with no database at all. So a row is written
**before** the kill and another **after** it, and both are read back out of the
promoted instance by name.

*Zero restarts is the other one.* Prisma's pool followed the `-rw` Service to the
new primary on its own. Had it cached the old address, an orchestrator would
have restarted the pod and the demo would have passed while hiding the
interesting part — which is why the restart count is measured rather than
assumed.

199 seconds is slow, on one node with no free memory, and the script prints it
rather than smoothing it over. A promotion is a short automatic outage, not an
invisible one.

