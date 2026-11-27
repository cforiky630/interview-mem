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
  serverExternalPackages: ["@electric-sql/pglite", "pg", "drizzle-orm", "ioredis"],
  compress: process.env.DISABLE_NEXT_COMPRESS === "true" ? false : true,
  poweredByHeader: false,
  async headers() {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https://challenges.cloudflare.com",
      "frame-src https://challenges.cloudflare.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; ");
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value:
              "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
          { key: "Content-Security-Policy", value: csp },
        ],
      },
    ];
  },
};

export default nextConfig;
