import { NextResponse } from "next/server";
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import {
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
import { AppError } from "@/server/errors";
import { deckIdSchema } from "@/server/resource-ids";
import { deckFields, deckGroupNameSchema } from "@/server/content-fields";

const deckColorSchema = z.enum(["sage", "blue", "sand", "rose"]);

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
    visibility: z.enum(["public", "unlisted"]),
    summary: z.string().max(1000).default(""),
  }),
  z.object({ action: z.literal("subscribe"), deckId: deckIdSchema }),
  z.object({ action: z.literal("unsubscribe"), deckId: deckIdSchema }),
  z.object({ action: z.literal("delete"), deckId: deckIdSchema }),
  z.object({
    action: z.literal("acknowledge"),
    deckId: deckIdSchema,
    version: z.number().int().nonnegative(),
  }),
]);
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
        if (!deck || deck.publishedVersion !== data.expectedVersion)
          throw new AppError(409, "题库已有新版本，请刷新后再发布。");
        const groupRows = await tx
          .select()
          .from(deckGroups)
          .where(
            and(
              eq(deckGroups.deckId, data.deckId),
              eq(deckGroups.ownerId, user.id),
            ),
          )
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
              eq(questions.deckId, data.deckId),
              eq(questions.ownerId, user.id),
              isNull(questions.deletedAt),
            ),
          );
        if (!deck.publishedVersion && !items.some((q) => !q.archived))
          throw new AppError(400, "题库还没有题目，请先导入。");
        const version = deck.publishedVersion + 1;
        const history = await tx
          .select({ release: releases })
          .from(releases)
          .innerJoin(decks, eq(releases.deckId, decks.id))
          .where(eq(decks.ownerId, user.id))
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
              ownerId: user.id,
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
          summary: data.summary,
          groups: groupRows.map(publishedDeckGroup),
          questions: snapshots,
        });
        await tx
          .update(decks)
          .set({
            publishedVersion: version,
            visibility: data.visibility,
            updatedAt: new Date(),
          })
          .where(eq(decks.id, deck.id));
        return { version };
      }),
    );
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
        seenVersion: deck.publishedVersion,
      })
      .onConflictDoNothing();
  }
  if (data.action === "unsubscribe")
    await db
      .delete(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, user.id),
          eq(subscriptions.deckId, data.deckId),
        ),
      );
  if (data.action === "acknowledge") {
    const [row] = await db
      .select({ version: decks.publishedVersion })
      .from(subscriptions)
      .innerJoin(decks, eq(subscriptions.deckId, decks.id))
      .where(
        and(
          eq(subscriptions.userId, user.id),
          eq(subscriptions.deckId, data.deckId),
        ),
      );
    if (!row) throw new AppError(404, "题库不可访问。");
    if (data.version > row.version) throw new AppError(400, "版本号无效。");
    await db
      .update(subscriptions)
      .set({ seenVersion: data.version })
      .where(
        and(
          eq(subscriptions.userId, user.id),
          eq(subscriptions.deckId, data.deckId),
        ),
      );
  }
  return NextResponse.json({ ok: true });
}, true);
