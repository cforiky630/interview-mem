import { NextResponse } from "next/server";
import { route } from "@/server/api";
import { getWorkspace, getWorkspaceEtag } from "@/server/workspace";
import { seedSamples } from "@/server/seed";
export const runtime = "nodejs";
export const GET = route(async (request, user) => {
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch) {
    const etag = await getWorkspaceEtag(user.id);
    if (ifNoneMatch === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": "no-store" },
      });
    }
  }
  const workspace = await getWorkspace(user);
  const etag = await getWorkspaceEtag(user.id);
  return NextResponse.json(workspace, {
    headers: { ETag: etag, "Cache-Control": "no-store" },
  });
});
export const POST = route(
  async (_request, user) => NextResponse.json(await seedSamples(user.id)),
  true,
);
