import { NextResponse } from "next/server";
import { z } from "zod";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  sql,
} from "drizzle-orm";
import { getDb, type Database } from "@/db";
import {
  authorSubscriptions,
  decks,
  questions,
  releases,
  subscriptions,
} from "@/db/schema";
import { body, route } from "@/server/api";
import {
  buildOwnedPublishSubtree,
  ownedDeck,
  withWorkspaceEtag,
} from "@/server/workspace";
import { computeUnpublishedDiff } from "@/lib/subscriptions";
import { AppError } from "@/server/errors";
import { deckIdSchema } from "@/server/resource-ids";
import { deckFields } from "@/server/content-fields";
import {
  buildServerFolderTree,
  collectOwnedAncestorIds,
  createFolderInTx,
  deleteFolderToTrashInTx,
  dissolveFolderInTx,
  editFolderInTx,
  folderDepth,
  groupIntoNewFolderInTx,
  loadActiveOwnedFolders,
  moveFolderInTx,
  placeSubscriptionInTx,
} from "@/server/folders";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const deckColorSchema = z.enum(["sage", "blue", "sand", "rose"]);
const publishVisibilitySchema = z.enum(["public", "unlisted"]);
const conflictStrategySchema = z.enum(["abort", "merge", "keepBoth"]);

const batchPublishItemSchema = z.object({
  deckId: deckIdSchema,
  expectedVersion: z.number().int().nonnegative(),
  visibility: publishVisibilitySchema.optional(),
  summary: z.string().max(1000).optional(),
  skipUnchanged: z.boolean().optional(),
});

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    ...deckFields,
    parentId: deckIdSchema.nullable().default(null),
    description: deckFields.description.default(""),
    color: deckColorSchema.default("sage"),
  }),
  z.object({
    action: z.literal("edit"),
    deckId: deckIdSchema,
    expected: z.object({
      title: z.string(),
      description: z.string(),
      color: deckColorSchema.optional(),
    }),
    ...deckFields,
    color: deckColorSchema.optional(),
  }),
  z.object({
    action: z.literal("moveFolder"),
    folderId: deckIdSchema,
    targetParentId: deckIdSchema.nullable(),
    conflictStrategy: conflictStrategySchema.default("abort"),
  }),
  z.object({
    action: z.literal("groupIntoNew"),
    parentId: deckIdSchema.nullable().default(null),
    ...deckFields,
    description: deckFields.description.default(""),
    color: deckColorSchema.default("sage"),
    folderIds: z.array(deckIdSchema).max(100).default([]),
    questionIds: z.array(z.string().uuid()).max(200).default([]),
    subscriptionDeckIds: z.array(deckIdSchema).max(100).default([]),
    conflictStrategy: conflictStrategySchema.default("abort"),
  }),
  z.object({
    action: z.literal("dissolve"),
    folderId: deckIdSchema,
    conflictStrategy: conflictStrategySchema.default("abort"),
  }),
  z.object({
    action: z.literal("delete"),
    deckId: deckIdSchema,
    mode: z.enum(["dissolve", "trash"]).default("dissolve"),
    conflictStrategy: conflictStrategySchema.default("keepBoth"),
  }),
  z.object({
    action: z.literal("placeSubscription"),
    deckId: deckIdSchema,
    folderId: deckIdSchema.nullable(),
  }),
  z.object({
    action: z.literal("publish"),
    deckId: deckIdSchema,
    expectedVersion: z.number().int().nonnegative(),
    visibility: publishVisibilitySchema,
    summary: z.string().max(1000).default(""),
  }),
  z.object({
    action: z.literal("batchPublish"),
    items: z
      .array(batchPublishItemSchema)
      .min(1, "请至少选择一个要发布的文件夹。")
      .max(50, "单次最多批量发布 50 个文件夹。")
      .refine(
        (items) => new Set(items.map((i) => i.deckId)).size === items.length,
        "包含重复的文件夹标识。",
      ),
    defaultVisibility: publishVisibilitySchema.default("public"),
    defaultSummary: z.string().max(1000).default(""),
    skipUnchanged: z.boolean().default(false),
  }),
  z.object({
    action: z.literal("unpublish"),
    deckId: deckIdSchema,
  }),
  z.object({
    action: z.literal("subscribe"),
    deckId: deckIdSchema,
    folderId: deckIdSchema.nullable().default(null),
  }),
  z.object({
    action: z.literal("batchSubscribe"),
    deckIds: z.array(deckIdSchema).min(1).max(50),
    folderId: deckIdSchema.nullable().default(null),
  }),
  z.object({
    action: z.literal("unsubscribe"),
    deckId: deckIdSchema,
  }),
  z.object({
    action: z.literal("batchUnsubscribe"),
    deckIds: z.array(deckIdSchema).min(1).max(50),
  }),
  z.object({
    action: z.literal("acknowledge"),
    deckId: deckIdSchema,
    version: z.number().int().nonnegative(),
  }),
  z.object({
    action: z.literal("applyUpdate"),
    deckId: deckIdSchema,
    targetVersion: z.number().int().positive().optional(),
  }),
  z.object({
    action: z.literal("dismissUpdate"),
    deckId: deckIdSchema,
    version: z.number().int().positive(),
  }),
  z.object({
    action: z.literal("applyAllUpdates"),
    deckIds: z.array(deckIdSchema).min(1).max(50).optional(),
  }),
]);

