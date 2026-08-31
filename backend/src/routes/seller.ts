import crypto from "crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { processImageUpload, MAX_UPLOAD_BYTES, UploadError } from "../lib/imageProcessing";
import { invalidate } from "../lib/cache";
import { listingKey } from "../lib/cacheKeys";
import { prisma } from "../lib/prisma";
import { checkRateLimit } from "../lib/rateLimit";
import { keyFromUrl, newKey, putFile, removeFile } from "../lib/storage";
import { requireAuth } from "../middleware/requireAuth";
import { requireSeller } from "../middleware/requireSeller";
import { ListingStatus } from "../generated/prisma/enums";

export const sellerRouter = Router();

sellerRouter.use(requireAuth, requireSeller);

const MAX_IMAGES_PER_LISTING = 8;

const listingSelect = {
  id: true,
  slug: true,
  title: true,
  description: true,
  condition: true,
  conditionNote: true,
  priceCents: true,
  originalPriceCents: true,
  currency: true,
  quantity: true,
  status: true,
  featured: true,
  createdAt: true,
  updatedAt: true,
  category: { select: { id: true, slug: true, title: true } },
  images: {
    orderBy: { position: "asc" as const },
    select: { id: true, url: true, alt: true, position: true },
  },
};

/**
 * Every lookup is scoped by sellerId, and a listing owned by someone else
 * returns 404 rather than 403 — a 403 would confirm the id exists, which lets
 * an attacker enumerate other sellers' inventory.
 */
async function findOwnListing(sellerId: string, id: string) {
  return prisma.listing.findFirst({
    where: { id, sellerId, deletedAt: null },
    select: listingSelect,
  });
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}

