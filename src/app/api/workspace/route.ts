import { NextResponse } from "next/server";
import { route } from "@/server/api";
import {
  getWorkspace,
  getWorkspaceEtag,
  withWorkspaceEtag,
} from "@/server/workspace";
import { seedSamples } from "@/server/seed";
export const runtime = "nodejs";
export const GET = route(async (request, user) => {
  // Read the revision first so a concurrent write cannot label older data as current.
  const etag = await getWorkspaceEtag(user.id, true);
  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": "no-store" },
    });
  }
  const workspace = await getWorkspace(user);
  return NextResponse.json(workspace, {
    headers: { ETag: etag, "Cache-Control": "no-store" },
  });
});
export const POST = route(
  async (_request, user) =>
    withWorkspaceEtag(user.id, NextResponse.json(await seedSamples(user.id))),
  true,
);
