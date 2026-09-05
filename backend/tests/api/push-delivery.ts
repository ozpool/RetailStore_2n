import crypto from "crypto";
import http from "http";
import https from "https";
import webpush from "web-push";
import { prisma, requireServices } from "../lib/db";
import { main, wireInterrupt, cleanupOnInterrupt } from "../lib/harness";
import { notify } from "../../src/lib/notifications";
import { relayOnce } from "../../src/lib/relay";
import { resetTransport } from "../../src/lib/notifyTransport";
import { saveSubscription, removeSubscription } from "../../src/lib/push";
import { setPreference } from "../../src/lib/channelPolicy";
import {
  DeliveryChannel,
  DeliveryStatus,
  NotificationType,
} from "../../src/generated/prisma/enums";

/**
 * Web Push delivery.
 *
 * A REAL PUSH SERVICE, LOCALLY. The suite stands up an HTTP server that answers
 * the way a browser's push service does — 201 for a live subscription, 410 for
 * a browser that is gone — and points real subscriptions at it. web-push
 * encrypts the payload for genuine ECDH keys and makes genuine requests.
 *
 * That matters for the one behaviour here that cannot be reasoned about: a
 * subscription is only deleted on 404 or 410, and never on anything else. Get
 * that wrong in the permissive direction and a bad minute at Google deletes
 * every Chrome subscription on the platform.
 *
 * See docs/plans/0001-multi-channel-notifications.md, phase 3.
 */

const TAG = `rs2.push.${Date.now()}`;
let userId = "";
let otherUserId = "";
let server: http.Server | null = null;
let base = "";

/**
 * web-push calls `https.request` unconditionally — reasonably, since every real
 * push service is HTTPS. A local test service would therefore need a
 * certificate, which means generating and trusting one just to check a status
 * code.
 *
 * Instead, requests to 127.0.0.1 are routed over plain HTTP. Everything else
 * stays real: the VAPID signature, the payload encryption, the request itself,
 * and every status code this suite asserts on. Only the TLS wrapper is missing,
 * and no assertion here is about TLS.
 *
 * Scoped to the loopback address, so a stray real endpoint in a fixture would
 * still go out over HTTPS rather than silently downgrading.
 */
const realHttpsRequest = https.request.bind(https);
(https as unknown as { request: unknown }).request = ((
  options: http.RequestOptions,
  callback?: (res: http.IncomingMessage) => void
) => {
  if (typeof options === "object" && options.hostname === "127.0.0.1") {
    return http.request(options, callback);
  }
  return realHttpsRequest(options as https.RequestOptions, callback);
}) as typeof https.request;

/** A real P-256 keypair, so web-push's encryption has something valid to use. */
function browserKeys() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: crypto.randomBytes(16).toString("base64url"),
  };
}

async function startPushService(): Promise<{ url: string; hits: string[] }> {
  const hits: string[] = [];

  server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    // Drain the body; some clients stall if nothing reads it.
    req.resume();
    if (req.url?.startsWith("/gone")) {
      res.writeHead(410).end();
    } else if (req.url?.startsWith("/wobble")) {
      // A bad minute, not a dead device. Must NOT delete the subscription.
      res.writeHead(503).end();
    } else {
      res.writeHead(201).end();
    }
  });

  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, hits };
}

async function eventIdFor(aggregateId: string): Promise<string> {
  const row = await prisma.outboxEvent.findFirst({
    where: { userId, aggregateId },
    select: { eventId: true },
  });
  if (!row) throw new Error(`no outbox event for ${aggregateId}`);
  return row.eventId;
}

function pushDelivery(eventId: string) {
  return prisma.notificationDelivery.findFirst({
    where: { eventId, channel: DeliveryChannel.PUSH },
  });
}

