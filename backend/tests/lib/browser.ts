import fs from "fs";
import path from "path";
import { chromium, type Browser, type Page } from "playwright";
import { PASSWORD } from "./fixtures";
import { WEB } from "./db";

/**
 * Browser helpers.
 *
 * These suites exist because assertions on the API kept passing while the page
 * was visibly wrong: a duplicated error message, a "Verified purchase" badge on
 * a review nobody paid for, a stretched card leaving dead space. Text checks
 * caught none of those. Looking did.
 */

export const SHOTS = path.join(import.meta.dirname, "..", "screenshots");

export type Harness = {
  browser: Browser;
  page: Page;
  /** Uncaught page errors. Asserted at the end of every browser suite. */
  jsErrors: string[];
  /** Non-2xx responses, tagged with the phase they happened in. */
  badResponses: string[];
  /** Set before each step so a failure says when it happened. */
  phase: (name: string) => void;
  shot: (name: string, opts?: { fullPage?: boolean }) => Promise<void>;
  close: () => Promise<void>;
};

export async function openBrowser(
  suite: string,
  viewport = { width: 1400, height: 1100 }
): Promise<Harness> {
  fs.mkdirSync(SHOTS, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport });

  const jsErrors: string[] = [];
  const badResponses: string[] = [];
  let current = "startup";

  page.on("pageerror", (e) => jsErrors.push(e.message));
  page.on("console", (m) => {
    // "Failed to load resource" duplicates what the response listener sees.
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) {
      jsErrors.push(m.text());
    }
  });
  page.on("response", (r) => {
    if (r.status() >= 400) {
      badResponses.push(
        `[${current}] ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`
      );
    }
  });

  return {
    browser,
    page,
    jsErrors,
    badResponses,
    phase: (name: string) => {
      current = name;
    },
    shot: async (name, opts = {}) => {
      await page.screenshot({
        path: path.join(SHOTS, `${suite}-${name}.png`),
        fullPage: opts.fullPage ?? false,
        ...(opts.fullPage ? {} : { clip: { x: 0, y: 0, ...viewport } }),
      });
    },
    close: () => browser.close(),
  };
}

/**
 * Fills a React-controlled input and confirms the value survived.
 *
 * Filling before hydration finishes gets silently reverted on the first render,
 * which cost a debugging round trip: the password stuck, the email did not, and
 * the form just sat there saying "please fill out this field".
 */
export async function fillReliably(page: Page, selector: string, value: string, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    await page.fill(selector, value);
    await page.waitForTimeout(400);
    if ((await page.inputValue(selector)) === value) return;
  }
  throw new Error(`could not fill ${selector} — the value keeps resetting`);
}

/** Signs in through the real form, not by injecting cookies. */
export async function login(page: Page, email: string) {
  await page.goto(`${WEB}/login`, { waitUntil: "networkidle" });
  await fillReliably(page, 'input[type="email"]', email);
  await fillReliably(page, 'input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
  await page.waitForTimeout(1500);
}

/**
 * Counts images that failed to load.
 *
 * Asserting the <img> element exists is not the same as asserting it rendered.
 * A suite once reported 20/20 green while every photo on the page was broken,
 * because it checked for the element and not for `naturalWidth`.
 */
export async function brokenImages(page: Page, within = "main") {
  return page.evaluate(
    (sel) =>
      [...document.querySelectorAll(`${sel} img`)].filter(
        (i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth === 0
      ).length,
    within
  );
}

/** The little count on a nav icon, or "" when there isn't one. */
export async function navBadge(page: Page, href: "/cart" | "/wishlist") {
  const badge = page.locator(`a[href="${href}"] span`);
  if ((await badge.count()) === 0) return "";
  return (await badge.first().innerText()).trim();
}

/**
 * Clicks a star in a rating picker.
 *
 * The inputs are `sr-only` so they can still take keyboard focus, which means
 * Playwright rightly refuses to click them directly. A person clicks the label.
 */
export async function pickStars(page: Page, rating: number) {
  await page.locator(`label:has(input[name="rating"][value="${rating}"])`).click();
  await page.waitForTimeout(300);
}

/**
 * Splits real failures from the ones a suite deliberately provokes.
 *
 * Two kinds are expected:
 *   [pre-login]  the auth context asking "am I signed in?" and being told no,
 *                which is a 401 by design
 *   [expected…]  a suite testing a refusal on purpose — a checkout with no
 *                address, say, which must 400
 *
 * A 5xx is never excused, whatever phase it happened in: those are bugs even
 * when a test was expecting a rejection.
 */
export function realFailures(badResponses: string[]) {
  return badResponses.filter((r) => {
    if (/ 5\d\d /.test(r)) return true;
    return !r.startsWith("[pre-login]") && !r.startsWith("[expected");
  });
}
