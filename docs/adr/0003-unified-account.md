# 3. One account type; selling is a capability

- **Status:** Accepted
- **Recorded:** 2026-08-22

## Context

Marketplaces split on this. Amazon separates buyer accounts from Seller Central
— different signup, different login, different console. Depop, Vinted, and
Poshmark use one account where anyone can list.

The choice shapes signup, session handling, navigation, and every
authorisation check thereafter.

## Decision

One `User` row per person. `isSeller` is a capability flag, and a
`SellerProfile` row is created when someone starts selling.

Both are written in a single transaction by `POST /auth/become-seller`. A user
with `isSeller = true` and no profile could not own a listing; a profile without
the flag would be invisible to the UI. Neither half is valid alone.

Seller-only state — shop name, verification status, payout permission — lives on
`SellerProfile` rather than on `User`, so the row read on every authenticated
request stays small.

## Consequences

- Someone browsing can start selling without a second signup, which is the
  behaviour that matters for a peer-to-peer marketplace where most sellers
  arrive as buyers.
- One session, one nav, one identity.
- Authorisation needs two composable middlewares: `requireAuth` for identity,
  `requireSeller` to resolve `sellerId`. Authentication never implies
  authorisation.
- `isSeller` duplicates "a SellerProfile exists". Tolerated because the flag is
  what auth responses and the UI read, and the transaction prevents drift. If
  they ever diverge, the profile is the source of truth.
- A future business-seller tier with tax registration and bulk tools would need
  more than a boolean. That would be a new record superseding this one.

## Alternatives considered

**Separate buyer and seller accounts (Amazon model).** Justified when the two
sides are genuinely different businesses with different compliance obligations.
Here it would mean asking a hobbyist clearing out a flat to register a second
account — friction with no benefit.

**A `role` enum on `User`.** Cheap, but wrong shape: buying and selling are not
mutually exclusive, and roles would either need to be a set or be a lie.

**Seller fields directly on `User`.** Fewer joins, but widens the hottest row in
the schema with columns almost every request ignores, and mixes identity data
with commerce state.