async function publishDeckInTx(
  tx: Transaction,
  userId: string,
  deck: typeof decks.$inferSelect,
  options: {
    expectedVersion: number;
    visibility: "public" | "unlisted";
    summary: string;
    skipUnchanged?: boolean;
    preloadedHistory?: { release: typeof releases.$inferSelect }[];
  },
): Promise<{ deckId: string; version: number; skipped: boolean }> {
  if (deck.publishedVersion !== options.expectedVersion) {
    throw new AppError(409, `「${deck.title}」已有新版本，请刷新后再发布。`);
  }

  // Load author's active folder tree to collect the recursive owned subtree (subscriptions structurally excluded).
  const ownedFolders = await loadActiveOwnedFolders(tx, userId);
  const ownedTree = buildServerFolderTree(ownedFolders);
  const rootFolder = ownedTree.byId.get(deck.id) ?? deck;
  const subtreeFolderIds = new Set<string>([deck.id]);
  {
    const stack = [deck.id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const child of ownedTree.children.get(cur) ?? []) {
        if (!subtreeFolderIds.has(child.id)) {
          subtreeFolderIds.add(child.id);
          stack.push(child.id);
        }
      }
    }
  }

  const rawItems = await tx
    .select()
    .from(questions)
    .where(
      and(
        eq(questions.ownerId, userId),
        inArray(questions.deckId, [...subtreeFolderIds]),
        isNull(questions.deletedAt),
        isNull(questions.purgedAt),
      ),
    );
  const subtree = buildOwnedPublishSubtree(ownedTree, rootFolder, rawItems);

  if (
    !deck.publishedVersion &&
    !subtree.rawQuestions.some((q) => !q.archived)
  ) {
    throw new AppError(400, `「${deck.title}」还没有题目，请先导入。`);
  }

  if (options.skipUnchanged && deck.publishedVersion > 0) {
    const [latest] = await tx
      .select()
      .from(releases)
      .where(
        and(
          eq(releases.deckId, deck.id),
          eq(releases.version, deck.publishedVersion),
        ),
      );
    const { publishStatus } = computeUnpublishedDiff(
      {
        title: deck.title,
        description: deck.description,
        groups: subtree.groups,
        questions: subtree.questions,
      },
      latest,
    );
    if (publishStatus === "synced" && deck.visibility === options.visibility) {
      return { deckId: deck.id, version: deck.publishedVersion, skipped: true };
    }
  }

  const version = deck.publishedVersion + 1;
  const history =
    options.preloadedHistory ??
    (await tx
      .select({ release: releases })
      .from(releases)
      .innerJoin(decks, eq(releases.deckId, decks.id))
      .where(eq(decks.ownerId, userId))
      .orderBy(desc(releases.version)));
  const prior = new Map<
    string,
    (typeof history)[number]["release"]["questions"][number]
  >();
  const publishedElsewhere = new Set<string>();
  for (const { release } of history)
    for (const item of release.questions) {
      const source = item.sourceQuestionId ?? item.id;
      if (release.deckId === deck.id) {
        if (!prior.has(source)) prior.set(source, item);
      } else publishedElsewhere.add(source);
    }

  const aliases: (typeof questions.$inferInsert)[] = [];
  const snapshots = subtree.questions.map((serialized) => {
    const sourceId = serialized.id;
    const previous = prior.get(sourceId);
    const id =
      previous?.id ??
      (publishedElsewhere.has(sourceId) ? crypto.randomUUID() : sourceId);
    if (id !== sourceId && !previous)
      aliases.push({
        id,
        ownerId: userId,
        deckId: null,
        title: "",
        answer: "",
        contentHash: `publication:${id}`,
        deletedAt: new Date(),
        purgedAt: new Date(),
      });
    return {
      ...serialized,
      id,
      ...(id !== sourceId ? { sourceQuestionId: sourceId } : {}),
    };
  });

  // Both moved questions and nested published folders get independent publication aliases so
  // every subscription has isolated study progress and release snapshots.
  if (aliases.length) await tx.insert(questions).values(aliases);
  await tx.insert(releases).values({
    deckId: deck.id,
    version,
    title: deck.title,
    description: deck.description,
    summary: options.summary,
    groups: subtree.groups,
    questions: snapshots,
  });
  await tx
    .update(decks)
    .set({
      publishedVersion: version,
      visibility: options.visibility,
      updatedAt: new Date(),
    })
    .where(eq(decks.id, deck.id));

  // Auto-subscribe opted-in followers ONLY on the very first public release (v0 -> v1),
  // AND skip any follower who already subscribes to a published ancestor of this folder!
  if (deck.publishedVersion === 0 && options.visibility === "public") {
    const followers = await tx
      .select({ followerId: authorSubscriptions.followerId })
      .from(authorSubscriptions)
      .where(
        and(
          eq(authorSubscriptions.authorId, userId),
          eq(authorSubscriptions.autoSubscribeNew, true),
        ),
      );
    let targets = followers
      .map((f) => f.followerId)
      .filter((id) => id !== userId);

    if (targets.length) {
      const ancestorIds = collectOwnedAncestorIds(ownedTree, deck.id);
      if (ancestorIds.length) {
        const coveredByAncestor = await tx
          .select({ userId: subscriptions.userId })
          .from(subscriptions)
          .where(
            and(
              inArray(subscriptions.userId, targets),
              inArray(subscriptions.deckId, ancestorIds),
            ),
          );
        const coveredSet = new Set(coveredByAncestor.map((r) => r.userId));
        targets = targets.filter((id) => !coveredSet.has(id));
      }
    }

    if (targets.length) {
      await tx
        .insert(subscriptions)
        .values(
          targets.map((followerId) => ({
            userId: followerId,
            deckId: deck.id,
            folderId: null,
            seenVersion: version,
            dismissedVersion: 0,
          })),
        )
        .onConflictDoNothing();
    }
  }

  return { deckId: deck.id, version, skipped: false };
}

