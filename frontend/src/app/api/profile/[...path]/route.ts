import type { NextRequest } from "next/server";
import { proxyToBackend } from "@/lib/backendProxy";

/** Catch-all so avatar uploads (multipart) cross the BFF boundary intact. */
async function handler(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
) {
  const { path } = await ctx.params;
  const segments = path.map(encodeURIComponent).join("/");
  return proxyToBackend(req, `/profile/${segments}${req.nextUrl.search}`);
}

export { handler as GET, handler as POST, handler as PATCH, handler as DELETE };
