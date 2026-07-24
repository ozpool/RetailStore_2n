import { Client, api, catalog, web } from "./api";
import { prisma } from "./db";
import type { Suite } from "./harness";

/**
 * Test accounts and listings, with cleanup that cannot forget.
 *
 * THE MISTAKE THIS EXISTS TO PREVENT
 * Every suite used to do its own teardown and its own "is the database clean?"
 * check, and those checks were written GLOBALLY: "are any listings SOLD?", "are
 * there any orders?". That reports the site owner's real purchase as leftover
 * test data. I wrote that bug four separate times, chased a phantom leak twice,
 * and once reset a seeded quantity-3 listing to 1 while "tidying up".
 *
 * So a Scope tracks exactly what it touched, restores exactly that, and its
 * verification is scoped by construction. There is no global variant to reach
 * for, because the global variant is the bug.
 */

export const PASSWORD = "correct horse battery staple 9";

/** Every test buyer gets one of these, because checkout requires an address. */
export const DEFAULT_ADDRESS = {
  fullName: "Test Buyer",
  line1: "12 Kiln Lane",
  line2: "Flat 3",
  city: "Bristol",
  region: "Avon",
  postcode: "BS1 4TR",
  country: "GB",
  phone: "+44 7700 900123",
} as const;

/** Reserved so cleanup can never match a real account. */
const PREFIX = "rs2.";
const DOMAIN = "@retailstore-2n.test";

type ListingSnapshot = { title: string; status: string; quantity: number };

/**
 * While email verification is switched off, signup also signs the account in.
 * The fixtures log in explicitly afterwards, so the signup session is dropped
 * to keep one live session per account — suites such as `refresh` count them.
 * With verification on, signup issues no session and this deletes nothing.
 */
async function dropSignupSession(email: string) {
  await prisma.refreshToken.deleteMany({ where: { user: { email } } });
}

export class Scope {
  private readonly emails = new Set<string>();
  private readonly listings = new Map<string, ListingSnapshot>();
  private readonly tag: string;

  constructor(tag: string) {
    // Included in every email so a leftover row says which suite made it.
    this.tag = tag.replace(/[^a-z0-9]/gi, "").slice(0, 12).toLowerCase();
  }

  /* ------------------------------------------------------------ *
   * Accounts
   * ------------------------------------------------------------ */

  /**
   * A signed-in buyer.
   *
   * Email verification is flipped directly rather than by following a link.
   *
   * Not because it cannot be done — the mailer really sends now — but because
   * tying 619 assertions to an SMTP round trip and an inbox poll would make the
   * suite slower and flakier for no coverage gain. The verification flow has
   * its own tests that exercise the token path properly.
   */
  async buyer(name = "one"): Promise<Client> {
    const email = `${PREFIX}${this.tag}.${name}${DOMAIN}`;
    this.emails.add(email);

    await prisma.user.deleteMany({ where: { email } });
    const client = web();
    await client.post("/api/auth/signup", {
      name: `Test ${name}`,
      email,
      password: PASSWORD,
    });
    await dropSignupSession(email);
    await prisma.user.update({ where: { email }, data: { emailVerified: true } });

    const login = await client.post("/api/auth/login", { email, password: PASSWORD });
    if (login.status !== 200) {
      throw new Error(`could not log in ${email}: ${login.status} ${login.text.slice(0, 120)}`);
    }

    // Checkout needs a delivery address, so every test buyer gets one. Suites
    // that care about the address itself create their own and override it.
    await client.post("/api/addresses", DEFAULT_ADDRESS);
    return client;
  }

  /**
   * A signed-in buyer talking straight to the Express API, not the BFF.
   *
   * For the payment-safety suite, which fires several pay requests at once to
   * prove the claim serialises them. Going through the Next proxy puts a hop
   * in front of every request, which spreads them out in time and makes the
   * race it is trying to provoke less likely to happen at all — a test that
   * can only pass is not measuring anything.
   *
   * Paths differ from the BFF ones: the API has no /api prefix.
   */
  async apiBuyer(name = "one"): Promise<Client> {
    const email = `${PREFIX}${this.tag}.${name}${DOMAIN}`;
    this.emails.add(email);

    await prisma.user.deleteMany({ where: { email } });
    const client = api();
    await client.post("/auth/signup", {
      name: `Test ${name}`,
      email,
      password: PASSWORD,
    });
    await dropSignupSession(email);
    await prisma.user.update({ where: { email }, data: { emailVerified: true } });

    const login = await client.post("/auth/login", { email, password: PASSWORD });
    if (login.status !== 200) {
      throw new Error(`could not log in ${email}: ${login.status} ${login.text.slice(0, 120)}`);
    }

    await client.post("/addresses", DEFAULT_ADDRESS);
    return client;
  }

