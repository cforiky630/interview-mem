import { NextResponse } from "next/server";
import { z } from "zod";
import { body, route } from "@/server/api";
import { restorePersonalBackup } from "@/server/backup-restore";

export const runtime = "nodejs";

export const POST = route(async (request, user) => {
  const raw = await body(request, z.unknown(), 20 * 1024 * 1024);
  return NextResponse.json(await restorePersonalBackup(user.id, raw));
}, true);
