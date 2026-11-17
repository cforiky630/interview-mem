import type { NextConfig } from "next";
import { applicationOrigins } from "./src/server/config.mjs";

const nextConfig: NextConfig = {
  devIndicators: false,
  output: process.env.NEXT_STANDALONE === "true" ? "standalone" : undefined,
  // Keep development resources aligned with the explicit authentication origins.
  allowedDevOrigins: applicationOrigins().map(
    (origin) => new URL(origin).hostname,
  ),
  distDir:
    process.env.NEXT_DIST_DIR ??
    (process.env.NODE_ENV === "production" ? ".next-build" : ".next"),
  serverExternalPackages: ["@electric-sql/pglite", "pg", "drizzle-orm"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
