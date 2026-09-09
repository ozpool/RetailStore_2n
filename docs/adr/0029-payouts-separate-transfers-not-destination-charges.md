# 29. Pay sellers with separate transfers, not destination charges

- **Status:** Accepted — implemented 2026-09-08 in `lib/payoutProvider.ts`, `lib/payouts.ts` and `routes/sellerPayouts.ts`.
  Exercised only against `PAYOUT_PROVIDER=stub`: nothing here has run against
  Stripe Connect. See [plan 0002](../plans/0002-seller-payouts.md).
- **Recorded:** 2026-09-08

## Context

Money reaches the platform and can be refunded from it. It cannot yet reach a
seller — `SellerProfile.payoutsEnabled` is set by identity verification
([ADR 0007](0007-verification-gates-payouts.md)) and **nothing consumes it**.
That is the largest remaining gap in the system.

Two existing decisions constrain every option:

**A basket spans sellers.** [ADR 0014](0014-one-order-fulfilment-per-line.md)
made one order per basket with fulfilment per line, so a single `Order` can
contain items from four different sellers, each shipped separately and each
refundable on its own. There is exactly **one** `PaymentIntent` per order.

**The platform takes no cut.** The README says so and the admin dashboard
labels its headline figure *gross sales*, never revenue. There is no
application fee to deduct.

Stripe Connect offers three ways to route money, and the choice is forced by
the first constraint more than by preference.

## Decision

**Separate charges and transfers.** The buyer's payment continues to go to the
platform exactly as it does today, and a later `Transfer` moves each seller's
share to their connected account.

### Why not destination charges

A destination charge names its recipient at the moment of the charge, so a
four-seller basket needs four charges. That means four card authorisations for
one checkout, four things that can fail independently, and a buyer who might be
told that two of their four items succeeded.

It would also demolish work that is already correct: the single-`PaymentIntent`
claim-then-charge sequence of
[ADR 0013](0013-payment-provider-seam.md), the single `refundedCents` headroom
counter of [ADR 0016](0016-refunds-claim-then-refund.md), and the reservation
locking of [ADR 0012](0012-row-locking-for-reservations.md) which holds stock
for one order.

**Separate transfers change nothing about checkout.** That is the whole
argument. Payouts become a process that reads settled orders and moves money
afterwards, rather than a rewrite of the most safety-critical path in the
system.

### Why Connect Express accounts

Three account types exist. The sellers here are individuals clearing out a
flat, not businesses with a finance function.

- **Express** — Stripe hosts onboarding and a dashboard, and takes on identity
  verification, bank details, and tax reporting. Chosen.
- **Standard** — the seller brings their own full Stripe account. Wrong
  audience: it asks someone selling one chair to sign up for a payments
  processor.
- **Custom** — the platform owns every screen and the compliance liability with
  it. That is a deliberate business undertaking, not a default.

### The transfer is claimed before it is made

Identical to charging and to refunding, and for identical reasons. A transfer
is money leaving an account, so the sequence is:

1. Claim the payout rows atomically — a conditional `UPDATE` that only one
   caller can win.
2. Call Stripe.
3. Record the outcome.

A read-then-transfer version ("what is owed? right, send that") lets two
concurrent runs both read the same balance and both send it, which for a $120
order means $240 leaving the platform. That is the same bug as the
five-simultaneous-charges one and it gets the same fix.

## Consequences

**Checkout, refunds and reservations are untouched.** No existing ADR is
amended by this one.

**The platform holds sellers' money for a while.** Between payment and transfer
the balance is the platform's legally and the seller's morally, which is
precisely why the hold period and its reasoning are their own decision — see
[ADR 0030](0030-payout-eligibility-and-hold.md).

**Stripe's Connect fees land on a platform that earns nothing.** Taking no cut
was defensible when money only ever flowed in. Moving it out costs per transfer
and per active connected account, and there is currently no revenue to pay that
from. **This is a business problem, not a technical one**, and it is recorded
here because the code cannot solve it: either the platform absorbs the cost, or
"no cut" has to become "no cut beyond the payment fees".

**Two verification systems now exist for one seller.** Stripe Identity was
integrated to gate payouts; Connect Express does its own verification before it
will release funds. Resolved in
[ADR 0030](0030-payout-eligibility-and-hold.md) rather than here.

**A refund can now arrive after the money has gone.** The hold period makes it
unlikely rather than impossible, so reversal has to exist. Also
[ADR 0030](0030-payout-eligibility-and-hold.md).

## Alternatives considered

**Destination charges with `on_behalf_of`.** The cleanest model for a
single-seller basket, and this marketplace does not have one. Rejected above.

**One charge per seller at checkout.** Same objection, stated plainly: it makes
a partial checkout failure a normal outcome the UI has to explain.

**Manual bank transfers, with payouts as a spreadsheet.** Honestly considered,
because it is what a marketplace this size would actually do first and it needs
no integration at all. Rejected because the system already claims to be
production-shaped everywhere else, and a payout path that cannot be tested is
the one place that claim would be false.
