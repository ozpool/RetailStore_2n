# Plan 0003 — Letting a buyer ask for their money back

- **Status:** all six phases landed 2026-09-09.
- **Written:** 2026-09-09
- **Produces:** ADR 0031

> **What this is now.** The plan is complete; the phase notes record what each
> one actually cost, including two bugs the work itself found. The durable
> description lives in [lld.md](../architecture/lld.md) and
> [api.md](../api.md); this file is the decision trail.

---

## 1. Where this stands today

A buyer has no way to ask for a refund. `RefundTrigger` is
`SELLER_UNFULFILLABLE | ADMIN` and nothing else, so the only paths to money
going back are a seller giving up on a line, or a moderator in the admin panel.

`/help/returns-refunds` is linked from the footer of every page and promises a
14-day window, a "Start a return" control, a prepaid return label, and a refund
triggered by a carrier scan. All four are false. That page is the single largest
untruth left in the repository.

## 2. What is being built

The entry point to machinery that already exists.

```
buyer opens a request  →  seller approves      →  issueRefund(BUYER_RETURN)
                       →  seller refuses       →  buyer escalates  →  admin decides
                       →  buyer withdraws it
```

Everything to the right of `issueRefund` is untouched: the over-refund guard,
the provider call, webhook settlement, the payout reversal and the debt that
follows a failed reversal. A return-driven refund is a refund by the time money
moves.

## 3. Schema additions

One enum and one table.

```prisma
enum ReturnStatus {
  OPEN        /// Asked. The seller has not answered.
  APPROVED    /// Answered yes. A Refund exists.
  REFUSED     /// Answered no by the seller. The buyer may escalate.
  ESCALATED   /// The buyer asked a moderator to look.
  REJECTED    /// A moderator agreed with the seller. Terminal.
  WITHDRAWN   /// The buyer changed their mind about asking. Terminal.
}

model ReturnRequest {
  /// UNIQUE. The insert is the claim: two taps on "Start a return" race, and
  /// the second collides here instead of opening a second request.
  orderItemId String @unique
  status      ReturnStatus @default(OPEN)
  /// The buyer's own words, shown to the seller and the moderator verbatim.
  reason      String
  /// Whether the buyer says it was misdescribed, which is what the help page
  /// distinguishes and what decides who pays return postage.
  notAsDescribed Boolean
  /// Set when answered. Whose words these are depends on the status.
  decisionNote   String?
  decidedById    String?
  refundId       String?  @unique
}
```

## 4. Phases

### ~~Phase 0 — Decide, and write it down~~ · landed 2026-09-09

- ADR 0031: a request rather than a refund; the seller answers and a refusal
  escalates; the window derives from the payout hold; the physical return is
  out of band; one request per line; no relisting.

**Exit:** one record naming its rejected alternatives and its costs.

**Met.** It records the thing worth arguing about — that picking 14 days because
a help page said 14 would make transfer reversals the normal path rather than
the exceptional one — and it states the cost of the alternative it chose, which
is a seven-day default instead of fourteen.

### ~~Phase 1 — What makes a request valid~~ · landed 2026-09-09

- `lib/returns.ts`: `returnWindowDays()` read per call, `eligibility(orderItemId)`
  returning why not, and `openReturn()` whose insert is the claim.
- Five conditions, each its own reason: the order is `PAID`, the line is
  `DELIVERED`, `deliveredAt` is inside the window, no refund already touches
  the line, and no request exists for it.
- A boot warning when `RETURN_WINDOW_DAYS` exceeds `PAYOUT_HOLD_DAYS`.

**Exit:** every refusal reason asserted separately against a hand-checked
fixture, including a line whose only disqualification is that its order was
never paid.

**Met.** `tests/api/returns.ts` asserts each of the five conditions on its own
line, including the unpaid one — everything else about that line passes, so a
query joining on delivery alone would hand back money nobody ever paid.

**The window derivation was worth the trouble.** `returnWindowDays()` falls back
to `holdDays()`, so the two cannot drift by default, and the boot banner says in
words when an operator has configured them apart:

```
Returns:  14 day(s) after delivery — LONGER than the 7-day payout hold,
          so returns opened after day 7 will need transfer reversals
```

### ~~Phase 2 — Answering it~~ · landed 2026-09-09

- `respond()` for the seller — approve or refuse, refusal requiring a note.
- Approval calls `issueRefund({ trigger: BUYER_RETURN })` and records the
  `refundId`, in that order, so a request is never APPROVED with no refund.
- `escalate()` for the buyer, `decide()` for a moderator, `withdraw()` for the
  buyer while still OPEN.
- Every transition is a conditional `UPDATE` on the current status, so two
  concurrent answers cannot both win.

**Exit:** a concurrent approve-and-refuse produces one outcome and one refund;
an approval whose refund throws leaves the request OPEN rather than APPROVED.

**Met.** Six simultaneous refusals produce exactly one answer, and exactly one
of the six notes is the one the buyer sees — an `update` by id would have let
all six write, so the note on screen would have been a different person's words
than the decision recorded first.

