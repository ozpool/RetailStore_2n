import { randomUUID } from "crypto";
import { WEB, prisma, requireCatalog, requireServices } from "../lib/db";
import { currentCode, freshCode } from "../lib/totp";
import { buyOne, PASSWORD, Scope } from "../lib/fixtures";
import { brokenImages, login, openBrowser, realFailures } from "../lib/browser";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";

/**
 * The admin dashboard, in a browser.
 *
 * Covers the screens the moderation suite does not: the metrics dashboard,
 * orders, customers, and the catalogue. The step-up and the negative
 * "invisible to everyone else" assertions live in admin-and-notifications.ts
 * and are not repeated here.
 *
 * The assertion this suite exists for is the last one: every number the
 * dashboard prints must be one the database agrees with. A dashboard that is
 * merely well laid out and quietly wrong is worse than no dashboard.
 */

const scope = new Scope("uidash");
wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

void main(
  "admin dashboard (browser)",
  async (t) => {
    await requireServices({ api: true, web: true });
    await requireCatalog();

    const adminEmail = await scope.register("admin", { withAddress: true });
    await prisma.user.update({ where: { email: adminEmail }, data: { role: "ADMIN" } });

    /**
     * At least one paid order has to exist before the dashboard means anything.
     *
     * This suite used to rely on whatever orders happened to be lying in the
     * database. On a developer's machine there are always some; on a fresh CI
     * database there are none, because the seed creates listings and reviews but
     * never buys anything. Every suite that does buy something also cleans up
     * after itself.
     *
     * With zero orders the Pagination component renders NOTHING — it returns
     * null rather than "0–0 of 0" — so the wait for the row counter timed out
     * after twenty seconds and took the suite down with it. The tell was one
     * line earlier: "gross sales reads $0, which is what the database holds".
     *
     * Buying here makes the run deterministic and the assertions worth making:
     * the dashboard is checked against a figure that is not zero.
     */
    const buyer = await scope.buyer("buyer");
    const listing = await scope.claimListing();
    const { paid } = await buyOne(buyer, listing.id);
    t.check(paid.json.outcome === "succeeded",
      "a paid order exists for the dashboard to report on", paid.json?.outcome);

    const h = await openBrowser("dashboard");
    try {
      h.phase("pre-login");
      await login(h.page, adminEmail);

      /**
       * Enrolment and step-up 401 on purpose.
       *
       * The gate asks "is an admin session live?" before showing anything, and
       * the answer here is no — that 401 is the mechanism working, not a fault.
       * The phase is named so realFailures() excuses it. Everything AFTER the
       * step-up runs under a plain phase name, so a 401 there still fails.
       */
      h.phase("expected: no admin session until step-up");

      /* ---- enrol, then step up ---- */
      await h.page.goto(`${WEB}/admin`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(1500);

      await h.page.getByLabel(/confirm your password/i).fill(PASSWORD);
      await h.page.getByRole("button", { name: /continue/i }).click();
      await h.page.waitForTimeout(2000);

      const secret = await prisma.user
        .findUniqueOrThrow({ where: { email: adminEmail }, select: { totpSecret: true } })
        .then((u) => u.totpSecret!);

      await h.page.getByLabel(/six-digit code/i).fill(currentCode(secret));
      await h.page.getByRole("button", { name: /confirm/i }).click();
      await h.page.waitForTimeout(2500);

      // Codes are single-use and the one above is now spent. Signing in needs
      // a genuinely new period, not the same digits the app is still showing.
      await h.page.getByLabel(/^password$/i).fill(PASSWORD);
      await h.page.getByLabel(/authenticator code/i).fill(await freshCode(secret));
      await h.page.getByRole("button", { name: /open the admin panel/i }).click();
      await h.page.waitForTimeout(3000);

      // From here on the panel is open, so nothing should 401.
      h.phase("admin");

      /* ============================================================ */
      t.section("the dashboard");

      await h.shot("1-dashboard");
      const dash = await h.page.locator("body").innerText();

      t.check(/dashboard/i.test(dash), "the dashboard loads");
      t.check(/gross sales/i.test(dash), "gross sales is shown");

      /**
       * No headline number may be CALLED revenue.
       *
       * Checked against the stat labels rather than the whole page, because the
       * page does use the word — in the caption explaining that this is not it.
       * An earlier version of this assertion searched the body text and failed
       * on the very sentence that makes the distinction.
       */
      const statLabels = await h.page.locator("dl dt").allInnerTexts();
      t.check(!statLabels.some((l) => /revenue/i.test(l)),
        "no stat is labelled revenue — RetailStore_2n keeps none of it",
        statLabels.join(" / "));

      t.check(/takes no cut/i.test(dash),
        "and the page says why that distinction is made");

      /* ---- the sidebar ---- */
      for (const label of [
        "Dashboard",
        "Orders",
        "Customers",
        "Catalogue",
        "Reports",
        "Delivery log",
        "Audit log",
      ]) {
        t.check(
          await h.page.getByRole("link", { name: label, exact: true }).first().isVisible(),
          `the sidebar has ${label}`
        );
      }

      t.check(!(await h.page.locator("footer").first().isVisible().catch(() => false)),
        "the storefront footer is not on the dashboard");

      /* ---- the session clock ---- */
      const clock = await h.page.locator("header span[title*='admin session']").innerText();
      t.check(/^\d+:\d{2}$/.test(clock.trim()), "a session countdown is shown", clock);
      const mins = Number(clock.trim().split(":")[0]);
      t.check(mins <= 30 && mins >= 25,
        "starting near thirty minutes, not an invented number", clock);

      /* ============================================================ */
      t.section("the numbers match the database");

      // Everything below compares what the page prints against a fresh query.
      const paidOrders = await prisma.order.count({ where: { status: "PAID" } });
      const gross = await prisma.order.aggregate({
        where: { status: "PAID", paidAt: { gte: since(30) } },
        _sum: { subtotalCents: true },
      });
      const grossCents = gross._sum.subtotalCents ?? 0;

      const shown = dash.replace(/,/g, "");
      const expected = `$${(grossCents / 100).toFixed(grossCents % 100 === 0 ? 0 : 2)}`;
      t.check(shown.includes(expected),
        `gross sales reads ${expected}, which is what the database holds`,
        dash.match(/Gross sales[\s\S]{0,40}/)?.[0]?.replace(/\n/g, " | "));

      /* ============================================================ */
      t.section("orders");

      await h.page.getByRole("link", { name: "Orders", exact: true }).first().click();
      // Wait for the count to appear rather than for a fixed number of seconds.
      // A dev server that takes three seconds to compile the route would
      // otherwise fail this on "Loading…", which is not a bug in the page.
      await h.page.getByText(/\d+[–-]\d+ of [\d,]+/).first().waitFor({ timeout: 20_000 });
      await h.shot("2-orders");

      const ordersText = await h.page.locator("main").innerText();
      const totalOrders = await prisma.order.count();
      t.check(new RegExp(`of ${totalOrders}\\b`).test(ordersText.replace(/,/g, "")),
        `the list says "of ${totalOrders}", matching the database`,
        ordersText.match(/\d+[–-]\d+ of [\d,]+/)?.[0]);

      /* ---- filtering ---- */
      await h.page.getByRole("button", { name: "Paid", exact: true }).click();
      await h.page.waitForTimeout(2000);
      const paidText = await h.page.locator("main").innerText();
      t.check(
        paidOrders === 0
          ? /no orders match/i.test(paidText)
          : new RegExp(`of ${paidOrders}\\b`).test(paidText.replace(/,/g, "")),
        `filtering to Paid gives ${paidOrders}`,
        paidText.match(/\d+[–-]\d+ of [\d,]+/)?.[0] ?? paidText.slice(0, 80)
      );

      /* ---- a search that cannot match ---- */
      await h.page.getByRole("button", { name: "All", exact: true }).click();
      await h.page.waitForTimeout(1200);
      await h.page.getByPlaceholder(/reference, name, or email/i).fill("zzzz-no-such-order");
      await h.page.waitForTimeout(2000);
      t.check(/no orders match/i.test(await h.page.locator("main").innerText()),
        "a search with no matches says so rather than showing everything");

      /* ---- order detail ---- */
      const anyOrder = await prisma.order.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true, reference: true } });
      if (anyOrder) {
        await h.page.goto(`${WEB}/admin/orders/${anyOrder.id}`, { waitUntil: "networkidle" });
        await h.page.waitForTimeout(2500);
        await h.shot("3-order-detail");
        const detail = await h.page.locator("main").innerText();
        t.check(detail.includes(anyOrder.reference), "the order detail opens", anyOrder.reference);
        t.check(/no card details are stored/i.test(detail),
          "and says plainly that no card data is held here");
      }

      /* ============================================================ */
      t.section("customers");

      await h.page.goto(`${WEB}/admin/customers`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(2500);
      await h.shot("4-customers");

      const custText = await h.page.locator("main").innerText();
      const totalUsers = await prisma.user.count();
      t.check(new RegExp(`of ${totalUsers}\\b`).test(custText.replace(/,/g, "")),
        `the list says "of ${totalUsers}", matching the database`,
        custText.match(/\d+[–-]\d+ of [\d,]+/)?.[0]);

      await h.page.getByRole("button", { name: "Sellers", exact: true }).click();
      await h.page.waitForTimeout(2000);
      const sellerCount = await prisma.user.count({ where: { isSeller: true } });
      t.check(new RegExp(`of ${sellerCount}\\b`).test(
        (await h.page.locator("main").innerText()).replace(/,/g, "")),
        `filtering to Sellers gives ${sellerCount}`);

      /* ---- an admin cannot be suspended from the panel ---- */
      const adminId = await prisma.user
        .findUniqueOrThrow({ where: { email: adminEmail }, select: { id: true } })
        .then((u) => u.id);
      await h.page.goto(`${WEB}/admin/customers/${adminId}`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(2500);
      await h.shot("5-customer-detail");

      const self = await h.page.locator("main").innerText();
      t.check(/admins can't be suspended/i.test(self),
        "an admin's page offers no suspend button",
        self.match(/.{0,60}suspend.{0,60}/i)?.[0]?.replace(/\n/g, " | "));
      t.check(/admin:revoke/.test(self),
        "and points at the CLI, which needs shell access rather than this panel");

      /* ---- a normal account does offer it, but not without a reason ---- */
      const ordinary = await prisma.user.findFirstOrThrow({
        where: { role: "USER", suspendedAt: null },
        select: { id: true },
      });
      await h.page.goto(`${WEB}/admin/customers/${ordinary.id}`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(2500);

      const suspendBtn = h.page.getByRole("button", { name: /suspend this account/i });
      t.check(await suspendBtn.isDisabled(), "the suspend button is disabled with no reason written");
      await h.page.getByLabel(/reason/i).fill("Checking the button enables.");
      await h.page.waitForTimeout(400);
      t.check(!(await suspendBtn.isDisabled()), "and enabled once a reason is given");

      /* ============================================================ */
      t.section("catalogue");

      await h.page.goto(`${WEB}/admin/catalogue`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(3000);
      await h.shot("6-catalogue");

      const catText = await h.page.locator("main").innerText();
      const totalListings = await prisma.listing.count();
      t.check(new RegExp(`of ${totalListings}\\b`).test(catText.replace(/,/g, "")),
        `the catalogue says "of ${totalListings}", matching the database`,
        catText.match(/\d+[–-]\d+ of [\d,]+/)?.[0]);

      // Returns a COUNT, not a list.
      const broken = await brokenImages(h.page);
      t.check(broken === 0, "every thumbnail loads", `${broken} broken`);

      /* ---- the remove dialog demands a reason ---- */
      // Scoped to the table AND exact. Unscoped, "Remove" also matches the
      // "Removed" filter tab — which clicked the filter, emptied the list, and
      // reported it as the dialog failing to open.
      await h.page
        .locator("table")
        .getByRole("button", { name: "Remove", exact: true })
        .first()
        .click();
      await h.page.waitForTimeout(900);
      await h.shot("7-remove-dialog");

      const dialog = h.page.getByRole("dialog");
      t.check(await dialog.isVisible(), "removing opens a dialog rather than acting on one click");
      const confirm = dialog.getByRole("button", { name: "Remove", exact: true });
      t.check(await confirm.isDisabled(), "which cannot be confirmed without a reason");
      t.check(/the seller sees this/i.test(await dialog.innerText()),
        "and says the seller will see what is written");

      await dialog.getByRole("button", { name: /cancel/i }).click();
      await h.page.waitForTimeout(700);
      t.check(!(await dialog.isVisible().catch(() => false)), "cancel closes it changing nothing");

      /* ============================================================ */
      t.section("delivery log");

      /**
       * The page that exists so "did the buyer get the refund email?" has an
       * answer. A row is written directly rather than by triggering a real
       * notification, because what is under test here is whether a moderator
       * can READ the ledger — the writing of it is covered, at length, by the
       * email, push, sms and operations suites.
       */
      const ledgerEvent = randomUUID();
      await prisma.notificationDelivery.create({
        data: {
          eventId: ledgerEvent,
          channel: "EMAIL",
          userId: adminId,
          status: "SUPPRESSED",
          suppressReason: "EMAIL is not used for ORDER_DELIVERED",
          completedAt: new Date(),
        },
      });

      await h.page.goto(`${WEB}/admin/deliveries`, { waitUntil: "networkidle" });

      /**
       * Waited for explicitly, because `networkidle` fires before the page's
       * own fetch resolves — the list is client-side. Reading innerText
       * straight after the navigation caught the intro paragraph and no table,
       * which looked exactly like a rendering bug and was not.
       */
      await h.page.locator("table").first().waitFor({ state: "visible", timeout: 15_000 });
      const log = await h.page.locator("main").innerText();

      /**
       * Asserted on the columns rather than the page title: the title is
       * rendered by AdminGate in the header, outside <main>, so matching it
       * here would pass or fail on where the heading lives rather than on
       * whether the table arrived.
       */
      /**
       * Compared case-insensitively, because `Th` applies `uppercase` in CSS
       * and innerText reflects text-transform — so the DOM says "Recipient"
       * and the browser reports "RECIPIENT". A case-sensitive match here
       * failed while the page was rendering perfectly, which is a bad way to
       * spend twenty minutes.
       */
      const columns = log.toUpperCase();
      t.check(
        ["RECIPIENT", "NOTIFICATION", "CHANNEL", "OUTCOME", "WHY"].every((h2) =>
          columns.includes(h2)
        ),
        "the delivery log opens, with the columns a support answer needs",
        log.slice(0, 300)
      );

      /**
       * The distinction the page exists to make. SUPPRESSED is neither a
       * success nor a fault, and a moderator reading this while on the phone
       * should not have to guess which.
       */
      t.check(
        /suppressed is a decision, not a fault/i.test(log),
        "and explains that a suppressed delivery is a choice rather than a failure"
      );

      /* ---- searching by the thing support actually has: an email ---- */
      await h.page.getByPlaceholder(/email, name, or event id/i).fill(adminEmail);
      await h.page.waitForTimeout(900);
      const found = await h.page.locator("main").innerText();

      t.check(
        found.includes(adminEmail),
        "searching by email address finds that person's deliveries"
      );
      t.check(
        /EMAIL/.test(found) && /Suppressed/i.test(found),
        "showing the channel and the outcome",
        found.slice(0, 200)
      );
      /**
       * The reason column is most of the value. "SUPPRESSED" with no reason
       * sends the reader straight back to a database console, which is the
       * thing this page was built to replace.
       */
      t.check(
        /is not used for ORDER_DELIVERED/i.test(found),
        "and the reason, in the words the ledger recorded"
      );

      /* ---- a search that cannot match must say so ---- */
      await h.page.getByPlaceholder(/email, name, or event id/i).fill("nobody@nowhere.invalid");
      await h.page.waitForTimeout(900);
      t.check(
        /nothing matches/i.test(await h.page.locator("main").innerText()),
        "a search with no matches says so rather than showing everything"
      );

      await prisma.notificationDelivery.deleteMany({ where: { eventId: ledgerEvent } });

      /* ============================================================ */
      t.section("nothing broke along the way");

      const failures = realFailures(h.badResponses);
      t.check(failures.length === 0, "no failed requests anywhere in the panel",
        failures.slice(0, 3).join(" | "));
    } finally {
      await h.close();
      await scope.cleanup();
    }

    await scope.verifyClean(t);
  }
);

function since(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - (days - 1));
  d.setHours(0, 0, 0, 0);
  return d;
}
