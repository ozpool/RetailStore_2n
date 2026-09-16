import { WEB, prisma, requireServices } from "../lib/db";
import { PASSWORD, Scope } from "../lib/fixtures";
import { fillReliably, login, openBrowser, realFailures } from "../lib/browser";
import { currentCode, freshCode } from "../lib/totp";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";
import { Condition, ListingStatus, UserRole } from "../../src/generated/prisma/enums";

/**
 * A placement negotiated from one end to the other, in a browser.
 *
 * WHAT THIS PROVES THAT THE ROUTE SUITE DOES NOT
 * `placement-routes.ts` drives the same negotiation over HTTP and proves the
 * endpoints and the authorisation. It cannot prove that a seller can FIND any
 * of it, that the counter-offer is legible when it arrives, or that the terms
 * shown on screen are the terms in the database. A feature nobody can reach is
 * indistinguishable from a feature that does not exist.
 *
 * The sequence is deliberately the real one, with two logged-in parties:
 *   seller asks  →  moderator counters  →  seller accepts  →  moderator
 *   activates  →  the label appears on the homepage.
 */

/**
 * Waits for `main` to CONTAIN something, and returns whatever it last saw.
 *
 * Every read in this suite used to be `waitForTimeout(1200)` then read, which
 * passed on this laptop and failed on a loaded CI runner at the one step whose
 * page does two fetches — the thread list, then the thread. A fixed sleep is a
 * guess about somebody else's machine.
 *
 * Returns the text rather than throwing, so a genuine failure is still an
 * assertion with the page contents attached rather than an opaque timeout.
 */
async function mainText(
  page: import("playwright").Page,
  want: RegExp,
  budgetMs = 30_000
): Promise<string> {
  const until = Date.now() + budgetMs;
  let last = "";
  for (;;) {
    last = await page.locator("main").innerText();
    if (want.test(last) || Date.now() > until) return last;
    await page.waitForTimeout(250);
  }
}

const scope = new Scope("uiplace");
wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

const TITLE = `Gilded hall bench ${Date.now().toString().slice(-6)}`;

