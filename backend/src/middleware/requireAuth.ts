import type { NextFunction, Request, Response } from "express";
import { getAccessTokenCookie, verifyAccessToken } from "../lib/auth";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = getAccessTokenCookie(req);
  const payload = token ? verifyAccessToken(token) : null;

  if (!payload) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  req.userId = payload.userId;
  next();
}