async function uniqueSlug(title: string): Promise<string> {
  const base = slugify(title) || "listing";

  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${crypto.randomBytes(3).toString("hex")}`;
    const clash = await prisma.listing.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!clash) return candidate;
  }

  return `${base}-${crypto.randomBytes(8).toString("hex")}`;
}

const CONDITIONS = ["LIKE_NEW", "GOOD", "WELL_LOVED", "NEEDS_REPAIR"] as const;

const listingBody = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(4000),
  categoryId: z.string().uuid(),
  condition: z.enum(CONDITIONS),
  conditionNote: z.string().trim().max(60).nullable().optional(),
  // Integer minor units. The client converts from the dollars its form collects,
  // which keeps float rounding out of the request body entirely.
  priceCents: z.number().int().min(1).max(100_000_000),
  originalPriceCents: z.number().int().min(1).max(100_000_000).nullable().optional(),
  quantity: z.number().int().min(1).max(999),
  currency: z.string().trim().length(3).toUpperCase().default("USD"),
});

/** A "was" price that isn't higher than the current price is not a discount. */
function priceProblem(priceCents: number, originalPriceCents?: number | null) {
  if (originalPriceCents != null && originalPriceCents <= priceCents) {
    return "Original price must be higher than the current price.";
  }
  return null;
}

sellerRouter.get("/me", async (req, res) => {
  try {
    const profile = await prisma.sellerProfile.findUnique({
      where: { id: req.sellerId },
      select: {
        id: true,
        shopName: true,
        bio: true,
        kycStatus: true,
        payoutsEnabled: true,
        createdAt: true,
      },
    });

    if (!profile) {
      return res.status(404).json({ error: "Seller profile not found." });
    }

    const counts = await prisma.listing.groupBy({
      by: ["status"],
      where: { sellerId: req.sellerId, deletedAt: null },
      _count: { status: true },
    });

    res.json({
      seller: profile,
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count.status])),
    });
  } catch (err) {
    console.error("GET /seller/me failed", err);
    res.status(500).json({ error: "Could not load your seller account." });
  }
});

sellerRouter.get("/listings", async (req, res) => {
  try {
    const listings = await prisma.listing.findMany({
      where: { sellerId: req.sellerId, deletedAt: null },
      select: listingSelect,
      orderBy: { updatedAt: "desc" },
    });

    res.json({ listings });
  } catch (err) {
    console.error("GET /seller/listings failed", err);
    res.status(500).json({ error: "Could not load your listings." });
  }
});

sellerRouter.get("/listings/:id", async (req, res) => {
  try {
    const listing = await findOwnListing(req.sellerId!, req.params.id);
    if (!listing) {
      return res.status(404).json({ error: "Listing not found.", code: "NOT_FOUND" });
    }
    res.json({ listing });
  } catch (err) {
    console.error("GET /seller/listings/:id failed", err);
    res.status(500).json({ error: "Could not load that listing." });
  }
});

sellerRouter.post("/listings", async (req, res) => {
  try {
    const parsed = listingBody.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return res.status(400).json({
        error: first?.message ?? "Please check the form.",
        code: "INVALID_INPUT",
        field: first?.path?.[0] != null ? String(first.path[0]) : undefined,
      });
    }

    const data = parsed.data;

    const problem = priceProblem(data.priceCents, data.originalPriceCents);
    if (problem) {
      return res
        .status(400)
        .json({ error: problem, code: "INVALID_INPUT", field: "originalPriceCents" });
    }

    const category = await prisma.category.findUnique({
      where: { id: data.categoryId },
      select: { id: true },
    });
    if (!category) {
      return res
        .status(400)
        .json({ error: "Pick a category.", code: "INVALID_INPUT", field: "categoryId" });
    }

    // Created as DRAFT: nothing reaches buyers until the seller publishes and
    // the publish check confirms there's at least one photo.
    const listing = await prisma.listing.create({
      data: {
        ...data,
        conditionNote: data.conditionNote ?? null,
        originalPriceCents: data.originalPriceCents ?? null,
        slug: await uniqueSlug(data.title),
        sellerId: req.sellerId!,
        status: ListingStatus.DRAFT,
      },
      select: listingSelect,
    });

    // A brand-new slug can already have a NEGATIVE cache entry: anything that
    // probed the URL before it existed cached the 404. Without this the seller
    // publishes and their own page still reports not-found.
    await invalidate(listingKey(listing.slug));

    res.status(201).json({ listing });
  } catch (err) {
    console.error("POST /seller/listings failed", err);
    res.status(500).json({ error: "Could not create that listing." });
  }
});

sellerRouter.patch("/listings/:id", async (req, res) => {
  try {
    const existing = await findOwnListing(req.sellerId!, req.params.id);
    if (!existing) {
      return res.status(404).json({ error: "Listing not found.", code: "NOT_FOUND" });
    }
    if (existing.status === ListingStatus.SOLD) {
      return res
        .status(409)
        .json({ error: "A sold listing can't be edited.", code: "LISTING_SOLD" });
    }

    const parsed = listingBody.partial().safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return res.status(400).json({
        error: first?.message ?? "Please check the form.",
        code: "INVALID_INPUT",
        field: first?.path?.[0] != null ? String(first.path[0]) : undefined,
      });
    }

    const data = parsed.data;

    const problem = priceProblem(
      data.priceCents ?? existing.priceCents,
      data.originalPriceCents !== undefined
        ? data.originalPriceCents
        : existing.originalPriceCents
    );
    if (problem) {
      return res
        .status(400)
        .json({ error: problem, code: "INVALID_INPUT", field: "originalPriceCents" });
    }

    if (data.categoryId) {
      const category = await prisma.category.findUnique({
        where: { id: data.categoryId },
        select: { id: true },
      });
      if (!category) {
        return res
          .status(400)
          .json({ error: "Pick a category.", code: "INVALID_INPUT", field: "categoryId" });
      }
    }

    // The slug is deliberately not regenerated on a title change: it is the
    // public URL, and rewriting it would break every existing link to the item.
    const listing = await prisma.listing.update({
      where: { id: existing.id },
      data,
      select: listingSelect,
    });

    await invalidate(listingKey(listing.slug));

    res.json({ listing });
  } catch (err) {
    console.error("PATCH /seller/listings/:id failed", err);
    res.status(500).json({ error: "Could not save your changes." });
  }
});

sellerRouter.post("/listings/:id/publish", async (req, res) => {
  try {
    const listing = await findOwnListing(req.sellerId!, req.params.id);
    if (!listing) {
      return res.status(404).json({ error: "Listing not found.", code: "NOT_FOUND" });
    }
    if (listing.status === ListingStatus.SOLD) {
      return res
        .status(409)
        .json({ error: "That listing is already sold.", code: "LISTING_SOLD" });
    }
    if (listing.images.length === 0) {
      return res.status(400).json({
        error: "Add at least one photo before publishing.",
        code: "NEEDS_PHOTO",
      });
    }

    // Note: publishing is intentionally NOT gated on identity verification.
    // Verification gates payouts, which is where money actually moves.
    const updated = await prisma.listing.update({
      where: { id: listing.id },
      data: { status: ListingStatus.ACTIVE },
      select: listingSelect,
    });

    await invalidate(listingKey(updated.slug));

    res.json({ listing: updated });
  } catch (err) {
    console.error("POST /seller/listings/:id/publish failed", err);
    res.status(500).json({ error: "Could not publish that listing." });
  }
});

sellerRouter.post("/listings/:id/unpublish", async (req, res) => {
  try {
    const listing = await findOwnListing(req.sellerId!, req.params.id);
    if (!listing) {
      return res.status(404).json({ error: "Listing not found.", code: "NOT_FOUND" });
    }
    if (listing.status === ListingStatus.SOLD) {
      return res
        .status(409)
        .json({ error: "A sold listing can't be unpublished.", code: "LISTING_SOLD" });
    }

    const updated = await prisma.listing.update({
      where: { id: listing.id },
      data: { status: ListingStatus.DRAFT },
      select: listingSelect,
    });

    await invalidate(listingKey(updated.slug));

    res.json({ listing: updated });
  } catch (err) {
    console.error("POST /seller/listings/:id/unpublish failed", err);
    res.status(500).json({ error: "Could not unpublish that listing." });
  }
});

sellerRouter.delete("/listings/:id", async (req, res) => {
  try {
    const listing = await findOwnListing(req.sellerId!, req.params.id);
    if (!listing) {
      return res.status(404).json({ error: "Listing not found.", code: "NOT_FOUND" });
    }

    // Soft delete: a listing referenced by a past order must remain resolvable,
    // so the row stays and the catalog filters it out via deletedAt.
    await prisma.listing.update({
      where: { id: listing.id },
      data: { deletedAt: new Date(), status: ListingStatus.REMOVED },
    });

    // Load-bearing, not tidiness: without it a removed listing stays readable
    // at its public URL for the rest of the TTL.
    await invalidate(listingKey(listing.slug));

    res.status(204).end();
  } catch (err) {
    console.error("DELETE /seller/listings/:id failed", err);
    res.status(500).json({ error: "Could not remove that listing." });
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

/** Turns multer's own errors into the same JSON shape as everything else. */
function singleImage(req: Request, res: Response, next: NextFunction) {
  upload.single("image")(req, res, (err: unknown) => {
    if (err) {
      const code = (err as { code?: string }).code;
      res.status(400).json({
        error:
          code === "LIMIT_FILE_SIZE"
            ? "Image must be 8MB or smaller."
            : "Could not read that upload.",
        code: "UPLOAD_FAILED",
      });
      return;
    }
    next();
  });
}

sellerRouter.post("/listings/:id/images", singleImage, async (req, res) => {
  try {
    const limit = await checkRateLimit(`upload:${req.userId}`, 30, 60 * 60 * 1000);
    if (!limit.allowed) {
      return res.status(429).json({
        error: "Too many uploads for now. Try again shortly.",
        code: "RATE_LIMITED",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const listing = await findOwnListing(req.sellerId!, req.params.id);
    if (!listing) {
      return res.status(404).json({ error: "Listing not found.", code: "NOT_FOUND" });
    }
    if (listing.images.length >= MAX_IMAGES_PER_LISTING) {
      return res.status(400).json({
        error: `A listing can have at most ${MAX_IMAGES_PER_LISTING} photos.`,
        code: "TOO_MANY_IMAGES",
      });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No image was attached.", code: "NO_FILE" });
    }

    const processed = await processImageUpload(req.file.buffer);
    const key = newKey(processed.ext);
    const url = await putFile(key, processed.data);

    const nextPosition = listing.images.reduce((max, img) => Math.max(max, img.position), -1) + 1;

    const image = await prisma.listingImage.create({
      data: { listingId: listing.id, url, alt: listing.title, position: nextPosition },
      select: { id: true, url: true, alt: true, position: true },
    });

    // Photos are part of the detail payload, so adding one makes it stale.
    await invalidate(listingKey(listing.slug));

    res.status(201).json({ image });
  } catch (err) {
    if (err instanceof UploadError) {
      return res.status(400).json({ error: err.message, code: "INVALID_IMAGE" });
    }
    console.error("POST /seller/listings/:id/images failed", err);
    res.status(500).json({ error: "Could not save that photo." });
  }
});

sellerRouter.delete("/listings/:id/images/:imageId", async (req, res) => {
  try {
    const listing = await findOwnListing(req.sellerId!, req.params.id);
    if (!listing) {
      return res.status(404).json({ error: "Listing not found.", code: "NOT_FOUND" });
    }

    const image = listing.images.find((img) => img.id === req.params.imageId);
    if (!image) {
      return res.status(404).json({ error: "Photo not found.", code: "NOT_FOUND" });
    }
    if (listing.status === ListingStatus.ACTIVE && listing.images.length === 1) {
      return res.status(400).json({
        error: "A published listing needs at least one photo.",
        code: "NEEDS_PHOTO",
      });
    }

    await prisma.listingImage.delete({ where: { id: image.id } });
    await invalidate(listingKey(listing.slug));

    const key = keyFromUrl(image.url);
    if (key) await removeFile(key);

    res.status(204).end();
  } catch (err) {
    console.error("DELETE /seller/listings/:id/images/:imageId failed", err);
    res.status(500).json({ error: "Could not remove that photo." });
  }
});
