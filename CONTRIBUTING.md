# Contributing

RetailStore_2n is a personal project rather than a community-maintained one, so
there's no review rota or triage process. This file exists because the setup has
sharp edges worth writing down — mostly for whoever picks it up next, including
future me.

## Conventions

**Validate at the boundary.** Zod parses request bodies and query strings in the
route; everything inward is typed. Errors carry a stable `code` and, when one
input is at fault, a `field` the UI renders against that input.

**Wrap async handlers.** Express 4 does not catch rejected promises. Every
handler try/catches, logs with context, and returns a generic message —
internal detail stays server-side.

**Scope by owner, return 404.** Seller queries filter on `sellerId`. A record
owned by someone else returns 404, never 403: a 403 confirms the id exists.

**Money is integer minor units.** `priceCents` end to end. Convert in
`dollarsToCents` on input and `formatPrice` on output, nowhere else.

**Explicit `select`.** Name the fields a route returns, so adding a column never
silently leaks it through an existing endpoint.

**Comments explain why.** The constraint that isn't visible from the signature,
not a restatement of the code.

**Don't fake unbuilt features.** Placeholders say what's missing and carry a
"Planned" badge. No button that looks functional and isn't.

Names: tables `snake_case` via `@@map`, TypeScript `camelCase`, enum values
`SCREAMING_SNAKE_CASE`.

