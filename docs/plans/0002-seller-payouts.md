# Plan 0002 — Paying sellers

- **Status:** all six phases landed 2026-09-08. Money moves against the stub;
  nothing has been run against Stripe Connect.
- **Written:** 2026-09-08
- **Produces:** ADRs 0029 and 0030

> **What this is now.** The plan is complete and the phase notes below record
> what each one actually cost, including where a phase was met only in part.
> The durable description lives in [lld.md](../architecture/lld.md); this file
> is the decision trail.
>
> **What is NOT proven.** Every number in this plan and in the README comes from
> `PAYOUT_PROVIDER=stub`. No connected account has ever been created, no
> transfer has ever been issued, and no `account.updated` webhook has ever
> arrived from Stripe. The seam is exercised end to end; the provider behind it
> is not. That is the same position payments and identity are in, and it is the
> honest limit of what a repository with no Stripe Connect account can claim.

---

## 1. Where this stood when the plan was written

*Kept as written, on 2026-09-08 before any of this existed. The constraints in
the table below are what shaped every decision that followed, and they are
easier to judge knowing what was and was not true at the time.*

Money reached the platform and could be refunded from it. It could not reach a
seller. From [hld.md](../architecture/hld.md)'s limitations list, as it then
read:

> **No payouts to sellers.** The largest remaining gap. Money reaches the
> platform and can be refunded from it; paying sellers out needs Stripe Connect.
> `payoutsEnabled` is set by identity verification and nothing consumes it yet.

Three facts about the existing system constrain everything here, and all three
are already decided:

| Fact | Decided in | Consequence for payouts |
| --- | --- | --- |
| One `PaymentIntent` per order, but a basket may span sellers | [ADR 0014](../adr/0014-one-order-fulfilment-per-line.md) | The payout unit is the **order item**, not the order |
| Refunds are per line, automatic when a seller cannot send | [ADR 0016](../adr/0016-refunds-claim-then-refund.md) | Money can be clawed back after delivery, so payout cannot be immediate |
| The platform takes no cut | README | There is no fee to deduct, and no revenue to pay Stripe's transfer costs from |

## 2. What is being built

The buyer's payment stays exactly as it is. A separate process reads settled
orders and moves each seller's share afterwards.

```
payment (unchanged)          →  platform balance
delivered + held + unrefunded →  payout claim  →  Stripe transfer  →  seller
refund after payout           →  transfer reversal, or a recorded debt
```

`PAYOUT_PROVIDER=stub|stripe_connect`, the seventh seam, so the whole path is
exercised in CI with no Stripe account — the same arrangement as payments,
identity, mail, file storage, SMS and the notification transport.

## 3. Schema additions

Four things. Two columns on `SellerProfile`, and two new tables.

```prisma
model SellerProfile {
  // ...existing
  /// OUR gate, from Stripe Identity. Unchanged by this plan.
  payoutsEnabled     Boolean @default(false)

  /// STRIPE'S gate, mirrored from the connected account's
  /// `payouts_enabled` capability by the account.updated webhook.
  /// Both must be true before a transfer is attempted — see ADR 0030.
  payoutsReady       Boolean @default(false)
  connectAccountId   String? @unique
  connectOnboardedAt DateTime?
}
```

```prisma
/// One transfer to one seller, covering one or more delivered order items.
model Payout {
  id       String @id @default(uuid())
  sellerId String

  /// The sum of the items below, minus any debt netted off.
  amountCents Int
  currency    String @default("USD")

  status PayoutStatus @default(PENDING)

  /// A REFERENCE to Stripe's transfer, never a copy of its contents —
  /// the same rule as paymentIntentId and providerRefundId.
  provider         String?
  providerTransferId String? @unique
  failureReason    String?

  createdAt   DateTime  @default(now())
  completedAt DateTime?

  items PayoutItem[]
}

/// THE IDEMPOTENCY GUARD. An order item can appear in at most one payout,
/// and that is a constraint rather than a promise about control flow.
model PayoutItem {
  id          String @id @default(uuid())
  payoutId    String
  orderItemId String @unique
  /// Snapshotted, because a payout statement must stay readable after the
  /// listing is gone — the same reasoning as the shipping address on an order.
  amountCents Int
}
```

