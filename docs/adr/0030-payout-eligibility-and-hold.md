# 30. What makes money payable, and the ledger that stops it being paid twice

- **Status:** Accepted — implemented 2026-09-08 in `lib/payouts.ts`, the `payouts` / `payout_items` / `payout_debts` tables, and `tests/api/payouts.ts`.
  Exercised only against `PAYOUT_PROVIDER=stub`: nothing here has run against
  Stripe Connect. See [plan 0002](../plans/0002-seller-payouts.md).
- **Recorded:** 2026-09-08

## Context

[ADR 0029](0029-payouts-separate-transfers-not-destination-charges.md) settled
*how* money moves. This settles *when*, and *at most once*.

The question is not academic. An item can be paid for, shipped, delivered, and
then refunded — the refund path exists for exactly that and fires
automatically when a seller marks a line unsendable. If the seller has already
been paid, the platform is out of pocket and has to claw it back from an
individual, which is the worst outcome available.

There is also a second verification system to reconcile. Stripe Identity gates
`payoutsEnabled` today; Connect Express performs its own checks before Stripe
will release funds at all.

## Decision

### Payable means: delivered, held, and not refunded

An **order item** — not an order — is the unit of payout, because fulfilment
and refunds are both per line already. An item is payable when *all* of these
hold:

| Condition | Why it is not enough on its own |
| --- | --- |
| The order is `PAID` | An unpaid order has no money to distribute |
| The item is `DELIVERED` | `SHIPPED` is the seller's claim, not an outcome. `UNFULFILLABLE` is never payable |
| `deliveredAt` is more than the hold period ago | The window in which a dispute or refund is still likely |
| Nothing has been refunded against it | A refunded item was never earned |
| The seller's account can receive funds | Stripe refuses the transfer otherwise, and a refused transfer is a support ticket |

**The hold is seven days after delivery, and it is a guess.** Long enough that
the ordinary refund arrives first; short enough that a seller is not financing
the platform. It is configurable because the right number is a business
judgement that will change with dispute data nobody has yet.

### Both verifications must pass, and they answer different questions

Not redundancy — two different questions with two different owners:

- **Stripe Identity** answers *"is this person who they say they are?"*, which
  is the platform's own trust decision and the subject of
  [ADR 0007](0007-verification-gates-payouts.md). It stays.
- **Connect Express** answers *"will Stripe move money to this account?"* —
  bank details, tax status, sanctions screening. The platform cannot overrule
  it and must not try.

So `payoutsEnabled` keeps its meaning (our gate, from Identity) and a separate
`payoutsReady` mirrors Stripe's `payouts_enabled` capability, kept current by
the `account.updated` webhook. **Both true, or no transfer.** Collapsing them
into one flag would mean either paying out to an account Stripe will reject, or
letting Stripe's opinion silently overwrite a moderation decision.

### One item, one payout, enforced by a constraint

Every payout row is joined to the order items it covers, and that join carries
`@@unique([orderItemId])`.

This is the same shape as the delivery ledger of
[ADR 0026](0026-delivery-idempotency.md), for the same reason: the constraint
is the guard, not the code above it. A second attempt to include an already-paid
item collides at the database and stops. **An item can be paid at most once, and
that is a schema property rather than a promise about control flow.**

It also answers the question a seller will actually ask — *"what is this $84
for?"* — because the join names the exact lines.

### A refund after a payout reverses the transfer

The hold makes this rare, not impossible. Stripe supports reversing a transfer,
so the refund path attempts that first. If the reversal fails — the seller has
already withdrawn the money — the shortfall is recorded against the seller as a
debt and **netted off their next payout**, because the alternative is a platform
silently absorbing it with no record of who owes what.

## Consequences

**A seller waits at least a week after delivery.** That is a real product cost
and the most likely thing to be argued about. It is stated on the seller's
payouts page rather than left to be discovered.

**Two verification flows are visible to one seller**, and the UI has to explain
why finishing one does not finish the other. Confusing, and less confusing than
a payout that fails after being promised.

**Refunds get slower.** The refund path now has to check for a completed payout
and possibly reverse it before settling, on a path that today is a single
conditional `UPDATE`.

**Debt has to be modelled or deliberately not.** Recording a shortfall is easy;
collecting it is not. The first version nets it off future payouts and does
nothing else — no invoicing, no collections — and a seller who never sells again
keeps the money.

## Alternatives considered

**Pay out on payment, and claw back on refund.** Fastest for sellers and the
usual first instinct. Rejected: it makes every refund a clawback against an
individual, and the automatic seller-unfulfillable refund path would fire it
routinely rather than exceptionally.

**Pay out on shipment.** Tempting, because tracking exists. Rejected because
`SHIPPED` is a seller's assertion — the fulfilment status a seller sets
themselves — so it would pay out on the strength of the claim being paid for.

**No hold at all, and accept the exposure.** Viable for a platform with a
balance sheet. This one takes no cut, so it has no float to absorb losses from.

**A single `payoutsEnabled` flag driven by Stripe alone.** Simpler, one flag,
one source. Rejected because it hands a moderation decision to a payments
provider: a seller suspended for selling counterfeits would still be payable if
their bank details were fine.
