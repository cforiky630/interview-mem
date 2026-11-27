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
import { deckIdSchema } from "@/server/resource-ids";
import { withWorkspaceEtag } from "@/server/workspace";

const authorIdSchema = z.string().trim().min(1, "缺少创作者标识。").max(128);

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("follow"),
    authorId: authorIdSchema,
    autoSubscribeNew: z.boolean().default(false),
    subscribeAll: z.boolean().default(false),
    folderId: deckIdSchema.nullable().default(null),
  }),
  z.object({
    action: z.literal("unfollow"),
    authorId: authorIdSchema,
    unsubscribeDecks: z.boolean().default(false),
  }),
  z.object({
    action: z.literal("subscribeAll"),
    authorId: authorIdSchema,
    folderId: deckIdSchema.nullable().default(null),
  }),
  z.object({
    action: z.literal("setAutoSubscribe"),
    authorId: authorIdSchema,
    autoSubscribeNew: z.boolean(),
  }),
]);

async function assertOptionalOwnedFolder(
  tx: Parameters<Parameters<Awaited<ReturnType<typeof getDb>>["transaction"]>[0]>[0] | Awaited<ReturnType<typeof getDb>>,
  userId: string,
  folderId: string | null,
) {
  if (!folderId) return;
  const [folder] = await tx
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
}

/**
 * Filter author's public decks so that if a public ancestor folder is already
 * in the public set (or already subscribed), its nested public descendants
 * are not redundantly subscribed by `subscribeAll` / `follow(subscribeAll)`.
 */
async function selectTopMostPublicDecks(
  tx: Parameters<Parameters<Awaited<ReturnType<typeof getDb>>["transaction"]>[0]>[0] | Awaited<ReturnType<typeof getDb>>,
  authorId: string,
  followerId: string,
) {
  const [authorFolders, existingSubs] = await Promise.all([
    tx
      .select({
        id: decks.id,
        parentId: decks.parentId,
        visibility: decks.visibility,
        publishedVersion: decks.publishedVersion,
      })
      .from(decks)
      .where(and(eq(decks.ownerId, authorId), isNull(decks.deletedAt))),
    tx
      .select({ deckId: subscriptions.deckId })
      .from(subscriptions)
      .where(eq(subscriptions.userId, followerId)),
  ]);
  const parentById = new Map(authorFolders.map((f) => [f.id, f.parentId]));
  const publicDecks = authorFolders.filter(
    (f) => f.visibility === "public" && f.publishedVersion > 0,
  );
  const publicIds = new Set(publicDecks.map((f) => f.id));
  const subscribedIds = new Set(existingSubs.map((s) => s.deckId));

  const hasCoveredAncestor = (id: string) => {
    const visited = new Set<string>([id]);
    let cur = parentById.get(id) ?? null;
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      if (publicIds.has(cur) || subscribedIds.has(cur)) return true;
      cur = parentById.get(cur) ?? null;
    }
    return false;
  };

  return publicDecks.filter((d) => !hasCoveredAncestor(d.id));
}

export const POST = route(async (request, user) => {
  const response = await (async () => {
    const data = await body(request, schema);
  const db = await getDb();

  if (data.action === "follow") {
    if (data.authorId === user.id) {
      throw new AppError(400, "不能关注自己。");
    }
    const [author] = await db
      .select({ id: users.id })
      .from(users)
      .innerJoin(decks, eq(decks.ownerId, users.id))
      .where(
        and(
          eq(users.id, data.authorId),
          eq(decks.visibility, "public"),
          gt(decks.publishedVersion, 0),
          isNull(decks.deletedAt),
        ),
      )
      .limit(1);
    if (!author) throw new AppError(404, "创作者不存在。");

    const subscribedDecks = await db.transaction(async (tx) => {
      if (data.subscribeAll) {
        await assertOptionalOwnedFolder(tx, user.id, data.folderId);
      }
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
      const publicDecks = await selectTopMostPublicDecks(
        tx,
        data.authorId,
        user.id,
      );
      if (!publicDecks.length) return 0;
      const inserted = await tx
        .insert(subscriptions)
        .values(
          publicDecks.map((d) => ({
            userId: user.id,
            deckId: d.id,
            folderId: data.folderId,
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
      throw new AppError(400, "你已经拥有自己的全部资料。");
    }
    const [author] = await db
      .select({ id: users.id })
      .from(users)
      .innerJoin(decks, eq(decks.ownerId, users.id))
      .where(
        and(
          eq(users.id, data.authorId),
          eq(decks.visibility, "public"),
          gt(decks.publishedVersion, 0),
          isNull(decks.deletedAt),
        ),
      )
      .limit(1);
    if (!author) throw new AppError(404, "创作者不存在。");
    await assertOptionalOwnedFolder(db, user.id, data.folderId);
    const publicDecks = await selectTopMostPublicDecks(
      db,
      data.authorId,
      user.id,
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
          folderId: data.folderId,
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
  })();
  return withWorkspaceEtag(user.id, response);
}, true);
