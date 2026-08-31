# 13. Payment provider seam, and preventing double payment

- **Status:** Accepted
- **Recorded:** 2026-08-24

## Context

Two separate problems arrive together at checkout, and conflating them produces
a design that looks safe and is not.

**Problem one: card data.** Anything that touches a card number pulls the whole
system into PCI DSS scope. That is avoidable entirely — the provider collects
the card, and we keep a reference to the resulting payment. Same reasoning as
ADR 0006 for identity documents: the sensitive thing stays with the party built
to hold it.

**Problem two: charging exactly once.** This is harder than it looks. The
obvious implementation is:

```ts
const order = await getOrder(id);
if (order.status !== "PENDING_PAYMENT") return conflict();
const outcome = await confirmIntent(order.paymentIntentId);   // charges the card
await markOrderPaid(order.id);
```

The status check reads correct. It is not sufficient, because the check and the
charge are two separate steps. Two concurrent requests — a double-clicked
button, a retried fetch — both complete the read before either reaches the
charge. Both see `PENDING_PAYMENT`, both conclude they are first, both charge.

This was not theoretical. Five simultaneous requests against the code above
produced **five successful charges**, with the order ending in a correct-looking
`PAID` state. The idempotent `markOrderPaid` hid the damage: the order looked
right while the buyer had been charged five times.

## Decision

### The seam

`src/lib/paymentProvider.ts` exposes `createIntent` / `confirmIntent` /
`getIntent` / `cancelIntent` / `verifyWebhook`, shaped after Stripe's
PaymentIntents because that is what it wraps. Two adapters implement it:

| | `stub` | `stripe` |
|---|---|---|
| Account needed | no | test-mode keys |
| Intent state | in-process `Map` | Stripe |
| Outcomes | scripted by last 4 digits | Stripe test payment methods |
| Webhooks | n/a | signature-verified |

Both are **state machines**. An earlier stub was a pure function that returned
`succeeded` on every call, which would have concealed exactly the bug above
rather than exposing it. A stub whose behaviour is safer than production is
worse than no stub.

In Stripe mode a typed card number is mapped to a test payment-method token
(`pm_card_visa`, `pm_card_chargeDeclined`, …) before the API call, so no card
number crosses the boundary even in testing. The server refuses to start with a
live key outside production.

### Layer 1 — claim the order, don't check it

One conditional UPDATE:

```sql
UPDATE orders SET status = 'PROCESSING'
WHERE id = $1 AND buyerId = $2 AND status = 'PENDING_PAYMENT'
```

Postgres serialises writes to a row, so of N concurrent statements exactly one
matches and gets `rowcount = 1`. Only that caller may contact the provider; the
rest get 0 and a 409. There is no window between checking and claiming because
they are the same statement.

Step order in the route is the safety property:

1. **validate the input** — before claiming, so a typo cannot strand the order
2. **claim atomically** — exactly one request proceeds
3. **call the provider** — with an idempotency key
4. **record the result** — idempotently

Doing 3 before 2 is the bug.

### Layer 2 — idempotency keys at the provider

Layer 1 cannot cover the failure that matters most: the request reaches Stripe,
the card is charged, and the *response* is lost to a timeout or a restart. The
application does not know whether money moved. No mutual exclusion helps —
the request that knew is gone.

So every mutating call carries an `Idempotency-Key` derived from the order id:

```
retailstore-2n:order:<id>:intent
retailstore-2n:order:<id>:confirm
```

Stripe retains keys for 24 hours and replays the original response rather than
charging again. **Derived, never random** — a per-attempt random key makes every
retry look new and protects nothing, which is the most common way this
mitigation is added and silently does nothing.

### Layer 3 — reconciliation

A process that dies between claiming and hearing back leaves `PROCESSING` with
a charge of unknown status. Both naive recoveries are wrong: cancelling can
discard a real payment, and reopening the order can charge twice. The provider
is the only authority, so `reconcileProcessingOrders()` asks it via `getIntent`
and settles accordingly.

Where the intent is still pending past the payment window — an abandoned 3-D
Secure prompt — it cancels the intent **before** releasing stock. Releasing
alone would leave a confirmable intent behind, letting a buyer authenticate an
hour later and pay for an item already back on sale.

### Why not a distributed lock

A Redis lock (`SET NX EX`) was considered and rejected for the mutual-exclusion
role.

A lock has a lease. If the provider call outlives it — a slow issuer, a 3-D
Secure prompt — the lease expires while the charge is still in flight and a
second caller acquires it cleanly, producing exactly the double charge the lock
was meant to prevent. Raising the timeout moves the window rather than closing
it; closing it properly requires fencing tokens, which is reimplementing what
the database already provides. This is the substance of Kleppmann's critique of
Redlock as a correctness mechanism.

There is a second reason, independent of the first: **an idempotency record must
be at least as durable as the side effect it guards.** Redis is memory-first and
can lose recent writes on restart even with AOF `everysec`. Losing the record of
"this card was already charged" means charging again. Order status lives in the
same durable, transactional store as the order itself, so there is no lease to
expire and no split brain between what the lock claims and what the data says.

Redis remains the right tool here for rate limiting the payment endpoint and for
caching catalog reads — work where occasional forgetting is acceptable.

## Consequences

**Good.** Concurrent payment is serialised per order with no new
infrastructure. Lost responses are safe to retry. Orders left mid-payment settle
themselves against the provider. The same code path works against the stub and
against Stripe, so the flow is exercised long before real keys exist.

**Costs and limits, stated plainly.**

- `PROCESSING` is a third state that commits stock and hides the listing from
  the catalog. That is the same shape as the deadlock ADR 0012 documents, for
  the third time in this codebase, and it is why reconciliation is a sweeper
  rather than something in the request path. **Any state that both commits
  stock and hides the listing needs an out-of-band release.** This has now been
  true three times; treat it as a rule, not a coincidence.
- A buyer whose payment is genuinely in flight cannot cancel or retry for up to
  two minutes. That is deliberate — returning stock while a charge may complete
  risks selling an item someone has paid for — but it is a real cost to them.
- The stub keeps intents in memory, so a restart loses them. Reconciliation
  reads that as "the provider has no record", which is correct for the stub and
  is why it is not a production path.
- A card decline moves the order to `FAILED` and returns the stock, so the buyer
  starts a new checkout rather than retrying with a different card in place.
  Simpler and safer; less pleasant than the alternative.
- Stripe's idempotency window is 24 hours. It covers retries, not a buyer
  returning the next day.

## Verification

`backend/tests/payment-safety.ts` (`npm run test:payments`) — 41 assertions
against a running server, covering: five simultaneous pay requests charging
exactly once; five simultaneous declines reaching the provider once; a
malformed card leaving the order payable rather than stranded; stock returning
on decline; 3-D Secure held as pending rather than failed, uncancellable while
in flight; an abandoned authentication reclaimed by the sweeper with its intent
cancelled; cross-buyer isolation returning 404; an unsigned webhook rejected
without leaking why; and no card digits present anywhere in the database.

The concurrency cases fail against the pre-decision code, which is the point of
keeping them.

## References

- ADR 0005 — money as integer minor units
- ADR 0006 — store a reference, not the document
- ADR 0012 — row-level locking for stock reservations
