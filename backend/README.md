# RetailStore_2n — backend

Express 4 API with PostgreSQL via Prisma 7. Holds all business rules: the
frontend renders and forwards, it does not decide.

```bash
npm install
cp .env.example .env         # then set JWT_SECRET
npx prisma migrate dev       # create schema
npx prisma db seed           # 5 categories, 13 listings, reviews
npm run dev                  # http://localhost:4000
npm run build                # tsc typecheck
```

Needs Postgres running — `docker compose up -d` from the repo root, which
publishes it on host port **5433**.

## Layout

```
prisma/
├── schema.prisma      Source of truth for the data model
├── migrations/
└── seed.ts            Idempotent; every write is an upsert
src/
├── routes/            auth · catalog · seller · sellerVerification
├── middleware/        requireAuth · requireSeller
└── lib/
    ├── auth.ts             Hashing, JWT, cookies
    ├── refreshTokens.ts    Rotation + reuse detection
    ├── passwordBreach.ts   Pwned Passwords k-anonymity
    ├── storage.ts          Storage seam (disk → S3/R2)
    ├── imageProcessing.ts  Magic bytes, EXIF stripping
    ├── kycProvider.ts      Identity provider seam (stubbed)
    ├── mailer.ts           Email seam (stubbed)
    └── rateLimit.ts        In-process fixed window
```

The three `lib` modules marked as seams are real interfaces with stub bodies —
see [HLD §6](../docs/architecture/hld.md#6-deliberate-stubs).

## Gotchas

- **`prisma migrate dev` doesn't reliably regenerate the client here.** If types
  are missing a new column or enum, run `npx prisma generate`.
- **Verification emails print to this console** — no mail provider is wired up.
- `npx prisma studio` to browse data.

More: [API reference](../docs/api.md) ·
[data model](../docs/architecture/data-model.md) ·
[contributing](../CONTRIBUTING.md)
