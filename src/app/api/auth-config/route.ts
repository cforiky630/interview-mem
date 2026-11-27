import { NextResponse } from "next/server";
import { isEmailOtpEnabled } from "@/server/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const turnstileSiteKey =
    process.env.TURNSTILE_SITE_KEY?.trim() ||
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() ||
    null;

  return NextResponse.json(
    {
      turnstileSiteKey:
        turnstileSiteKey && process.env.TURNSTILE_SECRET_KEY?.trim()
          ? turnstileSiteKey
          : null,
      emailOtpEnabled: isEmailOtpEnabled(),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
