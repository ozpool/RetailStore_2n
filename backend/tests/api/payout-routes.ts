import { prisma, requireServices } from "../lib/db";
import { Scope, buyOne } from "../lib/fixtures";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";
import { isStubPayouts } from "../../src/lib/payoutProvider";

/**
 * The payout endpoints, over HTTP.
 *
 * WHY THIS EXISTS SEPARATELY FROM `payouts.ts`
 * That suite proves the arithmetic and the claim: what is owed, and that the
 * same item cannot be paid twice. It runs entirely below HTTP, so none of it
 * touches the route layer — and the route layer is where the *permission* lives.
 * Six endpoints can move money or create an account at a payment provider, and
 * until this existed not one of them had an assertion that a stranger, or an
 * unverified seller, was refused.
 *
 * THE GATE IS THE POINT. Section 1 fires every route at an unverified seller,
 * because `403 PAYOUTS_LOCKED` is a promise ADR 0007 made and this is the only
 * thing that keeps it.
 *
 * Section 2 is the other half, and it exists because of a bug. This router is
 * mounted at `/seller` beside the verification router, and a `router.use()`
 * with no path runs for EVERY request reaching that mount — so an unscoped
 * gate reaches `/seller/verification`, the one page an unverified seller needs.
 * Worse than a wrong refusal: `requireSeller` is scoped too, so `req.sellerId`
 * is never set on those paths and the gate's own query throws. Reverting the
 * scoping turns these three assertions into **500s**, which is how this was
 * verified rather than assumed.
 *
 * `payoutsEnabled` is set directly below rather than earned through a
 * verification flow. Earning it is `identity.ts`'s job and duplicating it here
 * would test Stripe Identity twice and the payout gate once.
 */

const scope = new Scope("payoutroutes");
wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

const DAY = 24 * 3600_000;

