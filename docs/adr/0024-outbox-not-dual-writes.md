# 24. Transactional outbox, not dual writes

- **Status:** Accepted — implemented 2026-09-04 (plan 0001, phase 1).
  `prisma/schema.prisma` (`OutboxEvent`), `lib/outbox.ts`, `lib/relay.ts`,
  `src/relay.ts`. Covered by `tests/api/outbox.ts`.
- **Recorded:** 2026-09-04

## Context

Notifications are in-app only. `Notification` is the source of truth, eleven
call sites emit through `events.*`, and nothing anywhere delivers to a channel
outside the app.

Adding email, push, and SMS means one event has to reach several places. The
obvious implementation publishes to a broker from inside `notify()`, next to the
row insert:

```ts
await prisma.notification.create({ data });   // 1
await producer.send({ topic, messages });     // 2
```

That is a dual write: two systems, no transaction spanning them. There is no
ordering of those two lines that is correct.

**Row first, publish second.** A crash between them leaves the notification in
the app and nothing on the broker. The buyer sees "refunded" in their
notification list and never gets the email or the text. Nothing records that a
publish was owed, so nothing can retry it — the only evidence is the absence of
a message nobody knew to expect.

**Publish first, row second.** Worse. The transaction that was going to write
the row can still roll back, so an email goes out for a sale that did not
happen. This is not hypothetical here: `notify()` is called from payment,
fulfilment, and moderation paths, and `notifyMany()` is called from order
creation, which is inside a transaction that can fail.

**Both writes in one try/catch.** Does not help. The failure is not an exception
in the process; it is the process ending, or the network partitioning, between
two operations that were never atomic to begin with.

This class of bug is rejected everywhere else in this codebase. Stock is decided
under `SELECT … FOR UPDATE` ([ADR 0012](0012-row-locking-for-reservations.md)).
An order is claimed with a conditional `UPDATE` before Stripe is called
([ADR 0013](0013-payment-provider-seam.md)). Refund headroom is claimed the same
way ([ADR 0016](0016-refunds-claim-then-refund.md)). The rule in each is
identical: **one system decides, atomically, and the external call happens only
after that decision is durable.**

Publishing is an external call. It gets the same rule.

## Decision

Write the event to an **outbox table in the same transaction** as the thing it
describes. A separate relay reads committed outbox rows and publishes them.

```ts
await prisma.$transaction(async (tx) => {
  await tx.notification.create({ data });
  await enqueue(tx, { type, userId, payload });   // outbox_events
});
```

`enqueue` takes a transaction client rather than the global `prisma`, so it
cannot be called outside a transaction. The type signature is the enforcement.

### The relay claims with `FOR UPDATE SKIP LOCKED`

```sql
SELECT * FROM outbox_events
WHERE "publishedAt" IS NULL
ORDER BY "createdAt"
LIMIT 100
FOR UPDATE SKIP LOCKED
```

`FOR UPDATE` is the same lock discipline as `lib/reservations.ts`. `SKIP LOCKED`
is what makes it safe to run more than one relay: a row already claimed by
another relay is passed over rather than waited on, so N relays divide the work
instead of serialising behind each other or publishing the same row twice.

Without `SKIP LOCKED` a second relay blocks on the first's batch, which is
correct but pointless. Without `FOR UPDATE` at all, two relays both read the
same unpublished rows and publish each one twice.

### Publishing is at-least-once, deliberately

The relay publishes, then marks `publishedAt`. A crash between those two leaves
the row unpublished and it is published again on the next pass.

That is a duplicate, and it is the correct trade. The alternative — mark first,
publish second — turns the same crash into a *lost* event, and a lost
notification is unrecoverable while a duplicate one is merely a thing the
consumer has to handle. Consumers deduplicate on `eventId`; see
[ADR 0026](0026-delivery-idempotency.md), which is a hard dependency of this
record rather than a companion to it.

### The relay is its own process

Not a `setInterval` inside the API, even though `startOrderSweeper` and
`startReservationSweeper` are exactly that and have the same shape.

Those sweepers recover state that nothing in the request path can reach, and
they are idle almost always. The relay is on the critical path of every
notification, and its throughput is the thing that has to scale when volume
grows. Coupling it to the API means scaling the API to scale publishing, and a
relay bug taking down checkout with it. It gets its own Dockerfile target per
[ADR 0023](0023-one-dockerfile-many-targets.md), which is also what makes it a
Kubernetes Deployment later rather than a rewrite.

