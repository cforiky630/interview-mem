import { NextResponse } from "next/server";
import { z } from "zod";
import { and, asc, desc, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import { getDb, type Database } from "@/db";
import {
  authorSubscriptions,
  deckGroups,
  decks,
  questions,
  releases,
  subscriptions,
} from "@/db/schema";
import { body, route } from "@/server/api";
import {
  ownedDeck,
  publishedDeckGroup,
  publishedQuestion,
} from "@/server/workspace";
import { computeUnpublishedDiff } from "@/lib/subscriptions";
import { AppError } from "@/server/errors";
import { deckIdSchema } from "@/server/resource-ids";
import { deckFields, deckGroupNameSchema } from "@/server/content-fields";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const deckColorSchema = z.enum(["sage", "blue", "sand", "rose"]);
const publishVisibilitySchema = z.enum(["public", "unlisted"]);

const batchPublishItemSchema = z.object({
  deckId: deckIdSchema,
  expectedVersion: z.number().int().nonnegative(),
  visibility: publishVisibilitySchema.optional(),
  summary: z.string().max(1000).optional(),
});

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    ...deckFields,
    description: deckFields.description.default(""),
    groupName: deckGroupNameSchema.default(""),
    color: deckColorSchema.default("sage"),
  }),
  z.object({
    action: z.literal("edit"),
    deckId: deckIdSchema,
    expected: z.object({
      title: z.string(),
      description: z.string(),
      color: deckColorSchema.optional(),
      groupName: z.string().optional(),
    }),
    ...deckFields,
    color: deckColorSchema.optional(),
    groupName: deckGroupNameSchema.optional(),
  }),
  z.object({
    action: z.literal("setSubscriptionGroup"),
    deckId: deckIdSchema,
    groupName: deckGroupNameSchema,
  }),
  z.object({
    action: z.literal("renameDeckGroup"),
    from: z.string().trim().min(1, "请指定要重命名的题库分组。").max(40),
    to: deckGroupNameSchema,
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
      .min(1, "请至少选择一个要发布的题库。")
      .max(50, "单次最多批量发布 50 个题库。")
      .refine(
        (items) => new Set(items.map((i) => i.deckId)).size === items.length,
        "包含重复的题库标识。",
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
    groupName: deckGroupNameSchema.default(""),
  }),
  z.object({
    action: z.literal("batchSubscribe"),
    deckIds: z.array(deckIdSchema).min(1).max(50),
    groupName: deckGroupNameSchema.default(""),
  }),
  z.object({
    action: z.literal("unsubscribe"),
    deckId: deckIdSchema,
  }),
  z.object({
    action: z.literal("batchUnsubscribe"),
    deckIds: z.array(deckIdSchema).min(1).max(50),
  }),
  z.object({ action: z.literal("delete"), deckId: deckIdSchema }),
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
  },
): Promise<{ deckId: string; version: number; skipped: boolean }> {
  if (deck.publishedVersion !== options.expectedVersion) {
    throw new AppError(409, `「${deck.title}」已有新版本，请刷新后再发布。`);
  }
  const groupRows = await tx
    .select()
    .from(deckGroups)
    .where(and(eq(deckGroups.deckId, deck.id), eq(deckGroups.ownerId, userId)))
    .orderBy(
      asc(deckGroups.position),
      asc(deckGroups.createdAt),
      asc(deckGroups.id),
    );
  const items = await tx
    .select()
    .from(questions)
    .where(
      and(
        eq(questions.deckId, deck.id),
        eq(questions.ownerId, userId),
        isNull(questions.deletedAt),
      ),
    );
  if (!deck.publishedVersion && !items.some((q) => !q.archived)) {
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
        groups: groupRows.map(publishedDeckGroup),
        questions: items.map(publishedQuestion),
      },
      latest,
    );
    if (publishStatus === "synced" && deck.visibility === options.visibility) {
      return { deckId: deck.id, version: deck.publishedVersion, skipped: true };
    }
  }
  const version = deck.publishedVersion + 1;
  const history = await tx
    .select({ release: releases })
    .from(releases)
    .innerJoin(decks, eq(releases.deckId, decks.id))
    .where(eq(decks.ownerId, userId))
    .orderBy(desc(releases.version));
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
  const snapshots = items.map((q) => {
    const previous = prior.get(q.id);
    const id =
      previous?.id ??
      (publishedElsewhere.has(q.id) ? crypto.randomUUID() : q.id);
    if (id !== q.id && !previous)
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
      ...publishedQuestion(q),
      id,
      ...(id !== q.id ? { sourceQuestionId: q.id } : {}),
    };
  });
  // A moved question gets a separate published identity in the new collection.
  // Existing subscribers retain their original snapshot and study progress.
  if (aliases.length) await tx.insert(questions).values(aliases);
  await tx.insert(releases).values({
    deckId: deck.id,
    version,
    title: deck.title,
    description: deck.description,
    summary: options.summary,
    groups: groupRows.map(publishedDeckGroup),
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

  // Auto-subscribe opted-in followers ONLY on the very first public release (v0 -> v1).
  // Never auto-subscribe unlisted decks.
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
    const targets = followers.filter((f) => f.followerId !== userId);
    if (targets.length) {
      await tx
        .insert(subscriptions)
        .values(
          targets.map((f) => ({
            userId: f.followerId,
            deckId: deck.id,
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
  const [row] = await db
    .select({
      publishedVersion: decks.publishedVersion,
      seenVersion: subscriptions.seenVersion,
    })
    .from(subscriptions)
    .innerJoin(decks, eq(subscriptions.deckId, decks.id))
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.deckId, deckId),
      ),
    );
  if (!row) throw new AppError(404, "题库不可访问。");
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
  const [release] = await db
    .select({ version: releases.version })
    .from(releases)
    .where(
      and(eq(releases.deckId, deckId), eq(releases.version, targetVersion)),
    );
  if (!release) throw new AppError(404, "目标版本不存在。");
  await db
    .update(subscriptions)
    .set({ seenVersion: targetVersion, dismissedVersion: 0 })
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.deckId, deckId),
      ),
    );
  return { ok: true, syncedVersion: targetVersion };
}

