# Contributing

RetailStore_2n is a personal project rather than a community-maintained one, so
there's no review rota or triage process. This file exists because the setup has
sharp edges worth writing down — mostly for whoever picks it up next, including
future me.

## Setup

Follow [Quick start](README.md#quick-start). Two things that bite:

**Postgres runs on host port 5433, not 5432.** `docker-compose.yml` maps it
there to avoid clashing with a native Postgres install. If you change it, change
`DATABASE_URL` too.

**`prisma migrate dev` does not reliably regenerate the client here.** If a new
column or enum is missing from types at runtime — a `PrismaClientValidationError`
saying `Unknown argument` — run:

```bash
npx prisma generate
```

## Running things

```bash
# backend/
npm run dev            # tsx watch
npm run build          # tsc typecheck + emit
npx prisma studio      # browse data
npx prisma db seed     # idempotent; safe to re-run

# frontend/
npm run dev
npm run build          # includes typecheck — run before committing
```

**Restart the dev server after editing `next.config.ts`.** It is read at boot,
not watched. A stale config produced an hour of confusion once already.

**Start one dev server per app.** Repeated background launches leave orphaned
`tsx watch` / `next dev` trees fighting over ports 4000 and 3000, which shows up
as `EADDRINUSE` crash loops. On Windows:

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'tsx watch|next dev' } |
  Select-Object ProcessId, ParentProcessId, CommandLine
```

Kill the top of the tree (the `npm` process), not just the leaf.

## Signed commits

New commits are signed with SSH, so authorship is verifiable rather than
self-declared — Git's `author` field is plain text that anyone can set. History
from before signing was introduced is unsigned and stays that way; rewriting it
would destroy the timestamps that establish authorship in the first place.

Requires Git 2.34+ (`git --version`).

```bash
# A key dedicated to signing, separate from any authentication key.
# Omit -N "" to be prompted for a passphrase instead of having none.
ssh-keygen -t ed25519 -C "you@example.com (signing)" -f ~/.ssh/id_ed25519_signing

git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519_signing.pub
git config --global commit.gpgsign true
git config --global tag.gpgsign true
```

Then add the **public** key (`~/.ssh/id_ed25519_signing.pub`) to GitHub under
*Settings → SSH and GPG keys* → **New SSH key**, setting **Key type** to
**Signing Key** — it defaults to *Authentication Key*, and choosing wrong means
GitHub finds no signing key and every commit silently reads `Unverified`.
Enable **Vigilant mode** on the same page so unsigned commits are flagged
rather than shown without a badge.

For GitHub to show `Verified`, the commit's email must also be a verified
address on the account holding the key.

### Verifying locally

Git needs to be told which keys it should trust, or it can confirm a signature
is valid but not who it belongs to:

```bash
# Map your email to your public key, then point Git at that file.
printf '%s %s\n' "you@example.com" \
  "$(awk '{print $1" "$2}' ~/.ssh/id_ed25519_signing.pub)" >> ~/.ssh/allowed_signers
git config --global gpg.ssh.allowedSignersFile ~/.ssh/allowed_signers

git log --show-signature -1
```

Expected: `Good "git" signature for you@example.com with ED25519 key SHA256:…`

Skip the `allowed_signers` step and the same command reports `Unable to open
allowed keys file` alongside the signature — confusing, but harmless, and it
says nothing about whether GitHub will verify the commit.

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

## Documentation

Ship docs with the code, in the same change:

| Change | Also update |
| --- | --- |
| Schema | [docs/architecture/data-model.md](docs/architecture/data-model.md) |
| Endpoint added or changed | [docs/api.md](docs/api.md) |
| Module boundary or notable flow | [docs/architecture/lld.md](docs/architecture/lld.md) |
| A decision with more than one defensible answer | a new [ADR](docs/adr/README.md) |
| Env var | `.env.example` in the relevant app, **and** `k8s/base/configmap.yaml` or the Secret |
| Anything a deployment needs | `k8s/` — Compose and the manifests will drift, and where they disagree about anything but topology the manifests are wrong |

## Before you push

```bash
cd backend
npm run typecheck           # src AND tests/scripts — two tsconfigs, both required
npm run lint                # errors only; the warning ceiling is pinned
npm test                    # everything — 1,263 assertions, 35 suites
```

**`npm run typecheck` runs two programs, and the second one matters.**
`tsconfig.json` emits `dist`, so it covers only `src`. `tsconfig.tests.json`
covers `tests/`, `scripts/` and `prisma/` — as ESM with the DOM lib, because
tsx runs them and the browser suites pass callbacks to `page.evaluate`. A bare
`tsc --noEmit` checks neither the suites nor the scripts, which is how a type
error in a test used to reach CI green.

**The linter is for defects, not formatting.** Errors are rules like
`no-floating-promises` — a dropped `await` before a provider call is invisible
to the compiler and inverts a claim-then-act sequence. Warnings are pinned at a
ceiling so the count cannot quietly grow; raising it needs a written reason in
`eslint.config.mjs`, as the existing entries have.

```bash
npm test -- api             # only the API suites
npm test -- refunds         # any suite whose name matches
```

**These are end-to-end tests. They need the real stack running** — Postgres,
Redis, the API, and the frontend. `tests/run.ts` checks for all four before it
starts and tells you which one is missing rather than failing obscurely on the
first suite.

Nothing is mocked. The bugs worth catching here live in the seams between the
pieces — the BFF proxy, the payment claim, the row lock — and a mock of the
piece on the other side of a seam cannot fail the way the real one does.

**Assert on outcomes, not on the presence of elements.** Counting `<img>` tags
once reported a passing upload while every image on the page was broken;
checking `naturalWidth > 0` is what caught it.

**Watch for fire-and-forget writes.** Notifications are emitted without being
awaited, so a test that reads straight after the action that triggers one is
racing it. Six suites had this bug. Use `awaitNotifications()` from
`tests/lib/fixtures.ts` rather than a sleep — see `tests/README.md`.

**Drive the API, not the library.** Importing a function like `markUnfulfillable`
and calling it runs the code in the *test* process, against its own in-memory
state, while the server the rest of the suite is talking to knows nothing about
it. Three suites did this and would have passed forever without testing
anything. `Scope.ownListing()` exists so the seller side can be driven properly.

Adding a suite means registering it in `tests/run.ts`. CI runs the whole thing
on every push and pull request.