  /**
   * Creates and verifies an account without signing in.
   *
   * For browser suites: they log in through the real form, so an API session
   * here would be a second, unrelated one.
   */
  async register(
    name = "one",
    opts: { seller?: boolean; withAddress?: boolean } = {}
  ): Promise<string> {
    const email = `${PREFIX}${this.tag}.${name}${DOMAIN}`;
    this.emails.add(email);

    await prisma.user.deleteMany({ where: { email } });
    const client = web();
    await client.post("/api/auth/signup", { name: `Test ${name}`, email, password: PASSWORD });
    await dropSignupSession(email);
    await prisma.user.update({
      where: { email },
      data: { emailVerified: true, ...(opts.seller ? { isSeller: true } : {}) },
    });

    // A throwaway session for the setup that has to go through the API.
    const setup = web();
    await setup.post("/api/auth/login", { email, password: PASSWORD });

    if (opts.seller) {
      // become-seller creates the SellerProfile, which the isSeller flag alone
      // does not — several seller endpoints 404 without it.
      await setup.post("/api/auth/become-seller");
    }

    /**
     * Checkout requires an address, so give every account one by default.
     * Suites testing the no-address path pass `withAddress: false` — which is
     * the only reason this is a flag rather than unconditional.
     */
    if (opts.withAddress !== false) {
      await setup.post("/api/addresses", DEFAULT_ADDRESS);
    }
    return email;
  }

  /** A buyer who is also a seller, with a SellerProfile. */
  async seller(name = "seller"): Promise<Client> {
    const client = await this.buyer(name);
    const became = await client.post("/api/auth/become-seller");
    if (became.status !== 200) {
      throw new Error(`could not become a seller: ${became.status} ${became.text.slice(0, 120)}`);
    }
    return client;
  }

  /**
   * A seller this scope controls, plus a listing they own.
   *
   * WHY THIS EXISTS
   * claimListing() borrows a listing from the seeded catalogue, which belongs to
   * a seed seller nobody can log in as. Suites needing the SELLER side of a sale
   * therefore reached for the library directly — `import { markUnfulfillable }`
   * — and that quietly runs the code in the TEST process rather than the
   * server's.
   *
   * Which works, until the two processes disagree. Against a containerised API
   * it broke completely: the stub payment provider keeps intents in an
   * in-process Map, so a payment taken over HTTP lives in the server's memory
   * and a refund issued in-process looks for it in an empty one. Every refund
   * came back "could not confirm with the provider".
   *
   * Owning the listing means the seller can be logged in and driven through the
   * API like any other user, which is what the test should have been doing.
   */
  async ownListing(
    name = "owner",
    opts: { priceCents?: number; quantity?: number; title?: string } = {}
  ) {
    const seller = await this.seller(name);

    const profile = await prisma.sellerProfile.findFirstOrThrow({
      where: { user: { email: this.emailFor(name) } },
      select: { id: true },
    });
    const category = await prisma.category.findFirstOrThrow({ select: { id: true } });

    const listing = await prisma.listing.create({
      data: {
        // Timestamped: a suite may want several, and re-running must not
        // collide on the unique slug.
        slug: `${PREFIX}${this.tag}-${name}-${Date.now()}`,
        title: opts.title ?? "Test listing",
        description: "Created by a test so the seller side can be driven properly.",
        sellerId: profile.id,
        categoryId: category.id,
        condition: "GOOD",
        priceCents: opts.priceCents ?? 4200,
        quantity: opts.quantity ?? 1,
        status: "ACTIVE",
        images: {
          create: {
            url: "https://images.unsplash.com/photo-1465385076216-9288f6f0584b",
            position: 0,
          },
        },
      },
      select: { id: true, slug: true, title: true, priceCents: true, quantity: true },
    });

    // Tracked so cleanup restores it. Deleting the seller cascades the listing,
    // but tracking keeps verifyClean honest either way.
    this.listings.set(listing.id, {
      title: listing.title,
      status: "ACTIVE",
      quantity: listing.quantity,
    });

    return { seller, listing };
  }

