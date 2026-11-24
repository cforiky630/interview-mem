import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import {
  authorSubscriptions,
  decks,
  subscriptions,
  user as users,
} from "@/db/schema";
import { body, route } from "@/server/api";
import { AppError } from "@/server/errors";
import { deckGroupNameSchema } from "@/server/content-fields";

const authorIdSchema = z.string().trim().min(1, "缺少创作者标识。").max(128);

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("follow"),
    authorId: authorIdSchema,
    autoSubscribeNew: z.boolean().default(false),
    subscribeAll: z.boolean().default(false),
    groupName: deckGroupNameSchema.default(""),
  }),
  z.object({
    action: z.literal("unfollow"),
    authorId: authorIdSchema,
    unsubscribeDecks: z.boolean().default(false),
  }),
  z.object({
    action: z.literal("subscribeAll"),
    authorId: authorIdSchema,
    groupName: deckGroupNameSchema.default(""),
  }),
  z.object({
    action: z.literal("setAutoSubscribe"),
    authorId: authorIdSchema,
    autoSubscribeNew: z.boolean(),
  }),
]);

export const POST = route(async (request, user) => {
  const data = await body(request, schema);
  const db = await getDb();

  if (data.action === "follow") {
    if (data.authorId === user.id) {
      throw new AppError(400, "不能关注自己。");
    }
    const [author] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, data.authorId));
    if (!author) throw new AppError(404, "创作者不存在。");

    const subscribedDecks = await db.transaction(async (tx) => {
      await tx
        .insert(authorSubscriptions)
        .values({
          followerId: user.id,
          authorId: data.authorId,
          autoSubscribeNew: data.autoSubscribeNew,
        })
        .onConflictDoUpdate({
          target: [
            authorSubscriptions.followerId,
            authorSubscriptions.authorId,
          ],
          set: { autoSubscribeNew: data.autoSubscribeNew },
        });
      if (!data.subscribeAll) return 0;
      const publicDecks = await tx
        .select({ id: decks.id, publishedVersion: decks.publishedVersion })
        .from(decks)
        .where(
          and(
            eq(decks.ownerId, data.authorId),
            eq(decks.visibility, "public"),
            gt(decks.publishedVersion, 0),
            isNull(decks.deletedAt),
          ),
        );
      if (!publicDecks.length) return 0;
      const inserted = await tx
        .insert(subscriptions)
        .values(
          publicDecks.map((d) => ({
            userId: user.id,
            deckId: d.id,
            groupName: data.groupName,
            seenVersion: d.publishedVersion,
            dismissedVersion: 0,
          })),
        )
        .onConflictDoNothing()
        .returning({ deckId: subscriptions.deckId });
      return inserted.length;
    });

    return NextResponse.json({
      ok: true,
      followed: true,
      autoSubscribeNew: data.autoSubscribeNew,
      subscribedDecks,
    });
  }

  if (data.action === "unfollow") {
    await db.transaction(async (tx) => {
      await tx
        .delete(authorSubscriptions)
        .where(
          and(
            eq(authorSubscriptions.followerId, user.id),
            eq(authorSubscriptions.authorId, data.authorId),
          ),
        );
      if (data.unsubscribeDecks) {
        const authorDecks = await tx
          .select({ id: decks.id })
          .from(decks)
          .where(eq(decks.ownerId, data.authorId));
        if (authorDecks.length) {
          await tx
            .delete(subscriptions)
            .where(
              and(
                eq(subscriptions.userId, user.id),
                inArray(
                  subscriptions.deckId,
                  authorDecks.map((d) => d.id),
                ),
              ),
            );
        }
      }
    });
    return NextResponse.json({ ok: true, followed: false });
  }

  if (data.action === "subscribeAll") {
    if (data.authorId === user.id) {
      throw new AppError(400, "你已经拥有自己的全部题库。");
    }
    const [author] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, data.authorId));
    if (!author) throw new AppError(404, "创作者不存在。");
    const publicDecks = await db
      .select({ id: decks.id, publishedVersion: decks.publishedVersion })
      .from(decks)
      .where(
        and(
          eq(decks.ownerId, data.authorId),
          eq(decks.visibility, "public"),
          gt(decks.publishedVersion, 0),
          isNull(decks.deletedAt),
        ),
      );
    if (!publicDecks.length) {
      return NextResponse.json({
        ok: true,
        subscribed: 0,
        alreadySubscribed: 0,
      });
    }
    const inserted = await db
      .insert(subscriptions)
      .values(
        publicDecks.map((d) => ({
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
      alreadySubscribed: publicDecks.length - inserted.length,
    });
  }

  // action === "setAutoSubscribe"
  const [updated] = await db
    .update(authorSubscriptions)
    .set({ autoSubscribeNew: data.autoSubscribeNew })
    .where(
      and(
        eq(authorSubscriptions.followerId, user.id),
        eq(authorSubscriptions.authorId, data.authorId),
      ),
    )
    .returning({ authorId: authorSubscriptions.authorId });
  if (!updated) throw new AppError(404, "尚未关注该创作者。");
  return NextResponse.json({
    ok: true,
    autoSubscribeNew: data.autoSubscribeNew,
  });
}, true);
