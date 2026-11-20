import { NextResponse } from "next/server";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { route } from "@/server/api";
import { deckIdSchema } from "@/server/resource-ids";
import { getDb } from "@/db";
import { decks, releases, subscriptions, user as users } from "@/db/schema";
export const GET = route(async (request, user) => {
  const db = await getDb();
  const shared = new URL(request.url).searchParams.get("id");
  if (shared) deckIdSchema.parse(shared);
  const rows = await db
    .select({ deck: decks, release: releases, ownerName: users.name })
    .from(decks)
    .innerJoin(
      releases,
      and(
        eq(releases.deckId, decks.id),
        eq(releases.version, decks.publishedVersion),
      ),
    )
    .innerJoin(users, eq(decks.ownerId, users.id))
    .where(
      and(
        gt(decks.publishedVersion, 0),
        isNull(decks.deletedAt),
        shared
          ? and(
              eq(decks.id, shared),
              or(
                eq(decks.visibility, "public"),
                eq(decks.visibility, "unlisted"),
              ),
            )
          : eq(decks.visibility, "public"),
      ),
    )
    .orderBy(desc(decks.updatedAt))
    .limit(100);
  const subs = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, user.id));
  return NextResponse.json(
    rows.map(({ deck, release, ownerName }) => ({
      id: deck.id,
      title: release.title,
      description: release.description,
      color: deck.color,
      ownerName,
      publishedVersion: deck.publishedVersion,
      count: release.questions.filter((q) => !q.archived).length,
      subscribed: subs.some((s) => s.deckId === deck.id),
      isOwner: deck.ownerId === user.id,
      updatedAt: deck.updatedAt.toISOString(),
    })),
  );
});