> **Qualified in implementation.** This turned out to be true only under
> `NOTIFY_TRANSPORT=kafka`. Under `inline` — the default, and what the suite and
> CI run — there is no broker to publish to and therefore nothing to scale, so
> the API starts the relay in-process and development stays a single process. A
> second container for a function call would be ceremony.
>
> The reasoning above is unchanged for the transport it was written about: the
> two are mutually exclusive, and running both at once would mean the API
> quietly draining the outbox into its own consumers while the relay container
> finds an empty table. That is the one misconfiguration in this design with a
> silent symptom, and it is called out in `docker-compose.yml`.

### Polling, not change data capture

The relay polls on an interval. This is the part of the design most obviously
open to improvement, and it is chosen anyway — see the alternatives.

## Consequences

**The outbox grows without bound unless something prunes it.** Published rows
are dead weight the moment the relay is past them, and nothing in Postgres
removes them on its own. Retention is Phase 6 work, and until it exists this
table is a slow leak. Recorded here rather than discovered later from disk usage.

**Latency gains a poll interval.** A notification is published somewhere between
zero and one interval after it is committed. At a one-second interval that is
invisible for email and push and irrelevant for SMS; it would matter for
anything interactive, and nothing here is.

**At-least-once publishing makes [ADR 0026](0026-delivery-idempotency.md)
mandatory.** This record is not safe on its own. Deploying the outbox without
the delivery ledger means duplicate emails on every relay restart.

**A new thing that can fall behind.** Relay lag is a real operational signal and
needs to be visible, because the failure it produces — notifications arriving
late, or not at all, while the app looks completely healthy — is otherwise
invisible until somebody complains.

**The write path gains a row per notification.** `notifyMany()` for a basket
spanning five sellers now writes five notifications and five outbox rows in one
transaction rather than five rows in one `createMany`. Measured against what it
buys, this is not close.

## Alternatives considered

**Publish directly from `notify()`.** The dual write above. Rejected: there is
no ordering of the two writes that survives a crash between them, and the
failure is silent in both directions.

**Kafka's idempotent producer and transactions.** Kafka transactions are real,
and they do not help. They make a set of *Kafka* writes atomic with respect to
*Kafka* consumers. They cannot enrol a Postgres transaction, so the gap between
"the notification committed" and "the event was produced" is exactly as wide as
before. This is the most common misreading of what Kafka transactions do, and it
is worth writing down so nobody re-proposes it.

**Postgres `LISTEN`/`NOTIFY` to wake a publisher.** Attractive because it removes
the poll interval. Rejected as a *replacement* for the outbox: `NOTIFY` is fire
and forget and is not durable — a listener that is disconnected, restarting, or
simply not there when the notification fires never learns it happened, and there
is no record to recover from. It is viable as an *optimisation on top of* the
outbox, waking the relay early while the table remains the source of truth. Not
in Phase 1; the poll interval is not currently a problem worth solving.

**Debezium reading the WAL.** The more rigorous answer. CDC off the write-ahead
log — which is already being archived for
[ADR 0020](0020-replication-and-backups.md) — removes both the poll interval and
the relay's own failure modes, and it cannot miss a committed row by
construction. Rejected for now on operational cost: it means running Kafka
Connect, a connector configuration, and a replication slot whose disk usage will
take down the primary if the connector stops. That is a lot of new surface for a
system whose existing background work is two `setInterval` calls. Recorded as
the upgrade path, and the outbox table is the same table either way — switching
to CDC later changes how rows are read, not what is written.

**No broker at all: an outbox table and a worker.** This would work today. At
current volume a `SELECT … FOR UPDATE SKIP LOCKED` loop and three `await`s would
deliver every notification this system produces, with one new process instead of
three and no new stateful system to operate.

Rejected, and not comfortably. What it does not give is fan-out where adding a
channel touches no producer, per-channel consumer scaling where a slow SMS
provider cannot starve email, or replay after a template bug. Those are the
reasons, and they are reasons about where this is going rather than where it is —
which is a weaker justification than most records here rest on. The mitigating
fact is that the outbox is the part that carries the correctness, and it is
identical under both designs: if the broker turns out to be unearned, deleting
it is a change to the relay and the workers and to no call site at all.

See also [ADR 0025](0025-kafka-topics-and-partitioning.md) for what the relay
publishes to, and the honest note there about Kafka being oversized for one
broker on Compose.
