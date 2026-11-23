import { sql } from "drizzle-orm";
import { getDb } from "@/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const db = await getDb();
    // Check schema readiness without reading any user's data.
    await db.execute(
      sql`select c.base_url, i.preview, q.owner_id, q.purged_at, p.daily_new_limit, conv.attempt, conv.scope, conv.deck_id, cm.edits, cm.meta from ai_credentials c cross join imports i cross join questions q cross join preferences p cross join conversations conv cross join chat_messages cm limit 0`,
    );
    return Response.json(
      { status: "ok" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
