import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth";
import {
  WishlistError,
  countWishlist,
  listWishlist,
  listWishlistIds,
  remove,
  save,
} from "../lib/wishlist";

export const wishlistRouter = Router();

wishlistRouter.use(requireAuth);

const listingIdParam = z.object({ listingId: z.string().uuid() });

function fail(res: import("express").Response, err: unknown, fallback: string) {
  if (err instanceof WishlistError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error(fallback, err);
  return res.status(500).json({ error: fallback });
}

/** The full list, for the wishlist page. */
wishlistRouter.get("/", async (req, res) => {
  try {
    const items = await listWishlist(req.userId!);
    res.json({ items, count: items.length });
  } catch (err) {
    fail(res, err, "Could not load your wishlist.");
  }
});

/**
 * Just the saved listing ids, plus a count.
 *
 * What the catalog grid and the nav badge need. Kept separate from GET / so
 * drawing a page of hearts doesn't drag every saved listing's images and seller
 * along with it.
 */
wishlistRouter.get("/ids", async (req, res) => {
  try {
    const listingIds = await listWishlistIds(req.userId!);
    res.json({ listingIds, count: listingIds.length });
  } catch (err) {
    fail(res, err, "Could not load your wishlist.");
  }
});

wishlistRouter.get("/count", async (req, res) => {
  try {
    res.json({ count: await countWishlist(req.userId!) });
  } catch (err) {
    fail(res, err, "Could not count your wishlist.");
  }
});

/**
 * PUT rather than POST, because saving is idempotent: sending it twice leaves
 * exactly the same state, which is the correct behaviour for a heart that is
 * trivially easy to double-tap.
 */
wishlistRouter.put("/:listingId", async (req, res) => {
  try {
    const parsed = listingIdParam.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({ error: "Unknown listing.", code: "INVALID_INPUT" });
    }

    await save(req.userId!, parsed.data.listingId);
    res.json({ saved: true, count: await countWishlist(req.userId!) });
  } catch (err) {
    fail(res, err, "Could not save that item.");
  }
});

wishlistRouter.delete("/:listingId", async (req, res) => {
  try {
    const parsed = listingIdParam.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({ error: "Unknown listing.", code: "INVALID_INPUT" });
    }

    // No 404 for something that was never saved: the caller wanted it gone, and
    // it is gone. Reporting an error would be technically true and useless.
    await remove(req.userId!, parsed.data.listingId);
    res.json({ saved: false, count: await countWishlist(req.userId!) });
  } catch (err) {
    fail(res, err, "Could not remove that item.");
  }
});
