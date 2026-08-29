import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth";
import {
  MAX_BODY,
  ReviewError,
  deleteReview,
  editReview,
  eligibility,
  upsertReview,
} from "../lib/reviews";

export const reviewsRouter = Router();

reviewsRouter.use(requireAuth);

function fail(res: import("express").Response, err: unknown, fallback: string) {
  if (err instanceof ReviewError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error(fallback, err);
  return res.status(500).json({ error: fallback });
}

const writeBody = z.object({
  listingId: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  body: z.string().max(MAX_BODY).nullish(),
});

const editBody = z.object({
  rating: z.number().int().min(1).max(5),
  body: z.string().max(MAX_BODY).nullish(),
});

/**
 * Can this person review this listing, and have they already?
 *
 * Separate from the public listing endpoint because the answer depends on who
 * is asking, and the catalog is served to signed-out visitors too.
 */
reviewsRouter.get("/for/:listingId", async (req, res) => {
  try {
    const parsed = z.string().uuid().safeParse(req.params.listingId);
    if (!parsed.success) {
      return res.status(400).json({ error: "Unknown listing.", code: "INVALID_INPUT" });
    }
    res.json(await eligibility(req.userId!, parsed.data));
  } catch (err) {
    fail(res, err, "Could not check that listing.");
  }
});

/** Writes a review, or replaces the one already left for this listing. */
reviewsRouter.post("/", async (req, res) => {
  try {
    const parsed = writeBody.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return res.status(400).json({
        error:
          first?.path?.[0] === "rating"
            ? "Choose a rating from 1 to 5 stars."
            : `Keep your review under ${MAX_BODY} characters.`,
        code: "INVALID_INPUT",
        field: first?.path?.[0] != null ? String(first.path[0]) : undefined,
      });
    }

    const review = await upsertReview({
      userId: req.userId!,
      listingId: parsed.data.listingId,
      rating: parsed.data.rating,
      body: parsed.data.body ?? null,
    });

    res.status(201).json({
      review: {
        id: review.id,
        rating: review.rating,
        body: review.body,
        createdAt: review.createdAt.toISOString(),
        edited: review.updatedAt.getTime() - review.createdAt.getTime() > 1000,
        authorName: review.author.name,
        // Always true here: upsertReview refuses without a paid order.
        verified: true,
      },
    });
  } catch (err) {
    fail(res, err, "Could not post that review.");
  }
});

reviewsRouter.patch("/:id", async (req, res) => {
  try {
    const parsed = editBody.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Choose a rating from 1 to 5 stars.", code: "INVALID_INPUT" });
    }

    const review = await editReview({
      userId: req.userId!,
      reviewId: req.params.id,
      rating: parsed.data.rating,
      body: parsed.data.body ?? null,
    });

    res.json({
      review: {
        id: review.id,
        rating: review.rating,
        body: review.body,
        createdAt: review.createdAt.toISOString(),
        edited: true,
      },
    });
  } catch (err) {
    fail(res, err, "Could not update that review.");
  }
});

reviewsRouter.delete("/:id", async (req, res) => {
  try {
    await deleteReview(req.userId!, req.params.id);
    res.status(204).end();
  } catch (err) {
    fail(res, err, "Could not delete that review.");
  }
});
