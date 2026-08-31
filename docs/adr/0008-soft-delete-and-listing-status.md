# 8. Soft delete plus a status enum, not a stock count

- **Status:** Accepted
- **Recorded:** 2026-08-22

## Context

Two related questions came up when designing `listings`.

**How is availability modelled?** The reflex is a `stock` integer, decremented
on purchase. But this is a secondhand marketplace: nearly every item is
one-of-a-kind, and the UI already said "Only 1 available". A stock counter
models "how many are left", when the actual risk is **two buyers claiming the
same chair**. That is a concurrency problem, not an arithmetic one. Depop,
Vinted, and Poshmark are single-quantity with a sold state; Etsy has quantity
because handmade goods come in multiples.

**What happens on delete?** Hard-deleting a listing that appears in a past order
would leave that order pointing at nothing — an order history that cannot render
what was bought.

## Decision

**Availability** is a `ListingStatus` enum, with `quantity` as a secondary
attribute defaulting to 1:

```
DRAFT → ACTIVE → RESERVED → SOLD
          ↕                    
        DRAFT              REMOVED
```

`RESERVED` exists so checkout can hold a unique item without selling it twice.
`quantity` is retained because a seller may genuinely have several identical
mugs, but it is not the primary mechanism.

**Deletion** is soft: `deletedAt` is set and `status` becomes `REMOVED`. The row
stays. Every catalog read filters `status = ACTIVE AND deletedAt IS NULL`, so a
removed listing disappears from the storefront and from the seller's dashboard
while remaining resolvable by id.

Related: a listing's `slug` is generated once at creation and never regenerated
on rename, so published URLs keep working.

## Consequences

- The concurrency problem has a designated home before checkout is written,
  rather than needing a migration mid-feature.
- Order history will always be able to render what was purchased.
- Every read must remember both filter conditions. Centralised as a single
  `VISIBLE` constant in the catalog routes to avoid a query that forgets one.
- Removed rows accumulate. Fine at this scale; a retention job is the eventual
  answer.
- Unique-key collisions can outlive deletion — a soft-deleted listing still
  occupies its `slug`. Acceptable, since slugs carry a uniqueness suffix when
  they clash.
- `RESERVED` is currently unreachable. Deliberate, and documented as such rather
  than left looking like dead code.

## Alternatives considered

**`stock` integer only.** Invites overselling on the exact case that dominates
this catalog, and gives concurrency nowhere to live. A count reaching zero does
not express "this specific object is gone".

**Boolean `isSold`.** Cannot represent drafts, reservations, or seller-initiated
removal, all of which are distinct states with different visibility rules.

**Hard delete.** Simplest, and breaks referential integrity with orders. Cascade
would silently destroy order history; restricting the delete would just surface
a foreign-key error to the seller.

**Separate `archived_listings` table.** Keeps the hot table small, at the cost
of every historical query needing a union and every schema change happening
twice.
