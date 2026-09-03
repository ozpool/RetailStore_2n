# syntax=docker/dockerfile:1

# Every image this project ships, from one file.
#
#   docker build --target api       .   the Express API
#   docker build --target web       .   the Next storefront (which is the BFF)
#   docker build --target relay     .   the outbox relay (api image, other CMD)
#   docker build --target worker    .   notification channel workers (likewise)
#   docker build --target api-build .   migrations and seeding (has the CLI)
#
# docker-compose.yml selects these with `target:`; the Kubernetes manifests use
# `api` and `web`.
#
# WHY ONE FILE AND NOT TWO
# There were three: backend/Dockerfile, frontend/Dockerfile, and briefly an
# all-in-one that re-implemented both. The shared parts had already drifted
# apart once — the dependency prune below is thirteen paths that have to stay
# identical in every image, and it was living in two places, either of which
# could silently regain 204MB.
#
# An all-in-one target briefly lived here too, running both processes under a
# supervisor. It was removed: it was the one target nothing depended on, and it
# put a second, mutually exclusive way to run the app beside the real one. See
# ADR 0023.
#
# WHY DEBIAN SLIM AND NOT ALPINE
# `sharp` is a production dependency — every seller photo is re-encoded through
# it to strip EXIF (ADR 0010). It ships prebuilt binaries per platform, and the
# musl builds Alpine needs are the single most common source of "works locally,
# segfaults in the container". Roughly 70MB of image is a fair price for
# removing a class of failure that only appears at runtime.
#
# Prisma helps here: this project uses driver adapters (@prisma/adapter-pg), so
# there is no native query engine to match against the base image at all.
#
# See docs/adr/0023-one-dockerfile-many-targets.md

# ==================================================================
# Backend
# ==================================================================

# Its own stage so it is cached on the lockfile alone — editing a route must not
# reinstall node_modules.
FROM node:24-slim AS api-deps
WORKDIR /api
COPY backend/package.json backend/package-lock.json ./
RUN npm ci


# Also the image that runs migrations and the seed: it is the only stage
# carrying the Prisma CLI, the schema, and the migration history.
FROM api-deps AS api-build
WORKDIR /api

COPY backend/prisma ./prisma
COPY backend/prisma.config.ts backend/tsconfig.json ./

# Generated inside the image, never copied from the host: the client is built
# for a platform, and .dockerignore excludes backend/src/generated for that
# reason.
#
# The dummy URL is needed because prisma.config.ts declares a datasource url and
# the CLI insists on one being present. Nothing connects during generate — this
# value never reaches a database.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npx prisma generate

COPY backend/src ./src
RUN npm run build


# ------------------------------------------------------------------
# Production dependencies, and the one thing about them that is not obvious.
#
# `--omit=dev` IS NOT ENOUGH. `@prisma/client` declares the Prisma CLI and
# TypeScript as OPTIONAL PEER dependencies:
#
#   peerDependencies:     { "prisma": "*", "typescript": ">=5.4.0" }
#   peerDependenciesMeta: { "prisma": {"optional": true}, ... }
#
# npm installs optional peers anyway and marks them `devOptional` in the
# lockfile — reachable both as a devDependency and as an optional peer — so
# `--omit=dev` keeps them. A "production" tree therefore carried the CLI, the
# TypeScript compiler, and Prisma Studio's entire React UI. Measured: 204MB of
# 470MB.
#
# `--omit=optional` drops them and also drops `@img/sharp-linux-x64`, so image
# processing throws on the first upload — measured, not guessed. It removes
# about ninety other packages too, any of which might be needed on a path the
# tests do not reach. Rejected as a blunt instrument.
#
# So: delete exactly what the CLI drags in. Every entry below was traced with
# `npm ls` to one of `prisma`, `@prisma/config`, `@prisma/dev` or
# `@prisma/studio-core`; none of them is reachable from `@prisma/client`'s
# runtime.
#
# IN THE SAME `RUN` AS THE INSTALL, deliberately. Layers are additive, so
# deleting in a later step removes the files from the filesystem and leaves them
# in the image — making it bigger, not smaller.
#
# The `node -e` at the end is a build-time assertion: if this prune ever goes
# too far, the build fails here rather than the first upload failing in
# production.
# ------------------------------------------------------------------
FROM node:24-slim AS api-prod-deps
WORKDIR /api
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev \
 && rm -rf \
      node_modules/prisma \
      node_modules/typescript \
      node_modules/@prisma/config \
      node_modules/@prisma/dev \
      node_modules/@prisma/studio-core \
      node_modules/@electric-sql \
      node_modules/@radix-ui \
      node_modules/@visx \
      node_modules/react \
      node_modules/react-dom \
      node_modules/scheduler \
      node_modules/effect \
      node_modules/elkjs \
 && node -e "require('@prisma/adapter-pg'); require('sharp'); require('@confluentinc/kafka-javascript'); console.log('runtime deps still resolve after prune')"