void main(
  "placement negotiation (browser)",
  async (t) => {
    await requireServices({ api: true, web: true });

    const sellerEmail = await scope.register("seller", { seller: true });
    const adminEmail = await scope.register("admin");

    const profile = await prisma.sellerProfile.findFirstOrThrow({
      where: { user: { email: sellerEmail } },
      select: { id: true },
    });
    const category = await prisma.category.findFirstOrThrow({ select: { id: true } });

    const slug = `uiplace-${Date.now()}`;
    const listing = await prisma.listing.create({
      data: {
        slug,
        title: TITLE,
        description: "A long bench, repaired at one end with a visible gold seam.",
        sellerId: profile.id,
        categoryId: category.id,
        condition: Condition.GOOD,
        priceCents: 32_000,
        quantity: 1,
        status: ListingStatus.ACTIVE,
      },
      select: { id: true },
    });
    await scope.trackListing(listing.id);

    await prisma.user.update({
      where: { email: adminEmail },
      data: { role: UserRole.ADMIN },
    });

    /**
     * Warm the new routes before the browser asks for them.
     *
     * Against a dev server the first request to a route compiles it, which took
     * ~60s here and blew through Playwright's 30s navigation timeout on a page
     * that works perfectly once built. Warming is not papering over a slow
     * page: it removes a one-off compile from the middle of a user journey the
     * suite is trying to time.
     */
    for (const path of ["/seller/placements", "/seller/messages", "/admin/placements", "/admin/messages"]) {
      await fetch(`${WEB}${path}`, { signal: AbortSignal.timeout(180_000) }).catch(() => {});
    }

    const h = await openBrowser("uiplace");

    try {
      /* ---- 1. the seller finds it and asks ---- */
      /** Named for `realFailures`, which exempts exactly this phase: the auth
       *  probe 401s before anybody is signed in, and that is the correct
       *  answer rather than a fault. */
      h.phase("pre-login");
      await login(h.page, sellerEmail);
      h.phase("seller asks");

      await h.page.goto(`${WEB}/seller`, { waitUntil: "networkidle" });
      const hubLink = h.page.locator('a[href="/seller/placements"]');
      t.check(
        (await hubLink.count()) > 0,
        "the seller hub links to homepage placement — it is discoverable"
      );

      await hubLink.first().click();
      await h.page.waitForURL(/\/seller\/placements/, { timeout: 20000 });

      /**
       * THE DISCLOSURE, ON SCREEN, BEFORE THE FORM.
       * This is the legal requirement rather than a product preference, and the
       * page gets the wording from the API so it cannot be rendered without it.
       */
      const disclosure = await mainText(h.page, /promoted/i);
      t.check(
        /promoted/i.test(disclosure),
        "the request page tells the seller placements are labelled Promoted",
        disclosure.slice(0, 160)
      );

      await h.page.selectOption('select >> nth=0', { label: TITLE });
      await h.page.selectOption('select >> nth=1', "HERO");
      await fillReliably(h.page, 'input[type="number"]', "40");
      await fillReliably(
        h.page,
        "textarea",
        "It is the nicest thing in my shop and it photographs beautifully."
      );
      await h.page.click('button:has-text("Send request")');

      const afterAsk = await mainText(h.page, /Waiting for RetailStore_2n/);
      t.check(
        afterAsk.includes(TITLE) && /Waiting for RetailStore_2n/.test(afterAsk),
        "the request appears, and says whose turn it is in words",
        afterAsk.slice(0, 240)
      );

      /* ---- 2. the moderator counters ---- */
      h.phase("pre-login");
      await h.page.goto(`${WEB}/login`, { waitUntil: "networkidle" });
      await h.page.evaluate(() => localStorage.clear());
      await login(h.page, adminEmail);
      h.phase("moderator counters");

      // Enrol and step up the way a person does; two codes from two periods.
      const setup = await h.page.evaluate(
        async (password) => {
          const res = await fetch("/api/admin/totp/setup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password }),
          });
          return res.json();
        },
        PASSWORD
      );
      const secret = (setup as { secret: string }).secret;
      await h.page.evaluate(
        async (code) => {
          await fetch("/api/admin/totp/confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code }),
          });
        },
        currentCode(secret)
      );
      await h.page.evaluate(
        async ([password, code]) => {
          await fetch("/api/admin/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password, code }),
          });
        },
        [PASSWORD, await freshCode(secret)]
      );

      await h.page.goto(`${WEB}/admin/placements`, { waitUntil: "networkidle" });

      const queue = await mainText(h.page, new RegExp(TITLE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      t.check(
        queue.includes(TITLE),
        "the moderator's placement queue shows the request",
        queue.slice(0, 240)
      );
      t.check(
        /Live on the homepage/.test(queue),
        "and the screen opens with what is already live, not with the next decision"
      );

      await h.page.click('button:has-text("Counter or decline")');
      await h.page.locator('input[type="number"]').first().waitFor({ state: "visible", timeout: 15_000 });
      await fillReliably(h.page, 'input[type="number"]', "60");
      await fillReliably(
        h.page,
        "textarea",
        "The hero is our most valuable slot, so sixty dollars for the week."
      );
      await h.page.click('button:has-text("Send counter-offer")');

      const countered = await mainText(h.page, /COUNTERED/);
      t.check(
        /COUNTERED/.test(countered),
        "the request moves to COUNTERED on screen",
        countered.slice(0, 240)
      );

      /* ---- 3. the seller reads the counter and accepts ---- */
      h.phase("pre-login");
      await h.page.goto(`${WEB}/login`, { waitUntil: "networkidle" });
      await login(h.page, sellerEmail);
      h.phase("seller accepts");
      await h.page.goto(`${WEB}/seller/placements`, { waitUntil: "networkidle" });

      const counterSeen = await mainText(h.page, /Your turn/);
      t.check(
        /Your turn/.test(counterSeen) && /\$60/.test(counterSeen),
        "the seller sees the counter-offer and the number in it",
        counterSeen.slice(0, 300)
      );

      await h.page.click('button:has-text("Accept these terms")');

      const agreed = await mainText(h.page, /Agreed, not live yet/);
      t.check(
        /Agreed, not live yet/.test(agreed),
        "accepting reaches an agreed state the seller can read",
        agreed.slice(0, 240)
      );

      /* ---- 4. the conversation is legible to the seller ---- */
      h.phase("seller reads the thread");

      /**
       * `domcontentloaded` HERE AND NOWHERE ELSE IN THIS SUITE.
       *
       * This is the one navigation that fails in CI, and it fails by throwing:
       * `networkidle` waits for 500ms of network silence, and on a loaded
       * runner this page does not go quiet inside the 30s navigation ceiling —
       * so the goto throws, the suite aborts, and nothing is reported about
       * what the page held.
       *
       * Nothing here needs network silence, because the very next statement
       * waits for the element it is about to click. The other eight navigations
       * keep `networkidle`: switching them all to `domcontentloaded` returns
       * before React hydrates, and the seller-hub assertion then read a page
       * that had not finished rendering. Tried, and it broke two assertions
       * that had been passing.
       */
      await h.page.goto(`${WEB}/seller/messages`, { waitUntil: "domcontentloaded" });

      /**
       * Two fetches deep: the thread list arrives, then the thread itself.
       *
       * THIS IS THE STEP THAT FAILED IN CI, and it failed by THROWING — a
       * `page.click` timeout, which aborts the suite and reports nothing about
       * what the page actually showed. It could not be reproduced locally, so
       * the click is guarded: if the thread never appears in the list, this
       * reports the list's contents as a failed assertion and the run carries
       * on to the remaining checks. A flake that explains itself is worth more
       * than one that dies silently.
       */
      const threadButton = h.page.locator('button:has-text("Homepage placement")').first();
      const listed = await threadButton
        .waitFor({ state: "visible", timeout: 30_000 })
        .then(() => true)
        .catch(() => false);

      t.check(
        listed,
        "the placement thread is in the seller's message list",
        listed ? "" : (await h.page.locator("main").innerText()).slice(0, 300)
      );

      let thread = "";
      if (listed) {
        await threadButton.click();
        thread = await mainText(h.page, /most valuable slot/);
      }
      t.check(
        /most valuable slot/.test(thread),
        "the moderator's actual words are in the thread, not just a status",
        thread.slice(0, 300)
      );

      /**
       * The rest of the suite does not depend on the thread view, so it runs
       * either way — the activation and the homepage label are the assertions
       * that matter most and they must not be lost to a flake three steps
       * earlier.
       */

      /* ---- 5. the moderator makes it live, and the homepage says so ---- */
      h.phase("pre-login");
      await h.page.goto(`${WEB}/login`, { waitUntil: "networkidle" });
      await login(h.page, adminEmail);
      h.phase("moderator activates");
      await h.page.goto(`${WEB}/admin/placements`, { waitUntil: "networkidle" });
      const liveButton = h.page.locator('button:has-text("Make it live")').first();
      await liveButton.waitFor({ state: "visible", timeout: 30_000 });
      await liveButton.click();

      /**
       * Waits for the SLUG, not for "Live on the homepage" — that string is the
       * card's title and renders even when the card is empty, so waiting on it
       * returned instantly and the assertion read a half-rendered page. A
       * condition that is always true is worse than a sleep, because it looks
       * like a fix.
       */
      const live = await mainText(h.page, new RegExp(slug));
      /**
       * NOT a search for "LIVE" in the queue. Activating moves the row out of
       * the "Needs you" tab on purpose — it no longer needs anybody. What
       * proves it worked is the live-slots card at the top of the screen, which
       * is why that card is the first thing on the page.
       */
      t.check(
        /live on the homepage/i.test(live) && live.includes(slug),
        "the live-slots card now names this listing",
        live.slice(0, 220)
      );

      h.phase("homepage");
      await h.page.goto(`${WEB}/`, { waitUntil: "networkidle" });

      const home = await mainText(h.page, new RegExp(TITLE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      t.check(home.includes(TITLE), "the promoted listing is on the homepage", home.slice(0, 200));
      /**
       * Case-insensitive, and that is not laziness. `innerText` returns the
       * RENDERED text, and both labels are `uppercase` in CSS, so the browser
       * reports "PROMOTED" while the source says "Promoted". A case-sensitive
       * match failed here against a page that was labelled correctly.
       */
      t.check(
        /promoted/i.test(home),
        "and it is labelled Promoted where a visitor reads it",
        home.slice(0, 200)
      );

      await h.shot("negotiated", { fullPage: false });

      /* ---- 6. nothing broke on the way ---- */
      t.check(h.jsErrors.length === 0, "no JavaScript errors", h.jsErrors.slice(0, 3).join(" | "));
      const bad = realFailures(h.badResponses);
      t.check(bad.length === 0, "no failed requests", bad.slice(0, 4).join(" | "));
    } finally {
      await h.close();
    }
  },

  async (t) => {
    await prisma.placementRequest.deleteMany({ where: { listing: { title: TITLE } } });
    await scope.cleanup();
    await scope.verifyClean(t);
  }
);
