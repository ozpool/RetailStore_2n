import type { NextRequest } from "next/server";
import { proxyToBackend } from "@/lib/backendProxy";

/**
 * The admin API, proxied like everything else.
 *
 * The admin session cookie rides through here the same way the ordinary one
 * does. It is a separate cookie with a separate secret and a thirty-minute
 * life, so nothing about this proxy grants admin — it only forwards a cookie
 * the API itself refuses to honour unless it is valid.
 */
async function handler(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> }
) {
  const { path } = await ctx.params;
  const suffix = path?.length ? `/${path.map(encodeURIComponent).join("/")}` : "";
  return proxyToBackend(req, `/admin${suffix}${req.nextUrl.search}`);
}

export { handler as GET, handler as POST, handler as DELETE };
