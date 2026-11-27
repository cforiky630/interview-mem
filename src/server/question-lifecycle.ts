import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lte,
  notExists,
  sql,
} from "drizzle-orm";
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
import { mergeQuestionTags } from "@/lib/markdown-source";
import type { QuestionAnnotation, StoredCard } from "@/lib/types";
import { AppError } from "./errors";
import { nextQuestionPosition } from "./workspace";
import {
  findDuplicateHitsInTx,
  formatOwnedFolderPath,
  loadActiveOwnedFolders,
} from "./folders";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Question = typeof questions.$inferSelect;
export type MoveDuplicateStrategy = "check" | "keepBoth" | "skip";

/**
 * Global lock order: users (when tree-locked) -> decks (ORDER BY id FOR NO KEY UPDATE) -> questions (ORDER BY id FOR NO KEY UPDATE).
 * Folder locks precede question locks, including moves between two folders.
 */
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
          .for("no key update")
      : [];
    const [question] = await tx
      .select()
      .from(questions)
      .where(and(eq(questions.id, id), eq(questions.ownerId, userId)))
      .for("no key update");
    if (
      !question ||
      question.purgedAt ||
      (!options.allowDeleted && question.deletedAt)
    )
      throw new AppError(404, "题目已删除或不可访问。");
    if (question.deckId && question.deckId !== before.deckId)
      throw new AppError(409, "题目所在位置已更改，请刷新后重试。");
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
          .select({ id: decks.id })
          .from(decks)
          .where(
            and(
              eq(decks.id, deckId),
              eq(decks.ownerId, userId),
              isNull(decks.deletedAt),
            ),
          );
        if (!deck) deckId = null;
      }
      await tx
        .update(questions)
        .set({ deletedAt: null, deckId, updatedAt: new Date() })
        .where(eq(questions.id, id));
      const duplicates = await findDuplicateHitsInTx(tx, {
        userId,
        deckId,
        title: q.title,
        answer: q.answer,
        excludeQuestionId: q.id,
      });
      return { ok: true, deckId, duplicates };
    },
    { allowDeleted: true },
  );
}

export function moveQuestion(
  userId: string,
  id: string,
  deckId: string | null,
  duplicateStrategy: MoveDuplicateStrategy = "check",
) {
  return mutateOwnedQuestion(
    userId,
    id,
    async (tx, q, targetExists) => {
      if (!targetExists)
        throw new AppError(404, "目标文件夹不存在或没有管理权限。");
      if (q.deckId === deckId) return { ok: true, updated: 0, skipped: 0 };

      const existing = await tx
        .select({ id: questions.id, title: questions.title })
        .from(questions)
        .where(
          and(
            eq(questions.ownerId, userId),
            deckId ? eq(questions.deckId, deckId) : isNull(questions.deckId),
            eq(questions.contentHash, q.contentHash),
            isNull(questions.deletedAt),
            isNull(questions.purgedAt),
          ),
        )
        .limit(1);

      if (existing.length && existing[0].id !== q.id) {
        if (duplicateStrategy === "check") {
          const folders = await loadActiveOwnedFolders(tx, userId);
          const targetPath = formatOwnedFolderPath(
            new Map(folders.map((f) => [f.id, f])),
            deckId,
          );
          throw new AppError(
            409,
            "目标文件夹中已有相同内容，请选择保留两份或跳过。",
            "DUPLICATE_IN_TARGET",
            {
              conflicts: [
                {
                  sourceId: q.id,
                  existingId: existing[0].id,
                  title: q.title,
                  targetDeckId: deckId,
                  targetPath,
                },
              ],
            },
          );
        }
        if (duplicateStrategy === "skip") {
          return { ok: true, updated: 0, skipped: 1 };
        }
      }

      const position = await nextQuestionPosition(tx, userId, deckId);
      const updatedAt = new Date();
      await tx
        .update(questions)
        .set({
          deckId,
          position,
          updatedAt,
        })
        .where(eq(questions.id, id));
      return {
        ok: true,
        updated: 1,
        skipped: 0,
        position,
        updatedAt: updatedAt.toISOString(),
      };
    },
    { targetDeckId: deckId },
  );
}

export type BatchQuestionOperation =
  | {
      ids: string[];
      operation: "move";
      deckId: string | null;
      duplicateStrategy?: MoveDuplicateStrategy;
    }
  | { ids: string[]; operation: "archive" | "unarchive" | "delete" };