  /** The email this scope gave a named account, for direct DB assertions. */
  /**
   * Registers an account this scope created by some other route.
   *
   * Needed when a suite signs somebody up through the real endpoint rather than
   * a fixture — testing the signup path itself, for instance. Without it the
   * account is invisible to cleanup and survives the run, and verifyClean would
   * not notice because it only looks at what the scope knows about.
   */
  track(email: string) {
    this.emails.add(email);
  }

  emailFor(name: string) {
    return `${PREFIX}${this.tag}.${name}${DOMAIN}`;
  }

  /* ------------------------------------------------------------ *
   * Listings
   * ------------------------------------------------------------ */

  /**
   * Claims a catalog listing for this suite, remembering its exact stock.
   *
   * Restoring a flat `quantity: 1` is wrong and silently corrupted a seeded
   * set-of-three once. The snapshot is taken before anything touches it.
   */
  async claimListing(opts: { minQuantity?: number; exactQuantity?: number } = {}) {
    const min = opts.minQuantity ?? 1;
    /**
     * `exactQuantity` exists because "at least one" is not the same requirement
     * as "exactly one", and an assertion about a listing selling OUT needs the
     * second. The seeded catalogue used to be entirely quantity-1, so
     * `minQuantity: 1` happened to give a single-stock listing every time;
     * `seed:scale` makes 15% of them quantity 2-4, at which point that
     * assumption fails roughly one run in six.
     */
    const page = await catalog<{ listings: any[] }>("/catalog/listings?limit=40");

    const wanted = (l: any) =>
      opts.exactQuantity !== undefined ? l.quantity === opts.exactQuantity : l.quantity >= min;

    const found = page.listings.find((l) => !this.listings.has(l.id) && wanted(l));
    if (!found) {
      throw new Error(
        opts.exactQuantity !== undefined
          ? `no unclaimed active listing with quantity === ${opts.exactQuantity}`
          : `no unclaimed active listing with quantity >= ${min}`
      );
    }

    const row = await prisma.listing.findUniqueOrThrow({
      where: { id: found.id },
      select: { title: true, status: true, quantity: true },
    });
    this.listings.set(found.id, row);

    return { ...found, stockBefore: row.quantity, statusBefore: row.status };
  }

  /** Tracks a listing this suite did not claim through the catalog. */
  async trackListing(listingId: string) {
    if (this.listings.has(listingId)) return;
    const row = await prisma.listing.findUnique({
      where: { id: listingId },
      select: { title: true, status: true, quantity: true },
    });
    if (row) this.listings.set(listingId, row);
  }

  /* ------------------------------------------------------------ *
   * Teardown
   * ------------------------------------------------------------ */

  /**
   * Deletes this scope's accounts and restores its listings.
   *
   * Deleting the users cascades their orders, reservations, wishlist entries,
   * reviews, and seller profiles — so nothing else needs enumerating.
   */
  async cleanup() {
    const emails = [...this.emails];
    if (emails.length) {
      await prisma.user.deleteMany({ where: { email: { in: emails } } });

      /**
       * The login counter outlives the account, so it has to be cleared here.
       *
       * `login:{email}` is keyed on the ADDRESS, not the user id — deliberately,
       * because deleting an account must not hand an attacker a fresh
       * allowance. The consequence for tests is that a suite which exhausts the
       * limit for one of its addresses poisons that address for fifteen
       * minutes, and every scope email is deterministic (`rs2.<tag>.<name>@…`),
       * so the NEXT run of that suite cannot log in and fails during setup with
       * a 429 that looks nothing like the thing it was testing.
       *
       * That is exactly how tests/api/ratelimit.ts broke itself: its login
       * section spent the limit for `subject`, and the following run could not
       * create the account it needed.
       */
      const { clearRateLimit } = await import("../../src/lib/rateLimit");
      await clearRateLimit(...emails.map((e) => `login:${e}`));
    }

    // updateMany, not update: a listing this scope CREATED (ownListing) is
    // cascaded away when its seller is deleted a few lines above, and update()
    // throws on a row that is gone. A borrowed catalogue listing still exists
    // and is restored exactly as before.
    for (const [id, snapshot] of this.listings) {
      await prisma.listing.updateMany({
        where: { id },
        data: { status: snapshot.status as never, quantity: snapshot.quantity },
      });
    }
  }

