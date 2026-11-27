import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { reviewEvents, studyCards } from "@/db/schema";
import { body, route } from "@/server/api";
import { accessibleQuestion, withWorkspaceEtag } from "@/server/workspace";
import { reviewInsight, schedule } from "@/server/scheduler";
import { AppError } from "@/server/errors";
import type { StoredCard } from "@/lib/types";

export const GET = route(async (request, user) => {
  const id = z
    .string()
    .uuid()
    .parse(new URL(request.url).searchParams.get("questionId"));
  await accessibleQuestion(user.id, id);
  const db = await getDb();
  const [study] = await db
    .select()
    .from(studyCards)
    .where(and(eq(studyCards.userId, user.id), eq(studyCards.questionId, id)));
  return NextResponse.json(
    await reviewInsight((study?.fsrs as StoredCard | null) ?? null),
  );
});
const schema = z.object({
  questionId: z.string().uuid(),
  eventId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative(),
  questionRevision: z.number().int().positive(),
  rating: z.number().int().min(1).max(4),
  answer: z.string().max(20000).default(""),
});
export const POST = route(async (request, user) => {
  const data = await body(request, schema);
  const db = await getDb();
  async function replay(
    existing: typeof reviewEvents.$inferSelect,
    reader: Pick<typeof db, "select"> = db,
  ) {
    if (
      existing.userId !== user.id ||
      existing.questionId !== data.questionId ||
      existing.rating !== data.rating ||
      existing.questionRevision !== data.questionRevision ||
      (existing.answer ?? "") !== data.answer
    )
      throw new AppError(409, "复习提交标识已被使用。");
    const [cardRow] = await reader
      .select({
        fsrs: studyCards.fsrs,
        version: studyCards.version,
        reviewedRevision: studyCards.reviewedRevision,
      })
      .from(studyCards)
      .where(
        and(
          eq(studyCards.userId, user.id),
          eq(studyCards.questionId, data.questionId),
        ),
      );
    return {
      card: (cardRow?.fsrs as StoredCard | null) ?? existing.after,
      duplicate: true,
      studyVersion: cardRow?.version ?? data.expectedVersion + 1,
      reviewedRevision: cardRow?.reviewedRevision ?? existing.questionRevision,
      createdAt: existing.createdAt.toISOString(),
      isFirstLearn: existing.before === null,
      questionTitle: existing.questionTitle,
      questionAnswer: existing.questionAnswer,
      questionRevision: existing.questionRevision,
      rating: existing.rating,
      answer: existing.answer,
    };
  }
  const [completed] = await db
    .select()
    .from(reviewEvents)
    .where(eq(reviewEvents.id, data.eventId));
  if (completed) return NextResponse.json(await replay(completed));
  const question = await accessibleQuestion(user.id, data.questionId);
  if (question.archived) throw new AppError(400, "题目已归档，不能继续复习。");
  if (question.revision !== data.questionRevision)
    throw new AppError(409, "题目内容已有更新，请刷新后重新回忆。", "CONFLICT");
  const result = await db.transaction(async (tx) => {
    await tx
      .insert(studyCards)
      .values({ userId: user.id, questionId: data.questionId })
      .onConflictDoNothing();
    const [study] = await tx
      .select()
      .from(studyCards)
      .where(
        and(
          eq(studyCards.userId, user.id),
          eq(studyCards.questionId, data.questionId),
        ),
      )
      .for("update");
    const [existing] = await tx
      .select()
      .from(reviewEvents)
      .where(eq(reviewEvents.id, data.eventId));
    if (existing) return await replay(existing, tx);
    if (study.version !== data.expectedVersion)
      throw new AppError(
        409,
        "这道题已在另一个页面复习，请刷新后继续。",
        "CONFLICT",
      );
    const now = new Date();
    const next = await schedule(
      study.fsrs as StoredCard | null,
      data.rating,
      now,
    );
    await tx.insert(reviewEvents).values({
      id: data.eventId,
      userId: user.id,
      questionId: data.questionId,
      questionTitle: question.title,
      questionAnswer: question.answer,
      rating: data.rating,
      answer: data.answer || null,
      questionRevision: question.revision,
      before: study.fsrs,
      after: next,
      createdAt: now,
    });
    const nextVersion = study.version + 1;
    await tx
      .update(studyCards)
      .set({
        fsrs: next,
        version: nextVersion,
        reviewedRevision: question.revision,
        updatedAt: now,
      })
      .where(
        and(
          eq(studyCards.userId, user.id),
          eq(studyCards.questionId, data.questionId),
        ),
      );
    return {
      card: next,
      duplicate: false,
      studyVersion: nextVersion,
      reviewedRevision: question.revision,
      createdAt: now.toISOString(),
      isFirstLearn: study.fsrs === null,
      questionTitle: question.title,
      questionAnswer: question.answer,
      questionRevision: question.revision,
      rating: data.rating,
      answer: data.answer || null,
    };
  });
  const response = NextResponse.json(result);
  return result.duplicate ? response : withWorkspaceEtag(user.id, response);
}, true);
