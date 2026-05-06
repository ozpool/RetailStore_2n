# RetailStore_2n — frontend

Next.js 16 (App Router) storefront. Also acts as the BFF: route handlers under
`src/app/api/*` proxy browser traffic to the Express API so the browser never
reaches it directly ([ADR 0002](../docs/adr/0002-bff-proxy.md)).

```bash
npm install
cp .env.example .env.local
npm run dev              # http://localhost:3000
npm run build            # includes typecheck — run before committing
```

Requires the backend running on port 4000. See the
[root README](../README.md#quick-start) for full setup.

## Layout

```
src/
├── app/
│   ├── api/          BFF route handlers
│   ├── seller/       Seller dashboard, listing editor, verification
│   ├── listing/      Product detail
│   ├── search/       Results with filters
│   └── shop/         Category pages
├── components/       UI
└── lib/
    ├── backendProxy.ts   The BFF
    ├── catalog.ts        Server-side catalog fetches
    ├── api.ts            Auth client (browser)
    ├── sellerApi.ts      Seller client (browser)
    └── AuthContext.tsx   Client auth state
```

`catalog.ts` runs server-side and calls Express directly; `api.ts` and
`sellerApi.ts` run in the browser and go through `/api/*`. Keeping them separate
keeps the trust boundary legible.

## Notes

- **Restart the dev server after editing `next.config.ts`** — it's read at boot,
  not watched.
- Design tokens live in `src/app/globals.css` as Tailwind v4 `@theme` variables.

More: [architecture](../docs/architecture/lld.md#7-frontend-patterns) ·
[contributing](../CONTRIBUTING.md)
