import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Keep development resources aligned with the explicit authentication origins.
  allowedDevOrigins: [
    process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "").split(","),
  ]
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => new URL(origin).hostname),
  distDir:
    process.env.NEXT_DIST_DIR ??
    (process.env.NODE_ENV === "production" ? ".next-build" : ".next"),
  serverExternalPackages: ["@electric-sql/pglite", "pg", "ts-fsrs"],
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
