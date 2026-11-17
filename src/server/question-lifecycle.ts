import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm";
import { getDb, type Database } from "@/db";
import {
  conversations,
  decks,
  imports,
  questions,
  reviewEvents,
  studyCards,
} from "@/db/schema";
import { TRASH_RETENTION_MS, questionExpiresAt } from "@/lib/question-trash";
import { AppError } from "./errors";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Question = typeof questions.$inferSelect;

/** Category locks precede question locks, including moves between two categories. */
export async function mutateOwnedQuestion<T>(
  userId: string,
  id: string,
  change: (
    tx: Transaction,
    question: Question,
    targetExists: boolean,
  ) => Promise<T>,
  options: { allowDeleted?: boolean; targetDeckId?: string | null } = {},
) {
  const db = await getDb();
  const [before] = await db
    .select()
    .from(questions)
    .where(and(eq(questions.id, id), eq(questions.ownerId, userId)));
  if (!before) throw new AppError(404, "题目不存在或没有管理权限。");
  return db.transaction(async (tx) => {
    const ids = [
      ...new Set(
        [before.deckId, options.targetDeckId].filter(
          (id): id is string => !!id,
        ),
      ),
    ].sort();
    const locked = ids.length
      ? await tx
          .select()
          .from(decks)
          .where(and(eq(decks.ownerId, userId), inArray(decks.id, ids)))
          .orderBy(asc(decks.id))
          .for("update")
      : [];
    const [question] = await tx
      .select()
      .from(questions)
      .where(and(eq(questions.id, id), eq(questions.ownerId, userId)))
      .for("update");
    if (
      !question ||
      question.purgedAt ||
      (!options.allowDeleted && question.deletedAt)
    )
      throw new AppError(404, "题目已删除或不可访问。");
    if (question.deckId && question.deckId !== before.deckId)
      throw new AppError(409, "题目分类已更改，请刷新后重试。");
    const targetExists =
      !options.targetDeckId ||
      locked.some((d) => d.id === options.targetDeckId && !d.deletedAt);
    return change(tx, question, targetExists);
  });
}

export function deleteQuestion(userId: string, id: string) {
  return mutateOwnedQuestion(
    userId,
    id,
    async (tx, q) => {
      const deletedAt = q.deletedAt ?? new Date();
      if (questionExpiresAt(deletedAt).getTime() <= Date.now())
        throw new AppError(410, "题目已超过 30 天保留期。");
      await tx
        .update(questions)
        .set({ deletedAt, updatedAt: new Date() })
        .where(eq(questions.id, id));
      return {
        ok: true,
        expiresAt: questionExpiresAt(deletedAt).toISOString(),
      };
    },
    { allowDeleted: true },
  );
}

export function restoreQuestion(userId: string, id: string) {
  return mutateOwnedQuestion(
    userId,
    id,
    async (tx, q) => {
      if (!q.deletedAt) return { ok: true, deckId: q.deckId };
      if (questionExpiresAt(q.deletedAt).getTime() <= Date.now())
        throw new AppError(410, "题目已超过 30 天保留期，无法恢复。");
      let deckId = q.deckId;
      if (deckId) {
        const [deck] = await tx
          .select()
          .from(decks)
          .where(
            and(
              eq(decks.id, deckId),
              eq(decks.ownerId, userId),
              isNull(decks.deletedAt),
            ),
          );
        const duplicate = await tx
          .select({ id: questions.id })
          .from(questions)
          .where(
            and(
              eq(questions.deckId, deckId),
              eq(questions.contentHash, q.contentHash),
              isNull(questions.deletedAt),
            ),
          )
          .limit(1);
        if (!deck || duplicate.length) deckId = null;
      }
      await tx
        .update(questions)
        .set({ deletedAt: null, deckId, updatedAt: new Date() })
        .where(eq(questions.id, id));
      return { ok: true, deckId };
    },
    { allowDeleted: true },
  );
}

