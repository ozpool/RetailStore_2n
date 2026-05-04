import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Traces the files the server actually needs into .next/standalone.
   *
   * For the container image this is the difference between shipping the whole
   * node_modules tree and shipping the few hundred files that get imported.
   * `next start` still works locally and in CI, which read .next as before.
   */
  output: "standalone",

  turbopack: {
    root: path.join(__dirname),
  },
  images: {
    /**
     * Next blocks optimizing images from private IPs as SSRF protection, which
     * catches the dev backend on localhost:4000. Relaxed in development only —
     * in production uploads are served from object storage on a public
     * hostname, so this stays off where it would actually matter.
     */
    dangerouslyAllowLocalIP: process.env.NODE_ENV !== "production",
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.unsplash.com",
        pathname: "/**",
      },
      // Seller-uploaded photos on the local-disk driver, served by the API.
      {
        protocol: "http",
        hostname: "localhost",
        port: "4000",
        pathname: "/uploads/**",
      },
      /**
       * The same photos on the object-storage driver.
       *
       * Both entries are needed, because both are reachable configurations:
       * `npm run dev` defaults to local disk, Compose uses MinIO. Next refuses
       * to optimise an image from a host that is not listed here, and the
       * refusal renders as a broken image with the reason only in the server
       * log — so an omission here looks exactly like a broken upload.
       *
       * In production this becomes the CDN hostname in front of the bucket.
       */
      {
        protocol: "http",
        hostname: "localhost",
        port: "9000",
        pathname: "/**",
      },
    ],
  },
};

export default nextConfig;
