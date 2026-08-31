import type { NextRequest } from "next/server";
import { proxyToBackend } from "@/lib/backendProxy";

/**
 * Optional catch-all so `/api/reviews`, `/api/reviews/for/:listingId` and
 * `/api/reviews/:id` all land here.
 */
async function handler(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> }
) {
  const { path } = await ctx.params;
  const suffix = path?.length ? `/${path.map(encodeURIComponent).join("/")}` : "";
  return proxyToBackend(req, `/reviews${suffix}${req.nextUrl.search}`);
}

export { handler as GET, handler as POST, handler as PATCH, handler as DELETE };
