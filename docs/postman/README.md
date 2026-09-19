# Postman collection

Every endpoint of the API (145 requests) as a Postman collection, so it can be tried without writing a client. Each request carries its own documentation: who may call it, body fields and their rules, responses and error codes, and the source file the route lives in.

| File | What it is |
| --- | --- |
| `RetailStore_2n.postman_collection.json` | The requests, grouped by who uses them |
| `RetailStore_2n.local.postman_environment.json` | `baseUrl` and login details for a local stack |

## Use it

1. Start the stack (see the [root README](../../README.md)). The API listens on `http://localhost:4000`.
2. In Postman, **Import** both files and select the **RetailStore_2n — Local** environment.
3. Run **Health › Liveness**, then **Auth › Signup & login › Sign up**.

The collection's overview page (click the collection name in Postman) covers the rest: how cookie login works in Postman, a full seller-to-buyer walkthrough, stub test values for cards and identity documents, and the one-time admin setup.

## Groups

| Folder | Covers |
| --- | --- |
| Health | Liveness and notification-consumer lag |
| Auth | Signup, login, session refresh, email verification, passwords, becoming a seller |
| Profile | Avatar and the user's own reviews |
| Catalog | Public categories, search, promoted listings, listing detail |
| Buyer | Addresses, cart holds, checkout and payment, returns, refunds, wishlist, reviews, reports |
| Notifications | In-app notifications, channel preferences, SMS phone verification, web push |
| Seller | Listings and photos, identity verification, payouts, sales, returns, messages, placements |
| Admin | Step-up session, dashboard, orders, customers, moderation, reports, returns, payouts, delivery log, audit log, placements, messages |
| Webhooks | The Stripe webhook (needs a signed body) |

## How it was checked

Against a local stack:

- All 145 requests reach a real route.
- A Newman run of the main flow passed 56 of 56 requests. It went seller → buyer → seller → buyer → admin: create, photograph and publish a listing; verify identity; set up payouts; reserve, check out and pay; ship; confirm delivery; review; admin step-up and every admin list.

Requests with no step in that flow have been checked for their route, but not for a successful response.

## Keeping it current

The collection describes the routes in `backend/src/routes/`. A change to a route's path, body or response belongs in this collection in the same change, as it does in [api.md](../api.md).
