# 5. Money as integer minor units

- **Status:** Accepted
- **Recorded:** 2026-08-22

## Context

Prices began life as JavaScript numbers in mock data (`price: 310`). Moving them
into a database forced the question of what type they should actually be.

Binary floating point cannot represent most decimal fractions exactly.
`0.1 + 0.2 === 0.30000000000000004`. Applied to money this produces totals that
are off by a cent, and rounding that disagrees between two code paths that look
equivalent. These bugs surface in reconciliation, long after the code shipped.

## Decision

Money is stored and transported as **integer minor units** — `priceCents` — with
an ISO 4217 `currency` alongside it. No float touches a price at any layer.

- **Database:** `priceCents Int`, `originalPriceCents Int?`
- **Write APIs** accept cents, so no float rounding is possible in transit.
- **The search API** accepts `minPrice`/`maxPrice` in whole currency units,
  because that is what a price filter collects. Converted with `Math.round(v * 100)`
  at the boundary.
- **Forms** collect dollars and convert once, in `dollarsToCents`.
- **Display** happens only in `formatPrice`, which renders whole amounts without
  decimals (`$310`) and fractional ones with (`$64.50`).

Currency is stored per listing rather than assumed globally, so multi-currency
does not require a migration.

## Consequences

- Arithmetic is exact. No accumulated drift, no path-dependent rounding.
- Conversion happens at exactly two boundaries — form input and display —
  instead of scattered across components.
- Every price read must be formatted; a raw `priceCents` reaching a template
  renders `12000`. Centralising `formatPrice` makes that mistake visible.
- Zero-decimal currencies (JPY, KRW) and three-decimal ones (KWD) need
  per-currency exponents rather than a hardcoded ÷100. Not handled today;
  storing `currency` is what makes it addressable later.

## Alternatives considered

**Float / `Double`.** Familiar and wrong. The failure mode is silent and
appears in accounting rather than in tests.

**Postgres `NUMERIC` / Prisma `Decimal`.** Genuinely correct for arbitrary
precision, and the right choice for tax or interest calculations. Rejected here
because it arrives in JavaScript as a `Decimal` object needing conversion at
every boundary, and integers are sufficient when the smallest unit is fixed.
Stripe, Shopify, and Adyen all use integer minor units in their APIs.

**Strings.** Preserves precision in transit but pushes parsing onto every
consumer and permits malformed values.
