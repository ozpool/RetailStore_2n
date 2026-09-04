# 25. One topic keyed by user, consumer groups as fan-out, retries on delay topics

- **Status:** Accepted, partly implemented 2026-09-04 (plan 0001, phase 1).
  `lib/kafka.ts` creates all five topics and `lib/notifyTransport.ts` keys
  every message by `userId`. **The retry ladder is declared and nothing
  consumes it** — there is no channel that can fail transiently until email
  lands in phase 2, so the delay topics exist and stay empty.
- **Recorded:** 2026-09-04

## Context

[ADR 0024](0024-outbox-not-dual-writes.md) settles that a relay publishes
committed outbox rows to a broker. It does not settle what it publishes to.

Three questions have to be answered together, because the answers constrain each
other:

1. **How does one event reach three channels?** Email, push, and SMS all care
   about the same `SALE_MADE`, and a fourth channel will be added.
2. **What decides which partition a message lands on?** Kafka orders messages
   within a partition and makes no promise across them, so this choice *is* the
   ordering guarantee.
3. **What happens when a provider is down?** SMS providers return 503s. Push
   endpoints time out. Doing nothing means dropping notifications.

The ordering question is not academic. A seller's `SALE_MADE` and the buyer's
`ORDER_SHIPPED` for the same item are minutes or days apart and unrelated. But
`ORDER_UNFULFILLABLE` and `REFUND_ISSUED` are emitted back to back from
`lib/refunds.ts`, deliberately kept separate so a moderator-issued refund does
not read as a seller failure. Delivering the refund notice before the "can't be
sent" notice inverts cause and effect for the person reading them.

## Decision

### One domain topic, and consumer groups are the fan-out

`retailstore-2n.notifications.v1`. Every channel reads it as its own consumer group:
`email-worker`, `push-worker`, `sms-worker`. Each group gets every message and
tracks its own offsets.

The relay does not know that email exists. Adding WhatsApp is a new consumer
group and no producer change at all, which is the property being bought.

### The partition key is `userId`

Every event about one person lands on one partition, so their notifications
cannot overtake each other. Different people are spread across partitions, so
load distributes.

**Not `NotificationType`.** There are eleven values, so eleven partitions would
carry all the traffic and any beyond that would carry none — `SALE_MADE` a hot
partition while eight others idle. And it destroys the guarantee that matters:
one person's events would be scattered across every partition by type, which is
precisely the `ORDER_UNFULFILLABLE` / `REFUND_ISSUED` inversion above.

**Not `orderId` or `listingId`.** Correct ordering for one order, no ordering for
one person, and a partition key that is null for the moderation events.

### Twelve partitions

The partition count is the ceiling on useful consumers per group: a group with
more consumers than partitions leaves the extras idle, permanently. Twelve is
far above current need and is chosen anyway, because raising it later rehashes
every key — the same `userId` moves to a different partition, and during the
migration a person's events can be split across the old and new partitions with
no ordering between them. Cheap now, disruptive later.

`replication.factor` and `min.insync.replicas` come from environment rather than
a literal: 1 and 1 on a single-broker Compose stack, 3 and 2 anywhere real. A
hardcoded 3 makes the local stack refuse to create topics; a hardcoded 1 makes a
production cluster silently unreplicated.

### Retries go to delay topics, not to a sleep

Three rungs, then a dead-letter queue:

| Topic | Partitions | Retention |
| --- | --- | --- |
| `retailstore-2n.notifications.v1` | 12 | 7d |
| `retailstore-2n.notifications.retry.5s.v1` | 6 | 1d |
| `retailstore-2n.notifications.retry.1m.v1` | 6 | 1d |
| `retailstore-2n.notifications.retry.15m.v1` | 6 | 1d |
| `retailstore-2n.notifications.dlq.v1` | 3 | 30d |

