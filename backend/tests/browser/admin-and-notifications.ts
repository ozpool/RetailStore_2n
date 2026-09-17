import { WEB, prisma, requireCatalog, requireServices } from "../lib/db";
import { currentCode, freshCode } from "../lib/totp";
import { PASSWORD, Scope, buyOne } from "../lib/fixtures";
import { brokenImages, login, openBrowser, realFailures } from "../lib/browser";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";

/**
 * Notifications and the admin panel, in a browser.
 *
 * The assertions that matter most are negative:
 *   - a non-admin must see the panel as if it does not exist
 *   - being an admin must not be enough to open it
 *   - a report must be findable but understated
 */

const scope = new Scope("uiadmin");
wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

void main(
  "admin and notifications (browser)",
  async (t) => {
    await requireServices({ api: true, web: true });
    await requireCatalog();

    const sellerEmail = await scope.register("seller", { seller: true });
    const buyerEmail = await scope.register("buyer");
    const adminEmail = await scope.register("admin");

    const profile = await prisma.sellerProfile.findFirstOrThrow({
      where: { user: { email: sellerEmail } },
      select: { id: true },
    });
    const category = await prisma.category.findFirstOrThrow({ select: { id: true } });
    const listing = await prisma.listing.create({
      data: {
        slug: `uiadmin-${Date.now()}`,
        title: "Admin flow test kettle",
        description: "Listed so a sale can raise a notification and be reported.",
        sellerId: profile.id,
        categoryId: category.id,
        condition: "GOOD",
        priceCents: 3300,
        quantity: 1,
        status: "ACTIVE",
        images: {
          create: { url: "https://images.unsplash.com/photo-1465385076216-9288f6f0584b", position: 0 },
        },
      },
      select: { id: true, slug: true, title: true },
    });

    const h = await openBrowser("admin");
    try {
      /* ============================================================ */
      t.section("the panel is invisible to everyone else");
      h.phase("pre-login");
      await login(h.page, buyerEmail);
      h.phase("shopping");

      await h.page.goto(`${WEB}/admin`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(2500);
      const notForYou = await h.page.locator("main").innerText();
      t.check(/not found/i.test(notForYou),
        "a non-admin sees 'not found', not 'you aren't an admin'",
        notForYou.slice(0, 120).replace(/\n/g, " | "));
      t.check(!/admin sign-in|two-factor/i.test(notForYou),
        "and is shown no sign-in form to probe");

      /* ============================================================ */
      t.section("notifications arrive from real events");

      // The buyer buys the seller's kettle.
      const { paid } = await buyOne(
        await (async () => {
          const { web } = await import("../lib/api");
          const c = web();
          await c.post("/api/auth/login", { email: buyerEmail, password: PASSWORD });
          return c;
        })(),
        listing.id
      );
      t.check(paid.json.outcome === "succeeded", "buyer bought the kettle", paid.json?.outcome);

      const sellerBrowser = await openBrowser("admin-seller");
      try {
        sellerBrowser.phase("pre-login");
        await login(sellerBrowser.page, sellerEmail);
        sellerBrowser.phase("selling");
        await sellerBrowser.page.waitForTimeout(2000);

        const badge = sellerBrowser.page.locator('button[aria-label*="unread"]');
        t.check(await badge.count() > 0, "the seller's bell shows an unread count");
        t.check(/1 unread/.test((await badge.first().getAttribute("aria-label")) ?? ""),
          "of one", await badge.first().getAttribute("aria-label"));

        await badge.first().click();
        await sellerBrowser.page.waitForTimeout(2000);
        const dropdown = await sellerBrowser.page.locator('[role="menu"]').innerText();
        t.check(dropdown.includes(listing.title), "the dropdown names the item sold",
          dropdown.slice(0, 140).replace(/\n/g, " | "));
        t.check(/sold/i.test(dropdown), "and says it sold");
        await sellerBrowser.shot("1-bell");

        await sellerBrowser.page.getByRole("link", { name: /see all/i }).click();
        await sellerBrowser.page.waitForURL(/\/account\/notifications/, { timeout: 20000 });
        await sellerBrowser.page.waitForTimeout(2000);
        const listPage = await sellerBrowser.page.locator("main").innerText();
        t.check(listPage.includes(listing.title), "the full list shows it too");
        t.check(/nothing promotional/i.test(listPage),
          "and says plainly that nothing promotional lands here");
        t.check(await brokenImages(sellerBrowser.page) === 0, "no broken images");
        await sellerBrowser.shot("2-list");

        await sellerBrowser.page.getByRole("button", { name: /mark all read/i }).first().click();
        await sellerBrowser.page.waitForTimeout(2000);
        t.check(await sellerBrowser.page.locator('button[aria-label*="unread"]').count() === 0,
          "marking all read clears the badge");

        t.check(sellerBrowser.jsErrors.length === 0, "no JS errors for the seller",
          sellerBrowser.jsErrors.slice(0, 2).join(" | "));
      } finally {
        await sellerBrowser.close();
      }

      /* ============================================================ */
      t.section("reporting is findable but understated");
      await h.page.goto(`${WEB}/listing/${listing.slug}`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(2000);

      const reportLink = h.page.getByRole("button", { name: /report this listing/i });
      t.check(await reportLink.count() === 1, "there is a report link on the listing");
      await reportLink.click();
      await h.page.waitForTimeout(700);
      t.check(await h.page.locator(`#reason-${listing.id}`).isVisible(),
        "opening it shows a reason picker");

      await h.page.selectOption(`#reason-${listing.id}`, "MISLEADING_DESCRIPTION");
      await h.page.fill(`#detail-${listing.id}`, "The photo shows a different kettle.");
      await h.page.getByRole("button", { name: /send report/i }).click();
      await h.page.waitForTimeout(2500);
      t.check(/reported/i.test(await h.page.locator("main").innerText()),
        "sending it is acknowledged");
      await h.shot("3-reported");

      const filed = await prisma.report.count({ where: { targetId: listing.id, status: "OPEN" } });
      t.check(filed === 1, "and the report reached the database", filed);

      /* ============================================================ *
       * The step-up. Being an admin is not enough.
       * ============================================================ */
      t.section("admin sign-in");

      await prisma.user.update({ where: { email: adminEmail }, data: { role: "ADMIN" } });

      const adminBrowser = await openBrowser("admin-panel");
      try {
        adminBrowser.phase("pre-login");
        await login(adminBrowser.page, adminEmail);
        adminBrowser.phase("admin");

        await adminBrowser.page.goto(`${WEB}/admin`, { waitUntil: "networkidle" });
        await adminBrowser.page.waitForTimeout(2500);
        const setup = await adminBrowser.page.locator("main").innerText();
        t.check(/two-factor/i.test(setup),
          "an admin without 2FA is asked to set it up, not let in",
          setup.slice(0, 120).replace(/\n/g, " | "));
        t.check(/not SMS|sim|phone number/i.test(setup),
          "and told why it isn't SMS");
        await adminBrowser.shot("4-totp-setup");

        await adminBrowser.page.fill("#setup-password", PASSWORD);
        await adminBrowser.page.getByRole("button", { name: /^continue$/i }).click();
        await adminBrowser.page.waitForTimeout(2500);

        const qr = adminBrowser.page.locator('img[alt*="QR code"]');
        t.check(await qr.count() === 1, "a QR code is shown");
        const secret = await prisma.user
          .findUniqueOrThrow({ where: { email: adminEmail }, select: { totpSecret: true } })
          .then((u) => u.totpSecret!);
        t.check(!!secret, "and a secret was stored");
        await adminBrowser.shot("5-qr");

        await adminBrowser.page.fill("#setup-code", currentCode(secret));
        await adminBrowser.page.getByRole("button", { name: /^confirm$/i }).click();
        await adminBrowser.page.waitForTimeout(2500);

        const stepUp = await adminBrowser.page.locator("main").innerText();
        t.check(/admin sign-in/i.test(stepUp),
          "after enrolling, they still have to sign in to the panel",
          stepUp.slice(0, 120).replace(/\n/g, " | "));
        t.check(/isn['’]t enough/i.test(stepUp),
          "with the page saying being signed in isn't enough");

        // Codes are single-use, so the one that finished setup is spent. The
        // page has to say so, or the next screen refuses the digits the
        // authenticator app is visibly still displaying.
        t.check(/wait for the next one/i.test(stepUp),
          "and warning that the code just used to enrol is spent",
          stepUp.slice(0, 200).replace(/\n/g, " | "));

        // Password alone must not open it.
        await adminBrowser.page.fill("#admin-password", PASSWORD);
        await adminBrowser.page.fill("#admin-code", "000000");
        await adminBrowser.page.getByRole("button", { name: /open the admin panel/i }).click();
        await adminBrowser.page.waitForTimeout(2500);
        t.check(/that didn't work/i.test(await adminBrowser.page.locator("main").innerText()),
          "the right password with a wrong code is refused");

        await adminBrowser.page.fill("#admin-password", PASSWORD);
        await adminBrowser.page.fill("#admin-code", await freshCode(secret));
        await adminBrowser.page.getByRole("button", { name: /open the admin panel/i }).click();
        await adminBrowser.page.waitForTimeout(3000);

        const panel = await adminBrowser.page.locator("main").innerText();
        t.check(/open reports/i.test(panel), "both together open the panel",
          panel.slice(0, 160).replace(/\n/g, " | "));
        t.check(/thirty minutes/i.test(panel), "which says how long the session lasts");
        await adminBrowser.shot("6-panel");

        /* ---- the queue ---- */
        await adminBrowser.page.getByRole("link", { name: /^reports/i }).first().click();
        await adminBrowser.page.waitForURL(/\/admin\/reports/, { timeout: 20000 });
        await adminBrowser.page.waitForTimeout(2500);
        const queue = await adminBrowser.page.locator("main").innerText();
        t.check(queue.includes(listing.title), "the report is in the queue");
        t.check(/misleading/i.test(queue), "with a readable reason");
        t.check(/different kettle/i.test(queue), "and the reporter's words");
        t.check(!queue.includes("@retailstore-2n.test"),
          "but not the reporter's email address");
        await adminBrowser.shot("7-queue");

        /* ---- acting requires a reason ---- */
        const removeBtn = adminBrowser.page.getByRole("button", { name: /remove listing/i }).first();
        t.check(await removeBtn.isDisabled(), "the remove button is disabled without a reason");

        await adminBrowser.page.locator('textarea[id^="reason-"]').first()
          .fill("Photo doesn't match the item described.");
        await adminBrowser.page.waitForTimeout(400);
        t.check(!(await removeBtn.isDisabled()), "and enabled once a reason is written");

        await removeBtn.click();
        await adminBrowser.page.waitForTimeout(3000);

        const removed = await prisma.listing.findUniqueOrThrow({
          where: { id: listing.id },
          select: { deletedAt: true, status: true },
        });
        t.check(removed.deletedAt !== null && removed.status === "REMOVED",
          "the listing is soft-deleted", `${removed.status}`);
        const closed = await prisma.report.findFirstOrThrow({
          where: { targetId: listing.id },
          select: { status: true },
        });
        t.check(closed.status === "RESOLVED",
          "and the report is closed in the same step, not left for the next moderator",
          closed.status);

        /* ---- the audit log ---- */
        await adminBrowser.page.goto(`${WEB}/admin/audit`, { waitUntil: "networkidle" });
        await adminBrowser.page.waitForTimeout(2500);
        const audit = await adminBrowser.page.locator("main").innerText();
        t.check(/removed listing/i.test(audit), "the action is in the audit log");
        t.check(/photo doesn't match/i.test(audit), "with the reason given");
        t.check(audit.includes("Test admin"), "and who did it");
        t.check(/append-only/i.test(audit), "and the page says it cannot be edited");
        await adminBrowser.shot("8-audit");

        /* ---- ending the session shuts the door ---- */
        await adminBrowser.page.goto(`${WEB}/admin`, { waitUntil: "networkidle" });
        await adminBrowser.page.waitForTimeout(2000);
        await adminBrowser.page.getByRole("button", { name: /end admin session/i }).click();
        await adminBrowser.page.waitForTimeout(2000);
        await adminBrowser.page.goto(`${WEB}/admin/reports`, { waitUntil: "networkidle" });
        await adminBrowser.page.waitForTimeout(2500);
        /**
         * This used to assert the words "Admin sign-in needed" — an interstitial
         * that then linked to the sign-in form. The shared gate now renders the
         * form itself, which is one step rather than two.
         *
         * So the assertion checks the property instead of the wording: the
         * queue's contents must be gone, AND the password and code must be
         * asked for again. That is a stricter test of "locked" than any single
         * heading string was.
         */
        const afterEnd = await adminBrowser.page.locator("main").innerText();
        t.check(!/reported by/i.test(afterEnd),
          "ending the session locks the panel again",
          afterEnd.slice(0, 120).replace(/\n/g, " | "));
        t.check(
          (await adminBrowser.page.locator("#admin-password").isVisible()) &&
            (await adminBrowser.page.locator("#admin-code").isVisible()),
          "and both factors are demanded again, not merely a link to do so");

        t.check(adminBrowser.jsErrors.length === 0, "no JS errors in the panel",
          adminBrowser.jsErrors.slice(0, 2).join(" | "));
      } finally {
        await adminBrowser.close();
      }

      const failures = realFailures(h.badResponses);
      t.check(failures.length === 0, "no failed requests for the ordinary user",
        failures.slice(0, 4).join(" | "));
      t.check(h.jsErrors.length === 0, "no JS errors for the ordinary user",
        h.jsErrors.slice(0, 2).join(" | "));
    } finally {
      await h.close();
    }
  },
  async (t) => {
    await scope.cleanup();
    await scope.verifyClean(t);
  }
);