export function moveQuestion(
  userId: string,
  id: string,
  deckId: string | null,
) {
  return mutateOwnedQuestion(
    userId,
    id,
    async (tx, q, targetExists) => {
      if (!targetExists)
        throw new AppError(404, "目标题库不存在或没有管理权限。");
      if (q.deckId === deckId) return { ok: true };
      if (deckId) {
        const duplicate = await tx
          .select({ id: questions.id })
          .from(questions)
          .where(
            and(
              eq(questions.deckId, deckId),
              eq(questions.contentHash, q.contentHash),
              isNull(questions.deletedAt),
            ),
          )
          .limit(1);
        if (duplicate.length)
          throw new AppError(409, "目标题库已有相同内容，题目仍保留在原位置。");
      }
      await tx
        .update(questions)
        .set({ deckId, updatedAt: new Date() })
        .where(eq(questions.id, id));
      return { ok: true };
    },
    { targetDeckId: deckId },
  );
}

/** Clear the author's expired private content; released snapshots and subscribers' state are independent. */
export async function cleanupExpiredQuestions({
  userId,
  now = new Date(),
}: { userId?: string; now?: Date } = {}) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const expired = await tx
      .select({
        id: questions.id,
        ownerId: questions.ownerId,
        importId: questions.importId,
      })
      .from(questions)
      .where(
        and(
          lte(
            questions.deletedAt,
            new Date(now.getTime() - TRASH_RETENTION_MS),
          ),
          isNull(questions.purgedAt),
          userId ? eq(questions.ownerId, userId) : undefined,
        ),
      )
      .orderBy(asc(questions.id))
      .limit(200)
      .for("update", { skipLocked: true });
    if (!expired.length) return 0;
    const ids = expired.map((q) => q.id);
    // Pair each question with its owner so no subscriber loses personal notes or attempts.
    for (const owner of [...new Set(expired.map((q) => q.ownerId))].sort()) {
      const ownedIds = expired
        .filter((q) => q.ownerId === owner)
        .map((q) => q.id);
      await tx
        .delete(conversations)
        .where(
          and(
            eq(conversations.userId, owner),
            inArray(conversations.questionId, ownedIds),
          ),
        );
      await tx
        .delete(reviewEvents)
        .where(
          and(
            eq(reviewEvents.userId, owner),
            inArray(reviewEvents.questionId, ownedIds),
          ),
        );
      await tx
        .delete(studyCards)
        .where(
          and(
            eq(studyCards.userId, owner),
            inArray(studyCards.questionId, ownedIds),
          ),
        );
    }
    await tx
      .update(questions)
      .set({
        title: "",
        answer: "",
        sourceText: "",
        tags: [],
        validation: null,
        parentId: null,
        importId: null,
        deckId: null,
        purgedAt: now,
        updatedAt: now,
      })
      .where(inArray(questions.id, ids));
    for (const id of [
      ...new Set(
        expired.map((q) => q.importId).filter((id): id is string => !!id),
      ),
    ].sort()) {
      const stillReferenced = await tx
        .select({ id: questions.id })
        .from(questions)
        .where(eq(questions.importId, id))
        .limit(1);
      if (!stillReferenced.length)
        await tx.delete(imports).where(eq(imports.id, id));
    }
    return ids.length;
  });
}

const cleanupState = globalThis as unknown as {
  interviewTrashTimer?: ReturnType<typeof setInterval>;
};
export async function startQuestionTrashCleanup() {
  if (cleanupState.interviewTrashTimer) return;
  const sweep = async () => {
    for (let batch = 0; batch < 10; batch++)
      if ((await cleanupExpiredQuestions()) < 200) break;
  };
  await sweep();
  cleanupState.interviewTrashTimer = setInterval(
    () => {
      void sweep().catch(() =>
        console.error("题目回收站清理失败，将在下一轮重试。"),
      );
    },
    60 * 60 * 1000,
  );
  cleanupState.interviewTrashTimer.unref();
}