void main(
  "push delivery",

  async (t) => {
    await requireServices({ api: false, db: true });

    if ((process.env.NOTIFY_TRANSPORT ?? "inline").toLowerCase() !== "inline") {
      t.check(false, "runs on the inline transport", process.env.NOTIFY_TRANSPORT);
      return;
    }
    await resetTransport();

    const users = await prisma.user.createManyAndReturn({
      data: [
        { email: `${TAG}.a@retailstore-2n.test`, name: "Push A", passwordHash: "x", emailVerified: true },
        { email: `${TAG}.b@retailstore-2n.test`, name: "Push B", passwordHash: "x", emailVerified: true },
      ],
      select: { id: true },
    });
    userId = users[0].id;
    otherUserId = users[1].id;

    /* ---------------------------------------------------------------- */
    t.section("no VAPID keys: suppressed, not failed");

    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;

    await notify({
      userId,
      type: NotificationType.SALE_MADE,
      title: "Skillet sold",
      aggregateType: "test",
      aggregateId: "unconfigured",
    });
    await relayOnce();

    const unconfigured = await pushDelivery(await eventIdFor("unconfigured"));
    t.check(
      unconfigured?.status === DeliveryStatus.SUPPRESSED,
      "SUPPRESSED — the feature is off, nothing is broken",
      unconfigured?.status
    );
    t.check(
      (unconfigured?.suppressReason ?? "").includes("not configured"),
      "and says why",
      unconfigured?.suppressReason
    );

    /* ---------------------------------------------------------------- */
    t.section("configured, but no devices");

    const vapid = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
    process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
    process.env.VAPID_SUBJECT = "mailto:test@retailstore-2n.test";

    await notify({
      userId,
      type: NotificationType.SALE_MADE,
      title: "Skillet sold",
      aggregateType: "test",
      aggregateId: "nodevices",
    });
    await relayOnce();

    const nodevices = await pushDelivery(await eventIdFor("nodevices"));
    t.check(
      nodevices?.status === DeliveryStatus.SUPPRESSED,
      "SUPPRESSED — signed in, never granted permission anywhere",
      nodevices?.status
    );
    t.check(
      (nodevices?.suppressReason ?? "").includes("no devices"),
      "and says so rather than reporting a failure",
      nodevices?.suppressReason
    );

    /* ---------------------------------------------------------------- */
    t.section("two devices, one of them gone");

    const service = await startPushService();
    base = service.url;

    const live = browserKeys();
    const dead = browserKeys();

    await saveSubscription({
      userId,
      endpoint: `${base}/ok/device-live`,
      ...live,
      userAgent: "Chrome on Windows",
    });
    await saveSubscription({
      userId,
      endpoint: `${base}/gone/device-dead`,
      ...dead,
      userAgent: "Firefox on Linux",
    });

    t.check(
      (await prisma.pushSubscription.count({ where: { userId } })) === 2,
      "two devices registered"
    );

    await notify({
      userId,
      type: NotificationType.SALE_MADE,
      title: "Skillet sold",
      body: "Send it when you can.",
      link: "/seller/sales",
      aggregateType: "test",
      aggregateId: "twodevices",
    });
    const twoEvent = await eventIdFor("twodevices");
    await relayOnce();

    const sentRow = await pushDelivery(twoEvent);
    t.check(
      sentRow?.status === DeliveryStatus.SENT,
      "SENT — one device took it, which is a delivery",
      `${sentRow?.status} ${sentRow?.lastError ?? ""}`
    );

    const remaining = await prisma.pushSubscription.findMany({
      where: { userId },
      select: { endpoint: true },
    });
    t.check(
      remaining.length === 1,
      "the dead subscription was deleted",
      remaining.map((r) => r.endpoint)
    );
    t.check(
      remaining[0]?.endpoint.includes("/ok/"),
      "and the live one was kept",
      remaining[0]?.endpoint
    );
    t.check(
      service.hits.some((h) => h.includes("device-live")) &&
        service.hits.some((h) => h.includes("device-dead")),
      "both endpoints were really called",
      service.hits
    );

    /* ---------------------------------------------------------------- */
    t.section("a 503 is a bad minute, not a dead device");

    const wobbly = browserKeys();
    await saveSubscription({ userId, endpoint: `${base}/wobble/x`, ...wobbly });

    // Remove the working one so the send has nothing else to succeed with.
    await removeSubscription(userId, `${base}/ok/device-live`);

    await notify({
      userId,
      type: NotificationType.SALE_MADE,
      title: "Another sale",
      aggregateType: "test",
      aggregateId: "wobble",
    });
    await relayOnce();

    const wobbleRow = await pushDelivery(await eventIdFor("wobble"));
    t.check(
      wobbleRow?.status === DeliveryStatus.FAILED,
      "FAILED, because nothing landed",
      wobbleRow?.status
    );
    t.check(
      (await prisma.pushSubscription.count({
        where: { userId, endpoint: `${base}/wobble/x` },
      })) === 1,
      "but the subscription SURVIVED — only 404/410 delete",
      "still present"
    );

    /* ---------------------------------------------------------------- */
    t.section("a redelivery does not push twice");

    await prisma.outboxEvent.updateMany({
      where: { userId, aggregateId: "twodevices" },
      data: { publishedAt: null },
    });
    const before = service.hits.length;
    await relayOnce();

    const rows = await prisma.notificationDelivery.count({
      where: { eventId: twoEvent, channel: DeliveryChannel.PUSH },
    });
    t.check(rows === 1, "still exactly one push delivery row", rows);
    t.check(
      service.hits.length === before,
      "and the push service was not called again",
      `${before} → ${service.hits.length}`
    );

    /* ---------------------------------------------------------------- */
    t.section("a device moves between accounts, it does not duplicate");

    const shared = `${base}/ok/shared-laptop`;
    const keys = browserKeys();
    await saveSubscription({ userId, endpoint: shared, ...keys });
    // Same browser, different person signs in.
    await saveSubscription({ userId: otherUserId, endpoint: shared, ...keys });

    const owners = await prisma.pushSubscription.findMany({
      where: { endpoint: shared },
      select: { userId: true },
    });

    t.check(owners.length === 1, "one row, not two", owners.length);
    t.check(
      owners[0]?.userId === otherUserId,
      "owned by whoever signed in last — the first account stops receiving",
      owners[0]?.userId === userId ? "still the first user" : "moved"
    );

    /* ---------------------------------------------------------------- */
    t.section("unsubscribe is scoped to the owner");

    const removedByStranger = await removeSubscription(userId, shared);
    t.check(removedByStranger === 0, "another user cannot remove it", removedByStranger);
    t.check(
      (await prisma.pushSubscription.count({ where: { endpoint: shared } })) === 1,
      "and it is still there"
    );

    const removedByOwner = await removeSubscription(otherUserId, shared);
    t.check(removedByOwner === 1, "the owner can", removedByOwner);

    /* ---------------------------------------------------------------- */
    t.section("turning push off suppresses it");

    await setPreference({
      userId,
      type: NotificationType.REVIEW_RECEIVED,
      channel: DeliveryChannel.PUSH,
      enabled: false,
    });

    await notify({
      userId,
      type: NotificationType.REVIEW_RECEIVED,
      title: "5-star review",
      aggregateType: "test",
      aggregateId: "prefoff",
    });
    await relayOnce();

    const prefRow = await pushDelivery(await eventIdFor("prefoff"));
    t.check(
      prefRow?.status === DeliveryStatus.SUPPRESSED,
      "suppressed by the recipient's choice",
      prefRow?.status
    );
    t.check(
      (prefRow?.suppressReason ?? "").includes("turned off"),
      "and the reason distinguishes it from having no device",
      prefRow?.suppressReason
    );
  },

  async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    for (const id of [userId, otherUserId].filter(Boolean)) {
      await prisma.notificationDelivery.deleteMany({ where: { userId: id } });
      await prisma.outboxEvent.deleteMany({ where: { userId: id } });
      await prisma.user.deleteMany({ where: { id } });
    }
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    await resetTransport();
  }
);

wireInterrupt();
cleanupOnInterrupt(async () => {
  if (server) server.close();
  for (const id of [userId, otherUserId].filter(Boolean)) {
    await prisma.notificationDelivery.deleteMany({ where: { userId: id } });
    await prisma.outboxEvent.deleteMany({ where: { userId: id } });
    await prisma.user.deleteMany({ where: { id } });
  }
});
