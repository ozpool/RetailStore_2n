import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth";
import {
  cachedUnreadCount,
  countUnread,
  listNotifications,
  markAllRead,
  markRead,
  removeNotification,
} from "../lib/notifications";
import {
  ALWAYS_EMAILED,
  isOffered,
  preferencesFor,
  setPreference,
  unsubscribeAllOptional,
} from "../lib/channelPolicy";
import { readUnsubscribeToken } from "../lib/unsubscribe";
import {
  isPushConfigured,
  listSubscriptions,
  removeSubscription,
  saveSubscription,
  vapidPublicKey,
} from "../lib/push";
import { prisma } from "../lib/prisma";
import { checkRateLimit } from "../lib/rateLimit";
import { InvalidPhoneNumber, maskPhone } from "../lib/phone";
import { isStubSms } from "../lib/smsProvider";
import {
  PhoneAlreadyInUse,
  issueAndSendCode,
  removePhone,
  verifyCode,
} from "../lib/smsVerification";
import { DeliveryChannel, NotificationType } from "../generated/prisma/enums";

export const notificationsRouter = Router();

function fail(res: import("express").Response, err: unknown, fallback: string) {
  console.error(fallback, err);
  return res.status(500).json({ error: fallback });
}

/* ------------------------------------------------------------------ *
 * Unsubscribe — DELIBERATELY BEFORE requireAuth
 *
 * These two are the only unauthenticated routes in this file, and they have to
 * be: the person clicking is reading an email, possibly years later, on a
 * device that was never signed in. An unsubscribe that asks for a password is
 * an unsubscribe people replace with the spam button, and a spam report costs
 * the sending domain far more than the mail they objected to.
 *
 * The token carries its own authority — an HMAC over (user, channel, scope)
 * under a key derived from JWT_SECRET. It authorises exactly one thing: turning
 * something OFF. It cannot sign anybody in, read anything, or turn a
 * notification back on.
 *
 * See docs/adr/0027-notification-consent-and-preferences.md
 * ------------------------------------------------------------------ */

/**
 * Says what a token would do, WITHOUT doing it.
 *
 * A GET must not change anything here, and not only on principle: mail scanners
 * and link prefetchers fetch every URL in a message. A GET that unsubscribed
 * would silently opt people out of mail they never chose to leave, and the
 * first evidence would be somebody asking why they stopped getting order
 * updates.
 */
notificationsRouter.get("/unsubscribe", async (req, res) => {
  try {
    const token = readUnsubscribeToken(
      typeof req.query.token === "string" ? req.query.token : undefined
    );
    if (!token) {
      return res.status(400).json({ error: "That link is not valid.", code: "BAD_TOKEN" });
    }

    const user = await prisma.user.findUnique({
      where: { id: token.userId },
      select: { email: true },
    });
    if (!user) {
      return res.status(400).json({ error: "That link is not valid.", code: "BAD_TOKEN" });
    }

    res.json({
      channel: token.channel,
      scope: token.scope,
      /**
       * Masked. The token proves possession of a link, not of the inbox, and a
       * forwarded email should not hand somebody else a full address. Enough to
       * confirm "yes, this is my account" and no more.
       */
      email: maskEmail(user.email),
      alwaysSent: ALWAYS_EMAILED,
    });
  } catch (err) {
    fail(res, err, "Could not read that link.");
  }
});

/**
 * Performs it. Also the RFC 8058 one-click target named in List-Unsubscribe-Post,
 * which is what makes Gmail and Outlook show their own unsubscribe button.
 */
notificationsRouter.post("/unsubscribe", async (req, res) => {
  try {
    const raw =
      (typeof req.query.token === "string" ? req.query.token : undefined) ??
      (typeof req.body?.token === "string" ? req.body.token : undefined);

    const token = readUnsubscribeToken(raw);
    if (!token) {
      return res.status(400).json({ error: "That link is not valid.", code: "BAD_TOKEN" });
    }

    if (token.scope === "all") {
      const count = await unsubscribeAllOptional(token.userId, token.channel);
      return res.json({ ok: true, turnedOff: count, scope: "all" });
    }

    /**
     * The money-adjacent messages stay on, even from an "unsubscribe from this
     * type" link, because there is no such link for them — they are excluded
     * from ALWAYS_EMAILED's complement. Reaching here with one means a
     * hand-edited token, and the honest answer is that it did nothing.
     */
    if (ALWAYS_EMAILED.includes(token.scope)) {
      return res.json({ ok: true, turnedOff: 0, scope: token.scope, refused: true });
    }

    await setPreference({
      userId: token.userId,
      type: token.scope,
      channel: token.channel,
      enabled: false,
    });

    res.json({ ok: true, turnedOff: 1, scope: token.scope });
  } catch (err) {
    fail(res, err, "Could not update your preferences.");
  }
});

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "•••";
  const name = email.slice(0, at);
  const shown = name.slice(0, Math.min(2, name.length));
  return `${shown}${"•".repeat(Math.max(3, name.length - shown.length))}${email.slice(at)}`;
}