void main(
  "payout endpoints",
  async (t) => {
    await requireServices({ api: true, web: true });

    if (!isStubPayouts()) {
      t.check(false, "PAYOUT_PROVIDER=stub (these endpoints would move real money)");
      return;
    }

    /**
     * A seller with something sold, delivered, and long past the hold — so
     * `run` has something real to send rather than only the empty answer.
     */
    const { seller, listing } = await scope.ownListing("shop", {
      priceCents: 8_400,
      title: "A payout-route teacup",
    });
    const buyer = await scope.buyer("buyer");

    const profileId = await prisma.sellerProfile
      .findFirstOrThrow({
        where: { user: { email: scope.emailFor("shop") } },
        select: { id: true },
      })
      .then((p) => p.id);

    /* ============================================================ *
     * 1. Every route is shut before verification.
     * ============================================================ */
    t.section("1. locked until the seller is verified");

    const locked: [string, Promise<{ status: number; json: any }>][] = [
      ["GET  /payouts", seller.get("/api/seller/payouts")],
      ["POST /payouts/account", seller.post("/api/seller/payouts/account", {})],
      ["POST /payouts/account/refresh", seller.post("/api/seller/payouts/account/refresh", {})],
      [
        "POST /payouts/account/stub-complete",
        seller.post("/api/seller/payouts/account/stub-complete", {}),
      ],
      ["POST /payouts/run", seller.post("/api/seller/payouts/run", {})],
      ["GET  /payouts/:id", seller.get("/api/seller/payouts/00000000-0000-0000-0000-000000000000")],
    ];

    for (const [label, pending] of locked) {
      const res = await pending;
      t.check(
        res.status === 403 && res.json?.code === "PAYOUTS_LOCKED",
        `${label} is refused`,
        `${res.status} ${res.json?.code}`
      );
    }

    /**
     * ONBOARDING IS BEHIND THE GATE TOO, and that is deliberate rather than
     * incidental: `POST /payouts/account` creates a real account at a real
     * provider under somebody's name, and doing that before we know who they
     * are is the wrong order.
     */
    t.check(
      (await prisma.sellerProfile.findUniqueOrThrow({
        where: { id: profileId },
        select: { connectAccountId: true },
      })).connectAccountId === null,
      "and no connected account was created while locked"
    );

    /* ============================================================ *
     * 2. The gate does not leak onto its neighbours.
     * ============================================================ */
    t.section("2. the gate covers payouts and nothing else");

    const stillOpen = await seller.get("/api/seller/verification");
    t.check(
      stillOpen.status === 200,
      "an unverified seller can still reach /seller/verification — the page that unlocks them",
      `${stillOpen.status} ${stillOpen.json?.code}`
    );
    const sales = await seller.get("/api/seller/sales");
    t.check(sales.status === 200, "and /seller/sales", `${sales.status} ${sales.json?.code}`);
    const listings = await seller.get("/api/seller/listings");
    t.check(listings.status === 200, "and /seller/listings",
      `${listings.status} ${listings.json?.code}`);

    /* ---- a buyer is not a seller, whatever their verification says ---- */
    t.check(
      (await buyer.get("/api/seller/payouts")).status === 403,
      "a non-seller is refused outright"
    );

    /* ============================================================ *
     * 3. Verified: the summary explains itself.
     * ============================================================ */
    t.section("3. the summary once verified");

    await prisma.sellerProfile.update({
      where: { id: profileId },
      data: { payoutsEnabled: true, kycStatus: "VERIFIED" },
    });

    const empty = await seller.get("/api/seller/payouts");
    t.check(empty.status === 200, "payouts now load", empty.status);
    t.check(empty.json.summary.gates.payoutsEnabled === true, "the identity gate reads open");
    t.check(empty.json.summary.gates.payoutsReady === false,
      "the provider's gate is still shut — verifying does not connect an account");
    t.check(empty.json.summary.gates.onboarded === false, "and no account is connected");
    t.check(empty.json.holdDays > 0, "the hold length is reported, not implied",
      empty.json.holdDays);
    t.check(empty.json.isStub === true, "and the response says it is a stub");
    t.check(Array.isArray(empty.json.payable) && empty.json.payable.length === 0,
      "nothing is payable yet");

    /* ============================================================ *
     * 4. Running a payout with no account.
     * ============================================================ */
    t.section("4. the reasons a run refuses");

    const noAccount = await seller.post("/api/seller/payouts/run", {});
    t.check(noAccount.status === 409 && noAccount.json.code === "NO_ACCOUNT",
      "with no account connected: 409 NO_ACCOUNT",
      `${noAccount.status} ${noAccount.json?.code}`);

    const refreshNoAccount = await seller.post("/api/seller/payouts/account/refresh", {});
    t.check(refreshNoAccount.status === 409 && refreshNoAccount.json.code === "NO_ACCOUNT",
      "refreshing an account that does not exist: 409 NO_ACCOUNT",
      `${refreshNoAccount.status} ${refreshNoAccount.json?.code}`);

    const completeNoAccount = await seller.post("/api/seller/payouts/account/stub-complete", {});
    t.check(completeNoAccount.status === 409 && completeNoAccount.json.code === "NO_ACCOUNT",
      "completing onboarding that never started: 409 NO_ACCOUNT",
      `${completeNoAccount.status} ${completeNoAccount.json?.code}`);

    /* ============================================================ *
     * 5. Onboarding.
     * ============================================================ */
    t.section("5. connecting an account");

    const started = await seller.post("/api/seller/payouts/account", {});
    t.check(started.status === 201, "onboarding starts", started.status);
    t.check(typeof started.json.url === "string" && started.json.url.length > 0,
      "and returns somewhere to send the seller", started.json?.url);
    t.check(started.json.external === false,
      "the stub has no hosted page, and says so rather than pretending",
      started.json?.external);

    const first = await prisma.sellerProfile.findUniqueOrThrow({
      where: { id: profileId },
      select: { connectAccountId: true },
    });
    t.check(!!first.connectAccountId, "an account id was stored", first.connectAccountId);

    /**
     * REUSED, NOT RECREATED. Stripe has no delete worth relying on, so a seller
     * who refreshes the page mid-onboarding must not end up owning two accounts
     * — one of which nothing will ever look at again.
     */
    const again = await seller.post("/api/seller/payouts/account", {});
    t.check(again.status === 201, "starting again is allowed", again.status);
    const second = await prisma.sellerProfile.findUniqueOrThrow({
      where: { id: profileId },
      select: { connectAccountId: true },
    });
    t.check(second.connectAccountId === first.connectAccountId,
      "and reuses the same account rather than creating a second",
      `${first.connectAccountId} vs ${second.connectAccountId}`);

    /* ---- submitted is not the same as ready ---- */
    const beforeReady = await seller.get("/api/seller/payouts");
    t.check(beforeReady.json.summary.gates.onboarded === true, "the account now counts as connected");
    t.check(beforeReady.json.summary.gates.payoutsReady === false,
      "but is not ready until the provider says so");

    const notReady = await seller.post("/api/seller/payouts/run", {});
    t.check(notReady.status === 409 && notReady.json.code === "NOT_READY",
      "so a run refuses with 409 NOT_READY — a different fix from NO_ACCOUNT",
      `${notReady.status} ${notReady.json?.code}`);

    const completed = await seller.post("/api/seller/payouts/account/stub-complete", {});
    t.check(completed.status === 200 && completed.json.payoutsReady === true,
      "the stub finishes onboarding", `${completed.status} ${completed.json?.payoutsReady}`);

    const refreshed = await seller.post("/api/seller/payouts/account/refresh", {});
    t.check(refreshed.status === 200 && refreshed.json.payoutsReady === true,
      "and re-reading the provider agrees",
      `${refreshed.status} ${refreshed.json?.payoutsReady}`);

    /**
     * `connectOnboardedAt` is the day the seller submitted their details, and
     * that is not a fact that moves. The webhook and this endpoint both fire
     * repeatedly over an account's life, and an earlier version stamped `now()`
     * every time.
     */
    const stampFirst = await prisma.sellerProfile
      .findUniqueOrThrow({ where: { id: profileId }, select: { connectOnboardedAt: true } })
      .then((p) => p.connectOnboardedAt);
    await seller.post("/api/seller/payouts/account/refresh", {});
    const stampAgain = await prisma.sellerProfile
      .findUniqueOrThrow({ where: { id: profileId }, select: { connectOnboardedAt: true } })
      .then((p) => p.connectOnboardedAt);
    t.check(
      stampFirst !== null && stampAgain?.getTime() === stampFirst.getTime(),
      "and refreshing again does not move the onboarding date",
      `${stampFirst?.toISOString()} vs ${stampAgain?.toISOString()}`
    );

    /* ============================================================ *
     * 6. Nothing owed is a 200, not an error.
     * ============================================================ */
    t.section("6. nothing to pay out");

    const nothing = await seller.post("/api/seller/payouts/run", {});
    t.check(nothing.status === 200 && nothing.json.code === "NOTHING_PAYABLE",
      "both gates open but nothing earned: 200 NOTHING_PAYABLE, because it is the ordinary answer",
      `${nothing.status} ${nothing.json?.code}`);
    t.check(nothing.json.paid === false, "and it does not claim to have paid");

    /* ============================================================ *
     * 7. A real sale, all the way to money.
     * ============================================================ */
    t.section("7. a delivered sale becomes a payout");

    const { paid } = await buyOne(buyer, listing.id);
    /**
     * The OUTCOME, not just the status. A 200 carrying `outcome: "failed"` is a
     * refused card, and asserting only the status would let this pass and then
     * fail confusingly three sections later with "no sale reached the seller".
     */
    t.check(paid.status === 200 && paid.json.outcome === "succeeded", "the buyer pays",
      `${paid.status} ${paid.json?.outcome ?? paid.json?.error ?? ""}`);

    const sale = await seller.get("/api/seller/sales").then((r) => r.json.sales[0]);
    t.check(!!sale, "the sale reaches the seller", sale?.title);
    t.check((await seller.post(`/api/seller/sales/${sale.id}/ship`, {})).status === 200,
      "the seller ships it");

    const held = await seller.get("/api/seller/payouts");
    t.check(held.json.summary.inFlightCents === 8_400,
      "shipped but undelivered counts as not-yet-earned, not payable",
      held.json.summary.inFlightCents);
    t.check(held.json.summary.payableCents === 0, "so nothing is payable on a seller's own word");

    t.check((await buyer.post(`/api/orders/items/${sale.id}/delivered`)).status === 200,
      "the BUYER confirms delivery");

    const inHold = await seller.get("/api/seller/payouts");
    t.check(inHold.json.summary.heldCents === 8_400,
      "delivered money enters the hold rather than becoming payable",
      inHold.json.summary.heldCents);
    t.check(inHold.json.summary.heldUntil !== null,
      "and the seller is told when it comes off hold", inHold.json.summary.heldUntil);
    t.check((await seller.post("/api/seller/payouts/run", {})).json.code === "NOTHING_PAYABLE",
      "a run inside the hold window pays nothing");

    /**
     * Backdated rather than waiting seven days. The hold itself is asserted
     * against a fixed clock in `payouts.ts`; what this needs is a payable line.
     */
    await prisma.orderItem.update({
      where: { id: sale.id },
      data: { deliveredAt: new Date(Date.now() - 60 * DAY) },
    });

    const ready = await seller.get("/api/seller/payouts");
    t.check(ready.json.summary.payableCents === 8_400, "past the hold, it is payable",
      ready.json.summary.payableCents);
    t.check(ready.json.payable.length === 1 && ready.json.payable[0].amountCents === 8_400,
      "and the exact line is listed, so the total is not taken on trust",
      JSON.stringify(ready.json.payable));
    t.check(ready.json.payable[0].title === "A payout-route teacup",
      "with the item's name on it", ready.json.payable[0]?.title);

    const sent = await seller.post("/api/seller/payouts/run", {});
    t.check(sent.status === 201 && sent.json.paid === true, "the payout is sent",
      `${sent.status} ${JSON.stringify(sent.json)}`);
    t.check(sent.json.amountCents === 8_400, "for the right amount", sent.json?.amountCents);
    const payoutId: string = sent.json.payoutId;

    /* ---- and immediately again ---- */
    const twice = await seller.post("/api/seller/payouts/run", {});
    t.check(twice.status === 200 && twice.json.code === "NOTHING_PAYABLE",
      "asking again pays nothing — the line is spoken for",
      `${twice.status} ${twice.json?.code}`);
    t.check(
      (await prisma.payoutItem.count({ where: { orderItemId: sale.id } })) === 1,
      "and the item appears in exactly one payout"
    );

    const after = await seller.get("/api/seller/payouts");
    t.check(after.json.summary.paidCents === 8_400, "paid out now reflects it",
      after.json.summary.paidCents);
    t.check(after.json.summary.payableCents === 0, "and there is nothing left ready");
    t.check(after.json.history.length === 1 && after.json.history[0].status === "PAID",
      "the payout is in the history as PAID",
      JSON.stringify(after.json.history?.[0]?.status));

    /* ============================================================ *
     * 8. Reading one payout back.
     * ============================================================ */
    t.section("8. one payout, in detail");

    const detail = await seller.get(`/api/seller/payouts/${payoutId}`);
    t.check(detail.status === 200, "the payout loads", detail.status);
    t.check(detail.json.payout.items.length === 1, "with the line it covered",
      detail.json.payout?.items?.length);
    t.check(detail.json.payout.items[0].title === "A payout-route teacup",
      "named, so 'what was this payment for?' has an answer",
      detail.json.payout?.items?.[0]?.title);
    t.check(!!detail.json.payout.items[0].orderReference,
      "and traceable to an order", detail.json.payout?.items?.[0]?.orderReference);

    /**
     * 404 RATHER THAN 403, the same policy as addresses and sales: a 403 on
     * someone else's id confirms the id exists, which is a lookup oracle for
     * anybody who wants to know whether a given seller has been paid.
     */
    const stranger = await scope.seller("stranger");
    await prisma.sellerProfile.updateMany({
      where: { user: { email: scope.emailFor("stranger") } },
      data: { payoutsEnabled: true, kycStatus: "VERIFIED" },
    });
    const peek = await stranger.get(`/api/seller/payouts/${payoutId}`);
    t.check(peek.status === 404 && peek.json.code === "NOT_FOUND",
      "another seller's payout is a 404, not a 403",
      `${peek.status} ${peek.json?.code}`);

    /* ============================================================ *
     * 9. Rate limits. Last, because they leave the seller blocked.
     * ============================================================ */
    t.section("9. rate limits");

    /**
     * The claim is what makes a double-click safe, not this limit. The limit is
     * the cheaper place to stop a client hammering an endpoint that talks to a
     * payment provider on every call.
     */
    let runLimited: { status: number; json: any } | null = null;
    for (let i = 0; i < 14 && runLimited === null; i += 1) {
      const res = await seller.post("/api/seller/payouts/run", {});
      if (res.status === 429) runLimited = res;
    }
    t.check(runLimited !== null && runLimited.json.code === "RATE_LIMITED",
      "payout runs are capped per hour", runLimited?.json?.code ?? "never limited in 14 tries");
    t.check(
      typeof runLimited?.json?.retryAfterSeconds === "number",
      "and the client is told how long to wait rather than guessing",
      runLimited?.json?.retryAfterSeconds
    );

    let onboardLimited: { status: number; json: any } | null = null;
    for (let i = 0; i < 10 && onboardLimited === null; i += 1) {
      const res = await seller.post("/api/seller/payouts/account", {});
      if (res.status === 429) onboardLimited = res;
    }
    t.check(onboardLimited !== null,
      "onboarding is capped too — each call can create an account at a provider",
      onboardLimited?.json?.code ?? "never limited in 10 tries");
  },

  async () => {
    /**
     * Payouts hang off the seller profile, which the scope's own cleanup
     * cascades when it deletes the user — but the rows are deleted explicitly
     * first so a schema change that drops the cascade fails loudly here rather
     * than leaving money rows behind for the next run to trip over.
     */
    const profileIds = (
      await prisma.sellerProfile.findMany({
        where: { user: { email: { in: [scope.emailFor("shop"), scope.emailFor("stranger")] } } },
        select: { id: true },
      })
    ).map((p) => p.id);

    if (profileIds.length > 0) {
      await prisma.payoutItem.deleteMany({ where: { payout: { sellerId: { in: profileIds } } } });
      await prisma.payoutDebt.deleteMany({ where: { sellerId: { in: profileIds } } });
      await prisma.payout.deleteMany({ where: { sellerId: { in: profileIds } } });
    }
    await scope.cleanup();
  }
);
