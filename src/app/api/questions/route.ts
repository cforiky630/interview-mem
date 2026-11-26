import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb, type Database } from "@/db";
import { decks, questions, studyCards, user as users } from "@/db/schema";
import { body, route } from "@/server/api";
import {
  accessibleQuestion,
  nextQuestionBaseMs,
  nextQuestionPosition,
  ownedDeck,
  publishedQuestion,
} from "@/server/workspace";
import { contentHash } from "@/server/crypto";
import { AppError } from "@/server/errors";
import { deckIdSchema } from "@/server/resource-ids";
import { noteFields, questionFields } from "@/server/content-fields";
import { mergeQuestionTags } from "@/lib/markdown-source";
import {
  MAX_CONCEPT_ALIASES,
  MAX_CONCEPT_ALIAS_LENGTH,
  MAX_CONCEPT_GROUP_LENGTH,
} from "@/lib/concepts";
import type {
  ConceptFolderView,
  ConceptView,
  QuestionAnnotation,
} from "@/lib/types";
import {
  deleteQuestion,
  restoreQuestion,
  moveQuestion,
  mutateOwnedQuestion,
  batchMutateQuestions,
  mergeDuplicateQuestions,
} from "@/server/question-lifecycle";
import { findDuplicateHitsInTx, lockUserTree } from "@/server/folders";
import {
  syncConceptFromAnnotationEditInTx,
  upsertConceptFromAnnotationInTx,
} from "@/server/concepts";

const duplicateStrategySchema = z
  .enum(["check", "keepBoth", "skip"])
  .default("check");
const annotationColorSchema = z.enum(["accent", "amber", "sky", "rose"]);
const MAX_ANNOTATIONS_PER_QUESTION = 50;

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    deckId: deckIdSchema.nullable().default(null),
    ...questionFields,
    tags: questionFields.tags.default([]),
  }),
  z.object({
    action: z.literal("batch"),
    ids: z.array(z.string().uuid()).min(1).max(100),
    operation: z.enum(["move", "archive", "unarchive", "delete"]),
    deckId: deckIdSchema.nullable().optional(),
    duplicateStrategy: duplicateStrategySchema.optional(),
  }),
  z.object({ action: z.literal("delete"), id: z.string().uuid() }),
  z.object({ action: z.literal("restore"), id: z.string().uuid() }),
  z.object({
    action: z.literal("move"),
    id: z.string().uuid(),
    deckId: deckIdSchema.nullable(),
    duplicateStrategy: duplicateStrategySchema,
  }),
  z.object({
    action: z.literal("mergeDuplicates"),
    primaryId: z.string().uuid(),
    duplicateIds: z.array(z.string().uuid()).min(1).max(50),
    appendNotes: z.boolean().default(true),
    keepStrongerFsrs: z.boolean().default(true),
    mergeTags: z.boolean().default(true),
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
    ...noteFields,
    expectedVersion: z.number().int().nonnegative(),
  }),
  z.object({
    action: z.literal("copy"),
    id: z.string().uuid(),
    deckId: deckIdSchema.nullable().default(null),
    title: z.string().trim().min(1).max(200).optional(),
    answer: z.string().max(100_000).optional(),
  }),
  z.object({
    action: z.literal("addAnnotation"),
    id: z.string().uuid(),
    quote: z.string().trim().max(600).default(""),
    comment: z.string().trim().min(1, "请输入批注内容。").max(2000),
    color: annotationColorSchema.default("accent"),
    saveAsConcept: z.boolean().optional().default(false),
    conceptFolderId: z.string().trim().min(1).max(120).nullable().optional(),
    conceptGroup: z.string().trim().max(MAX_CONCEPT_GROUP_LENGTH).optional(),
    aliases: z
      .array(z.string().trim().min(1).max(MAX_CONCEPT_ALIAS_LENGTH))
      .max(MAX_CONCEPT_ALIASES)
      .optional(),
    updateExistingConcept: z.boolean().optional().default(false),
  }),
  z.object({
    action: z.literal("editAnnotation"),
    id: z.string().uuid(),
    annotationId: z.string().trim().min(1).max(100),
    comment: z.string().trim().min(1, "请输入批注内容。").max(2000),
    color: annotationColorSchema.optional(),
    syncConcept: z.boolean().optional().default(true),
  }),
  z.object({
    action: z.literal("deleteAnnotation"),
    id: z.string().uuid(),
    annotationId: z.string().trim().min(1).max(100),
  }),
]);

