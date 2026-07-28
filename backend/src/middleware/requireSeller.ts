import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma";

declare global {
  namespace Express {
    interface Request {
      sellerId?: string;
    }
  }
}

/**
 * Run after requireAuth. Resolves the caller's SellerProfile so downstream
 * handlers can scope every query by sellerId — authentication alone never
 * establishes which listings someone is allowed to touch.
 */
export async function requireSeller(req: Request, res: Response, next: NextFunction) {
  try {
    const profile = await prisma.sellerProfile.findUnique({
      where: { userId: req.userId },
      select: { id: true },
    });

    if (!profile) {
      res.status(403).json({
        error: "You need a seller account to do that.",
        code: "NOT_A_SELLER",
      });
      return;
    }

    req.sellerId = profile.id;
    next();
  } catch (err) {
    console.error("requireSeller failed", err);
    res.status(500).json({ error: "Could not verify your seller account." });
  }
}
