import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { ADMIN_COOKIE_NAME, readAdminToken } from "../lib/adminAuth";
import { UserRole } from "../generated/prisma/enums";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminId?: string;
    }
  }
}

/**
 * Guards every admin route.
 *
 * Checks THREE things, and all three matter:
 *
 *   1. A valid admin session cookie — signed with a different secret from the
 *      ordinary access token, so a storefront session cannot be replayed here.
 *   2. The role, re-read from the database on every request. Not trusted from
 *      the token: revoking admin must take effect immediately, not in thirty
 *      minutes when the session happens to expire.
 *   3. Suspension, for the same reason.
 *
 * The database read per request is deliberate. It is one indexed lookup on a
 * route family that is used by a handful of people, and the alternative is a
 * revoked admin keeping their powers for the rest of their session.
 */
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[ADMIN_COOKIE_NAME];
  const userId = readAdminToken(token);

  if (!userId) {
    return res.status(401).json({
      error: "Admin sign-in required.",
      code: "ADMIN_SESSION_REQUIRED",
    });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, suspendedAt: true },
  });

  if (!user || user.role !== UserRole.ADMIN || user.suspendedAt) {
    return res.status(403).json({
      error: "Admin access has been removed.",
      code: "ADMIN_REVOKED",
    });
  }

  req.adminId = user.id;
  next();
}
