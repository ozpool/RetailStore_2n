# 9. Compute ratings from review rows

- **Status:** Accepted
- **Recorded:** 2026-08-22

## Context

The mock catalog carried invented ratings — `rating: 4.9, reviews: 52` — as
plain fields on each item. Nothing backed them.

Migrating those fields into a database would have changed their character. In
mock data an obviously-round number reads as placeholder content. In a
`listings` table, `rating` and `reviewCount` columns read as *records*. The site
would then be asserting, with the authority of stored data, that 52 people
reviewed an item nobody had reviewed.

This matters more here than it would elsewhere: the product's entire pitch is
disclosure — "flaws always disclosed", condition stated honestly. Fabricated
social proof contradicts the thing being sold.

## Decision

There is no stored aggregate. A `reviews` table holds real rows, and averages
are computed from them.

- `Review` has `listingId`, `authorId`, `rating` (1–5), optional `body`, with
  `@@unique([listingId, authorId])` — one review per person per listing,
  enforced by the database.
- Catalog responses carry `rating: { average, count }`, derived per request via
  a single grouped query over the page's listing ids — not N+1.
- **No reviews yields `average: null`, not `0`.** The UI renders "No reviews
  yet". A zero would be a rating; absence is not.
- The seed creates real review rows so the numbers it produces are genuine
  aggregates of synthetic-but-existing records.

## Consequences

- Every rating on screen traces to rows that exist.
- Seeded numbers are smaller and less flattering than the invented ones — a
  jacket went from `4.9 (52)` to `4.8 (5)`, and a needs-repair bicycle honestly
  lands at `3.7`. Varied, imperfect ratings read as more trustworthy than a
  uniform sea of 4.7s.
- Newly created seller listings show "No reviews yet" rather than inheriting a
  flattering default.
- One extra grouped query per catalog page.
- Sorting by rating is not offered. Doing it in SQL requires the aggregate in
  the sortable set; sorting only the current page would be a plausible-looking
  lie. Omitted rather than faked.
- `StarRating` takes `count` as optional, because a single review has no
  aggregate to report — passing `0` would have rendered a misleading "(0)".

## Alternatives considered

**Denormalised `ratingSum` + `reviewCount` on `listings`.** The standard
optimisation, and the right move under read pressure: it makes rating sortable
and removes the extra query. Rejected for now because it introduces a
consistency burden — every review write must update two places — to solve a
performance problem this catalog does not have. Worth revisiting when sorting by
rating is wanted, since that is the point where computing it stops working.

**Keep `rating`/`reviewCount` as plain seeded columns.** One less table. Means
the database asserts reviews that do not exist, which is the specific outcome
this decision exists to avoid.

**Drop ratings from the UI entirely.** Honest, and discards a genuinely useful
signal for secondhand goods, where seller reliability is most of the risk.