/** Batch move, archive, restore-from-archive, or trash owned active questions in lock order. */
export async function batchMutateQuestions(
  userId: string,
  params: BatchQuestionOperation,
) {
  const uniqueIds = [...new Set(params.ids)].sort();
  if (!uniqueIds.length) throw new AppError(400, "请先选择要操作的题目。");
  const db = await getDb();
  const targetDeckId = params.operation === "move" ? params.deckId : undefined;
  const duplicateStrategy: MoveDuplicateStrategy =
    params.operation === "move"
      ? (params.duplicateStrategy ?? "check")
      : "check";
  const before = await db
    .select({ id: questions.id, deckId: questions.deckId })
    .from(questions)
    .where(
      and(
        eq(questions.ownerId, userId),
        inArray(questions.id, uniqueIds),
        isNull(questions.deletedAt),
        isNull(questions.purgedAt),
      ),
    );
  if (before.length !== uniqueIds.length) {
    throw new AppError(404, "部分题目不存在或没有管理权限，请刷新后重试。");
  }
  const deckIds = [
    ...new Set(
      [...before.map((q) => q.deckId), targetDeckId].filter(
        (id): id is string => !!id,
      ),
    ),
  ].sort();
  return db.transaction(async (tx) => {
    const lockedDecks = deckIds.length
      ? await tx
          .select()
          .from(decks)
          .where(and(eq(decks.ownerId, userId), inArray(decks.id, deckIds)))
          .orderBy(asc(decks.id))
          .for("no key update")
      : [];
    if (
      params.operation === "move" &&
      targetDeckId &&
      !lockedDecks.some((d) => d.id === targetDeckId && !d.deletedAt)
    ) {
      throw new AppError(404, "目标文件夹不存在或没有管理权限。");
    }
    const lockedQuestions = await tx
      .select()
      .from(questions)
      .where(
        and(
          eq(questions.ownerId, userId),
          inArray(questions.id, uniqueIds),
          isNull(questions.deletedAt),
          isNull(questions.purgedAt),
        ),
      )
      .orderBy(asc(questions.id))
      .for("no key update");
    if (lockedQuestions.length !== uniqueIds.length) {
      throw new AppError(404, "部分题目已在其他页面删除，请刷新后重试。");
    }
    const lockedDeckSet = new Set(lockedDecks.map((d) => d.id));
    if (lockedQuestions.some((q) => q.deckId && !lockedDeckSet.has(q.deckId))) {
      throw new AppError(
        409,
        "部分题目所在文件夹已在其他页面修改，请刷新后重试。",
        "CONFLICT",
      );
    }
    const now = new Date();
    if (params.operation === "delete") {
      await tx
        .update(questions)
        .set({ deletedAt: now, updatedAt: now })
        .where(inArray(questions.id, uniqueIds));
      return { ok: true, updated: uniqueIds.length, skipped: 0 };
    }
    if (params.operation === "archive" || params.operation === "unarchive") {
      await tx
        .update(questions)
        .set({ archived: params.operation === "archive", updatedAt: now })
        .where(inArray(questions.id, uniqueIds));
      return { ok: true, updated: uniqueIds.length, skipped: 0 };
    }

    const orderedForMove = [...lockedQuestions].sort(
      (a, b) =>
        a.position - b.position ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    );
    const destId = targetDeckId ?? null;
    const existingTarget = await tx
      .select({ id: questions.id, contentHash: questions.contentHash })
      .from(questions)
      .where(
        and(
          eq(questions.ownerId, userId),
          destId ? eq(questions.deckId, destId) : isNull(questions.deckId),
          isNull(questions.deletedAt),
          isNull(questions.purgedAt),
        ),
      );
    const targetHashToId = new Map<string, string>();
    for (const r of existingTarget) {
      if (!targetHashToId.has(r.contentHash)) {
        targetHashToId.set(r.contentHash, r.id);
      }
    }

    const conflicts: {
      sourceId: string;
      existingId: string;
      title: string;
      targetDeckId: string | null;
      targetPath: string;
    }[] = [];
    const movableIds: string[] = [];
    let skipped = 0;
    const seenHashes = new Map(targetHashToId);

    for (const q of orderedForMove) {
      if (q.deckId === destId) {
        skipped += 1;
        continue;
      }
      const existingId = seenHashes.get(q.contentHash);
      if (existingId && existingId !== q.id) {
        if (duplicateStrategy === "check") {
          conflicts.push({
            sourceId: q.id,
            existingId,
            title: q.title,
            targetDeckId: destId,
            targetPath: "",
          });
          continue;
        }
        if (duplicateStrategy === "skip") {
          skipped += 1;
          continue;
        }
      }
      if (!seenHashes.has(q.contentHash)) seenHashes.set(q.contentHash, q.id);
      movableIds.push(q.id);
    }

    if (conflicts.length > 0 && duplicateStrategy === "check") {
      const folders = await loadActiveOwnedFolders(tx, userId);
      const targetPath = formatOwnedFolderPath(
        new Map(folders.map((f) => [f.id, f])),
        destId,
      );
      for (const c of conflicts) c.targetPath = targetPath;
      throw new AppError(
        409,
        `目标文件夹中已有 ${conflicts.length} 道相同内容的题目，请选择保留两份或跳过重复项。`,
        "DUPLICATE_IN_TARGET",
        { conflicts },
      );
    }

    if (movableIds.length) {
      let pos = await nextQuestionPosition(tx, userId, destId);
      for (const id of movableIds) {
        await tx
          .update(questions)
          .set({
            deckId: destId,
            position: pos++,
            updatedAt: now,
          })
          .where(eq(questions.id, id));
      }
    }
    return {
      ok: true,
      updated: movableIds.length,
      skipped,
      movedIds: movableIds,
      updatedAt: now.toISOString(),
    };
  });
}

