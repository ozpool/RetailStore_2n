import type { NextRequest } from "next/server";
import { proxyToBackend } from "@/lib/backendProxy";

export async function POST(req: NextRequest) {
  return proxyToBackend(req, "/auth/become-seller");
}