A `PayoutDebt` row records a reversal that could not be recovered, netted off
the next payout. It is deliberately the thinnest thing that works — see the
consequences in [ADR 0030](../adr/0030-payout-eligibility-and-hold.md).

## 4. Phases

Each ships on its own and leaves the system working.

### ~~Phase 0 — Decide, and write it down~~ · landed 2026-09-08

Two ADRs, no code:

| ADR | Decision |
| --- | --- |
| 0029 | Separate transfers over destination charges; Connect Express; claim before transferring |
| 0030 | Payable means delivered, held and unrefunded; both verifications must pass; one item, one payout |

**Exit:** two records merged, each with its rejected alternatives.

**Met.** Both name what they cost, including the two things the code cannot
fix: Stripe's Connect fees landing on a platform that takes no cut, and a
seller waiting a week after delivery.

### ~~Phase 1 — The seam, the schema, and onboarding~~ · landed 2026-09-08

- Migration for the four schema additions above.
- `lib/payoutProvider.ts` — `createAccount`, `onboardingLink`,
  `accountStatus`, `transfer`, `reverseTransfer`. Two implementations.
- The stub keeps accounts in memory and returns deterministic ids, so the whole
  flow completes with no Stripe account and CI stays credential-free.
- `POST /seller/payouts/account` starts onboarding and returns the link;
  `account.updated` on the existing webhook endpoint keeps `payoutsReady` true.

**Exit:** a seller can complete onboarding against the stub and
`payoutsReady` flips, with no Stripe account anywhere.

**Met, in part.** The migration, `lib/payoutProvider.ts` and the stub exist, and
the boot banner reports `Payouts: stub`. `stripe_connect` refuses to start
without either secret, and an unknown provider is rejected by name. The payout
id is Stripe's idempotency key, because a retry after a timeout is the one case
where this platform cannot tell whether the money already moved.

**Settled in phase 3, as planned.** The onboarding routes were owed from here
and landed with the rest of `routes/sellerPayouts.ts`: `POST /seller/payouts/
account` starts onboarding, `POST /seller/payouts/account/refresh` re-reads the
account when a webhook is missed, and `handleConnectAccount` on the existing
webhook endpoint mirrors Stripe's `payouts_enabled` onto `payoutsReady`.

It mirrors onto `payoutsReady` and **never** onto `payoutsEnabled`. Those are
two different gates from two different authorities — ours and Stripe's — and a
webhook that could open our identity gate would make ADR 0007 decorative.

### ~~Phase 2 — What is owed~~ · landed 2026-09-08

- `lib/payouts.ts` — `payableItems(sellerId)` implementing the five conditions
  of ADR 0030, and `earningsSummary(sellerId)` splitting *paid*, *payable now*,
  *held until*, and *withheld* so the seller page can explain each.
- No money moves in this phase. It is a query, and it is where the reasoning
  about refunds and holds is actually encoded.

**Exit:** the four figures reconcile against a hand-checked fixture, including
an order with one delivered item, one refunded item and one still shipping.

**Met.** `tests/api/payouts.ts` — 52 assertions by the time phase 5 finished
with it, against a fixture whose every
expected figure is written as a sum of named lines, so a failure says which line
changed category rather than that two totals disagree.

The assertion that matters most is the unpaid order: its line is delivered and
long past the hold, so *every other condition passes* and only the order's
status excludes it. A query joining on fulfilment alone would hand the seller
$99 of money nobody ever paid.

Three decisions came out of writing it rather than planning it:

- **An order-level refund withholds every line of that order, whatever its
  amount.** A partial goodwill refund with no `orderItemId` cannot be
  attributed, and apportioning it across sellers by guesswork means paying
  someone money the buyer has already had back. Blunt on purpose.
- **A PENDING refund withholds too.** The money may not have left yet, but a
  refund in flight is not a reason to pay the seller first.