/* Everything below needs a session. */
notificationsRouter.use(requireAuth);

/* ------------------------------------------------------------------ *
 * Push devices
 * ------------------------------------------------------------------ */

/**
 * What the browser needs before it can subscribe.
 *
 * The VAPID public key is public by design — a subscription made with it is
 * still useless to anybody without the private half, which never leaves the
 * environment. `enabled: false` is a real answer, not an error: a server with
 * no keys has no push channel, and the UI should say so rather than offer a
 * button that fails.
 */
notificationsRouter.get("/push/key", (_req, res) => {
  res.json({ enabled: isPushConfigured(), publicKey: vapidPublicKey() });
});

notificationsRouter.get("/push/devices", async (req, res) => {
  try {
    res.json({ devices: await listSubscriptions(req.userId!) });
  } catch (err) {
    fail(res, err, "Could not list your devices.");
  }
});

const subscription = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(500),
    auth: z.string().min(1).max(500),
  }),
});

notificationsRouter.post("/push/subscribe", async (req, res) => {
  try {
    const parsed = subscription.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Check the request.", code: "INVALID_INPUT" });
    }

    await saveSubscription({
      userId: req.userId!,
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
      // Truncated: it is only ever shown in a device list, and a browser is
      // free to send a very long one.
      userAgent: req.header("user-agent")?.slice(0, 200) ?? null,
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    fail(res, err, "Could not enable notifications on this device.");
  }
});

notificationsRouter.post("/push/unsubscribe", async (req, res) => {
  try {
    const endpoint = typeof req.body?.endpoint === "string" ? req.body.endpoint : null;
    if (!endpoint) {
      return res.status(400).json({ error: "Check the request.", code: "INVALID_INPUT" });
    }

    // Scoped by user inside removeSubscription, so nobody can unsubscribe
    // somebody else's device by guessing an endpoint.
    const removed = await removeSubscription(req.userId!, endpoint);

    // Removing something already gone is a success. Unsubscribing twice — two
    // tabs, or a retry — is normal, and an error there would be noise.
    res.json({ removed });
  } catch (err) {
    fail(res, err, "Could not turn off notifications on this device.");
  }
});

/* ------------------------------------------------------------------ *
 * Phone, for SMS
 * ------------------------------------------------------------------ */

/**
 * BOTH ENDPOINTS ARE RATE-LIMITED, AND THEY GUARD DIFFERENT THINGS.
 *
 * Send: an unlimited send endpoint is a way to make this platform pay to text
 * an arbitrary number as often as somebody likes — a billing attack against us
 * and a harassment vector against them, in one request.
 *
 * Verify: an unlimited verify endpoint is a six-digit oracle. A million codes
 * sounds like a lot until it is divided by a request rate. The per-code attempt
 * counter caps guesses against ONE code and this caps how fast fresh codes can
 * be tried, which is the same pairing that protects `admin-stepup`
 * (ADR 0018).
 */
notificationsRouter.get("/phone", async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { phone: true, phoneVerifiedAt: true, smsConsentAt: true },
    });

    res.json({
      // Masked, never whole. This response is rendered in a browser, ends up in
      // screenshots on support tickets, and the owner only needs to recognise
      // which number it is.
      phone: user?.phone ? maskPhone(user.phone) : null,
      verified: !!user?.phoneVerifiedAt,
      consentedAt: user?.smsConsentAt ?? null,
      smsAvailable: true,
    });
  } catch (err) {
    fail(res, err, "Could not load your phone settings.");
  }
});

const phoneStart = z.object({ phone: z.string().min(1).max(32) });