function fsrsStrengthScore(
  raw: Record<string, unknown> | null | undefined,
): number {
  if (!raw || typeof raw !== "object") return -1;
  const card = raw as Partial<StoredCard>;
  const reps = typeof card.reps === "number" ? card.reps : 0;
  const stability = typeof card.stability === "number" ? card.stability : 0;
  const lastMs =
    typeof card.last_review === "string" ? Date.parse(card.last_review) : 0;
  return (
    reps * 100_000 +
    stability * 1_000 +
    (Number.isFinite(lastMs) ? lastMs / 1e12 : 0)
  );
}

/**
 * User-controlled duplicate cleanup: keep `primaryId`, optionally merge personal notes,
 * annotations, tags, favorite flag and stronger FSRS progress, and move duplicates to 30-day trash.
 */
export async function mergeDuplicateQuestions(
  userId: string,
  input: {
    primaryId: string;
    duplicateIds: string[];
    appendNotes?: boolean;
    keepStrongerFsrs?: boolean;
    mergeTags?: boolean;
  },
) {
  const dupIds = [
    ...new Set(input.duplicateIds.filter((id) => id !== input.primaryId)),
  ];
  if (!dupIds.length) {
    throw new AppError(400, "请至少选择一道要合并清理的重复题目。");
  }
  const allIds = [input.primaryId, ...dupIds].sort();
  const appendNotes = input.appendNotes ?? true;
  const keepStrongerFsrs = input.keepStrongerFsrs ?? true;
  const shouldMergeTags = input.mergeTags ?? true;

  const db = await getDb();
  return db.transaction(async (tx) => {
    const lockedQuestions = await tx
      .select()
      .from(questions)
      .where(
        and(
          eq(questions.ownerId, userId),
          inArray(questions.id, allIds),
          isNull(questions.deletedAt),
          isNull(questions.purgedAt),
        ),
      )
      .orderBy(asc(questions.id))
      .for("no key update");
    if (lockedQuestions.length !== allIds.length) {
      throw new AppError(404, "部分题目不存在或已删除，请刷新后重试。");
    }

    const byId = new Map(lockedQuestions.map((q) => [q.id, q]));
    const primary = byId.get(input.primaryId)!;
    const duplicates = dupIds.map((id) => byId.get(id)!);
    const now = new Date();

    // Load personal study state for primary and duplicates.
    const cardRows = await tx
      .select()
      .from(studyCards)
      .where(
        and(
          eq(studyCards.userId, userId),
          inArray(studyCards.questionId, allIds),
        ),
      );
    const cardByQId = new Map(cardRows.map((c) => [c.questionId, c]));
    const primaryCard = cardByQId.get(primary.id);

    // 1. Merge tags on primary question if enabled.
    if (shouldMergeTags) {
      const mergedTags = duplicates.reduce(
        (acc, q) => mergeQuestionTags(acc, q.tags),
        mergeQuestionTags([], primary.tags),
      );
      if (
        mergedTags.length !== primary.tags.length ||
        mergedTags.some((t, i) => t !== primary.tags[i])
      ) {
        await tx
          .update(questions)
          .set({ tags: mergedTags, updatedAt: now })
          .where(eq(questions.id, primary.id));
      }
    }

    // 2. Compute merged personal study card (note, annotations, favorite, FSRS).
    let nextNote = primaryCard?.note ?? "";
    let notesMerged = 0;
    if (appendNotes) {
      for (const dup of duplicates) {
        const dupNote = (cardByQId.get(dup.id)?.note ?? "").trim();
        if (!dupNote) continue;
        if (!nextNote.trim()) {
          nextNote = dupNote;
          notesMerged += 1;
        } else if (!nextNote.includes(dupNote)) {
          nextNote = `${nextNote.trimEnd()}\n\n---\n\n${dupNote}`;
          notesMerged += 1;
        }
      }
      if (nextNote.length > 50_000) nextNote = nextNote.slice(0, 50_000);
    }

    const nextAnnotations: QuestionAnnotation[] = Array.isArray(
      primaryCard?.annotations,
    )
      ? [...primaryCard.annotations]
      : [];
    const annKeys = new Set(
      nextAnnotations.map((a) => `${a.quote}\0${a.comment}`),
    );
    let annotationsChanged = false;
    if (appendNotes) {
      for (const dup of duplicates) {
        const dupAnns = cardByQId.get(dup.id)?.annotations ?? [];
        for (const ann of dupAnns) {
          if (nextAnnotations.length >= 50) break;
          const k = `${ann.quote}\0${ann.comment}`;
          if (annKeys.has(k)) continue;
          annKeys.add(k);
          nextAnnotations.push({ ...ann, id: crypto.randomUUID() });
          annotationsChanged = true;
        }
      }
    }

    const nextFavorite =
      Boolean(primaryCard?.favorite) ||
      duplicates.some((d) => Boolean(cardByQId.get(d.id)?.favorite));

    let bestFsrs = primaryCard?.fsrs ?? null;
    let bestReviewedRevision = primaryCard?.reviewedRevision ?? 0;
    let keptFsrsFrom = primary.id;
    let fsrsChanged = false;
    if (keepStrongerFsrs) {
      let bestScore = fsrsStrengthScore(bestFsrs);
      for (const dup of duplicates) {
        const dupCard = cardByQId.get(dup.id);
        const score = fsrsStrengthScore(dupCard?.fsrs);
        if (score > bestScore && dupCard?.fsrs) {
          bestScore = score;
          bestFsrs = dupCard.fsrs;
          bestReviewedRevision = Math.max(
            bestReviewedRevision,
            primary.revision,
          );
          keptFsrsFrom = dup.id;
          fsrsChanged = true;
        }
      }
    }

    const studyNeedsWrite =
      notesMerged > 0 ||
      annotationsChanged ||
      fsrsChanged ||
      nextFavorite !== Boolean(primaryCard?.favorite);
    if (studyNeedsWrite) {
      await tx
        .insert(studyCards)
        .values({
          userId,
          questionId: primary.id,
          fsrs: bestFsrs,
          version: fsrsChanged ? 1 : 0,
          reviewedRevision: bestReviewedRevision,
          favorite: nextFavorite,
          note: nextNote,
          noteVersion: notesMerged > 0 ? 1 : 0,
          annotations: nextAnnotations,
          annotationsVersion: annotationsChanged ? 1 : 0,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [studyCards.userId, studyCards.questionId],
          set: {
            fsrs: bestFsrs,
            reviewedRevision: bestReviewedRevision,
            favorite: nextFavorite,
            note: nextNote,
            annotations: nextAnnotations,
            version: fsrsChanged
              ? sql`${studyCards.version} + 1`
              : studyCards.version,
            noteVersion:
              notesMerged > 0
                ? sql`${studyCards.noteVersion} + 1`
                : studyCards.noteVersion,
            annotationsVersion: annotationsChanged
              ? sql`${studyCards.annotationsVersion} + 1`
              : studyCards.annotationsVersion,
            updatedAt: now,
          },
        });
    }

    // 3. Soft-delete duplicates to 30-day trash (reversible!).
    await tx
      .update(questions)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(questions.ownerId, userId), inArray(questions.id, dupIds)));

    return {
      ok: true,
      primaryId: primary.id,
      trashed: dupIds.length,
      notesMerged,
      keptFsrsFrom,
    };
  });
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
      .for("no key update", { skipLocked: true });
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

