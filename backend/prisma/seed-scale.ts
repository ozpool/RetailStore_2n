import "dotenv/config";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Condition, ListingStatus, VerificationStatus } from "../src/generated/prisma/enums";

/**
 * Bulk catalog, for load testing.
 *
 * 30 seller accounts × 30 listings = 900 listings, on top of whatever is
 * already there.
 *
 * WHAT THIS DOES AND DOESN'T DEMONSTRATE
 * It does not make Postgres struggle. 900 rows — or 900,000 — is not a load
 * problem; an unindexed query or a few hundred concurrent readers is. What this
 * gives you is a catalog big enough that a load test means something: real
 * pagination, real sort costs, a working set that doesn't fit in a single page
 * of results. The replication argument is made by hammering it and by killing
 * the primary, not by counting rows.
 *
 * ADDITIVE AND REVERSIBLE
 * Deliberately not part of `prisma db seed`, which resets. This only ever adds
 * accounts under a reserved prefix, and `--clean` removes exactly those. Real
 * orders, holds, and wishlists are never touched.
 *
 *   npm run seed:scale           add (idempotent — safe to re-run)
 *   npm run seed:scale -- --clean   remove everything it created
 */

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

/** Reserved so cleanup can never catch a real account. */
const SELLER_PREFIX = "scale.seller";
const REVIEWER_PREFIX = "scale.reviewer";
const DOMAIN = "@retailstore-2n.example";

const SELLERS = 30;
const LISTINGS_PER_SELLER = 30;
const REVIEWERS = 24;

/**
 * Deterministic PRNG (mulberry32), so re-running produces byte-identical data.
 * Math.random would make every run a different catalog, which makes an
 * idempotent upsert meaningless and load results incomparable.
 */
