# 14. One order per basket, fulfilment per line

- **Status:** Accepted
- **Recorded:** 2026-08-25

## Context

Sellers could not see their own sales. Someone could buy a chair and the seller
would never be told, never see it, and never be able to act on it — the
marketplace loop was open at exactly the point where a real transaction begins.

Two things blocked closing it.

**Order lines had no seller reference.** `OrderItem` carried `sellerName`, a
snapshot string for display. There was no way to ask "what did I sell?", because
nothing queryable connected a line to the shop that sold it.

**A basket can span several sellers, and two sellers cannot share one parcel.**
So "this order has shipped" is not something that can honestly be said. Some
structure had to carry per-seller delivery.

## Decision

### One order per basket. Fulfilment per line.

`OrderItem` gains `sellerId` (nullable, `SetNull`), plus its own `fulfilment`,
`shippedAt`, `deliveredAt`, `carrier`, `trackingNumber`, and `fulfilmentNote`.

The obvious alternative — splitting a basket into one order per seller, as Etsy
does — was **considered and rejected**, reversing an earlier recommendation of
mine. The reason is concrete:

```prisma
paymentIntentId String? @unique   // one payment per order
```

That uniqueness is what the double-charge defence rests on (ADR 0013). Splitting
orders forces one of two bad outcomes: the buyer pays N times for one basket, or
one payment spans N orders and the constraint has to go. Neither is worth it to
move a status field from one table to another.

This is closer to how Amazon models it than Etsy, and it does not preclude
splitting later.

### `FulfilmentStatus` is separate from `OrderStatus`

Payment and delivery are independent facts. An order is `PAID` *and*
`UNFULFILLED` for as long as it takes a seller to reach a post office, and one
enum cannot hold both. Folding them together is how systems end up with states
like `PAID_BUT_ALSO_SHIPPED`.

They also live on different tables — payment on `Order`, fulfilment on
`OrderItem` — so they could not be the same field even if that were desirable.

### Addresses are copied onto orders, never linked

Eight `shipTo*` columns on `Order`, filled from an `Address` at checkout. No
foreign key.

Same reasoning as `OrderItem.title` and `unitPriceCents`: a buyer can edit or
delete that address tomorrow, and the order still has to say where it was
actually sent. A foreign key would let last year's parcel silently move house,
and would break outright on deletion.

`Address` rows are soft-deleted, because a buyer may be mid-checkout in another
tab when they press delete.

### The buyer confirms delivery, not the seller

A seller marking their own parcel delivered is not evidence of anything. Once
payouts exist, that confirmation is what releasing money would hang on, so it
belongs to the party with no incentive to lie about it. A seller attempting it
gets a 404.

### Sellers see a sale only once it is PAID

The query filters on `OrderStatus.PAID`, which also gates when the buyer's
address is released. Showing pending checkouts would have sellers packing
parcels for carts that get abandoned — and abandoned carts sit in
`PENDING_PAYMENT` until a sweeper releases them.

## Consequences

**Good.** Sellers can see and fulfil their sales. Payment code was untouched, so
ADR 0013's 44 assertions still pass unchanged. Buyers see per-item delivery
status, which is the truth rather than a convenient simplification.

**Costs, stated plainly.**

- A basket spanning three sellers produces three separate parcels tracked
  independently, with no single "where is my order" answer. That is accurate,
  and it is also more for a buyer to read.
- `UNFULFILLABLE` records that a seller cannot send something **without
  refunding it**, because refunds are not built. The API returns
  `refundOwed: true` and the UI says the buyer must settle it with the seller
  directly. Recording it silently would leave money quietly kept for nothing.

  *Superseded 2026-09-05.* [ADR 0016](0016-refunds-claim-then-refund.md) built
  refunds, and marking a line unfulfillable now issues one in the same
  operation. `refundOwed` is gone; the route returns `refunded`,
  `refundCents`, `refundStatus` and `refundError`, because a provider can still
  refuse and the seller should be told which happened rather than reassured
  either way. The instinct recorded above — never keep money for something
  nobody will send — is what the automatic refund implements.
- Every existing buyer has no address, so checkout refuses until they add one.
  The UI treats `NO_ADDRESS` as a missing step and routes to the form with a
  `?next` parameter, rather than showing an error and leaving them to work out
  where to go.
- Fulfilment on `OrderItem` means a seller with fifty lines across ten orders
  updates fifty rows. Fine at this scale; a per-seller shipment grouping is the
  answer if it stops being fine.

## Alternatives considered

**Split at checkout, one order per seller.** Rejected above. Would additionally
have made "your order" ambiguous in every piece of buyer-facing copy.

**A separate `Shipment` table grouping lines by seller.** The correct model
eventually, and premature now: with one line per seller in almost every order it
would add a join and a lifecycle to manage for no behaviour gained. Worth
revisiting when sellers routinely ship several items together.

**Fulfilment on `Order` with a single status.** Simplest, and wrong. It can only
be honest when every order has exactly one seller, which is not something the
cart enforces.

**Foreign key from `Order` to `Address`.** Rejected for the mutation problem
above. `ON DELETE RESTRICT` would have fixed the deletion case while making the
edit case worse — a buyer could no longer correct a typo without it rewriting
history.

## References

- ADR 0005 — money as integer minor units
- ADR 0008 — soft delete plus a status enum
- ADR 0012 — row-level locking for stock reservations
- ADR 0013 — payment provider seam; `paymentIntentId @unique`