- **`withheld` is a separate figure from `held`.** Money blocked by the ACCOUNT
  is actionable by the seller — finish onboarding — where money inside its hold
  window is only a matter of waiting. Reporting both as `payable: 0` would tell
  a seller they had earned nothing.

### ~~Phase 3 — Moving the money~~ · landed 2026-09-08

- `claimPayout(sellerId)` — inserts the `Payout` and its `PayoutItem` rows in
  one transaction. The unique constraint on `orderItemId` is what makes a
  concurrent second run collide rather than double-pay.
- Then, and only then, the provider is called. Same order as claim-then-charge.
- `reverseForRefund(orderItemId)` on the refund path: reverse the transfer if
  the item has been paid, and record a `PayoutDebt` if the reversal fails.

**Exit:** two concurrent payout runs over the same seller produce one transfer
and one payout row; a refund after a completed payout reverses it; a reversal
that fails leaves a debt that the next payout nets off.

**Met.** All three, asserted in `tests/api/payouts.ts` and demonstrated under a
real SIGKILL by `scripts/payout-safety-demo.ts`. `routes/sellerPayouts.ts`
carries the six endpoints; `reverseForRefund` is wired into **both** settle
paths in `lib/refunds.ts`, not just the synchronous one — a refund settled by a
provider webhook is the same money.

Three things came out of building it rather than planning it:

- **The gate had to move, not be replaced.** ADR 0007 put `403 PAYOUTS_LOCKED`
  on `GET /seller/payouts` when that endpoint returned an honest zero. Deleting
  the placeholder without carrying its refusal forward would have quietly
  removed a documented permission boundary — so the real router opens with the
  same 403, and `tests/api/identity.ts` still asserts it.
- **That gate must be path-scoped.** `router.use(fn)` with no path runs for
  every request reaching the mount, and this router is mounted at `/seller`
  beside the verification router. An unscoped gate therefore reaches
  `/seller/verification` — the only page that could unverify-to-verified a
  seller locked out by it. And it does not even refuse cleanly: `requireSeller`
  is scoped to `/payouts` too, so `req.sellerId` is unset on sibling paths and
  the gate's own lookup throws a **500**. Caught by the identity suite, and now
  pinned by section 2 of `tests/api/payout-routes.ts` — verified by reverting
  the scoping and watching three assertions go red rather than by assuming they
  would.
- **`sendPendingPayouts` was not in the plan.** The claim commits before the
  transfer, so a crash in between leaves money reserved with nothing chasing
  it. That is the same ambiguous middle as the delivery ledger (ADR 0026) and
  it needs the same answer: something comes back for it. Without this, the
  claim-first ordering trades double-payment for indefinite limbo.

**Not built:** no scheduler calls `sendPendingPayouts`. It is exported and
covered, and an operator or a cron has to invoke it — for the same reason
outbox retention has no scheduler
([ADR 0024](../adr/0024-outbox-not-dual-writes.md) §Retention).

### ~~Phase 4 — The screens~~ · landed 2026-09-08

- `/seller/payouts` — the four figures, the next payout date, the items in each
  past payout, and why anything withheld is withheld.
- The admin panel gains payouts beside the delivery log, because "when was this
  seller paid?" is the same class of support question as "did the buyer get the
  email?".

**Exit:** a seller can answer "why is this $84?" without asking anyone.

**Met.** `/seller/payouts` lists every payable line with its title, delivery
date and amount, so the total is never a figure to take on trust, and every
past payout expands to the items it covered. `/admin/payouts` sits beside the
delivery log with the same search-and-filter shape.

Two departures from the plan, both deliberate:

- **There is no "next payout date", because there is no schedule.** The plan
  asked for one. Writing it meant inventing a cadence the system does not have,
  so the page says when the next money comes *off hold* and states plainly that
  a payout is requested rather than scheduled.
- **The admin view is read only.** No retry button. A retry moves money, and the
  only safe way to move it is the seller's own claim-then-transfer path, which
  cannot pay one item twice. A button that transferred directly would bypass
  the claim and become the single way to double-pay somebody.