export const GET = route(async (_request, user) =>
  Response.json(
    await (
      await getDb()
    )
      .select({ id: decks.id, title: decks.title })
      .from(decks)
      .where(and(eq(decks.ownerId, user.id), isNull(decks.deletedAt))),
  ),
);

export const POST = route(async (request, user) => {
  const data = await body(request, schema);
  const db = await getDb();
  if (data.action === "delete")
    return Response.json(
      await db.transaction(async (tx) => {
        const [deck] = await tx
          .select()
          .from(decks)
          .where(and(eq(decks.id, data.deckId), eq(decks.ownerId, user.id)))
          .for("update");
        if (!deck) throw new AppError(404, "题库不存在或没有管理权限。");
        const contents = await tx
          .select({ id: questions.id })
          .from(questions)
          .where(
            and(eq(questions.deckId, deck.id), eq(questions.ownerId, user.id)),
          )
          .orderBy(asc(questions.id))
          .for("update");
        if (contents.length)
          await tx
            .update(questions)
            .set({ deckId: null, groupId: null, updatedAt: new Date() })
            .where(
              inArray(
                questions.id,
                contents.map((q) => q.id),
              ),
            );
        // Retain only publication identity for existing subscribers; there is no category recycle bin.
        await tx
          .update(decks)
          .set({
            deletedAt: deck.deletedAt ?? new Date(),
            updatedAt: new Date(),
          })
          .where(eq(decks.id, deck.id));
        return { ok: true, detached: contents.length };
      }),
    );
  if (data.action === "create") {
    const [deck] = await db
      .insert(decks)
      .values({
        id: crypto.randomUUID(),
        ownerId: user.id,
        title: data.title,
        description: data.description,
        groupName: data.groupName,
        color: data.color,
      })
      .returning();
    return NextResponse.json({ deck });
  }
  if (data.action === "edit") {
    const [changed] = await db
      .update(decks)
      .set({
        title: data.title,
        description: data.description,
        ...(data.color ? { color: data.color } : {}),
        ...(data.groupName !== undefined ? { groupName: data.groupName } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(decks.id, data.deckId),
          eq(decks.ownerId, user.id),
          isNull(decks.deletedAt),
          eq(decks.title, data.expected.title),
          eq(decks.description, data.expected.description),
          ...(data.expected.color !== undefined
            ? [eq(decks.color, data.expected.color)]
            : []),
          ...(data.expected.groupName !== undefined
            ? [eq(decks.groupName, data.expected.groupName)]
            : []),
        ),
      )
      .returning({ id: decks.id });
    if (!changed) {
      await ownedDeck(user.id, data.deckId);
      throw new AppError(
        409,
        "题库信息已更新，请重新生成修改建议。",
        "CONFLICT",
      );
    }
    return Response.json({ ok: true });
  }
  if (data.action === "setSubscriptionGroup") {
    const [changed] = await db
      .update(subscriptions)
      .set({ groupName: data.groupName })
      .where(
        and(
          eq(subscriptions.userId, user.id),
          eq(subscriptions.deckId, data.deckId),
        ),
      )
      .returning({ deckId: subscriptions.deckId });
    if (!changed) throw new AppError(404, "未订阅该题库。");
    return Response.json({ ok: true });
  }
  if (data.action === "renameDeckGroup") {
    const result = await db.transaction(async (tx) => {
      const now = new Date();
      const updatedOwned = await tx
        .update(decks)
        .set({ groupName: data.to, updatedAt: now })
        .where(
          and(
            eq(decks.ownerId, user.id),
            isNull(decks.deletedAt),
            eq(decks.groupName, data.from),
          ),
        )
        .returning({ id: decks.id });
      const updatedSubs = await tx
        .update(subscriptions)
        .set({ groupName: data.to })
        .where(
          and(
            eq(subscriptions.userId, user.id),
            eq(subscriptions.groupName, data.from),
          ),
        )
        .returning({ deckId: subscriptions.deckId });
      return { ok: true, updated: updatedOwned.length + updatedSubs.length };
    });
    return Response.json(result);
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
          .for("update");
        if (!deck) throw new AppError(404, "题库不存在或没有编辑权限。");
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
          .for("update");
        const deckById = new Map(locked.map((d) => [d.id, d]));
        if (deckById.size !== deckIds.length) {
          throw new AppError(404, "部分题库不存在或没有发布权限。");
        }
        const results: { deckId: string; version: number; skipped: boolean }[] =
          [];
        for (const item of data.items) {
          const deck = deckById.get(item.deckId)!;
          const published = await publishDeckInTx(tx, user.id, deck, {
            expectedVersion: item.expectedVersion,
            visibility: item.visibility ?? data.defaultVisibility,
            summary: item.summary ?? data.defaultSummary,
            skipUnchanged: data.skipUnchanged,
          });
          results.push(published);
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
      throw new AppError(404, "题库尚未发布或不可订阅。");
    if (deck.ownerId === user.id)
      throw new AppError(400, "你已经拥有这个题库。");
    await db
      .insert(subscriptions)
      .values({
        userId: user.id,
        deckId: deck.id,
        groupName: data.groupName,
        seenVersion: deck.publishedVersion,
        dismissedVersion: 0,
      })
      .onConflictDoNothing();
    return NextResponse.json({ ok: true });
  }
  if (data.action === "batchSubscribe") {
    const uniqueIds = [...new Set(data.deckIds)];
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
          groupName: data.groupName,
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
    if (!row) throw new AppError(404, "题库不可访问。");
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
    const updated = await db.transaction(async (tx) => {
      const outdated = await tx
        .select({
          deckId: subscriptions.deckId,
          publishedVersion: decks.publishedVersion,
        })
        .from(subscriptions)
        .innerJoin(decks, eq(subscriptions.deckId, decks.id))
        .where(
          and(
            eq(subscriptions.userId, user.id),
            gt(decks.publishedVersion, subscriptions.seenVersion),
            targetIds?.length
              ? inArray(subscriptions.deckId, targetIds)
              : undefined,
          ),
        );
      for (const item of outdated) {
        await tx
          .update(subscriptions)
          .set({ seenVersion: item.publishedVersion, dismissedVersion: 0 })
          .where(
            and(
              eq(subscriptions.userId, user.id),
              eq(subscriptions.deckId, item.deckId),
            ),
          );
      }
      return outdated.length;
    });
    return NextResponse.json({ ok: true, updated });
  }
  return NextResponse.json({ ok: true });
}, true);