async function insertOwnedQuestion(
  db: Database,
  params: {
    userId: string;
    deckId: string | null;
    parentId: string | null;
    title: string;
    answer: string;
    tags: string[];
    sourceText: string;
  },
) {
  if (params.deckId) await ownedDeck(params.userId, params.deckId);
  const hash = contentHash(params.title, params.answer);
  return db.transaction(async (tx) => {
    if (params.deckId) {
      const [target] = await tx
        .select()
        .from(decks)
        .where(
          and(
            eq(decks.id, params.deckId),
            eq(decks.ownerId, params.userId),
            isNull(decks.deletedAt),
          ),
        )
        .for("no key update");
      if (!target) throw new AppError(404, "目标文件夹已删除。");
    } else {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, params.userId))
        .for("no key update");
    }
    const duplicates = await findDuplicateHitsInTx(tx, {
      userId: params.userId,
      deckId: params.deckId,
      title: params.title,
      answer: params.answer,
    });
    const ts = new Date(await nextQuestionBaseMs(tx, params.userId));
    const position = await nextQuestionPosition(
      tx,
      params.userId,
      params.deckId,
    );
    const [inserted] = await tx
      .insert(questions)
      .values({
        id: crypto.randomUUID(),
        deckId: params.deckId,
        position,
        ownerId: params.userId,
        parentId: params.parentId,
        title: params.title,
        answer: params.answer,
        tags: params.tags,
        sourceText: params.sourceText,
        contentHash: hash,
        needsEditing: !params.answer.trim(),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    if (params.deckId) {
      await tx
        .update(decks)
        .set({ updatedAt: ts })
        .where(eq(decks.id, params.deckId));
    }
    return {
      id: inserted.id,
      duplicates,
      question: publishedQuestion(inserted),
    };
  });
}