export const ORPHAN_IMPORT_TTL_MS = 24 * 60 * 60 * 1000;

export async function cleanupOrphanedImportPreviews(
  options: { userId?: string; now?: Date; ttlMs?: number } = {},
) {
  const db = await getDb();
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? ORPHAN_IMPORT_TTL_MS;
  const cutoff = new Date(now.getTime() - ttlMs);
  const removed = await db
    .delete(imports)
    .where(
      and(
        ...(options.userId ? [eq(imports.userId, options.userId)] : []),
        inArray(imports.status, ["draft", "failed", "parsing"]),
        lte(imports.createdAt, cutoff),
        notExists(
          db
            .select({ id: questions.id })
            .from(questions)
            .where(eq(questions.importId, imports.id)),
        ),
      ),
    )
    .returning({ id: imports.id });
  return removed.length;
}

const cleanupState = globalThis as unknown as {
  interviewTrashTimer?: ReturnType<typeof setInterval>;
};
export async function startQuestionTrashCleanup() {
  if (cleanupState.interviewTrashTimer) return;
  const sweep = async () => {
    for (let batch = 0; batch < 10; batch++)
      if ((await cleanupExpiredQuestions()) < 200) break;
    await cleanupOrphanedImportPreviews();
  };
  const initialTimer = setTimeout(() => {
    void sweep().catch(() =>
      console.error("题目回收站清理失败，将在下一轮重试。"),
    );
  }, 10_000);
  initialTimer.unref();
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
