import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { decks, questions, releases, subscriptions } from "@/db/schema";
import { body, route } from "@/server/api";
import { ownedDeck, publishedQuestion } from "@/server/workspace";
import { AppError } from "@/server/errors";

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    title: z.string().trim().min(1).max(80),
    description: z.string().max(500).default(""),
    color: z.enum(["sage", "blue", "sand", "rose"]).default("sage"),
  }),
  z.object({
    action: z.literal("publish"),
    deckId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    visibility: z.enum(["public", "unlisted"]),
    summary: z.string().max(1000).default(""),
  }),
  z.object({ action: z.literal("subscribe"), deckId: z.string().uuid() }),
  z.object({ action: z.literal("unsubscribe"), deckId: z.string().uuid() }),
  z.object({
    action: z.literal("acknowledge"),
    deckId: z.string().uuid(),
    version: z.number().int().nonnegative(),
  }),
]);
export const POST = route(async (request, user) => {
  const data = await body(request, schema);
  const db = await getDb();
  if (data.action === "create") {
    const [deck] = await db
      .insert(decks)
      .values({
        id: crypto.randomUUID(),
        ownerId: user.id,
        title: data.title,
        description: data.description,
        color: data.color,
      })
      .returning();
    return NextResponse.json({ deck });
  }
  if (data.action === "publish") {
    await ownedDeck(user.id, data.deckId);
    return NextResponse.json(
      await db.transaction(async (tx) => {
        const [deck] = await tx
          .select()
          .from(decks)
          .where(and(eq(decks.id, data.deckId), eq(decks.ownerId, user.id)))
          .for("update");
        if (!deck || deck.publishedVersion !== data.expectedVersion)
          throw new AppError(409, "题库已有新版本，请刷新后再发布。");
        const items = await tx
          .select()
          .from(questions)
          .where(eq(questions.deckId, data.deckId));
        if (
          !items.length ||
          (!deck.publishedVersion && !items.some((q) => !q.archived))
        )
          throw new AppError(400, "题库还没有题目，请先导入。");
        const version = deck.publishedVersion + 1;
        await tx.insert(releases).values({
          deckId: deck.id,
          version,
          title: deck.title,
          description: deck.description,
          summary: data.summary,
          questions: items.map(publishedQuestion),
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
    if (!deck || !deck.publishedVersion || deck.visibility === "private")
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
    const [deck] = await db
      .select()
      .from(decks)
      .where(eq(decks.id, data.deckId));
    if (!deck || data.version > deck.publishedVersion)
      throw new AppError(400, "版本号无效。");
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