function rng(seed: number) {
  let a = seed;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = rng(20260825);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

function unsplash(id: string, params = "w=1600&q=80&auto=format&fit=crop") {
  return `https://images.unsplash.com/photo-${id}?${params}`;
}

/**
 * 205 Unsplash photo ids, grouped by the category they were searched for.
 *
 * EVERY ONE WAS FETCHED AND CHECKED before being written here: HTTP 200, an
 * image content-type, and a final host of images.unsplash.com. That last check
 * matters — Unsplash+ ids redirect to plus.unsplash.com, which is licensed
 * separately and not ours to ship. 205 candidates were tested and 205 passed.
 *
 * Ids are globally unique across categories, so no photo appears under two
 * headings. With ~130 listings per category and ~29 photos each, a given photo
 * repeats about four times instead of the thirty-odd it did when this list held
 * 28 ids in total.
 *
 * Repetition is the honest cost of generated data. The alternative is inventing
 * ids, and an invented id is a 404.
 */
const PHOTOS: Record<string, string[]> = {
  "furniture-home": [
    "1577176434922-803273eba97a", "1460776960860-7adc30a4e69d", "1544691560-fc2053d97726",
    "1600620195943-eb20d00a556f", "1569424746512-4f98ac866469", "1624347443725-dac2bcc04c82",
    "1715249892549-8dbafc328b18", "1588296401836-21d1fbcafd5b", "1591291608932-8bab6b55204c",
    "1689280730533-4fdacc46e6c4", "1715249891485-4b8e66b584dc", "1560295888-44704dea4ea7",
    "1605665497157-8b40497be469", "1566097127420-26750d93591e", "1648657458755-74ceaf075f18",
    "1598300042247-d088f8ab3a91", "1506439773649-6e0eb8cfb237", "1612372606404-0ab33e7187ee",
    "1581539250439-c96689b516dd", "1650476524564-f94dc9669067", "1487015307662-6ce6210680f1",
    "1640938776314-4d303f8a1380", "1634712282287-14ed57b9cc89", "1699588772787-1eed3b726e0a",
    "1634798245965-03669c757183", "1638285852125-c6ed00ff2065", "1624985113578-3b6af96e5eed",
    "1507878866276-a947ef722fee", "1622880355742-af182a61b362", "1656870916547-9e6a8a17f6e7",
  ],
  "clothing-accessories": [
    "1551028719-00167b16eac5", "1521223890158-f9f7c3d5d504", "1727515546577-f7d82a47b51d",
    "1623854156816-4c4fc355ffc7", "1727524366429-27de8607d5f6", "1602370463198-086436840055",
    "1553640662-9ab20b8fa2ea", "1489286696299-aa7486820bd5", "1511280303142-0051e93baeeb",
    "1559551409-dadc959f76b8", "1592158249887-ac6ae7921691", "1647960514922-052047430407",
    "1578198576866-7e0ba6078128", "1596832772762-78e213deff5f", "1700168077358-692db90c8b7f",
    "1520006403909-838d6b92c22e", "1614990354198-b06764dcb13c", "1647664856968-880b8eccd588",
    "1617331721458-bd3bd3f9c7f8", "1634133118553-1e6e18299886", "1453486030486-0a5ffcd82cd9",
    "1630797160982-553facf1c3cc", "1445205170230-053b83016050", "1666861585341-5bd1e7b1ed71",
    "1634133118060-99de9d0dc039", "1680362667647-c2a8c6994742", "1569909265601-2110fe50a54f",
    "1540221652346-e5dd6b50f3e7", "1600269453043-e8776c7f2595",
  ],
  "music-film-books": [
    "1602848597941-0d3d3a2c1241", "1616714109948-c74fe5029a4d", "1580656449278-e8381933522c",
    "1669801158950-f663cf15298c", "1603048588665-791ca8aea617", "1526394931762-90052e97b376",
    "1582730147924-d92f4da00252", "1596633313465-1256feb1c6d9", "1483412033650-1015ddeb83d1",
    "1619983081563-430f63602796", "1488841714725-bb4c32d1ac94", "1535992165812-68d1861aa71e",
    "1672073314527-cd2d83182992", "1496293455970-f8581aae0e3b", "1588532218970-c2cab983746a",
    "1457369804613-52c61a468e7d", "1550399105-c4db5fb85c18", "1600181982553-ce7d36051c01",
    "1491841573634-28140fc7ced7", "1556566952-11eff3d06ed4", "1529590003495-b2646e2718bf",
    "1521587760476-6c12a4b040da", "1595123550441-d377e017de6a", "1534289855405-ab820a118fc1",
    "1491841651911-c44c30c34548", "1613324766451-2d03b2ea8190", "1550399105-05c4a7641b02",
    "1515325595179-59cd5262ca53", "1625053376622-e462848c453f", "1719563015025-83946fb49e49",
  ],
  "decor-curiosities": [
    "1606241018160-4985a8ab5dec", "1652598631616-3f5f4d2cfbd5", "1633101635884-93a9992960fa",
    "1739483213555-6b94115feab8", "1758380742318-4074cce52ec4", "1739134472894-16f657cb1aff",
    "1739134471861-d56aac3b0e87", "1672939716738-2070a8382a1f", "1620207745017-3e9ef8cd2a1b",
    "1784022163259-543a172ac3ee", "1765000884263-0bf0a2232b5f", "1678705544977-0d0b86a8b5f9",
    "1631125915902-d8abe9225ff2", "1597696929736-6d13bed8e6a8", "1660721671073-e139688fa3cf",
    "1612196808214-b8e1d6145a8c", "1677761640321-b80251be00ca", "1631125915732-b98f8774f675",
    "1643569556871-91ec60671ed7", "1481401908818-600b7a676c0d", "1631125915973-e0d155a14e4e",
    "1526198049595-f32cde2a219d", "1526198330131-9b0bc79625e4", "1631125916276-69bcd14e3980",
    "1687191883721-257d8cad5b54", "1633000116322-d7f5cb7d3ebb", "1705526966290-2de7b8a33f03",
  ],
  "bikes-outdoors": [
    "1523740856324-f2ce89135981", "1578509557315-37510239a203", "1625656006822-0f81e8380331",
    "1570169043013-de63774bbf97", "1592614558340-8095660384f6", "1495570042983-249df576ad3c",
    "1739783267575-d7ed597e84e0", "1588766919876-f2ad05ff92f5", "1663427768578-aa88be42bf56",
    "1631443412966-2a2ab5e18c3b", "1705329353595-d79fa4241cba", "1521218462742-5cc9d586f913",
    "1786882693307-aa8ecf693fe6", "1782851938244-7b632c31bd61", "1502913625325-725506829ddc",
    "1504280390367-361c6d9f38f4", "1576176539998-0237d1ac6a85", "1537905569824-f89f14cceb68",
    "1525811902-f2342640856e", "1532339142463-fd0a8979791a", "1571863533956-01c88e79957e",
    "1625834509314-3b12c6153624", "1508873696983-2dfd5898f08b", "1492648272180-61e45a8d98a7",
    "1624923686627-514dd5e57bae", "1471115853179-bb1d604434e0", "1534880606858-29b0e8a24e8d",
    "1625013964767-0e4b3c041607", "1621519994490-b87b9401599e", "1493244040629-496f6d136cc4",
  ],
  "kitchen-tableware": [
    "1523039031846-6b3f39302cb8", "1715249891396-653a32ff2d39", "1627362139686-2dc7fef67dd1",
    "1466027575040-12134f1397fa", "1760720061928-703533ae9c24", "1673598001134-d8c86ab6f408",
    "1771179231923-3d63f348e5df", "1784466505252-2f55029ad682", "1673598004024-1a8fb802a44e",
    "1775613501006-51dc1c0861c9", "1782758896098-11cf364d6ba3", "1777499455332-ec8800b7c197",
    "1777499455349-724b6605d0af", "1770924673879-781860ce03f1", "1780246031877-9bfe3be0a5b7",
    "1571987530791-58e3e7744d99", "1591632288574-a387f820a1ca", "1633856858940-42229cb53dd3",
    "1551807306-4bcd16b92a41", "1612293905838-667dea27cc79", "1705948731485-6e4c6c180d0d",
    "1605883705077-8d3d3cebe78c", "1614548539644-ef528186523a", "1484632105053-8662f3194e7f",
    "1624819107687-15524ecf555a", "1632996547863-828cf385e4cf", "1670843840695-be4ce9626145",
    "1610300034180-d55d519ca946", "1620818309896-df4306ec95d8", "1534273006427-1686266049b7",
  ],
  electronics: [
    "1510127034890-ba27508e9f1c", "1495121553079-4c61bcce1894", "1516961642265-531546e84af2",
    "1603208234872-619ffa1209cb", "1520549233664-03f65c1d1327", "1595401735913-4ca17c66e755",
    "1516852294404-5423eaa0d4a9", "1452587925148-ce544e77e70d", "1516962126636-27ad087061cc",
    "1601854266103-c1dd42130633", "1524135220673-c731600a1a50", "1528594498426-ea65fdafcbf4",
    "1543785832-0781599790c2", "1481923387198-050ac1a2896e", "1512390225428-a9d51c817f94",
    "1633294666093-ab54f43a947a", "1517408395525-fa05dd0bb2ef", "1623969451926-10c5e52b707a",
    "1584541728894-dbcae08f94ac", "1573154622954-b5fae2c1eed8", "1588523900549-d60e602ced7c",
    "1683189400209-a076d6c375b8", "1593078166039-c9878df5c520", "1564386377355-e6738e1df113",
    "1606422360319-c1512f54d1b9", "1623990670975-d294abcb659b", "1576360956491-858d2702cfbd",
    "1487180144351-b8472da7d491", "1612869544295-eda1013274aa",
  ],
};

/** Titles are assembled rather than listed, because 900 hand-written ones is
 *  not a good use of anyone's time. Kept plausible: no "Product 417". */
const WORDS: Record<string, { adj: string[]; noun: string[]; price: [number, number] }> = {
  "furniture-home": {
    adj: ["Oak", "Teak", "Walnut", "Pine", "Rattan", "Mid-century", "Danish", "Reclaimed", "Painted", "Bentwood"],
    noun: ["dining chair", "side table", "bookcase", "writing desk", "dresser", "footstool", "coffee table", "armchair", "sideboard", "plant stand", "mirror", "bed frame"],
    price: [4500, 48000],
  },
  "clothing-accessories": {
    adj: ["Wool", "Corduroy", "Leather", "Linen", "Tweed", "Denim", "Suede", "Cashmere", "Waxed cotton", "Silk"],
    noun: ["overcoat", "blazer", "work jacket", "shirt", "scarf", "satchel", "boots", "cardigan", "trousers", "gloves", "belt", "handbag"],
    price: [1800, 22000],
  },
  "music-film-books": {
    adj: ["Original-pressing", "Reissued", "First-edition", "Boxed", "Hardback", "Import", "Mono", "Well-thumbed", "Signed", "Complete"],
    noun: ["jazz LP", "soul 7-inch", "poetry collection", "cookbook", "film reel", "paperback set", "vinyl bundle", "art monograph", "cassette lot", "atlas", "comic run", "novel"],
    price: [800, 14000],
  },
  "decor-curiosities": {
    adj: ["Brass", "Enamel", "Hand-painted", "Etched", "Porcelain", "Carved", "Stoneware", "Milk-glass", "Wrought-iron", "Beaded"],
    noun: ["candlestick", "wall clock", "jewellery box", "vase", "picture frame", "tin sign", "letter rack", "figurine", "map print", "trinket dish", "bookend pair", "lamp base"],
    price: [900, 16000],
  },
  "bikes-outdoors": {
    adj: ["Steel-framed", "Touring", "Vintage racing", "Folding", "Canvas", "Aluminium", "Waxed", "Three-speed", "Lugged", "Expedition"],
    noun: ["road bike", "commuter bike", "rucksack", "two-person tent", "sleeping bag", "pannier set", "camp stove", "tennis racket", "walking poles", "bike frame", "helmet", "cool box"],
    price: [2500, 62000],
  },
  "kitchen-tableware": {
    adj: ["Cast-iron", "Copper", "Stoneware", "Pyrex", "Enamelled", "Hand-thrown", "Pressed-glass", "Stainless", "Terracotta", "Bone-china"],
    noun: ["skillet", "casserole dish", "mixing bowl set", "teapot", "dinner plates", "tumblers", "serving platter", "storage jars", "cake tin", "coffee pot", "cutlery set", "mugs"],
    price: [1200, 19000],
  },
  electronics: {
    adj: ["Working", "Serviced", "Boxed", "Untested", "Refurbished", "Portable", "Valve", "Compact", "Battery", "Mains"],
    noun: ["film camera", "transistor radio", "cassette deck", "turntable", "desk fan", "record player", "slide projector", "amplifier", "rotary phone", "calculator", "speakers", "light meter"],
    price: [1500, 42000],
  },
};

const CONDITION_NOTES: Record<string, string[]> = {
  LIKE_NEW: ["Barely used", "As new", "Hardly touched", "Immaculate"],
  GOOD: ["Minor wear", "Light marks", "Solid condition", "Good working order"],
  WELL_LOVED: ["Well used", "Honest wear", "Marks throughout", "Shows its age"],
  NEEDS_REPAIR: ["Needs a tune-up", "Sold as seen", "For parts or repair", "Needs attention"],
};

const CONDITIONS = [
  Condition.LIKE_NEW,
  Condition.GOOD,
  Condition.GOOD,
  Condition.GOOD,
  Condition.WELL_LOVED,
  Condition.WELL_LOVED,
  Condition.NEEDS_REPAIR,
] as const;

const SHOP_WORDS_A = ["Second", "Salt", "Copper", "Vellum", "Harbour", "Ash", "Linden", "Marlow", "Thistle", "Bramble", "Quarry", "Ember", "Hollow", "Wren", "Fen"];
const SHOP_WORDS_B = ["Life", "& Pine", "Row", "Attic", "Trading Co.", "Yard", "Emporium", "Finds", "Salvage", "Rooms", "Wares", "Curios", "Depot", "Loft", "Store"];

const REVIEW_BODIES = [
  "Exactly as described. Packed carefully.",
  "Better in person than the photos suggest.",
  "Some wear, all of it disclosed up front. Happy.",
  "Quick to post and answered my questions.",
  "Lovely piece. Would buy from this shop again.",
  "Arrived well wrapped and on time.",
  "Solid and honest. No surprises.",
  "Slightly more worn than I expected, but fairly described.",
  "Great find. The photos didn't do it justice.",
  "Seller was straight with me about the damage.",
];

async function unguessableHash() {
  return bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/* ------------------------------------------------------------------ */

async function clean() {
  console.log("Removing bulk seed data…\n");

  const users = await prisma.user.findMany({
    where: {
      OR: [
        { email: { startsWith: SELLER_PREFIX } },
        { email: { startsWith: REVIEWER_PREFIX } },
      ],
      email: { endsWith: DOMAIN },
    },
    select: { id: true, email: true },
  });

  if (users.length === 0) {
    console.log("  nothing to remove");
    return;
  }

  const listings = await prisma.listing.count({
    where: { seller: { userId: { in: users.map((u) => u.id) } } },
  });

  // Cascades through SellerProfile -> Listing -> images/reviews/reservations.
  const deleted = await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });

  console.log(`  removed ${deleted.count} accounts and ${listings} listings`);
  console.log(`  remaining listings: ${await prisma.listing.count()}`);
}

