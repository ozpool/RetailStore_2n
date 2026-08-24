import type { NextRequest } from "next/server";
import { proxyToBackend } from "@/lib/backendProxy";

/**
 * Optional catch-all so `/api/wishlist`, `/api/wishlist/ids` and
 * `/api/wishlist/:listingId` all land here.
 */
async function handler(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> }
) {
  const { path } = await ctx.params;
  const suffix = path?.length ? `/${path.map(encodeURIComponent).join("/")}` : "";
  return proxyToBackend(req, `/wishlist${suffix}${req.nextUrl.search}`);
}

export { handler as GET, handler as PUT, handler as DELETE };