**The rollback is the part that mattered.** Approval claims the transition, then
issues the refund; if the refund throws, the claim is reverted. A request left
APPROVED with no refund behind it tells the buyer their money is coming while
nothing is owed to anyone — worse than the request simply staying open. Forced
in the suite by approving against an order with no payment intent.

The reverse ordering — refund first, then mark — was considered. It cannot
double-spend, because the headroom guard on `Order.refundedCents` stops the
second, but it leaves money moved against a request that still reads unanswered.

### ~~Phase 3 — The routes~~ · landed 2026-09-09

- `POST /orders/items/:itemId/return` — open one. `GET` it back on the order.
- `POST /returns/:id/withdraw` · `POST /returns/:id/escalate` — the buyer's.
- `GET /seller/returns` · `POST /seller/returns/:id/respond` — the seller's.
- `GET /admin/returns` · `POST /admin/returns/:id/decide` — the moderator's,
  writing an audit row like every other admin action.

**Exit:** each route refuses the wrong party with a 404 rather than a 403, so an
id is not an oracle.

**Met.** Asserted for all four parties in `tests/api/return-routes.ts`: another
buyer, another seller, a seller reaching into an escalation, and a buyer trying
to escalate before the seller has answered.

**Mounted on the existing routers, not a new one.** `/orders/*` for the buyer
and the sales router for the seller. Adding a second router at `/seller` is
exactly how the payout gate came to answer 500 for every sibling route under
that mount, and nothing about returns needed its own.

### ~~Phase 4 — The screens~~ · landed 2026-09-09

- The buyer's order page grows a "Start a return" control, and shows the
  request's state and the answer.
- `/seller/sales` shows requests needing an answer.
- `/admin/returns` beside the payout and delivery logs.

**Exit:** a buyer can see why a refusal happened without asking anyone.

**Met, and verified in a browser rather than asserted.** The order page shows
the refusal, the seller's reason verbatim, and the escalation button; 13 checks
passed with no JS errors.

That browser check earned its keep immediately: the four new client functions
had `/orders/...` paths while `ordersApi`'s own `request()` already prefixes
`/api/orders`, so every one of them 404'd at `/api/orders/orders/...`. It
typechecked, it built, and it was completely broken — nothing but running it
would have found that.

**The admin page is not read-only,** unlike the payout log. Settling an
escalation is the whole job. The safety is elsewhere: approving goes through the
same `issueRefund`, so the headroom guard bounds it, and a rejection is terminal
so one request cannot be shopped to a second moderator. An escalation is also
counted on `/admin/overview` and badged in the nav — nothing in the system will
ever move one on its own, so a moderator should not have to open a page to learn
one is waiting.

### ~~Phase 5 — Prove it, and rewrite the page~~ · landed 2026-09-09

- `tests/api/returns.ts`: the five conditions separately, the concurrent claim,
  the concurrent answer, escalation, withdrawal, and a refund failure leaving
  the request answerable.
- Rewrite `/help/returns-refunds` to describe what exists — which is the reason
  this plan was written.

**Exit:** the footer's most-clicked promise is true.

**Met.** 71 assertions across two suites, and `/help/returns-refunds` now
describes what happens. The page names no number: the window derives from the
payout hold, so a hardcoded "14 days" would go stale the moment an operator
changed either — it says "the return window" and the order page shows the date.

**A second bug came out of writing the suite.** A full refund flips the order to
`REFUNDED`, so a buyer revisiting a line they had successfully returned was told
*"that order was never paid"* — to the one person who had definitely paid and
definitely been refunded. `REFUNDED` is answered separately now, and an
assertion pins the message.

Three other pages were repaired in the same pass, all of them promising things
that did not exist: `/sell/shipping-labels` claimed prepaid labels, listing
weights and automatic tracking (the last directly contradicting the manual
carrier field the ship route actually takes), and `OrderLines` told buyers that
refunds "aren't automated yet" when the seller-unfulfillable path had been
issuing them automatically for some time.

## 5. What this does not do

**No return shipping labels, and no scan-triggered refund.** Both need a carrier
integration that does not exist, which is the same reason outbound labels were
removed from `/sell/shipping-labels` rather than implemented.

**No proof the item came back.** Approval is the seller saying they are content.
A seller who approves and receives nothing has been defrauded and support is
their only route.

**No automatic relisting.** A returned item does not go back on sale.

**No timer.** An unanswered request waits until the buyer escalates it. There is
no scheduler here to expire anything with.

**No partial returns.** A request is for a whole line at its full price. Partial
goodwill amounts remain a moderator's job in the admin panel.

## 6. Open questions

1. **Is seven days long enough?** It is the payout hold, chosen so a return can
   never land on money that has already gone. Fourteen would be kinder to buyers
   and would guarantee a reversal on every late return. **A business answer.**
2. **Who pays return postage?** The schema records `notAsDescribed` because the
   help page drew that distinction, and nothing acts on it. Acting on it needs a
   way to charge or credit postage, which needs the carrier integration.
3. **Should a seller's silence eventually approve?** It would need a scheduler.
   Until there is one, silence is answered by the buyer escalating.
