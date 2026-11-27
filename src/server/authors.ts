import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import type { Database } from "@/db";
import { decks } from "@/db/schema";

export async function findFollowableAuthorIds(
  db: Pick<Database, "selectDistinct">,
  authorIds: readonly string[],
): Promise<string[]> {
  if (!authorIds.length) return [];
  const rows = await db
    .selectDistinct({ id: decks.ownerId })
    .from(decks)
    .where(
      and(
        inArray(decks.ownerId, authorIds),
        eq(decks.visibility, "public"),
        gt(decks.publishedVersion, 0),
        isNull(decks.deletedAt),
      ),
    );
  return rows.map((row) => row.id);
}
