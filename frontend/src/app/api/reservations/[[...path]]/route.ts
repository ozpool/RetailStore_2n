import type { NextRequest } from "next/server";
import { proxyToBackend } from "@/lib/backendProxy";

/**
 * Optional catch-all so both `/api/reservations` and
 * `/api/reservations/:id` land here.
 */
async function handler(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> }
) {
  const { path } = await ctx.params;
  const suffix = path?.length ? `/${path.map(encodeURIComponent).join("/")}` : "";
  return proxyToBackend(req, `/reservations${suffix}${req.nextUrl.search}`);
}

export { handler as GET, handler as POST, handler as DELETE };
