import { NextResponse } from "next/server";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { route } from "@/server/api";
import { deckIdSchema } from "@/server/resource-ids";
import { AppError } from "@/server/errors";
import { getDb } from "@/db";
import {
  authorSubscriptions,
  decks,
  releases,
  subscriptions,
  user as users,
  type PublishedDeckGroup,
  type PublishedQuestion,
} from "@/db/schema";
import type {
  CatalogAuthorView,
  CatalogDeck,
  CatalogDeckPreview,
  RichCatalogResponse,
} from "@/lib/types";
import { markdownDocument, mergeQuestionTags } from "@/lib/markdown-source";

const authorQuerySchema = z.string().trim().min(1).max(128);

function topTagsFromQuestions(qs: readonly PublishedQuestion[], limit = 5): string[] {
  const counts = new Map<string, number>();
  for (const q of qs) {
    if (q.archived) continue;
    const noteTags =
      q.answer.startsWith("---") || q.answer.startsWith("\uFEFF---")
        ? markdownDocument(q.answer).tags
        : [];
    for (const tag of mergeQuestionTags(q.tags, noteTags)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
    .slice(0, limit)
    .map(([tag]) => tag);
}

type RawCatalogRow = {
  deck: typeof decks.$inferSelect;
  ownerName: string;
  release: typeof releases.$inferSelect;
};

function toCatalogDeck(
  row: RawCatalogRow,
  userId: string,
  subMap: Map<string, typeof subscriptions.$inferSelect>,
  followedAuthorSet: Set<string>,
  subCountMap: Map<string, number>,
): CatalogDeck {
  const active = row.release.questions.filter((q) => !q.archived);
  const sub = subMap.get(row.deck.id);
  const syncedVersion = sub ? sub.seenVersion : null;
  return {
    id: row.deck.id,
    title: row.release.title,
    description: row.release.description,
    color: row.deck.color,
    ownerId: row.deck.ownerId,
    ownerName: row.ownerName,
    publishedVersion: row.deck.publishedVersion,
    releaseSummary: row.release.summary ?? "",
    publishedAt: row.release.createdAt.toISOString(),
    count: active.length,
    groupCount: (row.release.groups ?? []).length,
    subscriberCount: subCountMap.get(row.deck.id) ?? 0,
    tags: topTagsFromQuestions(active),
    subscribed: Boolean(sub),
    syncedVersion,
    hasUpdate: Boolean(
      sub && row.deck.publishedVersion > sub.seenVersion,
    ),
    authorFollowed: followedAuthorSet.has(row.deck.ownerId),
    isOwner: row.deck.ownerId === userId,
    updatedAt: row.deck.updatedAt.toISOString(),
  };
}

export const GET = route(async (request, user) => {
  const db = await getDb();
  const params = new URL(request.url).searchParams;
  const shared = params.get("id");
  const mode = params.get("mode");
  const preview = params.get("preview") === "1";
  const authorParam = params.get("author");
  if (shared) deckIdSchema.parse(shared);
  if (authorParam) authorQuerySchema.parse(authorParam);

  // Mode 1: Lightweight deck preview (groups + up to 40 sample question titles) before subscribing.
  if (preview) {
    if (!shared) throw new AppError(400, "缺少要预览的题库标识。");
    const [row] = await db
      .select({
        deck: decks,
        ownerName: users.name,
        release: releases,
      })
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
          eq(decks.id, shared),
          gt(decks.publishedVersion, 0),
          isNull(decks.deletedAt),
          or(
            eq(decks.visibility, "public"),
            eq(decks.visibility, "unlisted"),
            eq(decks.ownerId, user.id),
          ),
        ),
      );
    if (!row) throw new AppError(404, "题库不存在或未公开。");

    const [subRows, followRows, countRows] = await Promise.all([
      db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.userId, user.id),
            eq(subscriptions.deckId, row.deck.id),
          ),
        ),
      db
        .select({ authorId: authorSubscriptions.authorId })
        .from(authorSubscriptions)
        .where(
          and(
            eq(authorSubscriptions.followerId, user.id),
            eq(authorSubscriptions.authorId, row.deck.ownerId),
          ),
        ),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(subscriptions)
        .where(eq(subscriptions.deckId, row.deck.id)),
    ]);

    const subMap = new Map(subRows.map((s) => [s.deckId, s]));
    const followedSet = new Set(followRows.map((f) => f.authorId));
    const subCountMap = new Map([[row.deck.id, countRows[0]?.count ?? 0]]);
    const catalogDeck = toCatalogDeck(
      row,
      user.id,
      subMap,
      followedSet,
      subCountMap,
    );

    const activeQuestions = row.release.questions.filter((q) => !q.archived);
    const releaseGroups: PublishedDeckGroup[] = [
      ...(row.release.groups ?? []),
    ].sort(
      (a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id),
    );
    const groupOrder = new Map(releaseGroups.map((g, idx) => [g.id, idx]));
    const countByGroup = new Map<string, number>();
    for (const q of activeQuestions) {
      if (q.groupId && groupOrder.has(q.groupId)) {
        countByGroup.set(q.groupId, (countByGroup.get(q.groupId) ?? 0) + 1);
      }
    }
    const orderedQuestions = [...activeQuestions].sort((a, b) => {
      const ga = a.groupId ? (groupOrder.get(a.groupId) ?? 1e9) : 1e9;
      const gb = b.groupId ? (groupOrder.get(b.groupId) ?? 1e9) : 1e9;
      if (ga !== gb) return ga - gb;
      const posDiff = (a.position ?? 0) - (b.position ?? 0);
      if (posDiff !== 0) return posDiff;
      return Date.parse(a.createdAt) - Date.parse(b.createdAt);
    });

    const payload: CatalogDeckPreview = {
      deck: catalogDeck,
      groups: releaseGroups.map((g) => ({
        id: g.id,
        category: g.category ?? "",
        title: g.title,
        description: g.description ?? "",
        position: g.position ?? 0,
        count: countByGroup.get(g.id) ?? 0,
      })),
      sampleQuestions: orderedQuestions.slice(0, 40).map((q) => ({
        id: q.id,
        title: q.title,
        groupId: q.groupId && groupOrder.has(q.groupId) ? q.groupId : null,
        tags: q.tags.slice(0, 4),
        hasAnswer: Boolean(q.answer.trim()),
      })),
      totalQuestions: activeQuestions.length,
    };
    return NextResponse.json(payload);
  }

  // Mode 2 & 3: Default array (`CatalogDeck[]`) OR `?mode=rich` (`RichCatalogResponse`).
  const isRich = mode === "rich";
  const rows = await db
    .select({
      deck: decks,
      ownerName: users.name,
      release: releases,
    })
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
        !isRich && shared
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
    .orderBy(desc(releases.createdAt), desc(decks.updatedAt))
    .limit(isRich ? 200 : 100);

  // In rich mode, if deep-linked to a specific shared (possibly unlisted) deck not in public rows, fetch it too.
  let sharedRow: RawCatalogRow | null = null;
  if (isRich && shared) {
    const existing = rows.find((r) => r.deck.id === shared);
    if (existing) {
      sharedRow = existing;
    } else {
      const [found] = await db
        .select({
          deck: decks,
          ownerName: users.name,
          release: releases,
        })
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
            eq(decks.id, shared),
            gt(decks.publishedVersion, 0),
            isNull(decks.deletedAt),
            or(
              eq(decks.visibility, "public"),
              eq(decks.visibility, "unlisted"),
              eq(decks.ownerId, user.id),
            ),
          ),
        );
      sharedRow = found ?? null;
    }
  }

  const allRows =
    sharedRow && !rows.some((r) => r.deck.id === sharedRow!.deck.id)
      ? [...rows, sharedRow]
      : rows;
  const deckIds = allRows.map((r) => r.deck.id);
  const authorIds = [...new Set(allRows.map((r) => r.deck.ownerId))];

  const [subs, myFollows, deckSubCounts, authorFollowerCounts] =
    await Promise.all([
      db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.userId, user.id)),
      db
        .select()
        .from(authorSubscriptions)
        .where(eq(authorSubscriptions.followerId, user.id)),
      deckIds.length
        ? db
            .select({
              deckId: subscriptions.deckId,
              count: sql<number>`count(*)::int`,
            })
            .from(subscriptions)
            .where(inArray(subscriptions.deckId, deckIds))
            .groupBy(subscriptions.deckId)
        : [],
      isRich && authorIds.length
        ? db
            .select({
              authorId: authorSubscriptions.authorId,
              count: sql<number>`count(*)::int`,
            })
            .from(authorSubscriptions)
            .where(inArray(authorSubscriptions.authorId, authorIds))
            .groupBy(authorSubscriptions.authorId)
        : [],
    ]);

  const subMap = new Map(subs.map((s) => [s.deckId, s]));
  const followMap = new Map(myFollows.map((f) => [f.authorId, f]));
  const followedAuthorSet = new Set(followMap.keys());
  const subCountMap = new Map(deckSubCounts.map((c) => [c.deckId, c.count]));
  const followerCountMap = new Map(
    authorFollowerCounts.map((c) => [c.authorId, c.count]),
  );

  const catalogDecks = rows.map((row) =>
    toCatalogDeck(row, user.id, subMap, followedAuthorSet, subCountMap),
  );

  if (!isRich) {
    return NextResponse.json(catalogDecks);
  }

  // Aggregate creator profiles from public decks.
  const authorBuckets = new Map<string, CatalogDeck[]>();
  for (const d of catalogDecks) {
    const list = authorBuckets.get(d.ownerId);
    if (list) list.push(d);
    else authorBuckets.set(d.ownerId, [d]);
  }
  const authors: CatalogAuthorView[] = Array.from(
    authorBuckets.entries(),
    ([authorId, list]) => {
      const follow = followMap.get(authorId);
      const subscribedDeckCount = list.filter((d) => d.subscribed).length;
      const latestPublishedAt = list.reduce(
        (max, d) => (d.publishedAt > max ? d.publishedAt : max),
        list[0].publishedAt,
      );
      return {
        id: authorId,
        name: list[0].ownerName,
        deckCount: list.length,
        questionCount: list.reduce((sum, d) => sum + d.count, 0),
        followerCount: followerCountMap.get(authorId) ?? 0,
        subscriberCount: list.reduce((sum, d) => sum + d.subscriberCount, 0),
        followed: Boolean(follow),
        autoSubscribeNew: Boolean(follow?.autoSubscribeNew),
        subscribedDeckCount,
        unsubscribedDeckCount:
          authorId === user.id
            ? 0
            : Math.max(0, list.length - subscribedDeckCount),
        latestPublishedAt,
        isSelf: authorId === user.id,
        decks: list.map((d) => ({
          id: d.id,
          title: d.title,
          count: d.count,
          color: d.color,
          subscribed: d.subscribed,
        })),
      };
    },
  ).sort((a, b) => {
    if (a.followed !== b.followed) return a.followed ? -1 : 1;
    return (
      Date.parse(b.latestPublishedAt) - Date.parse(a.latestPublishedAt) ||
      b.deckCount - a.deckCount
    );
  });

  const sharedDeck = sharedRow
    ? toCatalogDeck(sharedRow, user.id, subMap, followedAuthorSet, subCountMap)
    : null;
  const focusedAuthor = authorParam
    ? (authors.find((a) => a.id === authorParam) ?? null)
    : null;

  const response: RichCatalogResponse = {
    decks: catalogDecks,
    authors,
    ...(shared ? { sharedDeck } : {}),
    ...(authorParam ? { focusedAuthor } : {}),
  };
  return NextResponse.json(response);
});
