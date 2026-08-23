import { Router } from "express";
import { z } from "zod";
import {
  RESERVATION_TTL_MS,
  ReservationError,
  listMyReservations,
  releaseReservation,
  reserveListing,
} from "../lib/reservations";
import { cartSummary } from "../lib/cart";
import { requireAuth } from "../middleware/requireAuth";

export const reservationsRouter = Router();

reservationsRouter.use(requireAuth);

/**
 * Everything the cart badge needs, in one request.
 *
 * Declared before `/:id` so "summary" is never mistaken for a reservation id.
 * Kept separate from GET / because the nav renders on every page and has no
 * use for titles, prices, or images.
 */
reservationsRouter.get("/summary", async (req, res) => {
  try {
    res.json(await cartSummary(req.userId!));
  } catch (err) {
    console.error("GET /reservations/summary failed", err);
    res.status(500).json({ error: "Could not load your cart." });
  }
});

const createBody = z.object({
  listingId: z.string().min(1),
  quantity: z.number().int().min(1).max(99).default(1),
});

reservationsRouter.get("/", async (req, res) => {
  try {
    const reservations = await listMyReservations(req.userId!);
    res.json({
      reservations: reservations.map((r) => ({
        id: r.id,
        // The client needs this to tell whether the listing it's showing is one
        // the viewer already holds.
        listingId: r.listingId,
        quantity: r.quantity,
        expiresAt: r.expiresAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
        listing: {
          slug: r.listing.slug,
          title: r.listing.title,
          priceCents: r.listing.priceCents,
          currency: r.listing.currency,
          image: r.listing.images[0]?.url ?? null,
        },
      })),
      holdMinutes: Math.round(RESERVATION_TTL_MS / 60000),
    });
  } catch (err) {
    console.error("GET /reservations failed", err);
    res.status(500).json({ error: "Could not load your holds." });
  }
});

reservationsRouter.post("/", async (req, res) => {
  try {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Check the request and try again.", code: "INVALID_INPUT" });
    }

    const reservation = await reserveListing({
      userId: req.userId!,
      listingId: parsed.data.listingId,
      quantity: parsed.data.quantity,
    });

    res.status(201).json({
      reservation: {
        id: reservation.id,
        listingId: reservation.listingId,
        quantity: reservation.quantity,
        expiresAt: reservation.expiresAt.toISOString(),
        remainingQuantity: reservation.remainingQuantity,
      },
    });
  } catch (err) {
    if (err instanceof ReservationError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error("POST /reservations failed", err);
    res.status(500).json({ error: "Could not hold that item." });
  }
});

reservationsRouter.delete("/:id", async (req, res) => {
  try {
    await releaseReservation({ userId: req.userId!, reservationId: req.params.id });
    res.status(204).end();
  } catch (err) {
    if (err instanceof ReservationError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error("DELETE /reservations/:id failed", err);
    res.status(500).json({ error: "Could not release that hold." });
  }
});