A consumer that retries in place blocks its partition for the duration. One
recipient with a dead phone number holds up every other user hashed to that
partition — a per-recipient failure escalating into a per-channel stall.
Republishing to a delay topic lets the consumer commit its offset and move on;
a worker on the delay topic picks the message up once the delay has elapsed.

**Retryable is decided per failure, not per exception type.** A 5xx, a timeout,
or a connection reset is transient and rides the ladder. A rejected address, an
unsubscribed recipient, or a `410 Gone` from a push service is permanent: it is
recorded as `FAILED` and never retried, because retrying a hard bounce is how a
sender reputation gets burned and how a push service starts rate-limiting the
whole application.

### Versioned topic names

`.v1` is in the name from the first day. A change to the event envelope that
consumers cannot read both sides of is then a new topic and a parallel run,
rather than a coordinated deploy of the relay and three workers at the same
instant.

## Consequences

**The retry ladder breaks per-user ordering for the messages that use it.** A
message that fails once, waits fifteen minutes, and then succeeds is delivered
after events for the same user that were emitted later and succeeded first. The
`userId` key guarantees ordering on the happy path only.

This is the real cost of not blocking the partition, and it is accepted rather
than solved: the alternative is head-of-line blocking, where one bad recipient
delays everyone else's notifications by the full retry budget. A late message
out of order beats a stalled channel. Anything that genuinely cannot tolerate
reordering must not be built on this topic.

**Twelve partitions is a commitment.** More consumers than that in one group buy
nothing, and changing it is disruptive in the way described above.

**Five topics to create, configure, and monitor** rather than one. Topic
creation is explicit — no auto-creation, which would let a typo in a topic name
silently produce a new empty topic instead of an error.

**A DLQ that nobody reads is a data sink.** It only earns its place with an
alert on its depth and a replay tool, which is why both are named in Phase 5 and
Phase 6 of the plan rather than left as implied future work.

**Kafka is oversized for one broker on Compose, and that should be said plainly.**
At this traffic a table and a worker would do the job; ADR 0024's alternatives
say so directly. What is bought here is fan-out that does not touch the producer,
per-channel scaling, and replay. Those are real, and they are also aspirational
at current volume. Anyone reading this later who finds one broker, three
consumer groups, and a hundred notifications a day is not looking at a mistake —
they are looking at a bet on where this was going, recorded as a bet.

## Alternatives considered

**A topic per channel** — `notifications.email.v1`, `notifications.push.v1`, and
so on, with the relay publishing to each. Rejected: it moves the channel set into
the producer, so adding a channel means changing the relay and redeploying it,
and the relay would have to resolve preferences to know which topics to write to.
That drags preference logic out of the workers and into publishing, where a
preference change would need a republish to take effect.

**Round-robin partitioning with no key.** Best possible load distribution and no
ordering whatsoever. Rejected on the `ORDER_UNFULFILLABLE` / `REFUND_ISSUED`
case: those two are emitted together and read together.

**In-process retry with backoff.** Simplest to write and the default in most
consumer libraries. Rejected on head-of-line blocking, which is the failure that
turns one bad recipient into a stalled partition.

**One retry topic with a longer sleep in its consumer.** Fewer topics, and the
sleep reintroduces exactly the blocking the ladder exists to avoid — now on the
retry consumer instead of the main one. A tiered set of topics with a fixed delay
each keeps every consumer non-blocking.

**Exponential backoff computed per message, with the delay carried in a header.**
More precise than three fixed rungs. Rejected as premature: it needs a scheduler
or a per-message timer, and three rungs covers the actual failure shape — a
provider is either briefly unavailable or properly down, and the difference
between 47 seconds and 60 seconds of backoff has no consequence for an email.

**RabbitMQ or a Postgres job table.** Both are lighter and both would work.
Recorded in [ADR 0024](0024-outbox-not-dual-writes.md) under "no broker at all",
where the decision actually sits — this record is about topic shape given that a
log-structured broker was chosen.
