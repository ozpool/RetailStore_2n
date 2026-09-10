# RetailStore_2n

[![CI](https://github.com/ozpool/RetailStore_2n/actions/workflows/ci.yml/badge.svg)](https://github.com/ozpool/RetailStore_2n/actions/workflows/ci.yml)

RetailStore_2n — repaired, not hidden. Wear and repairs are treated as part of
an item's history instead of something to hide.

A marketplace for secondhand furniture, clothing, and objects, where condition
is disclosed rather than hidden. Built as a full-stack TypeScript application:
a Next.js storefront, an Express API, and PostgreSQL.

## Stack

| Layer | Technology |
| --- | --- |
| Frontend | Next.js 16 (App Router), TypeScript, Tailwind CSS v4 |
| Backend | Node.js 24, Express 4, TypeScript, Zod |
| Database | PostgreSQL 16, Prisma 7 (driver adapters — no query engine binary) |
| Cache & counters | Redis 7 — rate limits and read-through caching |
| Auth | JWT access tokens + rotating opaque refresh tokens with reuse detection, bcrypt |
| Admin | CLI-granted role, TOTP step-up (`otplib`), separate short-lived session |
| Payments | Stripe PaymentIntents + Refunds, behind a provider seam with a stub |
| Identity | Stripe Identity, behind the same kind of seam |
| Payouts | Stripe Connect Express — separate transfers, behind the same kind of seam |
| Email | Nodemailer — console, Ethereal, or real SMTP |
| Notifications | Transactional outbox → Kafka (KRaft) → per-channel workers, behind an `inline`/`kafka` transport seam |
| Web push | VAPID / Web Push, with a service worker in the storefront |
| SMS | Twilio REST API, behind a provider seam with a stub |
| Images | Sharp (re-encode + metadata stripping) |
| Uploads | S3-compatible object storage (MinIO locally), or local disk |
| Backups | WAL archiving + base backups to object storage, PITR, a rehearsed restore |
| Delivery | Multi-stage Docker builds, Compose, Kustomize manifests with CloudNativePG, GitHub Actions CI |

## Quick start

**Prerequisites:** Node.js 20+ (developed on 24), Docker, npm.

### Everything, in one command

```bash
git clone https://github.com/ozpool/RetailStore_2n.git && cd RetailStore_2n
docker compose up --build
docker compose --profile tools run --rm seed   # 7 categories, 27 listings, reviews
```

The storefront is on http://localhost:3000, the API on http://localhost:4000, and
MinIO's console on http://localhost:9001 (`retailstore-2n` / `retailstore-2n-dev-secret`).

**If you browsed before seeding, the category shelf stays empty for a few
minutes.** Not a bug, and worth knowing before you go looking for one: the
category list is read through a Redis cache, and the seed writes straight to
Postgres — so nothing invalidates the entry that was cached while the database
was still empty. It expires on its own. `docker compose restart redis` clears it
immediately, or just seed first. Cache invalidation happens on writes *through
the API* ([ADR 0019](docs/adr/0019-cache-tiering-rule.md)), which a one-shot
seed job deliberately is not.

**Two of the seven containers exit immediately, and that is correct.** `migrate`
applies the migration history and `minio-init` creates the uploads bucket, both
running to completion before the API starts. Doing either at API startup is the
usual shortcut and it breaks the moment there is more than one replica —
several containers racing `migrate deploy`, or racing to set the same bucket
policy. Each maps directly onto a Kubernetes Job. A *running* migration
container would be the bug.

All images come from the single [`Dockerfile`](Dockerfile), selected by build
target — see [ADR 0023](docs/adr/0023-one-dockerfile-many-targets.md).

### Running the servers locally

Better for development — hot reload, and the test suite expects this.

```bash
docker compose up -d postgres redis   # just the datastores
```

```bash
cd backend
npm install
cp .env.example .env                  # then set JWT_SECRET
npx prisma migrate dev
npx prisma db seed
npm run dev                           # http://localhost:4000
```

```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev                           # http://localhost:3000
```

Sign up, and with the default `MAIL_TRANSPORT=console` the verification link is
printed to the **backend terminal** — paste it into your browser to activate the
account. Set `MAIL_TRANSPORT=ethereal` to have it delivered to a throwaway inbox
instead, or `smtp` with credentials to send for real.

