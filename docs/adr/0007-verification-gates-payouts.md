# 7. Verification gates payouts, not listing creation

- **Status:** Accepted
- **Recorded:** 2026-08-22

## Context

Once identity verification exists, something has to depend on it. The obvious
placement is the seller gate: verify before you may list anything.

That placement front-loads the highest-friction step in onboarding onto someone
who has not yet decided whether the platform is worth using. A person clearing
out a flat, curious enough to photograph one chair, is asked for a passport
before they can find out if it sells.

It also protects the wrong thing. An unverified listing is not dangerous — it is
a photo and a description, subject to the same moderation as any other. The
irreversible action is **money leaving the platform**.

## Decision

Verification gates **payouts**. It does not gate listing creation or publishing.

- Anyone with a seller profile may create, publish, edit, and delete listings.
- `payoutsEnabled` becomes true only alongside a `VERIFIED` decision, written in
  the same transaction.
- `GET /seller/payouts` returns **403 `PAYOUTS_LOCKED`** until verified.
- Public listings show a "Verified" badge only when the seller is verified, so
  the status carries buyer-facing value rather than being pure overhead.

This mirrors Stripe Connect, where accounts can be created and charges
configured before onboarding completes, but payouts stay blocked until identity
requirements are satisfied. eBay and Etsy behave the same way.

The gate is enforced **server-side**. Disabled UI is a courtesy; the API
re-checks.

## Consequences

- Sellers reach value before friction: list first, verify when there is money to
  collect.
- Verification has a concrete, explainable reward — "verify to get paid" is a
  better prompt than "verify to continue".
- Unverified sellers can accumulate published listings. Acceptable: nothing has
  been paid, and listings remain moderatable.
- Once checkout exists, a **purchase** from an unverified seller becomes
  possible, so funds must be held rather than paid. That is the normal
  marketplace escrow shape, and it is a checkout-time concern.
- `payoutsEnabled` exists with no consumer today. Deliberate: the permission
  boundary is real and tested even though money movement is not built.

  *Since 2026-09-08 it has one.* [ADR 0029](0029-payouts-separate-transfers-not-destination-charges.md)
  built the payout path, and `lib/payouts.ts` reads this column as one of the
  two gates money passes — the other being Stripe's own
  ([ADR 0030](0030-payout-eligibility-and-hold.md)). The boundary this record
  argued for turned out to be the right shape: nothing had to move, only be
  consumed. The `403 PAYOUTS_LOCKED` promised here is still the answer on every
  payout route, and `tests/api/payout-routes.ts` fires all six at an unverified
  seller to keep it that way.

## Alternatives considered

**Verify before listing.** Simplest to reason about, worst for onboarding, and
protects an action that is not risky.

**Tiered thresholds** — unverified up to $X in sales, then required. What larger
marketplaces converge on, and genuinely better at scale. Rejected for now
because it needs sales volume tracking that does not exist without checkout.

**Verify before publishing, allow drafts.** A middle ground, but drafts are
private and worth nothing, so it is verify-before-listing with extra steps.

**No gate at all.** Then verification is decoration, and the schema records a
status nothing consults.
