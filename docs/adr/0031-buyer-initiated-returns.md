# 31. Buyer-initiated returns, as a request the seller answers

- **Status:** Accepted — implemented 2026-09-09 in `lib/returns.ts`, the
  `return_requests` table, and routes on the orders, sales and admin routers.
  Covered by `tests/api/returns.ts` and `tests/api/return-routes.ts`.
  See [plan 0003](../plans/0003-buyer-returns.md).
- **Recorded:** 2026-09-09

## Context

A buyer cannot ask for their money back.

`RefundTrigger` has exactly two values. `SELLER_UNFULFILLABLE` fires when a
seller marks a line they cannot send, and `ADMIN` is a moderator pressing a
button in the panel ([ADR 0016](0016-refunds-claim-then-refund.md)). There is no
third path, and in particular no route a buyer can reach. If an item arrives
smashed, their only recourse is to email support and hope somebody opens the
admin panel.

Meanwhile `/help/returns-refunds` — linked from the site-wide footer — tells
them: *"Every purchase includes a 14-day return window"*, *"select 'Start a
return'"*, *"you'll get a prepaid return label"*, and *"refunds are issued once
the returned item is scanned back in transit"*. None of that exists. The page is
the most-linked customer promise in the application and every specific claim in
it is false.

So this is not a new capability so much as the missing entry point to one. The
machinery is already built and tested:

| Already exists | Where |
| --- | --- |
| Per-line refunds with a stated reason | [ADR 0016](0016-refunds-claim-then-refund.md) |
| Over-refund headroom as a conditional `UPDATE` | `lib/refunds.ts` |
| Provider call, webhook settlement, forged-signature rejection | `routes/webhooks.ts` |
| Payout reversal, and a debt when reversal fails | [ADR 0030](0030-payout-eligibility-and-hold.md) |
| A hold after delivery before money reaches the seller | [ADR 0030](0030-payout-eligibility-and-hold.md) |

What is missing is who may ask, what makes a request valid, and who answers it.

## Decision

### A return is a REQUEST, and a separate table from the refund

`ReturnRequest` is its own model. Approving one calls the existing
`issueRefund()` with a new `RefundTrigger.BUYER_RETURN`.

**Rejected: putting a status on `Refund` instead.** A refund is money moving; a
return is a question that may be answered no. Conflating them means a refused
return is indistinguishable from a *failed* refund in the one table the finance
view reads, and `Order.refundedCents` would have to start excluding rows that
were only ever asked for. The over-refund guard is a conditional `UPDATE` on
that column and it is the reason two clicks cannot refund twice; making it
reason about hypothetical refunds is the last thing it needs.

### The seller answers it. A refusal escalates to an admin

Three parties could decide, and each way of choosing is wrong on its own:

- **Auto-approve** is what a buyer-friendly marketplace does, and with no way to
  confirm the item came back it is an instruction for how to get things free.
- **Only an admin** ignores that the seller is the one who knows what they
  packed, and makes every dispute a support ticket.
- **Only the seller** hands the decision to the party with an incentive to
  refuse.

So: the seller sees the request and approves or refuses it. A refusal is not the
end — the buyer can escalate to a moderator, who decides. That is the same shape
as reports and moderation, which already exist and already write audit rows
([ADR 0015](0015-admin-by-cli-grant-and-step-up.md)).

**No timer anywhere in it.** An unanswered request does not auto-approve after
n days. A buyer whose seller stays silent escalates; that is a button they
press, not a deadline the system keeps.

*The reason has changed since this was written and the decision has not.* At the
time the argument was that there was nowhere to run a schedule.
[ADR 0032](0032-kubernetes-manifests.md) has since added a CronJob, so that
argument is gone — and expiring a return on a timer is still wrong, because it
would decide a dispute by clock rather than by anybody looking at it. Auto-
approving takes a seller's money without a decision; auto-rejecting takes the
buyer's. Neither is a default worth having.

### The return window defaults to the payout hold, and boot says so if they diverge

One config value, `RETURN_WINDOW_DAYS`, defaulting to whatever
`PAYOUT_HOLD_DAYS` is.

This is the decision most worth explaining, because the obvious alternative —
picking 14 days because the help page said 14 — is actively harmful. The payout
hold exists to keep the platform from paying a seller money that is about to be
clawed back. If the return window is *longer* than the hold, then every return
opened after the hold expires lands on money that has already been transferred,
and the reversal-and-debt path stops being the exceptional case it was designed
as and becomes the normal one. Two independently-chosen numbers that must relate
to each other will not stay related.

Deriving one from the other makes them consistent by construction. Raising the
window above the hold stays possible, and the boot banner then says in plain
words that returns past the hold will require transfer reversals — the same
treatment the SMS and payout seams get when they are configured into a corner.

**Cost, stated plainly:** it means the shipped default is a **seven-day** return
window, not fourteen. That is shorter than a buyer would like and it is honest;
the help page is being rewritten to match the code rather than the reverse.

### Whether the item comes back is out of band

Approval issues the refund. Nothing here tracks a parcel going the other way.

**Rejected: refund on return-scan**, which is what the help page promised.
It requires a carrier integration that does not exist — the same one that makes
prepaid outbound labels impossible ([the shipping page](../../frontend/src/app/sell/shipping-labels/page.tsx)
was rewritten for the same reason). Promising a scan-triggered refund with no
carrier account is a lie that would be discovered by the first person to use it.

So the physical return is arranged between buyer and seller, and the approval is
the seller saying they are content. A seller who approves and then receives
nothing has been defrauded and has an escalation route of their own, which is
support — recorded as a gap rather than solved.

### One request per order item, enforced by the database

`@@unique([orderItemId])` on `ReturnRequest`.

The insert is the claim, exactly as with `PayoutItem`
([ADR 0030](0030-payout-eligibility-and-hold.md)): two taps on "Start a return"
race, and the second collides with the constraint rather than opening a second
request against the same line. It also means a refused-and-rejected request
cannot be re-opened to try a different moderator, which is deliberate.

### A returned item is not relisted

Nothing goes back on sale. The listing was decremented at payment
([ADR 0012](0012-row-locking-for-reservations.md)) and stays that way.
Restocking means deciding whether a returned item is still the item that was
described, and that is a judgement call the seller should make by listing it
again.

## Consequences

**A buyer gets the thing the footer has been promising.** Open the order, ask,
and see the answer — with the reason, and an escalation if the answer is no.

**Refunds stay one code path.** `issueRefund()` is unchanged apart from a new
trigger value. Over-refund protection, idempotency, webhook settlement and
payout reversal all apply to a return-driven refund because it *is* a refund by
the time money moves.

**The default return window shortens the public promise from 14 days to 7.**
Recorded as the cost of not guaranteeing a reversal on every late return.

**Two parties can now cause a refund without a moderator.** A seller could
approve returns fraudulently to move money to a buyer they know. The existing
per-line over-refund guard bounds the damage to the order's own value, and the
audit trail records who approved what, but nothing detects the pattern. Noted,
not solved.

**Support is still the backstop for a seller defrauded by a buyer** who keeps
both the item and the money. There is no seller-protection flow, and building
one needs the carrier integration this ADR just declined.