async function applySubscriptionUpdate(
  db: Database,
  userId: string,
  deckId: string,
  requestedVersion?: number,
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        publishedVersion: decks.publishedVersion,
        visibility: decks.visibility,
        deletedAt: decks.deletedAt,
        seenVersion: subscriptions.seenVersion,
      })
      .from(subscriptions)
      .innerJoin(decks, eq(subscriptions.deckId, decks.id))
      .where(
        and(eq(subscriptions.userId, userId), eq(subscriptions.deckId, deckId)),
      )
      .for("update", { of: subscriptions });
    if (!row || row.deletedAt || row.visibility === "private")
      throw new AppError(404, "订阅不可访问或作者已取消公开。");
    const targetVersion =
      requestedVersion === undefined || requestedVersion === 0
        ? row.publishedVersion
        : requestedVersion;
    if (
      targetVersion < 1 ||
      targetVersion > row.publishedVersion ||
      targetVersion < row.seenVersion
    ) {
      throw new AppError(400, "版本号无效。");
    }
    const [release] = await tx
      .select({ version: releases.version })
      .from(releases)
      .where(
        and(eq(releases.deckId, deckId), eq(releases.version, targetVersion)),
      );
    if (!release) throw new AppError(404, "目标版本不存在。");
    const [updated] = await tx
      .update(subscriptions)
      .set({
        seenVersion: sql`GREATEST(${subscriptions.seenVersion}, ${targetVersion})`,
        dismissedVersion: 0,
      })
      .where(
        and(
          eq(subscriptions.userId, userId),
          eq(subscriptions.deckId, deckId),
          lte(subscriptions.seenVersion, targetVersion),
        ),
      )
      .returning({ seenVersion: subscriptions.seenVersion });
    if (updated) {
      return { ok: true, syncedVersion: updated.seenVersion };
    }
    const [latest] = await tx
      .select({ seenVersion: subscriptions.seenVersion })
      .from(subscriptions)
      .where(
        and(eq(subscriptions.userId, userId), eq(subscriptions.deckId, deckId)),
      );
    if (!latest) throw new AppError(404, "订阅不可访问。");
    return { ok: true, syncedVersion: latest.seenVersion };
  });
}

