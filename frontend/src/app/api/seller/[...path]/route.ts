import type { NextRequest } from "next/server";
import { proxyToBackend } from "@/lib/backendProxy";

/**
 * Catch-all for the seller API. One handler keeps the BFF boundary intact for
 * every seller route — including multipart image uploads — without a file per
 * endpoint.
 */
async function handler(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
) {
  const { path } = await ctx.params;
  const segments = path.map(encodeURIComponent).join("/");
  return proxyToBackend(req, `/seller/${segments}${req.nextUrl.search}`);
}

export { handler as GET, handler as POST, handler as PATCH, handler as DELETE };
