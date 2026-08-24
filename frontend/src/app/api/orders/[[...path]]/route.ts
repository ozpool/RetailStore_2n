import type { NextRequest } from "next/server";
import { proxyToBackend } from "@/lib/backendProxy";

/**
 * Optional catch-all so `/api/orders`, `/api/orders/:id`, `/api/orders/:id/pay`
 * and `/api/orders/:id/cancel` all land here.
 *
 * The card number passes through this proxy on its way to the API, which then
 * hands it to the provider and discards it. Nothing is logged here — see
 * lib/backendProxy.ts, which forwards bodies as bytes without inspecting them.
 */
async function handler(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> }
) {
  const { path } = await ctx.params;
  const suffix = path?.length ? `/${path.map(encodeURIComponent).join("/")}` : "";
  return proxyToBackend(req, `/orders${suffix}${req.nextUrl.search}`);
}

export { handler as GET, handler as POST };