async function verifyTargetPlacementFolder(
  db: Database,
  userId: string,
  folderId: string | null,
): Promise<string | null> {
  if (!folderId) return null;
  const [folder] = await db
    .select({ id: decks.id })
    .from(decks)
    .where(
      and(
        eq(decks.id, folderId),
        eq(decks.ownerId, userId),
        isNull(decks.deletedAt),
      ),
    );
  if (!folder) throw new AppError(404, "目标文件夹不存在或没有访问权限。");
  return folder.id;
}

export const GET = route(async (_request, user) =>
  Response.json(
    await (
      await getDb()
    )
      .select({ id: decks.id, parentId: decks.parentId, title: decks.title })
      .from(decks)
      .where(and(eq(decks.ownerId, user.id), isNull(decks.deletedAt))),
  ),
);

export const POST = route(async (request, user) => {
  const response = await (async () => {
    const data = await body(request, schema);
  const db = await getDb();

  if (data.action === "create") {
    const deck = await db.transaction((tx) =>
      createFolderInTx(tx, user.id, {
        title: data.title,
        parentId: data.parentId,
        description: data.description,
        color: data.color,
      }),
    );
    return NextResponse.json({ id: deck.id, deck });
  }

  if (data.action === "edit") {
    await db.transaction((tx) =>
      editFolderInTx(tx, user.id, {
        deckId: data.deckId,
        title: data.title,
        description: data.description,
        color: data.color,
        expected: data.expected,
      }),
    );
    return Response.json({ ok: true, updatedAt: new Date().toISOString() });
  }

  if (data.action === "moveFolder") {
    return NextResponse.json(
      await db.transaction((tx) =>
        moveFolderInTx(tx, user.id, {
          folderId: data.folderId,
          targetParentId: data.targetParentId,
          conflictStrategy: data.conflictStrategy,
        }),
      ),
    );
  }

  if (data.action === "groupIntoNew") {
    return NextResponse.json(
      await db.transaction((tx) =>
        groupIntoNewFolderInTx(tx, user.id, {
          parentId: data.parentId,
          title: data.title,
          description: data.description,
          color: data.color,
          folderIds: data.folderIds,
          questionIds: data.questionIds,
          subscriptionDeckIds: data.subscriptionDeckIds,
          conflictStrategy: data.conflictStrategy,
        }),
      ),
    );
  }

  if (data.action === "dissolve") {
    return NextResponse.json(
      await db.transaction((tx) =>
        dissolveFolderInTx(tx, user.id, {
          folderId: data.folderId,
          conflictStrategy: data.conflictStrategy,
        }),
      ),
    );
  }

  if (data.action === "delete") {
    if (data.mode === "trash") {
      return NextResponse.json(
        await db.transaction((tx) =>
          deleteFolderToTrashInTx(tx, user.id, data.deckId),
        ),
      );
    }
    return NextResponse.json(
      await db.transaction((tx) =>
        dissolveFolderInTx(tx, user.id, {
          folderId: data.deckId,
          conflictStrategy: data.conflictStrategy,
        }),
      ),
    );
  }

  if (data.action === "placeSubscription") {
    await db.transaction((tx) =>
      placeSubscriptionInTx(tx, user.id, data.deckId, data.folderId),
    );
    return Response.json({ ok: true });
  }

  if (data.action === "publish") {
    await ownedDeck(user.id, data.deckId);
    return NextResponse.json(
      await db.transaction(async (tx) => {
        const [deck] = await tx
          .select()
          .from(decks)
          .where(
            and(
              eq(decks.id, data.deckId),
              eq(decks.ownerId, user.id),
              isNull(decks.deletedAt),
            ),
          )
          .for("no key update");
        if (!deck) throw new AppError(404, "文件夹不存在或没有编辑权限。");
        const published = await publishDeckInTx(tx, user.id, deck, {
          expectedVersion: data.expectedVersion,
          visibility: data.visibility,
          summary: data.summary,
        });
        return { version: published.version };
      }),
    );
  }

  if (data.action === "batchPublish") {
    const deckIds = data.items.map((item) => item.deckId);
    return NextResponse.json(
      await db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(decks)
          .where(
            and(
              inArray(decks.id, deckIds),
              eq(decks.ownerId, user.id),
              isNull(decks.deletedAt),
            ),
          )
          .orderBy(asc(decks.id))
          .for("no key update");
        const deckById = new Map(locked.map((d) => [d.id, d]));
        if (deckById.size !== deckIds.length) {
          throw new AppError(404, "部分文件夹不存在或没有发布权限。");
        }
        // Publish ancestors before descendants so autoSubscribeNew ancestor coverage deduplicates cleanly.
        const ownedTree = buildServerFolderTree(
          await loadActiveOwnedFolders(tx, user.id),
        );
        const orderedItems = [...data.items].sort(
          (a, b) =>
            folderDepth(ownedTree, a.deckId) - folderDepth(ownedTree, b.deckId),
        );
        const preloadedHistory = await tx
          .select({ release: releases })
          .from(releases)
          .innerJoin(decks, eq(releases.deckId, decks.id))
          .where(eq(decks.ownerId, user.id))
          .orderBy(desc(releases.version));
        const results: { deckId: string; version: number; skipped: boolean }[] =
          [];
        for (const item of orderedItems) {
          const deck = deckById.get(item.deckId)!;
          const published = await publishDeckInTx(tx, user.id, deck, {
            expectedVersion: item.expectedVersion,
            visibility: item.visibility ?? data.defaultVisibility,
            summary: item.summary ?? data.defaultSummary,
            skipUnchanged: item.skipUnchanged ?? data.skipUnchanged,
            preloadedHistory,
          });
          results.push(published);
          if (!published.skipped) {
            const [createdRel] = await tx
              .select({ release: releases })
              .from(releases)
              .where(
                and(
                  eq(releases.deckId, deck.id),
                  eq(releases.version, published.version),
                ),
              );
            if (createdRel) preloadedHistory.unshift(createdRel);
          }
        }
        const publishedCount = results.filter((r) => !r.skipped).length;
        const skippedCount = results.length - publishedCount;
        return { ok: true, results, publishedCount, skippedCount };
      }),
    );
  }

  if (data.action === "unpublish") {
    await ownedDeck(user.id, data.deckId);
    await db
      .update(decks)
      .set({ visibility: "private", updatedAt: new Date() })
      .where(
        and(
          eq(decks.id, data.deckId),
          eq(decks.ownerId, user.id),
          isNull(decks.deletedAt),
        ),
      );
    return NextResponse.json({ ok: true });
  }

  if (data.action === "subscribe") {
    const [deck] = await db
      .select()
      .from(decks)
      .where(eq(decks.id, data.deckId));
    if (
      !deck ||
      deck.deletedAt ||
      !deck.publishedVersion ||
      deck.visibility === "private"
    )
      throw new AppError(404, "内容尚未发布或不可订阅。");
    if (deck.ownerId === user.id)
      throw new AppError(400, "你已经拥有这个文件夹。");
    const targetFolderId = await verifyTargetPlacementFolder(
      db,
      user.id,
      data.folderId,
    );
    await db
      .insert(subscriptions)
      .values({
        userId: user.id,
        deckId: deck.id,
        folderId: targetFolderId,
        seenVersion: deck.publishedVersion,
        dismissedVersion: 0,
      })
      .onConflictDoNothing();
    return NextResponse.json({ ok: true });
  }

  if (data.action === "batchSubscribe") {
    const uniqueIds = [...new Set(data.deckIds)];
    const targetFolderId = await verifyTargetPlacementFolder(
      db,
      user.id,
      data.folderId,
    );
    const validDecks = await db
      .select({ id: decks.id, publishedVersion: decks.publishedVersion })
      .from(decks)
      .where(
        and(
          inArray(decks.id, uniqueIds),
          isNull(decks.deletedAt),
          gt(decks.publishedVersion, 0),
          ne(decks.visibility, "private"),
          ne(decks.ownerId, user.id),
        ),
      );
    if (!validDecks.length) {
      return NextResponse.json({
        ok: true,
        subscribed: 0,
        skipped: uniqueIds.length,
      });
    }
    const inserted = await db
      .insert(subscriptions)
      .values(
        validDecks.map((d) => ({
          userId: user.id,
          deckId: d.id,
          folderId: targetFolderId,
          seenVersion: d.publishedVersion,
          dismissedVersion: 0,
        })),
      )
      .onConflictDoNothing()
      .returning({ deckId: subscriptions.deckId });
    return NextResponse.json({
      ok: true,
      subscribed: inserted.length,
      skipped: uniqueIds.length - inserted.length,
    });
  }

  if (data.action === "unsubscribe") {
    await db
      .delete(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, user.id),
          eq(subscriptions.deckId, data.deckId),
        ),
      );
    return NextResponse.json({ ok: true });
  }

  if (data.action === "batchUnsubscribe") {
    const uniqueIds = [...new Set(data.deckIds)];
    const removed = await db
      .delete(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, user.id),
          inArray(subscriptions.deckId, uniqueIds),
        ),
      )
      .returning({ deckId: subscriptions.deckId });
    return NextResponse.json({ ok: true, removed: removed.length });
  }

  if (data.action === "acknowledge") {
    return NextResponse.json(
      await applySubscriptionUpdate(db, user.id, data.deckId, data.version),
    );
  }

  if (data.action === "applyUpdate") {
    return NextResponse.json(
      await applySubscriptionUpdate(
        db,
        user.id,
        data.deckId,
        data.targetVersion,
      ),
    );
  }

  if (data.action === "dismissUpdate") {
    const [row] = await db
      .select({
        publishedVersion: decks.publishedVersion,
        dismissedVersion: subscriptions.dismissedVersion,
      })
      .from(subscriptions)
      .innerJoin(decks, eq(subscriptions.deckId, decks.id))
      .where(
        and(
          eq(subscriptions.userId, user.id),
          eq(subscriptions.deckId, data.deckId),
        ),
      );
    if (!row) throw new AppError(404, "订阅不可访问。");
    if (data.version > row.publishedVersion) {
      throw new AppError(400, "版本号无效。");
    }
    const nextDismissed = Math.max(row.dismissedVersion, data.version);
    await db
      .update(subscriptions)
      .set({ dismissedVersion: nextDismissed })
      .where(
        and(
          eq(subscriptions.userId, user.id),
          eq(subscriptions.deckId, data.deckId),
        ),
      );
    return NextResponse.json({ ok: true, dismissedVersion: nextDismissed });
  }

  if (data.action === "applyAllUpdates") {
    const targetIds = data.deckIds ? [...new Set(data.deckIds)] : undefined;
    if (targetIds && !targetIds.length) {
      return NextResponse.json({ ok: true, updated: 0 });
    }
    const idFilter = targetIds?.length
      ? sql`and s.deck_id in (${sql.join(
          targetIds.map((id) => sql`${id}`),
          sql`, `,
        )})`
      : sql``;
    const updatedRows = await db.execute(sql`
      update ${subscriptions} as s
      set seen_version = d.published_version,
          dismissed_version = 0
      from ${decks} as d
      where s.deck_id = d.id
        and s.user_id = ${user.id}
        and d.deleted_at is null
        and d.visibility <> 'private'
        and d.published_version > s.seen_version
        ${idFilter}
      returning s.deck_id
    `);
    return NextResponse.json({ ok: true, updated: updatedRows.rows.length });
  }

  return NextResponse.json({ ok: true });
  })();
  return withWorkspaceEtag(user.id, response);
}, true);
