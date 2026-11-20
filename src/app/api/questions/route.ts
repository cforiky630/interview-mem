import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { decks, questions, studyCards, user as users } from "@/db/schema";
import { body, route } from "@/server/api";
import { accessibleQuestion, ownedDeck } from "@/server/workspace";
import { contentHash } from "@/server/crypto";
import { AppError } from "@/server/errors";
import { deckIdSchema } from "@/server/resource-ids";
import { questionFields } from "@/server/content-fields";
import {
  deleteQuestion,
  restoreQuestion,
  moveQuestion,
  mutateOwnedQuestion,
} from "@/server/question-lifecycle";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("delete"), id: z.string().uuid() }),
  z.object({ action: z.literal("restore"), id: z.string().uuid() }),
  z.object({
    action: z.literal("move"),
    id: z.string().uuid(),
    deckId: deckIdSchema.nullable(),
  }),
  z.object({
    action: z.literal("edit"),
    id: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
    ...questionFields,
    major: z.boolean().default(false),
  }),
  z.object({
    action: z.literal("archive"),
    id: z.string().uuid(),
    archived: z.boolean(),
  }),
  z.object({
    action: z.literal("favorite"),
    id: z.string().uuid(),
    favorite: z.boolean(),
  }),
  z.object({
    action: z.literal("note"),
    id: z.string().uuid(),
    note: z.string().max(50_000),
    expectedVersion: z.number().int().nonnegative(),
  }),
  z.object({
    action: z.literal("copy"),
    id: z.string().uuid(),
    deckId: deckIdSchema.nullable().default(null),
    title: z.string().trim().min(1).max(200).optional(),
    answer: z.string().max(100_000).optional(),
  }),
]);
export const POST = route(async (request, user) => {
  const data = await body(request, schema);
  if (data.action === "delete")
    return Response.json(await deleteQuestion(user.id, data.id));
  if (data.action === "restore")
    return Response.json(await restoreQuestion(user.id, data.id));
  if (data.action === "move")
    return Response.json(await moveQuestion(user.id, data.id, data.deckId));
  const question = await accessibleQuestion(user.id, data.id);
  const db = await getDb();
  if (data.action === "edit" || data.action === "archive") {
    if (!question.isOwner)
      throw new AppError(
        403,
        "订阅题目的修改请保存在个人笔记中，或另存个人副本。",
      );
    return NextResponse.json(
      await mutateOwnedQuestion(user.id, data.id, async (tx, current) => {
        if (data.action === "archive") {
          await tx
            .update(questions)
            .set({ archived: data.archived, updatedAt: new Date() })
            .where(eq(questions.id, data.id));
          return { ok: true };
        }
        const hash = contentHash(data.title, data.answer);
        const duplicates = current.deckId
          ? await tx
              .select({ id: questions.id })
              .from(questions)
              .where(
                and(
                  eq(questions.deckId, current.deckId),
                  isNull(questions.deletedAt),
                  eq(questions.contentHash, hash),
                ),
              )
          : [];
        if (duplicates.some((q) => q.id !== data.id))
          throw new AppError(409, "题库里已经存在相同题目和答案。");
        const changed = await tx
          .update(questions)
          .set({
            title: data.title,
            ...(data.answer === current.answer ? {} : { answer: data.answer }),
            tags: data.tags,
            contentHash: hash,
            revision: sql`${questions.revision} + 1`,
            ...(data.major ? { majorRevision: data.expectedRevision + 1 } : {}),
            needsEditing: !data.answer.trim(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(questions.id, data.id),
              eq(questions.revision, data.expectedRevision),
            ),
          )
          .returning();
        if (!changed.length)
          throw new AppError(
            409,
            "题目已在其他页面修改，请刷新后再保存。",
            "CONFLICT",
          );
        return { revision: changed[0].revision };
      }),
    );
  }
  if (data.action === "copy") {
    if (data.deckId) await ownedDeck(user.id, data.deckId);
    const title = data.title ?? question.title;
    const answer = data.answer ?? question.answer;
    const inserted = await db.transaction(async (tx) => {
      if (data.deckId) {
        const [target] = await tx
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
        if (!target) throw new AppError(404, "目标题库已删除。");
      } else
        await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, user.id))
          .for("update");
      const duplicate = await tx
        .select({ id: questions.id })
        .from(questions)
        .where(
          and(
            eq(questions.ownerId, user.id),
            data.deckId
              ? eq(questions.deckId, data.deckId)
              : isNull(questions.deckId),
            eq(questions.contentHash, contentHash(title, answer)),
            isNull(questions.deletedAt),
          ),
        )
        .limit(1);
      if (duplicate.length) throw new AppError(409, "当前位置已有相同内容。");
      return tx
        .insert(questions)
        .values({
          id: crypto.randomUUID(),
          deckId: data.deckId,
          ownerId: user.id,
          parentId: data.id,
          title,
          answer,
          tags: question.tags,
          sourceText: `引用：${question.title}\n\n${answer}`,
          contentHash: contentHash(title, answer),
          needsEditing: !answer.trim(),
        })
        .onConflictDoNothing()
        .returning();
    });
    if (!inserted.length) throw new AppError(409, "目标题库已有相同内容。");
    return NextResponse.json({ id: inserted[0].id });
  }
  await db
    .insert(studyCards)
    .values({ userId: user.id, questionId: data.id })
    .onConflictDoNothing();
  if (data.action === "favorite")
    await db
      .update(studyCards)
      .set({ favorite: data.favorite })
      .where(
        and(eq(studyCards.userId, user.id), eq(studyCards.questionId, data.id)),
      );
  if (data.action === "note") {
    const changed = await db
      .update(studyCards)
      .set({
        note: data.note,
        noteVersion: sql`${studyCards.noteVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(studyCards.userId, user.id),
          eq(studyCards.questionId, data.id),
          eq(studyCards.noteVersion, data.expectedVersion),
        ),
      )
      .returning();
    if (!changed.length)
      throw new AppError(
        409,
        "笔记已在另一页面更新，当前草稿已保留，请刷新后合并。",
        "CONFLICT",
      );
    return NextResponse.json({ version: changed[0].noteVersion });
  }
  return NextResponse.json({ ok: true });
}, true);
