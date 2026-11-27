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
  const ifNoneMatch = request.headers.get("if-none-match");
  let precomputedEtag: string | null = null;
  if (ifNoneMatch) {
    precomputedEtag = await getWorkspaceEtag(user.id);
    if (ifNoneMatch === precomputedEtag) {
      return new NextResponse(null, {
        status: 304,
        headers: { ETag: precomputedEtag, "Cache-Control": "no-store" },
      });
    }
  }
  const workspace = await getWorkspace(user);
  const etag = precomputedEtag ?? (await getWorkspaceEtag(user.id));
  return NextResponse.json(workspace, {
    headers: { ETag: etag, "Cache-Control": "no-store" },
  });
});
export const POST = route(
  async (_request, user) =>
    withWorkspaceEtag(user.id, NextResponse.json(await seedSamples(user.id))),
  true,
);