# ==================================================================
# Frontend
# ==================================================================

FROM node:24-slim AS web-deps
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci


FROM web-deps AS web-build
WORKDIR /web
COPY frontend/ ./

# `output: "standalone"` in next.config.ts traces the files the server actually
# imports — about 41MB, against the whole node_modules tree otherwise.
#
# BACKEND_URL is a build-time placeholder only. The BFF reads it at RUNTIME,
# which is what lets one build serve compose (`http://api:4000`) and Kubernetes
# (a Service name) without rebuilding.
RUN BACKEND_URL="http://localhost:4000" npm run build


# ==================================================================
# Target: api
# ==================================================================
FROM node:24-slim AS api
ENV NODE_ENV=production
WORKDIR /app

# Ownership is set BY the COPY, not by a chown afterwards.
#
# `RUN chown -R node:node /app` looks equivalent and costs ~455MB: chown
# rewrites every file's metadata, so the layer it creates contains a second
# complete copy of node_modules. --chown does it as the files land.
COPY --from=api-prod-deps --chown=node:node /api/node_modules ./node_modules
COPY --from=api-build     --chown=node:node /api/dist         ./dist
COPY --chown=node:node backend/package.json ./

# Only used on the local-disk storage driver; with object storage (ADR 0022,
# and the default in compose) nothing is written here. Empty, so this layer is
# bytes rather than megabytes.
RUN mkdir -p /app/uploads && chown node:node /app/uploads

# Never root. A process that only needs to read its own code and write one
# directory has no business being able to modify the image.
USER node

EXPOSE 4000

# Uses the app's own /health endpoint, via node's fetch rather than curl —
# which slim does not ship, and installing a package purely to poll yourself is
# a poor trade.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations are NOT run here. See the `migrate` service in
# docker-compose.yml: several replicas racing `migrate deploy` on startup is a
# problem worth not having, and a one-shot job maps directly onto a Kubernetes
# Job.
CMD ["node", "dist/index.js"]


# ==================================================================
# Targets: relay, worker
#
# Both are the api image with a different entrypoint. `FROM api` rather than a
# repeat of the COPY stanzas above, because they run the same compiled tree from
# the same node_modules — duplicating the copies would be three places for the
# prune list to drift apart again, which is the whole reason this file exists.
#
# They are SEPARATE TARGETS and not flags on the api container because they
# scale on different axes and fail independently: publishing throughput is not
# request throughput, and a stalled SMS worker must not take checkout with it.
# Each maps onto its own Kubernetes Deployment. See ADR 0024.
#
# HEALTHCHECK NONE, honestly: neither serves HTTP, so the inherited /health poll
# would fail forever and report a working process as unhealthy. A real liveness
# signal for these is consumer lag at /health/lag, which is phase 6 work.
# `EXPOSE 4000` is inherited and meaningless here; Docker has no way to unset it.
# ==================================================================
FROM api AS relay
HEALTHCHECK NONE
CMD ["node", "dist/relay.js"]


# Takes an optional consumer group as its argument — `dist/worker.js log-worker`
# runs one group, no argument runs all of them. One per container is what lets
# email and SMS scale separately, which is most of why a broker is here.
FROM api AS worker
HEALTHCHECK NONE
CMD ["node", "dist/worker.js"]


# ==================================================================
# Target: web
# ==================================================================
FROM node:24-slim AS web
ENV NODE_ENV=production
WORKDIR /app

# Three copies, and all three are required. The standalone output does NOT
# include static assets or public files — Next expects them placed alongside
# it, and leaving either out gives a site that renders with no CSS and no
# images.
COPY --from=web-build --chown=node:node /web/.next/standalone ./
COPY --from=web-build --chown=node:node /web/.next/static     ./.next/static
COPY --from=web-build --chown=node:node /web/public           ./public

USER node

# Standalone binds to the HOSTNAME env var and defaults to localhost, which
# inside a container accepts nothing from outside it. 0.0.0.0 is required, and
# forgetting it produces a container that looks healthy and refuses every
# connection.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# server.js sits at the root of the standalone output, not in .next.
CMD ["node", "server.js"]
