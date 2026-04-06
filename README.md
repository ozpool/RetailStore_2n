# RetailStore_2n


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

