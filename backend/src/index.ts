import "dotenv/config";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { UPLOAD_DIR, assertStorage, storageDriver } from "./lib/storage";
import { authRouter } from "./routes/auth";
import { catalogRouter } from "./routes/catalog";
import { sellerRouter } from "./routes/seller";
import { sellerMessagingRouter } from "./routes/sellerMessaging";
import { profileRouter } from "./routes/profile";
import { startDeferredSweeper } from "./lib/deferredDeliveries";
import { startOutboxRetentionSweeper } from "./lib/outboxRetention";
import { startPlacementSweeper } from "./lib/placement";
import { startIdempotencySweeper } from "./lib/idempotency";
import { startStalePendingSweeper } from "./lib/stalePending";
import { startOrderSweeper } from "./lib/orders";
import { assertKycConfigured } from "./lib/kycProvider";
import { assertProviderConfigured } from "./lib/paymentProvider";
import { assertMailConfigured } from "./lib/mailer";
import { assertNotifyConfigured, notifyTransportKind } from "./lib/notifyTransport";
import { assertPushConfigured } from "./lib/push";
import { assertSmsConfigured } from "./lib/smsProvider";
import { assertPayoutsConfigured } from "./lib/payoutProvider";
import { returnWindowSummary } from "./lib/returns";
import { lagReport } from "./lib/consumerLag";
import { assertRateLimitStore } from "./lib/rateLimit";
import { relayEnabledInProcess, startRelay } from "./lib/relay";
import { startReservationSweeper } from "./lib/reservations";
import { ordersRouter } from "./routes/orders";
import { addressesRouter } from "./routes/addresses";
import { adminRouter } from "./routes/admin";
import { notificationsRouter } from "./routes/notifications";
import { reportsRouter } from "./routes/reports";
import { reservationsRouter } from "./routes/reservations";
import { reviewsRouter } from "./routes/reviews";
import { salesRouter } from "./routes/sales";
import { sellerPayoutsRouter } from "./routes/sellerPayouts";
import { sellerVerificationRouter } from "./routes/sellerVerification";
import { webhooksRouter } from "./routes/webhooks";
import { wishlistRouter } from "./routes/wishlist";

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";

app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));

/**
 * Mounted BEFORE express.json(), because Stripe signs the raw request bytes.
 * If the JSON parser reaches the body first, it is re-serialised and every
 * signature check fails. This is the single most common way webhook
 * verification gets broken, so the ordering here is load-bearing.
 *
 * No CSRF concern: webhooks are cookie-less and authenticated by signature.
 */
app.use("/webhooks", webhooksRouter);

app.use(express.json());
app.use(cookieParser());

/**
 * Uploaded images, when they are on this container's disk.
 *
 * Keys are random and never reused, so a long immutable cache is safe.
 * `dotfiles: deny` and `index: false` keep this from serving anything other
 * than the files we wrote.
 *
 * MOUNTED ONLY FOR THE DISK DRIVER. Under object storage the browser fetches
 * objects from the store directly and this route would serve an empty
 * directory — answering 404 for images that exist, which is a worse failure
 * than not having the route at all, because it looks like the upload broke.
 */
if (storageDriver() === "disk") {
  app.use(
    "/uploads",
    express.static(UPLOAD_DIR, {
      maxAge: "1y",
      immutable: true,
      index: false,
      dotfiles: "deny",
      fallthrough: false,
    })
  );
}

/**
 * Is anyone actually receiving notifications?
 *
 * SEPARATE FROM /health, AND DELIBERATELY SO. `/health` answers "is this
 * process alive" and has to stay cheap enough for a load balancer to call every
 * second. This one talks to a broker over the network, so it belongs behind its
 * own path where a slow answer degrades a dashboard rather than a deploy.
 *
 * 503 WHEN UNHEALTHY, because a monitor should not have to parse a body to know
 * something is wrong. The body says which group and which topic.
 */