  /**
   * Confirms the teardown worked — scoped to this suite, and only this suite.
   *
   * Deliberately has no "is the whole database clean?" mode. Real users have
   * real sold listings and real orders; asking globally makes their data look
   * like our mess.
   */
  async verifyClean(t: Suite) {
    const emails = [...this.emails];

    const usersLeft = emails.length
      ? await prisma.user.count({ where: { email: { in: emails } } })
      : 0;
    t.check(usersLeft === 0, "test accounts removed", `${usersLeft} left`);

    const notRestored: string[] = [];
    for (const [id, snapshot] of this.listings) {
      const row = await prisma.listing.findUnique({
        where: { id },
        select: { title: true, status: true, quantity: true },
      });
      if (!row) continue;
      if (row.status !== snapshot.status || row.quantity !== snapshot.quantity) {
        notRestored.push(
          `${row.title}: ${row.status} q=${row.quantity}, expected ${snapshot.status} q=${snapshot.quantity}`
        );
      }
    }
    t.check(
      notRestored.length === 0,
      `all ${this.listings.size} touched listing(s) restored`,
      notRestored.join(" | ")
    );

    if (notRestored.length) {
      console.error(
        "\n  WARNING: listings left out of the catalog. The shop is now smaller.\n" +
          "  Re-run this suite, or reseed with: npx prisma db seed\n"
      );
    }
  }
}

/**
 * Waits for notifications to actually land.
 *
 * WHY THIS IS NEEDED, AND WHY IT IS NOT A BUG IN THE APP
 * notify() is deliberately fire-and-forget: a notification failure must never
 * fail the sale, refund, or moderation action that raised it. The consequence
 * is that the rows commit shortly AFTER the call returns.
 *
 * A test that reads the inbox on the next line is therefore racing, and it is a
 * race that usually passes — which is worse than one that never does. It has
 * bitten three separate suites now, each time reported as a wording bug in a
 * message that was perfectly correct.
 *
 * Polls until every expected type is present, then returns the inbox. Times out
 * and returns whatever arrived, so the caller's assertion produces a readable
 * failure rather than a hang.
 */
/** Same, for a user known by id rather than by address. */
export async function awaitNotificationsForUser(
  userId: string,
  types: string[],
  timeoutMs = 5000
): Promise<Array<{ type: string; title: string; body: string | null }>> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const rows = await prisma.notification.findMany({
      where: { userId },
      select: { type: true, title: true, body: true },
      orderBy: { createdAt: "desc" },
    });
    const present = new Set(rows.map((r) => r.type));
    if (types.every((t) => present.has(t as never))) return rows;
    if (Date.now() >= deadline) return rows;
    await new Promise((r) => setTimeout(r, 150));
  }
}

export async function awaitNotifications(
  email: string,
  types: string[],
  timeoutMs = 5000
): Promise<Array<{ type: string; title: string; body: string | null }>> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const rows = await prisma.notification.findMany({
      where: { user: { email } },
      select: { type: true, title: true, body: true },
      orderBy: { createdAt: "desc" },
    });
    const present = new Set(rows.map((r) => r.type));
    if (types.every((t) => present.has(t as never))) return rows;
    if (Date.now() >= deadline) return rows;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Sweeps up after a crashed run from an earlier session. */
export async function purgeStaleTestData() {
  const { count } = await prisma.user.deleteMany({
    where: { email: { startsWith: PREFIX, endsWith: DOMAIN } },
  });
  return count;
}

/* ------------------------------------------------------------------ *
 * Shopping helpers, used by several suites
 * ------------------------------------------------------------------ */

/** Hold → checkout. Returns the created order. */
export async function checkoutOne(client: Client, listingId: string) {
  const held = await client.post("/api/reservations", { listingId, quantity: 1 });
  if (held.status !== 200 && held.status !== 201) {
    throw new Error(`could not hold ${listingId}: ${held.status} ${held.text.slice(0, 140)}`);
  }
  const created = await client.post("/api/orders");
  if (created.status !== 201) {
    throw new Error(`checkout failed: ${created.status} ${created.text.slice(0, 140)}`);
  }
  return created.json.order;
}

/** Test card numbers, identical across the stub and Stripe test mode. */
export const CARDS = {
  succeeds: "4242424242424242",
  declined: "4000000000000002",
  expired: "4000000000000069",
  needsAuth: "4000002500003155",
} as const;

/** Hold → checkout → pay. Returns the pay response. */
export async function buyOne(client: Client, listingId: string, card = CARDS.succeeds) {
  const order = await checkoutOne(client, listingId);
  const paid = await client.post(`/api/orders/${order.id}/pay`, { cardNumber: card });
  return { order, paid };
}
