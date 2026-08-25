import type { NextRequest } from "next/server";
import { proxyToBackend } from "@/lib/backendProxy";

/** `/api/reports` and `/api/reports/reasons`. */
async function handler(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> }
) {
  const { path } = await ctx.params;
  const suffix = path?.length ? `/${path.map(encodeURIComponent).join("/")}` : "";
  return proxyToBackend(req, `/reports${suffix}${req.nextUrl.search}`);
}

export { handler as GET, handler as POST };