export const POST = route(async (request, user) => {
  const data = await body(request, schema);
  if (data.action === "batch")
    return Response.json(
      await batchMutateQuestions(
        user.id,
        data.operation === "move"
          ? {
              ids: data.ids,
              operation: "move",
              deckId: data.deckId ?? null,
              duplicateStrategy: data.duplicateStrategy ?? "check",
            }
          : { ids: data.ids, operation: data.operation },
      ),
    );
  if (data.action === "mergeDuplicates")
    return Response.json(
      await mergeDuplicateQuestions(user.id, {
        primaryId: data.primaryId,
        duplicateIds: data.duplicateIds,
        appendNotes: data.appendNotes,
        keepStrongerFsrs: data.keepStrongerFsrs,
        mergeTags: data.mergeTags,
      }),
    );
  const db = await getDb();
  if (data.action === "create") {
    const normalizedTags = mergeQuestionTags([], data.tags);
    const sourceText = data.answer.trim()
      ? `# ${data.title}\n\n${data.answer}`
      : `# ${data.title}`;
    return NextResponse.json(
      await insertOwnedQuestion(db, {
        userId: user.id,
        deckId: data.deckId,
        parentId: null,
        title: data.title,
        answer: data.answer,
        tags: normalizedTags,
        sourceText,
      }),
    );
  }
  if (data.action === "delete")
    return Response.json(await deleteQuestion(user.id, data.id));
  if (data.action === "restore")
    return Response.json(await restoreQuestion(user.id, data.id));
  if (data.action === "move")
    return Response.json(
      await moveQuestion(user.id, data.id, data.deckId, data.duplicateStrategy),
    );
  const question = await accessibleQuestion(user.id, data.id);
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
        const normalizedTags = mergeQuestionTags([], data.tags);
        const hash = contentHash(data.title, data.answer);
        const changed = await tx
          .update(questions)
          .set({
            title: data.title,
            ...(data.answer === current.answer ? {} : { answer: data.answer }),
            tags: normalizedTags,
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
        const duplicates = await findDuplicateHitsInTx(tx, {
          userId: user.id,
          deckId: current.deckId,
          title: data.title,
          answer: data.answer,
          excludeQuestionId: data.id,
        });
        return {
          revision: changed[0].revision,
          majorRevision: changed[0].majorRevision,
          tags: changed[0].tags,
          updatedAt: changed[0].updatedAt.toISOString(),
          duplicates,
        };
      }),
    );
  }
  if (data.action === "copy") {
    const title = data.title ?? question.title;
    const answer = data.answer ?? question.answer;
    return NextResponse.json(
      await insertOwnedQuestion(db, {
        userId: user.id,
        deckId: data.deckId,
        parentId: data.id,
        title,
        answer,
        tags: question.tags,
        sourceText: `引用：${question.title}\n\n${answer}`,
      }),
    );
  }
  if (
    data.action === "addAnnotation" ||
    data.action === "editAnnotation" ||
    data.action === "deleteAnnotation"
  ) {
    const needsConceptLock =
      (data.action === "addAnnotation" && data.saveAsConcept) ||
      (data.action === "editAnnotation" && data.syncConcept);
    const result = await db.transaction(async (tx) => {
      if (needsConceptLock) {
        await lockUserTree(tx, user.id);
      }
      await tx
        .insert(studyCards)
        .values({ userId: user.id, questionId: data.id })
        .onConflictDoNothing();
      const [card] = await tx
        .select({
          annotations: studyCards.annotations,
          annotationsVersion: studyCards.annotationsVersion,
        })
        .from(studyCards)
        .where(
          and(
            eq(studyCards.userId, user.id),
            eq(studyCards.questionId, data.id),
          ),
        )
        .for("update");
      const current: QuestionAnnotation[] = Array.isArray(card?.annotations)
        ? card.annotations
        : [];
      if (data.action === "addAnnotation") {
        if (current.length >= MAX_ANNOTATIONS_PER_QUESTION)
          throw new AppError(400, "单道题最多添加 50 条批注。");
        let savedConcept: ConceptView | null = null;
        let savedConceptFolder: ConceptFolderView | null = null;
        if (data.saveAsConcept) {
          const upserted = await upsertConceptFromAnnotationInTx(tx, user.id, {
            questionId: data.id,
            quote: data.quote,
            comment: data.comment,
            color: data.color,
            conceptFolderId: data.conceptFolderId,
            conceptGroup: data.conceptGroup,
            aliases: data.aliases,
            updateExistingConcept: data.updateExistingConcept,
          });
          savedConcept = upserted.concept;
          savedConceptFolder = upserted.folder;
        }
        const now = new Date().toISOString();
        const annotation: QuestionAnnotation = {
          id: crypto.randomUUID(),
          quote: data.quote,
          comment: data.comment,
          color: data.color,
          ...(savedConcept ? { conceptId: savedConcept.id } : {}),
          createdAt: now,
          updatedAt: now,
        };
        const next = [...current, annotation];
        const [updated] = await tx
          .update(studyCards)
          .set({
            annotations: next,
            annotationsVersion: sql`${studyCards.annotationsVersion} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(studyCards.userId, user.id),
              eq(studyCards.questionId, data.id),
            ),
          )
          .returning({ annotationsVersion: studyCards.annotationsVersion });
        return {
          ok: true,
          annotation,
          concept: savedConcept,
          ...(savedConceptFolder ? { conceptFolder: savedConceptFolder } : {}),
          annotations: next,
          version: updated.annotationsVersion,
        };
      }
      if (data.action === "editAnnotation") {
        const idx = current.findIndex((item) => item.id === data.annotationId);
        if (idx === -1) throw new AppError(404, "批注不存在或已删除。");
        const existingItem = current[idx];
        let syncedConcept: ConceptView | null = null;
        if (data.syncConcept && existingItem.conceptId) {
          syncedConcept = await syncConceptFromAnnotationEditInTx(tx, user.id, {
            questionId: data.id,
            conceptId: existingItem.conceptId,
            comment: data.comment,
            color: data.color,
          });
        }
        const annotation: QuestionAnnotation = {
          ...existingItem,
          comment: data.comment,
          ...(data.color ? { color: data.color } : {}),
          updatedAt: new Date().toISOString(),
        };
        const next = current.map((item, i) => (i === idx ? annotation : item));
        const [updated] = await tx
          .update(studyCards)
          .set({
            annotations: next,
            annotationsVersion: sql`${studyCards.annotationsVersion} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(studyCards.userId, user.id),
              eq(studyCards.questionId, data.id),
            ),
          )
          .returning({ annotationsVersion: studyCards.annotationsVersion });
        return {
          ok: true,
          annotation,
          concept: syncedConcept,
          annotations: next,
          version: updated.annotationsVersion,
        };
      }
      const idx = current.findIndex((item) => item.id === data.annotationId);
      if (idx === -1) throw new AppError(404, "批注不存在或已删除。");
      const next = current.filter((item) => item.id !== data.annotationId);
      const [updated] = await tx
        .update(studyCards)
        .set({
          annotations: next,
          annotationsVersion: sql`${studyCards.annotationsVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(studyCards.userId, user.id),
            eq(studyCards.questionId, data.id),
          ),
        )
        .returning({ annotationsVersion: studyCards.annotationsVersion });
      return {
        ok: true,
        annotations: next,
        version: updated.annotationsVersion,
      };
    });
    return NextResponse.json(result);
  }
  await db
    .insert(studyCards)
    .values({ userId: user.id, questionId: data.id })
    .onConflictDoNothing();
  if (data.action === "favorite")
    await db
      .update(studyCards)
      .set({ favorite: data.favorite, updatedAt: new Date() })
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