app.get("/health/lag", async (_req, res) => {
  try {
    const report = await lagReport();
    res.status(report.healthy ? 200 : 503).json(report);
  } catch (err) {
    // Reaching here means lagReport itself threw, which it is written not to.
    res.status(503).json({
      healthy: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "retailstore-2n-backend" });
});

app.use("/auth", authRouter);
app.use("/catalog", catalogRouter);
app.use("/profile", profileRouter);
app.use("/reservations", reservationsRouter);
app.use("/orders", ordersRouter);
app.use("/wishlist", wishlistRouter);
app.use("/reviews", reviewsRouter);
app.use("/addresses", addressesRouter);
app.use("/notifications", notificationsRouter);
app.use("/reports", reportsRouter);
app.use("/admin", adminRouter);
// Verification and sales are mounted before the listing router so their paths
// aren't shadowed by its own — `/seller/listings/:id` would otherwise swallow
// anything it pattern-matches.
app.use("/seller", sellerPayoutsRouter);
app.use("/seller", sellerVerificationRouter);
app.use("/seller", salesRouter);
app.use("/seller", sellerMessagingRouter);
app.use("/seller", sellerRouter);

/**
 * Fail before binding the port, not at the first checkout. A missing Stripe key
 * discovered mid-payment is one broken customer; discovered here it is a
 * one-line startup error.
 */
let paymentSummary: string;
let kycSummary: string;
let mailSummary: string;
let notifySummary: string;
let smsSummary: string;
let payoutSummary: string;
try {
  paymentSummary = assertProviderConfigured();
  kycSummary = assertKycConfigured();
  mailSummary = assertMailConfigured();
  notifySummary = assertNotifyConfigured();
  smsSummary = assertSmsConfigured();
  payoutSummary = assertPayoutsConfigured();
} catch (err) {
  console.error(`\nConfiguration error:\n  ${(err as Error).message}\n`);
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`RetailStore_2n backend listening on http://localhost:${PORT}`);
  console.log(`Payments: ${paymentSummary}`);
  console.log(`Identity: ${kycSummary}`);
  console.log(`Email:    ${mailSummary}`);
  console.log(`Notify:   ${notifySummary}`);
  console.log(`SMS:      ${smsSummary}`);
  console.log(`Payouts:  ${payoutSummary}`);
  /**
   * Said at boot because the relationship between these two numbers is easy to
   * break and expensive when broken: a return window longer than the payout
   * hold means every late return lands on money already transferred, turning
   * the reversal-and-debt path from the exception into the norm. Not fatal —
   * it is a legitimate, buyer-friendly choice — but nobody should discover it
   * from a debt row. See ADR 0031.
   */
  console.log(`Returns:  ${returnWindowSummary()}`);
  // Not fatal, same policy as Redis and object storage: an unconfigured push
  // channel is a missing feature, not a broken server. Printed loudly so
  // nobody has to guess why nothing arrives.
  console.log(`Push:     ${assertPushConfigured()}`);

  /**
   * Reported after binding, not before.
   *
   * Unlike the payment and mail checks this one is not fatal: an unreachable
   * Redis is a degraded limiter, not a broken server, and refusing to start
   * would turn a cache outage into an outage. It is printed loudly so nobody
   * has to guess whether their limits are actually shared between instances.
   */
  assertRateLimitStore()
    .then((summary) => console.log(`Limits:   ${summary}`))
    .catch((err) => {
      console.error(`Limits:   REDIS UNREACHABLE — ${(err as Error).message}`);
      console.error("          Limits fall back to per-process counters.");
    });

  /**
   * Also not fatal, and also printed loudly.
   *
   * A misconfigured bucket has no symptom until a seller uploads a photo and
   * gets an error, or worse, uploads one that silently 404s in the page. One
   * line at boot beats discovering it from a support message.
   */
  assertStorage()
    .then((summary) => console.log(`Uploads:  ${summary}`))
    .catch((err) => {
      console.error(`Uploads:  OBJECT STORE UNREACHABLE — ${(err as Error).message}`);
      console.error("          Photo uploads will fail until this is fixed.");
    });

  // Expired holds must be returned to stock by something other than a new
  // reservation attempt: a fully-held listing is hidden from the catalog, so no
  // buyer can trigger the lazy reclaim for it.
  startReservationSweeper();

  // Two jobs, same reasoning as above — both recover state that nothing in the
  // request path can reach:
  //   unpaid orders hold stock, and their listing is hidden from the catalog
  //   in-flight payments whose request died need settling against the provider
  startOrderSweeper();

  /**
   * And a third, for the same reason: a message parked by quiet hours is owed
   * to somebody and nothing in the request path will ever go looking for it.
   *
   * Runs on every API replica. That is safe rather than wasteful — the claim
   * is a conditional UPDATE on the row, so N sweepers divide the work instead
   * of sending it N times, exactly as N relays divide the outbox.
   */
  startDeferredSweeper();

  /**
   * And two more, both recovering state nothing in the request path reaches.
   *
   * The stale-pending one closes the ambiguous middle of ADR 0026: a consumer
   * killed between claiming a delivery and settling it leaves a row that, left
   * alone, is a notification lost behind something that looks like proof it was
   * sent.
   *
   * Retention keeps `outbox_events` from growing without bound, which it has
   * done since the outbox landed.
   */
  startStalePendingSweeper();
  startOutboxRetentionSweeper();

  /**
   * And a sixth: a placement whose start date has arrived, and one whose end
   * date has passed.
   *
   * Same test as the other five — nothing in the request path will ever reach
   * it. A seller who agreed to a window starting Monday is not going to be
   * served by a moderator remembering to press a button, and a placement whose
   * week is over must stop being on the homepage whether anybody is looking or
   * not. See docs/adr/0034-paid-homepage-placement.md
   */
  startPlacementSweeper();

  /**
   * And a seventh, for a table rather than a promise owed to anybody.
   *
   * Idempotency keys are honoured for 24 hours and then mean nothing, but
   * nothing in the request path deletes them — a key is only ever read by a
   * retry of its own request. Without this, `idempotency_keys` grows by one row
   * per keyed request, forever. See docs/adr/0035-idempotency-keys-at-the-api-boundary.md
   */
  startIdempotencySweeper();

  /**
   * The outbox relay, but ONLY on the inline transport.
   *
   * Under inline there is no broker: the relay hands events straight to the
   * consumer functions, so a second container for a function call would be
   * ceremony. Development and the test suite stay one process.
   *
   * Under kafka it runs as its own program (src/relay.ts) instead — it is on
   * the critical path of every notification and has to scale separately from
   * the API. Starting it here too would mean two relays racing, which is safe
   * (FOR UPDATE SKIP LOCKED) but means scaling the API silently scales
   * publishing with it. See docs/adr/0024-outbox-not-dual-writes.md
   */
  /**
   * ...unless it is switched off, which exists for exactly one reason.
   *
   * `tests/api/outbox.ts` drives `relayOnce()` by hand and registers its own
   * spy consumer IN THE TEST PROCESS, so that every relay pass happens exactly
   * when that file says it does. A relay ticking in the API steals those rows
   * and hands them to the API's consumers instead — the suite then reports
   * "one event published — 0", which is true and completely misleading.
   *
   * It only bites during a full `npm test`, where the API has to be up for the
   * other suites. Nothing else in the suite needs this relay: the delivery
   * suites call the consumers directly.
   */
  if (notifyTransportKind() === "inline" && relayEnabledInProcess()) {
    startRelay();
  }
});
