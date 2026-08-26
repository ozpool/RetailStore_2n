# 16. Refunds: claim headroom, then refund

- **Status:** Accepted
- **Recorded:** 2026-08-25

## Context

A seller could mark an order line "can't send it". The code recorded that a
refund was owed, returned `{ refundOwed: true }`, and stopped. Nothing anywhere
ever settled it.

That is worse than a missing feature. The buyer paid, the item was never coming,
and the system knew both facts and kept the money. The notification even told
them to take it up with the seller themselves — which is a marketplace declining
to be one.

Two questions had to be answered before writing any of it.

**How much comes back, and to whom?** A basket can span several sellers. One
seller failing to post their line says nothing about the others, so refunding
the whole order would take money from sellers who did their part.

**What stops us sending back more than came in?** This is the same problem as
taking payment twice, in the opposite direction, and it has the same shape: a
check followed by a separate action, with a window in between.

## Decision

### Refunds are per line, recorded in their own append-only table

`Refund` rows carry `orderItemId` (nullable, so a moderator can refund an order
as a whole), the amount, the trigger, the reason, and a reference to the
provider's refund. Rows are never edited except to move `status` off `PENDING`.

Append-only for the same reason `ModerationAction` and `KycAttempt` are: a
financial decision has to still be answerable a year later, including when
somebody disputes it.

The amount is **snapshotted**, not derived from the line at read time — same
reasoning as `OrderItem` copying title and price. What was actually returned is
a fact about the past and must not move when anything else does.

### `Order.refundedCents` is denormalised, and that is the point

It is not a display convenience. It is the column the over-refund guard reads,
and issuing a refund is one conditional UPDATE:

```sql
UPDATE orders
SET "refundedCents" = "refundedCents" + $amount
WHERE id = $id
  AND status = 'PAID'
  AND "refundedCents" + $amount <= "subtotalCents"
```

Only the caller whose UPDATE matched a row may contact the provider. Summing the
refund rows per request could not be made atomic this way.

The read-then-write version — "how much is left? fine, refund that" — lets two
requests both read the same headroom and both spend it. On a $120 order that
sends back $240. It is the identical bug as
[five simultaneous charges](0013-payment-provider-seam.md), so it gets the
identical fix. A test fires five concurrent refunds and asserts at most one wins.

### Books before provider

1. claim the headroom (atomic; decides who proceeds)
2. write a `PENDING` row
3. call the provider, keyed on the row id
4. settle the row

Steps 1–2 before step 3 means the ledger says the money is gone slightly before
it is. **That is the safe direction.** The failure mode is a refund we owe and
have recorded, which a person can find and finish. Provider-first fails as money
that left with no record, which nobody can find at all.

An **indeterminate** provider error (a dropped connection on a mutating call)
leaves the headroom claimed and the row `PENDING`. Releasing it would invite a
second refund for money that may already be on its way back.

### The idempotency key is the refund row's id

Never random, for the same reason payment intents are keyed on the order. The
caller has already committed a row and incremented `refundedCents` before the
provider is called; a retry with a fresh key would issue a second refund for
money the books say has already gone.

### Unfulfillable refunds are automatic

`markUnfulfillable` issues the refund in the same operation. The buyer should
not have to ask — they paid, the item is not coming, and making them chase it is
how a marketplace earns a reputation.

It is idempotent per line: a seller marking the same line twice is refused with
`ALREADY_UNFULFILLABLE` rather than refunding twice. The atomic claim alone
would not be enough — a part-refunded multi-line order can still absorb another
refund for a line that was already settled.

A refund failure does **not** roll back the unfulfillable mark. The item
genuinely is not coming and the buyer needs to know regardless; a failed refund
is recorded for a person to pick up, which beats pretending the line is still
fulfillable.

### The webhook exists for the refunds that are not instant

Most settle inside the original request. Some do not — a refund can come back
`pending` and be decided minutes later. `refund.created`, `refund.updated`,
`refund.failed` and `charge.refund.updated` all carry a Refund object, so one
handler covers them.

`charge.refunded` is deliberately unhandled: it fires alongside but carries a
Charge, whose `refunds` list needs separate unwrapping — two code paths for one
fact, the second only ever agreeing with the first.

A **failure** arriving by webhook matters as much as a success. It releases the
headroom, and if that refund is what flipped the order to `REFUNDED`, the order
goes back to `PAID`. Leaving it would tell the buyer their money came back, hide
the order from the seller's earnings, and disagree with the provider — three
wrong answers from one missing branch.

## Consequences

**A `PAID` order with `refundedCents > 0` is normal.** `status` only becomes
`REFUNDED` when the whole subtotal has gone back. Partial refunds are the common
case in a multi-seller basket, and inventing a `PARTIALLY_REFUNDED` state would
put the same information in two places.

**Seller visibility and seller earnings had to be separated.** Every
seller-facing query filtered `order.status = PAID`, which was correct when that
was the only post-payment state. Once a fully refunded order became `REFUNDED`,
those sales vanished from the seller's list, summary and totals as though the
transaction never happened.

The filter is now a shared `SETTLED = [PAID, REFUNDED]` constant — one constant
rather than six copies, because a single site left behind is a sale that
disappears from one screen but not the others. But refunded lines are **excluded
from `soldCount` and `grossCents`**: a sale whose money went back is not
something the seller sold, and counting it would make their totals disagree with
their bank in the one direction nobody wants to discover late.

**Pending counts as refunded** in both that exclusion and the dashboard figure.
A refund in flight is money leaving; treating it as still-earned shows a number
that is about to be wrong.

**The dashboard reports refunds beside gross, not netted off it.** A fully
refunded order drops out of the `PAID` set on its own; a partly refunded one does
not. Showing both lets the reader subtract knowingly instead of being handed a
net figure that hides how much came back.

**There are no partial-line refunds.** A line is refunded at exactly what was
paid for it, or a moderator names an arbitrary amount against the order. Refunding
"half of one line" would need the amount split across `orderItemId` rows and
there is no case for it yet.

**No refund window.** Nothing stops a moderator refunding a two-year-old order,
because the provider will refuse it long before we need to. Encoding a policy we
have not decided would be inventing a constraint to maintain.

## Alternatives considered

**Summing refund rows instead of a denormalised total.** Cleaner on paper, and
unable to express the atomic guard. Rejected: correctness beats normalisation
where money is concerned, and the sum is asserted against `refundedCents` in the
test suite so drift would be caught.

**Refunding the whole order when any line fails.** Simpler, and wrong. It takes
money from sellers who posted their items.

**Marking the refund succeeded and reconciling later.** Rejected. Optimism about
money is how a buyer gets told their refund arrived when it did not, and finds
out from their bank instead.

**A `PARTIALLY_REFUNDED` order status.** Rejected as redundant: `refundedCents`
between zero and the subtotal already says it, and two sources for one fact
eventually disagree.