notificationsRouter.post("/phone/start", async (req, res) => {
  try {
    const parsed = phoneStart.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Check the request.", code: "INVALID_INPUT" });
    }

    /**
     * Three an hour. Enough for a mistyped number and a genuine retry, and
     * nowhere near enough to be worth using as a way to spend our money.
     */
    const limit = await checkRateLimit(`phone-verify-send:${req.userId}`, 3, 60 * 60 * 1000);
    if (!limit.allowed) {
      return res.status(429).json({
        error: "Too many codes requested. Try again later.",
        code: "RATE_LIMITED",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const result = await issueAndSendCode(req.userId!, parsed.data.phone);

    res.status(201).json({
      phone: maskPhone(result.phone),
      expiresAt: result.expiresAt,
      /**
       * Only under the stub provider, and it is what lets the suite and a local
       * developer finish the flow without a handset. Under twilio this is null
       * — returning a live code to a client would make the whole verification
       * decorative.
       */
      devCode: isStubSms() ? result.devCode : null,
    });
  } catch (err) {
    if (err instanceof InvalidPhoneNumber) {
      return res.status(400).json({ error: err.message, code: "INVALID_PHONE" });
    }
    if (err instanceof PhoneAlreadyInUse) {
      return res.status(409).json({ error: err.message, code: "PHONE_IN_USE" });
    }
    fail(res, err, "Could not send a verification code.");
  }
});

const phoneVerify = z.object({ code: z.string().min(4).max(10) });

notificationsRouter.post("/phone/verify", async (req, res) => {
  try {
    const parsed = phoneVerify.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Check the request.", code: "INVALID_INPUT" });
    }

    const limit = await checkRateLimit(`phone-verify-check:${req.userId}`, 8, 15 * 60 * 1000);
    if (!limit.allowed) {
      return res.status(429).json({
        error: "Too many attempts. Try again later.",
        code: "RATE_LIMITED",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const outcome = await verifyCode(req.userId!, parsed.data.code);

    if (!outcome.ok) {
      /**
       * One status and one message for every wrong-code case.
       *
       * Distinguishing "expired" from "wrong" from "too many attempts" would
       * tell someone guessing exactly which of their assumptions was wrong,
       * and the honest-user benefit is small — the fix is the same in all
       * three: ask for a new code.
       */
      const status = outcome.reason === "taken" ? 409 : 400;
      const message =
        outcome.reason === "taken"
          ? "That number is already verified on another account."
          : "That code is not valid. Ask for a new one.";
      return res.status(status).json({ error: message, code: "INVALID_CODE" });
    }

    res.json({ phone: maskPhone(outcome.phone), verified: true });
  } catch (err) {
    fail(res, err, "Could not verify that code.");
  }
});

notificationsRouter.delete("/phone", async (req, res) => {
  try {
    await removePhone(req.userId!);
    // Removing a number that was never there is a success, for the same reason
    // unsubscribing twice is: it is the state the caller asked for.
    res.json({ removed: true });
  } catch (err) {
    fail(res, err, "Could not remove your phone number.");
  }
});

/* ------------------------------------------------------------------ *
 * Preferences
 * ------------------------------------------------------------------ */

notificationsRouter.get("/preferences", async (req, res) => {
  try {
    res.json({ preferences: await preferencesFor(req.userId!) });
  } catch (err) {
    fail(res, err, "Could not load your notification settings.");
  }
});

const preferenceUpdate = z.object({
  type: z.enum(Object.values(NotificationType) as [string, ...string[]]),
  channel: z.enum(Object.values(DeliveryChannel) as [string, ...string[]]),
  enabled: z.boolean(),
});

notificationsRouter.put("/preferences", async (req, res) => {
  try {
    const parsed = preferenceUpdate.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Check the request.", code: "INVALID_INPUT" });
    }

    const { type, channel, enabled } = parsed.data;

    // A channel the product never sends this type on is a 400 rather than a
    // silent no-op: the UI does not offer the switch, so getting here means a
    // client is out of date or hand-rolled, and it should hear about it.
    if (!isOffered(type as never, channel as never)) {
      return res.status(400).json({
        error: `${channel} is not used for ${type}.`,
        code: "CHANNEL_NOT_OFFERED",
      });
    }

    await setPreference({
      userId: req.userId!,
      type: type as never,
      channel: channel as never,
      enabled,
    });

    res.json({ preferences: await preferencesFor(req.userId!) });
  } catch (err) {
    fail(res, err, "Could not save that setting.");
  }
});

const query = z.object({
  unread: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

notificationsRouter.get("/", async (req, res) => {
  try {
    const parsed = query.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Check the request.", code: "INVALID_INPUT" });
    }

    const [notifications, unread] = await Promise.all([
      listNotifications(req.userId!, {
        unreadOnly: parsed.data.unread === "true",
        take: parsed.data.limit,
      }),
      countUnread(req.userId!),
    ]);

    res.json({ notifications, unread });
  } catch (err) {
    fail(res, err, "Could not load your notifications.");
  }
});

/**
 * Just the count, for the nav bell.
 *
 * Separate from GET / because the bell renders on every page and has no use for
 * fifty rows of text it will not display.
 */
notificationsRouter.get("/count", async (req, res) => {
  try {
    // The cached variant, and the only place that uses it — this is the one
    // endpoint every open tab polls on a timer. See lib/notifications.ts.
    res.json({ unread: await cachedUnreadCount(req.userId!) });
  } catch (err) {
    fail(res, err, "Could not count your notifications.");
  }
});

notificationsRouter.post("/:id/read", async (req, res) => {
  try {
    await markRead(req.userId!, req.params.id);
    // Already-read is a success. Opening the same thing twice is normal, and an
    // error there would be noise rather than information.
    res.json({ unread: await countUnread(req.userId!) });
  } catch (err) {
    fail(res, err, "Could not update that notification.");
  }
});

notificationsRouter.post("/read-all", async (req, res) => {
  try {
    const count = await markAllRead(req.userId!);
    res.json({ marked: count, unread: 0 });
  } catch (err) {
    fail(res, err, "Could not update your notifications.");
  }
});

notificationsRouter.delete("/:id", async (req, res) => {
  try {
    await removeNotification(req.userId!, req.params.id);
    res.status(204).end();
  } catch (err) {
    fail(res, err, "Could not remove that notification.");
  }
});
