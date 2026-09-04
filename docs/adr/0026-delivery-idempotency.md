# 26. A delivery ledger, claimed before the provider is called

- **Status:** Accepted — implemented in phases 2-4 of
  [plan 0001](../plans/0001-multi-channel-notifications.md).
  `NotificationDelivery` and `lib/deliveryLedger.ts` are the ledger; the
  `@@unique([eventId, channel])` constraint is the guard.
- **Recorded:** 2026-09-04

## Context

Two decisions upstream of this one both produce duplicates on purpose.

[ADR 0024](0024-outbox-not-dual-writes.md) has the relay publish and *then* mark
`publishedAt`, so a crash between them republishes the event. That is the correct
trade — a duplicate is recoverable and a lost notification is not — but it means
duplicates are normal traffic.

Kafka adds its own. A consumer that sends and then dies before committing its
offset reprocesses the message on restart. A rebalance during a deploy hands a
partition to a new consumer at the last committed offset, which is behind. Both
are ordinary operational events, not failures.

So the pipeline delivers at least once, end to end, by design. Without something
that recognises a repeat, every relay restart and every rolling deploy sends a
second copy of whatever was in flight — a second email, a second push, and a
second SMS to somebody's phone in the middle of the night.

This is not a new problem in this codebase. `routes/webhooks.ts` states it
directly:

> Stripe delivers at least once and retries on any non-2xx, so duplicates are
> normal traffic rather than an error case. Both handlers below early-return on
> an already-settled record.

The same answer applies, one layer further out.

## Decision

A **`NotificationDelivery` ledger**, one row per `(eventId, channel)`, with a
unique constraint on that pair. The row is inserted **before** the provider is
called.

```prisma
status  DeliveryStatus @default(PENDING)   // PENDING SENT FAILED SUPPRESSED

@@unique([eventId, channel])
```

### Claim, then send — the same shape as claim-then-charge

The order of operations is the whole decision:

1. Resolve preferences. If this channel is off for this user and type, insert
   `SUPPRESSED` and stop.
2. Insert `PENDING`. **A unique violation here means another consumer already
   has this delivery — return, do not send.**
3. Call the provider.
4. Update to `SENT` with the provider's message id, or `FAILED` with the reason.

Step 2 is the guard. It is the same discipline as claiming an order before
charging it ([ADR 0013](0013-payment-provider-seam.md)) and claiming refund
headroom before refunding ([ADR 0016](0016-refunds-claim-then-refund.md)):
mutual exclusion is decided by whether a database write matched, and only the
winner may talk to the provider. There is no window between checking and
claiming, because the check *is* the claim.

Checking first and inserting after would reintroduce the read-then-write race
that ADR 0012 exists to prevent — two consumers both read "no row", both decide
to send, and both send.

### `eventId` comes from the outbox, and is never regenerated

`OutboxEvent.eventId` is generated once, at enqueue time, inside the transaction
that wrote the notification. Every republish by the relay and every redelivery by
Kafka carries the same value. A consumer that generated its own id, or derived
one from the message offset, would produce a different key for the same logical
event and defeat the constraint entirely.

### `SUPPRESSED` is an outcome, not an absence

A notification not sent because the user turned that channel off, or because it
arrived inside quiet hours, gets a row. Recording it costs one insert and answers
"why did I not get a text about my refund?" — a question that, with no row, can
only be answered by reasoning about what the preferences *would have* evaluated
to at a past moment, from preferences that have since been edited.

### The ambiguous middle, and a per-channel answer

A consumer that dies after step 3 and before step 4 leaves a `PENDING` row and a
provider call whose outcome is unknown. This is the same shape as an order stuck
in `PROCESSING`, which `reconcileProcessingOrders` handles by asking Stripe what
happened.

Here there is no equivalent question to ask — email and SMS providers have no
"did I already accept this?" lookup keyed by our id. So a sweeper resolves stale
`PENDING` rows on a **per-channel policy**, and the policies deliberately differ:

| Channel | Stale `PENDING` becomes | Why |
| --- | --- | --- |
| Email | Retried once, then `SENT` | A duplicate email is a minor annoyance; a missing refund notice is not |
| Push | Retried once, then `SENT` | Same, and push is deduplicated by tag on the device |
| SMS | `FAILED`, needs a human | A duplicate SMS costs money and trust, and the recipient cannot tell it from a phishing retry |

Guessing differently per channel is not inconsistency. It is the cost of a
duplicate differing per channel, and encoding that next to the channel is what
stops someone applying the email policy to SMS by default.

## Consequences

**Exactly-once is not achieved, and must not be claimed.** This makes delivery
idempotent against redelivery, which is weaker. A provider that accepts a message
and then fails to return an id still leaves the ambiguous middle above, and the
SMS policy resolves it by under-delivering rather than over-delivering. Any
document that describes this system as exactly-once is wrong.

**Three writes per notification per event.** A `SALE_MADE` produces up to three
ledger rows plus its updates. This table grows faster than `notifications` does
and will need the same retention treatment as the outbox.

**The ledger is a privacy surface.** It records that a specific person was
messaged, when, and by which channel, keyed to a provider message id. It holds no
message content — the same reference-not-content rule as
[ADR 0006](0006-kyc-store-reference-not-document.md) and the payment fields on
`Order` — and it should not acquire any.

**A failed insert is a success path.** The unique violation in step 2 is the
mechanism working, not an error, and it must not be logged as one. Logging it at
error level would fill the log during every rolling deploy and train people to
ignore it.

## Alternatives considered

**Deduplicate in Redis with a `SET NX` on the event id.** Faster and needs no
migration. Rejected on the line [ADR 0018](0018-redis-for-shared-ephemeral-state.md)
draws: Redis here runs with `--save "" --appendonly no` and no volume, because
nothing in it is allowed to matter after a restart. A dedupe key that evaporates
is a duplicate SMS after every Redis restart, and putting a guard on money-adjacent
messages into the store this codebase treats as safe to lose would make that line
meaningless. The same objection that rejected caching in ADR 0018 applies with
more force, because this is a correctness guard rather than a speed one.

**Kafka's exactly-once semantics.** Real, and out of scope by construction. EOS
covers consume-transform-produce *within* Kafka — read a topic, write a topic,
commit the offset atomically. The moment the side effect is an HTTP call to
Twilio, it is outside the transaction and the guarantee stops at the boundary.
Enabling it would add configuration and a transactional producer, and would not
prevent a single duplicate SMS.

**Provider-side idempotency keys.** Stripe supports them and some providers do
too. Worth using *in addition* where available, and rejected as the primary
mechanism because coverage is inconsistent — the three providers here have three
different answers — and because it moves the record of what was sent into a
third party, where it cannot be joined to a user, cannot record `SUPPRESSED`, and
cannot be read by the admin panel.

**Deduplicate on `(notificationId, channel)` instead of `eventId`.** Nearly
equivalent, and it fails for the moderation events, where one action can produce
notifications to several people from one decision, and for any future event that
has no `Notification` row at all. `eventId` is the identity of the *event*, which
is the thing being delivered.

**Accept duplicates and let people mute the channel.** Rejected. The two events
that default to SMS are `REFUND_ISSUED` and `ORDER_UNFULFILLABLE` — the exact
messages where a second copy reads as either a second refund or a phishing
attempt.
