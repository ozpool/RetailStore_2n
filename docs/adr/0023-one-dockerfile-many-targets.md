# 23. One Dockerfile with several targets

- **Status:** Accepted
- **Recorded:** 2026-09-03

## Context

Every image this project ships had its own Dockerfile: `backend/Dockerfile`,
`frontend/Dockerfile`, and — briefly — a third at the repository root that ran
both processes in one container.

346 lines across three files, and the shared parts had **already drifted apart
once.** The dependency prune in the production stage is thirteen paths that must
be byte-identical in every image, and it was living in two places, either of
which could silently regain 204MB. Only one of them had the comment explaining
why the list exists.

Several other decisions were also duplicated: why the base is Debian slim rather
than Alpine (`sharp`'s prebuilt binaries), why ownership is set by `COPY --chown`
rather than a later `chown -R` (a second full copy of `node_modules` in its own
layer), and why Next's standalone output needs three separate copies.

## Decision

One `./Dockerfile`, with a target per image.

| Target | What it is |
| --- | --- |
| `api` | the Express API |
| `web` | the Next storefront, which is also the BFF ([ADR 0002](0002-bff-proxy.md)) |
| `api-build` | migrations and seeding — the only target carrying the Prisma CLI |

`docker-compose.yml` selects these with `target:`; the Kubernetes manifests use
`api` and `web`.

Every shared decision now exists exactly once, and `api` and `api-build` share
the `api-deps` layer rather than resolving the same lockfile twice.

### The cost

The build context is the repository root for every image, so
**`docker build ./backend` no longer works** and a root `.dockerignore` is
mandatory rather than convenient — without it both `node_modules` trees are
uploaded to the daemon on every build and the layer cache is invalidated by
files no image opens. The two app-level `.dockerignore` files are gone, because
there is nothing left to build from those directories.

## The all-in-one target, built and then removed

Worth recording rather than quietly deleting, because the reasoning cuts both
ways and the next person will have the same idea.

It ran the API and the storefront in one container under a small Node
supervisor, with the storefront reaching the API over loopback
(`BACKEND_URL=http://127.0.0.1:4000`). It worked, and it was verified: clean
shutdown in 1s on `docker compose stop`, one child dying taking the container
down with exit 143 and the restart policy recovering it, and **610 assertions
passing** against it.

**Removed anyway**, for two reasons:

**It was the only thing nothing depended on.** `api` and `web` are load-bearing:
Kubernetes needs one process per container to scale the tiers independently,
`scripts/ratelimit-demo.ts` needs the API standalone and run three times to
show 30 attempts getting through unshared against 10 with Redis, and the whole
point of moving rate limits and the cache to Redis
([ADR 0018](0018-redis-for-shared-ephemeral-state.md),
[ADR 0019](0019-cache-tiering-rule.md)), the refresh race to Postgres
([ADR 0021](0021-refresh-race-grace-window.md)) and uploads to object storage
([ADR 0022](0022-object-storage-for-uploads.md)) was that each tier can run
several replicas. The all-in-one gave that up by construction.

**It made the project harder to read.** A second, mutually exclusive way to run
the application sat in the same compose file as the real one — 472 lines, with
two services that must never both start because they collide on ports 3000 and
4000. The convenience of one command did not pay for a reader having to work out
which of two shapes was the actual deployment.

What it was solving is real: five services is a poor first impression for
somebody who just wants to see the application. The better answer is a shorter
quick start, not a second architecture.

## Consequences

**Verified across both remaining targets rather than assumed.** The
consolidation was checked by building each one and running the suite against
the split services:

| Checked | Result |
| --- | --- |
| Every target builds | ok |
| `node_modules` in `api` | **266MB** — the prune, applied once |
| Prisma CLI / TypeScript present? | gone; sharp's platform binaries intact |
| API suites against `api` + `web` | **610 assertions, 0 failed** |
| `api-build` still migrates and seeds | ok |
| Full suite, Stripe test mode | **870 assertions, 0 failed across 25 suites** |

**`--omit=dev` does not give a production dependency tree**, which is the
finding the prune exists for and the reason it must not be duplicated.
`@prisma/client` declares the Prisma CLI and TypeScript as *optional peer*
dependencies:

```
peerDependencies:     { "prisma": "*", "typescript": ">=5.4.0" }
peerDependenciesMeta: { "prisma": {"optional": true}, "typescript": {"optional": true} }
```

npm installs optional peers regardless and marks them `devOptional` in the
lockfile — reachable both as a devDependency and as an optional peer — so
`--omit=dev` keeps them. The runtime image was carrying the CLI, the compiler,
and Prisma Studio's entire React UI (`react-dom`, `@radix-ui`, `@visx`,
`elkjs`), plus `effect` and `@electric-sql`: **204MB of a 470MB tree.**

`--omit=optional` removes them and also removes `@img/sharp-linux-x64`, so image
processing throws on the first upload — measured, not guessed. It drops about
ninety other packages too, any of which might be needed on a path the tests do
not reach.

So the prune deletes exactly what the CLI drags in, in the same `RUN` as the
install, because layers are additive and deleting in a later step makes an image
bigger rather than smaller. A `node -e "require(...)"` at the end of that same
layer is a build-time assertion: if the list ever goes too far, the build fails
there rather than the first upload failing in production.

A comment in the old `backend/Dockerfile` had claimed the runtime image "never
contains typescript, tsx, the Prisma CLI, or Playwright". Two of those four were
wrong.

## Alternatives considered

**Three Dockerfiles, kept in step by discipline.** What existed. Rejected on
evidence: they had already drifted, and the drift was invisible until the image
sizes were compared.

**A shared base image the two real Dockerfiles extend.** Removes the
duplication without a root build context, so `docker build ./backend` keeps
working. Rejected because the base would have to be built and tagged before
either app image, which turns one `docker build` into two ordered ones and puts
that ordering in every place that builds — compose, CI, and a developer's
terminal. A multi-stage file expresses the same sharing with no build order to
remember.

**Keeping the all-in-one behind a profile.** Where it was. Rejected above: the
cost was the reader's, and it was the one target nothing else needed.