async function seed() {
  const categories = await prisma.category.findMany({ select: { id: true, slug: true } });
  if (categories.length === 0) {
    throw new Error("No categories. Run `npx prisma db seed` first.");
  }
  const categoryIds = new Map(categories.map((c) => [c.slug, c.id]));
  const catSlugs = categories.map((c) => c.slug).filter((s) => WORDS[s]);

  const before = await prisma.listing.count();
  console.log(`Starting from ${before} listings.\n`);

  /* ---- sellers ---- */
  console.log(`Creating ${SELLERS} seller accounts…`);
  const passwordHash = await unguessableHash();
  const sellerProfileIds: string[] = [];

  for (let i = 1; i <= SELLERS; i++) {
    const n = String(i).padStart(2, "0");
    const email = `${SELLER_PREFIX}${n}${DOMAIN}`;
    const shopName = `${SHOP_WORDS_A[(i - 1) % SHOP_WORDS_A.length]} ${SHOP_WORDS_B[(i * 7 - 1) % SHOP_WORDS_B.length]}`;

    // Two thirds verified, so the verified badge means something on the page
    // rather than being universal decoration.
    const verified = i % 3 !== 0;

    const user = await prisma.user.upsert({
      where: { email },
      update: {},
      create: {
        email,
        name: shopName,
        passwordHash,
        isSeller: true,
        emailVerified: true,
      },
      select: { id: true },
    });

    const profile = await prisma.sellerProfile.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        shopName,
        bio: "Clearing out slowly, listing the good bits.",
        kycStatus: verified ? VerificationStatus.VERIFIED : VerificationStatus.UNSTARTED,
        kycProvider: verified ? "seed" : null,
        kycVerifiedAt: verified ? new Date() : null,
        payoutsEnabled: verified,
      },
      select: { id: true },
    });

    sellerProfileIds.push(profile.id);
  }
  console.log(`  ${sellerProfileIds.length} sellers ready`);

  /* ---- reviewers ---- */
  console.log(`Creating ${REVIEWERS} reviewer accounts…`);
  const reviewerIds: string[] = [];
  for (let i = 1; i <= REVIEWERS; i++) {
    const n = String(i).padStart(2, "0");
    const user = await prisma.user.upsert({
      where: { email: `${REVIEWER_PREFIX}${n}${DOMAIN}` },
      update: {},
      create: {
        email: `${REVIEWER_PREFIX}${n}${DOMAIN}`,
        name: `Buyer ${n}`,
        passwordHash,
        emailVerified: true,
      },
      select: { id: true },
    });
    reviewerIds.push(user.id);
  }
  console.log(`  ${reviewerIds.length} reviewers ready`);

  /* ---- listings ---- */
  const total = SELLERS * LISTINGS_PER_SELLER;
  console.log(`\nBuilding ${total} listings…`);

  type Row = {
    slug: string;
    title: string;
    description: string;
    sellerId: string;
    categoryId: string;
    condition: (typeof CONDITIONS)[number];
    conditionNote: string;
    priceCents: number;
    originalPriceCents: number | null;
    currency: string;
    quantity: number;
    status: ListingStatus;
    featured: boolean;
    createdAt: Date;
    photo: string;
    photoAlt: string;
  };

  const rows: Row[] = [];
  /**
   * Per-category round-robin, so photos spread evenly.
   *
   * The previous `(s + k) % photos.length` clustered badly: which category a
   * listing lands in is itself a function of s and k, so the two indices moved
   * together and the same few photos kept coming up. A plain counter per
   * category cannot do that.
   */
  const photoCursor: Record<string, number> = {};

  for (let s = 0; s < SELLERS; s++) {
    for (let k = 0; k < LISTINGS_PER_SELLER; k++) {
      const catSlug = catSlugs[(s * LISTINGS_PER_SELLER + k) % catSlugs.length];
      const bank = WORDS[catSlug];
      const adj = pick(bank.adj);
      const noun = pick(bank.noun);
      const title = `${adj} ${noun}`;

      const condition = pick(CONDITIONS);
      const conditionNote = pick(CONDITION_NOTES[condition]);

      const priceCents = between(bank.price[0], bank.price[1]);
      // A third are marked down, which is what makes the discount badge and the
      // "was" price on a card worth rendering at all.
      const discounted = rand() < 0.34;
      const originalPriceCents = discounted
        ? Math.round(priceCents * (1.15 + rand() * 0.5))
        : null;

      const photos = PHOTOS[catSlug];
      photoCursor[catSlug] = (photoCursor[catSlug] ?? 0) + 1;
      const photo = photos[photoCursor[catSlug] % photos.length];

      rows.push({
        // Slug carries the seller and item index, so two sellers can both list
        // an "Oak dining chair" without colliding.
        slug: `${slugify(title)}-s${String(s + 1).padStart(2, "0")}-${String(k + 1).padStart(2, "0")}`,
        title,
        description:
          `${adj} ${noun}, picked up second-hand and listed as found. ` +
          `${conditionNote}. Happy to send more photos of anything specific before you buy.`,
        sellerId: sellerProfileIds[s],
        categoryId: categoryIds.get(catSlug)!,
        condition,
        conditionNote,
        priceCents,
        originalPriceCents,
        currency: "USD",
        // Mostly one-of-a-kind, which is the premise of the whole site.
        quantity: rand() < 0.85 ? 1 : between(2, 4),
        status: ListingStatus.ACTIVE,
        featured: rand() < 0.05,
        // Spread across six months so "recently listed" is a real sort rather
        // than 900 rows sharing one timestamp.
        createdAt: new Date(Date.now() - Math.floor(rand() * 180) * 86_400_000),
        photo: unsplash(photo),
        photoAlt: `${title}, photographed on a plain background`,
      });
    }
  }

  console.log("Inserting listings…");
  const CHUNK = 200;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const result = await prisma.listing.createMany({
      data: chunk.map(({ photo: _photo, photoAlt: _photoAlt, ...rest }) => rest),
      // Makes re-running a no-op instead of an error.
      skipDuplicates: true,
    });
    inserted += result.count;
    process.stdout.write(`  ${Math.min(i + CHUNK, rows.length)}/${rows.length}\r`);
  }
  console.log(`\n  inserted ${inserted} new listings`);

  /* ---- images ---- */
  console.log("Attaching images…");
  const created = await prisma.listing.findMany({
    where: { slug: { in: rows.map((r) => r.slug) } },
    select: { id: true, slug: true },
  });
  const idBySlug = new Map(created.map((l) => [l.slug, l.id]));

  /**
   * Replaced rather than skipped-if-present.
   *
   * Re-running is how the photo set gets refreshed after the pool grows, so
   * "already has an image" must not mean "leave the old one alone" — that made
   * the seeder unable to fix the very thing it was re-run to fix.
   */
  const listingIds = created.map((l) => l.id);
  for (let i = 0; i < listingIds.length; i += CHUNK) {
    await prisma.listingImage.deleteMany({
      where: { listingId: { in: listingIds.slice(i, i + CHUNK) } },
    });
  }

  const imageRows = rows
    .map((r) => ({ listingId: idBySlug.get(r.slug)!, url: r.photo, alt: r.photoAlt, position: 0 }))
    .filter((r) => r.listingId);

  for (let i = 0; i < imageRows.length; i += CHUNK) {
    await prisma.listingImage.createMany({ data: imageRows.slice(i, i + CHUNK) });
    process.stdout.write(`  ${Math.min(i + CHUNK, imageRows.length)}/${imageRows.length}\r`);
  }
  console.log(`\n  attached ${imageRows.length} images`);

  const distinctPhotos = new Set(imageRows.map((r) => r.url)).size;
  console.log(`  ${distinctPhotos} distinct photos in use`);

  /* ---- reviews ---- */
  console.log("Adding reviews…");
  const withReviews = new Set(
    (
      await prisma.review.findMany({
        where: { listingId: { in: created.map((l) => l.id) } },
        select: { listingId: true },
        distinct: ["listingId"],
      })
    ).map((r) => r.listingId)
  );

  const reviewRows: { listingId: string; authorId: string; rating: number; body: string }[] = [];
  for (const r of rows) {
    const listingId = idBySlug.get(r.slug);
    if (!listingId || withReviews.has(listingId)) continue;

    // A fifth have none, so "No reviews yet" stays a real state on the card.
    if (rand() < 0.2) continue;

    const count = between(1, 4);
    const used = new Set<string>();
    for (let i = 0; i < count; i++) {
      const authorId = reviewerIds[Math.floor(rand() * reviewerIds.length)];
      // The unique index is [listingId, authorId]; one person, one review.
      if (used.has(authorId)) continue;
      used.add(authorId);
      reviewRows.push({
        listingId,
        authorId,
        rating: rand() < 0.62 ? 5 : rand() < 0.75 ? 4 : between(2, 3),
        body: pick(REVIEW_BODIES),
      });
    }
  }

  for (let i = 0; i < reviewRows.length; i += CHUNK) {
    await prisma.review.createMany({ data: reviewRows.slice(i, i + CHUNK), skipDuplicates: true });
    process.stdout.write(`  ${Math.min(i + CHUNK, reviewRows.length)}/${reviewRows.length}\r`);
  }
  console.log(`\n  added ${reviewRows.length} reviews`);

  /* ---- summary ---- */
  const after = await prisma.listing.count();
  const active = await prisma.listing.count({ where: { status: ListingStatus.ACTIVE } });
  console.log(`\nListings: ${before} -> ${after} (${active} active)`);
  console.log(`Sellers:  ${await prisma.sellerProfile.count()}`);
  console.log(`Reviews:  ${await prisma.review.count()}`);
}

async function main() {
  const wantsClean = process.argv.includes("--clean");
  if (wantsClean) await clean();
  else await seed();
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