`held`, `withheld` and `debt` are shown as three separate figures with three
separate explanations, because they are three different things for the seller
to do: wait, finish onboarding, or nothing.

### ~~Phase 5 — Prove it does not double-pay~~ · landed 2026-09-08

- `tests/api/payouts.ts` against the stub: the five eligibility conditions each
  asserted separately, the concurrent-claim race, refund-before-payout,
  refund-after-payout, and a failed reversal becoming a debt.
- `scripts/payout-safety-demo.ts` in the style of `payment-safety` — kill the
  process between the claim and the transfer and show that no money moves twice.

**Exit:** numbers and assertions in the README, in the existing style.

**Met.** 52 assertions, and a demo that kills a real process.

`scripts/payout-safety-demo.ts` does not simulate the crash. A child process
claims the payout and then SIGKILLs its own pid, so the row is committed by a
process that no longer exists and gets no chance to roll back, retry or finish.
Three numbers hold together across runs at 6 and 20 lines and up to 16
concurrent racers:

```
  paid twice              $0.00
  lost to the crash       $0.00
  left in limbo           0 payouts
```

**Duplicates are counted without trusting the constraint that prevents them.**
The figure is `payout_items rows - distinct(orderItemId)`, so dropping the
unique index tomorrow would make this script report the duplicates it allows
rather than report zero because the index made the query impossible to fail.
The same reasoning as `consumer-failure-demo.ts`.

One assertion had to be rewritten during this phase. The concurrent-claim test
demanded the losing runs report `raced` specifically — but `nothing-payable` is
an equally correct loss, depending on whether the loser reads the claim or
collides with it. Asserting a scheduler-dependent reason made a correct system
fail intermittently. It now asserts the property that matters: exactly one
transfer, and the line paid exactly once.

## 5. What this does not do

**No payout scheduling.** A payout is triggered by a seller or an admin, not by
a cron. Compose has no scheduler, and a `setInterval` in the process serving
checkout is the wrong place for something that calls Stripe.

*Since revisited, and the distinction is worth keeping straight.* The
Kubernetes deployment does have one scheduled job
([ADR 0032](../adr/0032-kubernetes-manifests.md)) and it does not undo this:
`payouts:pending` settles payouts already claimed by a request that never
reached the provider. Nothing has ever begun a payout on a timer.

**No debt collection.** A shortfall is netted off the next payout and nothing
else. A seller who never sells again keeps the money.

**No multi-currency.** Every amount is USD, as everywhere else in the system.
Connect can pay out in other currencies and none of the surrounding code is
ready for it.

**No 1099 / tax reporting from this codebase.** Express accounts put that on
Stripe, which is most of why Express was chosen.

## 6. Open questions

1. **Who pays Stripe's Connect fees?** Per transfer, and per active connected
   account. "The platform takes no cut" has no revenue behind it to cover this.
   **Needs a business answer, not a technical one** — either the platform
   absorbs it, or the position becomes "no cut beyond the payment fees".
2. **Is the seven-day hold right?** It is a guess made without dispute data.
   Too short and the platform eats refunds; too long and sellers finance the
   platform.
3. **Payout cadence — on demand, or batched?** Built on demand, because it is
   simpler and needs no scheduler this deployment does not have. That is a
   decision made by default rather than on merit, and it should be revisited
   with question 1: batching means fewer transfers and therefore lower fees, and
   nothing in the claim or the ledger would have to change to support it — only
   what triggers `runPayout`.
4. **Does Stripe Identity survive?** ADR 0030 keeps it, on the argument that it
   answers a different question from Connect's checks. The counter-argument is
   real: it is a second verification for one seller, and a reader could
   reasonably call it redundant. Building both gates did not settle it — it only
   made the cost visible, which is a seller who verifies twice before being
   paid once.

**Nothing above blocks the code, and none of it is answerable from inside this
repository.** They are recorded rather than resolved because inventing a
business position to close a plan is worse than leaving the question open.
