import "dotenv/config";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { UPLOAD_DIR, assertStorage, storageDriver } from "./lib/storage";
import { authRouter } from "./routes/auth";
import { catalogRouter } from "./routes/catalog";
import { sellerRouter } from "./routes/seller";
import { profileRouter } from "./routes/profile";
import { startOrderSweeper } from "./lib/orders";
import { assertKycConfigured } from "./lib/kycProvider";
import { assertProviderConfigured } from "./lib/paymentProvider";
import { assertMailConfigured } from "./lib/mailer";
import { startReservationSweeper } from "./lib/reservations";
import { ordersRouter } from "./routes/orders";
import { reservationsRouter } from "./routes/reservations";
import { sellerVerificationRouter } from "./routes/sellerVerification";
import { webhooksRouter } from "./routes/webhooks";

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

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "retailstore-2n-backend" });
});

app.use("/auth", authRouter);
app.use("/catalog", catalogRouter);
app.use("/profile", profileRouter);
app.use("/reservations", reservationsRouter);
app.use("/orders", ordersRouter);
// Verification and sales are mounted before the listing router so their paths
// aren't shadowed by its own — `/seller/listings/:id` would otherwise swallow
// anything it pattern-matches.
app.use("/seller", sellerVerificationRouter);
app.use("/seller", sellerRouter);

/**
 * Fail before binding the port, not at the first checkout. A missing Stripe key
 * discovered mid-payment is one broken customer; discovered here it is a
 * one-line startup error.
 */
let paymentSummary: string;
let kycSummary: string;
let mailSummary: string;
try {
  paymentSummary = assertProviderConfigured();
  kycSummary = assertKycConfigured();
  mailSummary = assertMailConfigured();
} catch (err) {
  console.error(`\nConfiguration error:\n  ${(err as Error).message}\n`);
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`RetailStore_2n backend listening on http://localhost:${PORT}`);
  console.log(`Payments: ${paymentSummary}`);
  console.log(`Identity: ${kycSummary}`);
  console.log(`Email:    ${mailSummary}`);

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
});
