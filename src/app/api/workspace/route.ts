import { NextResponse } from "next/server";
import { route } from "@/server/api";
import { getWorkspace } from "@/server/workspace";
import { seedSamples } from "@/server/seed";
export const runtime = "nodejs";
export const GET = route(async (_request, user) =>
  NextResponse.json(await getWorkspace(user), {
    headers: { "Cache-Control": "no-store" },
  }),
);
export const POST = route(
  async (_request, user) => NextResponse.json(await seedSamples(user.id)),
  true,
);
