import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import {
  conversations,
  deckGroups,
  decks,
  imports,
  messages,
  preferences,
  questions,
  releases,
  reviewEvents,
  studyCards,
  subscriptions,
  type PublishedDeckGroup,
  type PublishedQuestion,
} from "@/db/schema";
import { mergeQuestionTags } from "@/lib/markdown-source";
import type {
  ChatEdit,
  ChatMessageMeta,
  QuestionAnnotation,
} from "@/lib/types";
import type { ContentValidation } from "@/lib/content-validation";
import { contentHash } from "./crypto";
import { AppError } from "./errors";

const uuidOrString = z.string().min(1).max(120);

const deckGroupBackupSchema = z
  .object({
    id: uuidOrString,
    deckId: uuidOrString,
    title: z.string().max(120),
    category: z.string().max(80).optional().default(""),
    description: z.string().max(2000).optional().default(""),
    position: z.number().int().optional().default(0),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

const deckBackupSchema = z
  .object({
    id: uuidOrString,
    title: z.string().max(120),
    description: z.string().max(2000).optional().default(""),
    groupName: z.string().max(80).optional().default(""),
    groups: z.array(deckGroupBackupSchema).max(200).optional().default([]),
    color: z.string().max(32).optional().default("sage"),
    visibility: z.string().max(32).optional().default("private"),
    isOwner: z.boolean().optional().default(true),
    publishedVersion: z.number().int().min(0).optional().default(0),
    seenVersion: z.number().int().min(0).optional().default(0),
    syncedVersion: z.number().int().min(0).optional(),
    dismissedVersion: z.number().int().min(0).optional().default(0),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

const questionBackupSchema = z
  .object({
    id: uuidOrString,
    deckId: uuidOrString.nullable().optional().default(null),
    groupId: uuidOrString.nullable().optional().default(null),
    position: z.number().int().optional().default(0),
    parentId: uuidOrString.nullable().optional().default(null),
    title: z.string().max(500),
    answer: z.string().max(200_000).optional().default(""),
    tags: z.array(z.string().max(60)).max(30).optional().default([]),
    sourceText: z.string().max(200_000).optional().default(""),
    importId: uuidOrString.nullable().optional().default(null),
    validation: z.unknown().nullable().optional(),
    revision: z.number().int().min(1).optional().default(1),
    majorRevision: z.number().int().min(0).optional().default(0),
    needsEditing: z.boolean().optional().default(false),
    archived: z.boolean().optional().default(false),
    isOwner: z.boolean().optional().default(true),
    note: z.string().max(100_000).optional(),
    noteVersion: z.number().int().min(0).optional(),
    annotations: z.array(z.unknown()).max(100).optional(),
    annotationsVersion: z.number().int().min(0).optional(),
    favorite: z.boolean().optional(),
    fsrs: z.record(z.string(), z.unknown()).nullable().optional(),
    studyVersion: z.number().int().min(0).optional(),
    reviewedRevision: z.number().int().min(0).optional(),
    deletedAt: z.string().nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

const studyCardBackupSchema = z
  .object({
    questionId: uuidOrString,
    fsrs: z.record(z.string(), z.unknown()).nullable().optional().default(null),
    version: z.number().int().min(0).optional().default(0),
    reviewedRevision: z.number().int().min(0).optional().default(0),
    favorite: z.boolean().optional().default(false),
    note: z.string().max(100_000).optional().default(""),
    noteVersion: z.number().int().min(0).optional().default(0),
    annotations: z.array(z.unknown()).max(100).optional().default([]),
    annotationsVersion: z.number().int().min(0).optional().default(0),
    updatedAt: z.string().optional(),
  })
  .passthrough();

const reviewBackupSchema = z
  .object({
    id: uuidOrString,
    questionId: uuidOrString,
    questionTitle: z.string().max(500).nullable().optional(),
    questionAnswer: z.string().max(200_000).nullable().optional(),
    rating: z.number().int().min(1).max(4),
    answer: z.string().max(50_000).nullable().optional().default(null),
    questionRevision: z.number().int().min(1).optional().default(1),
    before: z.record(z.string(), z.unknown()).nullable().optional().default(null),
    after: z.record(z.string(), z.unknown()),
    createdAt: z.string().optional(),
  })
  .passthrough();

const importBackupSchema = z
  .object({
    id: uuidOrString,
    deckId: uuidOrString.nullable().optional().default(null),
    raw: z.string().max(500_000),
    inputType: z.enum(["qa", "questions"]).optional().default("qa"),
    method: z.string().max(32).optional().default("rules"),
    sourceName: z.string().max(300).nullable().optional().default(null),
    sourceHash: z.string().max(128).nullable().optional().default(null),
    preview: z.unknown().nullable().optional(),
    commitHash: z.string().max(128).nullable().optional().default(null),
    status: z.string().max(32).optional().default("complete"),
    result: z
      .object({
        added: z.number().int(),
        duplicates: z.number().int(),
        updated: z.number().int().optional(),
      })
      .nullable()
      .optional(),
    createdAt: z.string().optional(),
  })
  .passthrough();

const releaseBackupSchema = z
  .object({
    deckId: uuidOrString,
    version: z.number().int().min(1),
    title: z.string().max(120),
    description: z.string().max(2000).optional().default(""),
    summary: z.string().max(1000).optional().default(""),
    groups: z.array(z.unknown()).max(200).optional().default([]),
    questions: z.array(z.unknown()).max(5000).optional().default([]),
    createdAt: z.string().optional(),
  })
  .passthrough();

const subscriptionBackupSchema = z
  .object({
    deckId: uuidOrString,
    groupName: z.string().max(80).optional().default(""),
    seenVersion: z.number().int().min(0).optional().default(0),
    dismissedVersion: z.number().int().min(0).optional().default(0),
    createdAt: z.string().optional(),
  })
  .passthrough();

const messageBackupSchema = z
  .object({
    id: uuidOrString,
    role: z.string().max(32),
    content: z.string().max(200_000),
    edits: z.unknown().nullable().optional(),
    meta: z.unknown().nullable().optional(),
    createdAt: z.string().optional(),
  })
  .passthrough();

const conversationBackupSchema = z
  .object({
    id: uuidOrString,
    scope: z.enum(["question", "deck", "workspace"]).optional().default("question"),
    deckId: uuidOrString.nullable().optional().default(null),
    questionId: uuidOrString.nullable().optional().default(null),
    quote: z.string().max(20_000).optional().default(""),
    attempt: z.string().max(50_000).optional().default(""),
    questionTitle: z.string().max(500).optional().default(""),
    answerSnapshot: z.string().max(200_000).optional().default(""),
    questionRevision: z.number().int().min(0).optional().default(0),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    messages: z.array(messageBackupSchema).max(1000).optional().default([]),
  })
  .passthrough();

export const backupRestoreSchema = z
  .object({
    format: z.literal("shiyi-backup"),
    version: z.number().int().min(1).max(2),
    preferences: z
      .object({
        dailyGoal: z.number().int().min(1).max(200).optional(),
        dailyNewLimit: z.number().int().min(0).max(50).optional(),
        theme: z.enum(["light", "dark"]).optional(),
        timeZone: z.string().min(1).max(80).optional(),
      })
      .optional(),
    decks: z.array(deckBackupSchema).max(500).optional().default([]),
    deckGroups: z.array(deckGroupBackupSchema).max(2000).optional().default([]),
    releases: z.array(releaseBackupSchema).max(2000).optional().default([]),
    subscriptions: z
      .array(subscriptionBackupSchema)
      .max(500)
      .optional()
      .default([]),
    questions: z.array(questionBackupSchema).max(20_000).optional().default([]),
    trash: z.array(questionBackupSchema).max(5000).optional().default([]),
    personalStudyState: z
      .array(studyCardBackupSchema)
      .max(20_000)
      .optional()
      .default([]),
    reviews: z.array(reviewBackupSchema).max(100_000).optional().default([]),
    imports: z.array(importBackupSchema).max(5000).optional().default([]),
    conversations: z
      .array(conversationBackupSchema)
      .max(10_000)
      .optional()
      .default([]),
  })
  .passthrough();

export type BackupPayload = z.infer<typeof backupRestoreSchema>;

const VALID_COLORS = new Set(["sage", "blue", "sand", "rose"]);
const VALID_VISIBILITIES = new Set(["private", "public", "unlisted"]);

function safeDate(value: string | undefined, fallback = new Date()): Date {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function sanitizeColor(value: string): string {
  return VALID_COLORS.has(value) ? value : "sage";
}

function sanitizeVisibility(value: string): string {
  return VALID_VISIBILITIES.has(value) ? value : "private";
}

function sanitizeFsrs(
  raw: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.due !== "string") return null;
  const parsed = Date.parse(raw.due);
  if (Number.isNaN(parsed)) return null;
  return { ...raw, due: new Date(parsed).toISOString() };
}

function deterministicRemapId(
  userId: string,
  namespace: string,
  originalId: string,
): string {
  const bytes = createHash("sha256")
    .update(`shiyi-restore:v1:${userId}:${namespace}:${originalId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function sanitizeAnnotations(raw: unknown[]): QuestionAnnotation[] {
  const validColors = new Set(["accent", "amber", "sky", "rose"]);
  const result: QuestionAnnotation[] = [];
  for (const entry of raw.slice(0, 50)) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.comment !== "string" || !item.comment.trim()) continue;
    const id =
      typeof item.id === "string" && item.id.trim()
        ? item.id.slice(0, 120)
        : crypto.randomUUID();
    const color =
      typeof item.color === "string" && validColors.has(item.color)
        ? (item.color as QuestionAnnotation["color"])
        : "accent";
    const nowIso = new Date().toISOString();
    result.push({
      id,
      quote: typeof item.quote === "string" ? item.quote.slice(0, 600) : "",
      comment: item.comment.trim().slice(0, 2000),
      color,
      createdAt:
        typeof item.createdAt === "string" ? item.createdAt : nowIso,
      updatedAt:
        typeof item.updatedAt === "string" ? item.updatedAt : nowIso,
    });
  }
  return result;
}

export async function restorePersonalBackup(
  userId: string,
  rawPayload: unknown,
) {
  const parsed = backupRestoreSchema.safeParse(rawPayload);
  if (!parsed.success) {
    throw new AppError(400, "备份文件格式无效或已损坏，请确认是否为拾忆导出的 JSON 备份。");
  }
  const data = parsed.data;
  const db = await getDb();

  return db.transaction(async (tx) => {
    const withRemapped = (ids: string[], namespace: string) => [
      ...new Set([
        ...ids,
        ...ids.map((id) => deterministicRemapId(userId, namespace, id)),
      ]),
    ];

    const allDeckIds = withRemapped(
      data.decks.map((d) => d.id).filter(Boolean),
      "deck",
    );
    const groupCandidates = [
      ...data.deckGroups,
      ...data.decks.flatMap((d) => d.groups ?? []),
    ];
    const allGroupIds = withRemapped(
      groupCandidates.map((g) => g.id).filter(Boolean),
      "group",
    );
    const allImportIds = withRemapped(
      data.imports.map((i) => i.id).filter(Boolean),
      "import",
    );
    const allQuestionCandidates = [...data.questions, ...data.trash];
    const allQuestionIds = withRemapped(
      allQuestionCandidates.map((q) => q.id).filter(Boolean),
      "question",
    );
    const allReviewIds = withRemapped(
      data.reviews.map((r) => r.id).filter(Boolean),
      "review",
    );
    const allConvIds = withRemapped(
      data.conversations.map((c) => c.id).filter(Boolean),
      "conv",
    );
    const allMsgIds = withRemapped(
      data.conversations
        .flatMap((c) => c.messages.map((m) => m.id))
        .filter(Boolean),
      "msg",
    );

    const [
      existingDecks,
      existingSubs,
      existingGroups,
      existingImports,
      existingQuestions,
      existingStudyCards,
      existingReviews,
      existingConvs,
      existingMsgs,
    ] = await Promise.all([
      allDeckIds.length
        ? tx
            .select({
              id: decks.id,
              ownerId: decks.ownerId,
              visibility: decks.visibility,
              publishedVersion: decks.publishedVersion,
              deletedAt: decks.deletedAt,
            })
            .from(decks)
            .where(inArray(decks.id, allDeckIds))
        : Promise.resolve([]),
      tx
        .select({ deckId: subscriptions.deckId })
        .from(subscriptions)
        .where(eq(subscriptions.userId, userId)),
      allGroupIds.length
        ? tx
            .select({ id: deckGroups.id, ownerId: deckGroups.ownerId })
            .from(deckGroups)
            .where(inArray(deckGroups.id, allGroupIds))
        : Promise.resolve([]),
      allImportIds.length
        ? tx
            .select({ id: imports.id, userId: imports.userId })
            .from(imports)
            .where(inArray(imports.id, allImportIds))
        : Promise.resolve([]),
      allQuestionIds.length
        ? tx
            .select({
              id: questions.id,
              ownerId: questions.ownerId,
              deckId: questions.deckId,
              deletedAt: questions.deletedAt,
              purgedAt: questions.purgedAt,
            })
            .from(questions)
            .where(inArray(questions.id, allQuestionIds))
        : Promise.resolve([]),
      tx
        .select({ questionId: studyCards.questionId })
        .from(studyCards)
        .where(eq(studyCards.userId, userId)),
      allReviewIds.length
        ? tx
            .select({ id: reviewEvents.id, userId: reviewEvents.userId })
            .from(reviewEvents)
            .where(inArray(reviewEvents.id, allReviewIds))
        : Promise.resolve([]),
      allConvIds.length
        ? tx
            .select({ id: conversations.id, userId: conversations.userId })
            .from(conversations)
            .where(inArray(conversations.id, allConvIds))
        : Promise.resolve([]),
      allMsgIds.length
        ? tx
            .select({ id: messages.id })
            .from(messages)
            .where(inArray(messages.id, allMsgIds))
        : Promise.resolve([]),
    ]);

    const existingDeckById = new Map(existingDecks.map((d) => [d.id, d]));
    const existingSubSet = new Set(existingSubs.map((s) => s.deckId));
    const existingGroupById = new Map(existingGroups.map((g) => [g.id, g]));
    const existingImportById = new Map(existingImports.map((i) => [i.id, i]));
    const existingQuestionById = new Map(
      existingQuestions.map((q) => [q.id, q]),
    );
    const existingStudySet = new Set(
      existingStudyCards.map((c) => c.questionId),
    );
    const existingReviewById = new Map(existingReviews.map((r) => [r.id, r]));
    const existingConvById = new Map(existingConvs.map((c) => [c.id, c]));
    const existingMsgSet = new Set(existingMsgs.map((m) => m.id));

    let preferencesRestored = false;
    if (data.preferences) {
      const insertedPref = await tx
        .insert(preferences)
        .values({
          userId,
          dailyGoal: data.preferences.dailyGoal ?? 5,
          dailyNewLimit: data.preferences.dailyNewLimit ?? 3,
          theme: data.preferences.theme ?? "light",
          timeZone: data.preferences.timeZone ?? "Asia/Shanghai",
          onboarded: true,
        })
        .onConflictDoNothing()
        .returning({ userId: preferences.userId });
      preferencesRestored = insertedPref.length > 0;
    }

    const deckMap = new Map<string, string>();
    const materializedSubDeckIds = new Set<string>();
    const newlyInsertedOwnedDeckIds = new Set<string>();
    const validOwnedDeckIds = new Set<string>();
    const accessibleSubDeckIds = new Set<string>();
    let restoredDecks = 0;
    let skippedDecks = 0;

    const subRowByDeck = new Map(
      data.subscriptions.map((s) => [s.deckId, s]),
    );

    // Query existing user-owned decks (for validOwnedDeckIds).
    const currentOwnedDecks = await tx
      .select({ id: decks.id })
      .from(decks)
      .where(and(eq(decks.ownerId, userId), isNull(decks.deletedAt)));
    for (const d of currentOwnedDecks) {
      validOwnedDeckIds.add(d.id);
    }

    for (const deck of data.decks) {
      const existing = existingDeckById.get(deck.id);
      if (!deck.isOwner) {
        const canKeepSubscription =
          Boolean(existing) &&
          !existing!.deletedAt &&
          existing!.ownerId !== userId &&
          (existing!.visibility === "public" || existingSubSet.has(deck.id));
        if (canKeepSubscription && existing) {
          deckMap.set(deck.id, deck.id);
          accessibleSubDeckIds.add(deck.id);
          const subBackup = subRowByDeck.get(deck.id);
          const requestedSeen = Math.max(
            0,
            Math.min(
              existing.publishedVersion,
              subBackup?.seenVersion ??
                deck.syncedVersion ??
                deck.seenVersion ??
                existing.publishedVersion,
            ),
          );
          if (requestedSeen > 0 && !existingSubSet.has(deck.id)) {
            await tx
              .insert(subscriptions)
              .values({
                userId,
                deckId: deck.id,
                groupName: (subBackup?.groupName ?? deck.groupName ?? "").slice(
                  0,
                  80,
                ),
                seenVersion: requestedSeen,
                dismissedVersion: subBackup?.dismissedVersion ?? 0,
              })
              .onConflictDoNothing();
            existingSubSet.add(deck.id);
            restoredDecks += 1;
          } else {
            skippedDecks += 1;
          }
          continue;
        }
        // Materialize inaccessible subscribed deck into user's private workspace.
        materializedSubDeckIds.add(deck.id);
      }

      if (existing && existing.ownerId === userId && !existing.deletedAt) {
        deckMap.set(deck.id, deck.id);
        validOwnedDeckIds.add(deck.id);
        skippedDecks += 1;
        continue;
      }

      let targetDeckId = deck.id;
      if (existing) {
        const remappedId = deterministicRemapId(userId, "deck", deck.id);
        const existingRemapped = existingDeckById.get(remappedId);
        if (
          existingRemapped &&
          existingRemapped.ownerId === userId &&
          !existingRemapped.deletedAt
        ) {
          deckMap.set(deck.id, remappedId);
          validOwnedDeckIds.add(remappedId);
          skippedDecks += 1;
          continue;
        }
        targetDeckId = existingRemapped ? crypto.randomUUID() : remappedId;
      }
      deckMap.set(deck.id, targetDeckId);
      const isMaterializedSub = materializedSubDeckIds.has(deck.id);
      const insertedDeck = await tx
        .insert(decks)
        .values({
          id: targetDeckId,
          ownerId: userId,
          title: (deck.title || "未命名题库").slice(0, 120),
          description: (deck.description ?? "").slice(0, 2000),
          groupName: (deck.groupName ?? "").slice(0, 80),
          color: sanitizeColor(deck.color),
          visibility: isMaterializedSub
            ? "private"
            : sanitizeVisibility(deck.visibility),
          publishedVersion: isMaterializedSub ? 0 : (deck.publishedVersion ?? 0),
          createdAt: safeDate(deck.createdAt),
          updatedAt: safeDate(deck.updatedAt),
        })
        .onConflictDoNothing()
        .returning({ id: decks.id });
      if (insertedDeck.length) {
        restoredDecks += 1;
        validOwnedDeckIds.add(targetDeckId);
        if (!isMaterializedSub) newlyInsertedOwnedDeckIds.add(targetDeckId);
      } else {
        skippedDecks += 1;
      }
    }

    // Restore deck groups for owned / materialized decks.
    const groupMap = new Map<string, string>();
    const validGroupIds = new Set<string>();
    const currentOwnedGroups = await tx
      .select({ id: deckGroups.id })
      .from(deckGroups)
      .where(eq(deckGroups.ownerId, userId));
    for (const g of currentOwnedGroups) {
      validGroupIds.add(g.id);
    }

    const dedupedGroups = new Map<string, z.infer<typeof deckGroupBackupSchema>>();
    for (const g of data.deckGroups) {
      dedupedGroups.set(g.id, g);
    }
    for (const deck of data.decks) {
      for (const g of deck.groups ?? []) {
        if (!dedupedGroups.has(g.id)) {
          dedupedGroups.set(g.id, { ...g, deckId: g.deckId || deck.id });
        }
      }
    }

    let restoredGroups = 0;
    for (const grp of dedupedGroups.values()) {
      if (accessibleSubDeckIds.has(grp.deckId)) {
        groupMap.set(grp.id, grp.id);
        continue;
      }
      const targetDeckId = deckMap.get(grp.deckId);
      if (!targetDeckId || !validOwnedDeckIds.has(targetDeckId)) continue;
      const existing = existingGroupById.get(grp.id);
      if (existing && existing.ownerId === userId) {
        groupMap.set(grp.id, grp.id);
        validGroupIds.add(grp.id);
        continue;
      }
      let targetGroupId = grp.id;
      if (existing) {
        const remappedId = deterministicRemapId(userId, "group", grp.id);
        const existingRemapped = existingGroupById.get(remappedId);
        if (existingRemapped && existingRemapped.ownerId === userId) {
          groupMap.set(grp.id, remappedId);
          validGroupIds.add(remappedId);
          continue;
        }
        targetGroupId = existingRemapped ? crypto.randomUUID() : remappedId;
      }
      groupMap.set(grp.id, targetGroupId);
      const inserted = await tx
        .insert(deckGroups)
        .values({
          id: targetGroupId,
          deckId: targetDeckId,
          ownerId: userId,
          title: (grp.title || "未命名分组").slice(0, 120),
          category: (grp.category ?? "").slice(0, 80),
          description: (grp.description ?? "").slice(0, 2000),
          position: grp.position ?? 0,
          createdAt: safeDate(grp.createdAt),
          updatedAt: safeDate(grp.updatedAt),
        })
        .onConflictDoNothing()
        .returning({ id: deckGroups.id });
      if (inserted.length) {
        restoredGroups += 1;
        validGroupIds.add(targetGroupId);
      }
    }

    // Restore committed/referenced imports.
    const importMap = new Map<string, string>();
    const validImportIds = new Set<string>();
    const currentOwnedImports = await tx
      .select({ id: imports.id })
      .from(imports)
      .where(eq(imports.userId, userId));
    for (const imp of currentOwnedImports) {
      validImportIds.add(imp.id);
    }
    const referencedImportIds = new Set(
      allQuestionCandidates.map((q) => q.importId).filter((id): id is string => !!id),
    );
    for (const imp of data.imports) {
      if (imp.status !== "complete" && !referencedImportIds.has(imp.id)) {
        continue;
      }
      const existing = existingImportById.get(imp.id);
      if (existing && existing.userId === userId) {
        importMap.set(imp.id, imp.id);
        validImportIds.add(imp.id);
        continue;
      }
      let targetImportId = imp.id;
      if (existing) {
        const remappedId = deterministicRemapId(userId, "import", imp.id);
        const existingRemapped = existingImportById.get(remappedId);
        if (existingRemapped && existingRemapped.userId === userId) {
          importMap.set(imp.id, remappedId);
          validImportIds.add(remappedId);
          continue;
        }
        targetImportId = existingRemapped ? crypto.randomUUID() : remappedId;
      }
      importMap.set(imp.id, targetImportId);
      const mappedDeckId =
        imp.deckId && deckMap.has(imp.deckId) ? deckMap.get(imp.deckId)! : null;
      const inserted = await tx
        .insert(imports)
        .values({
          id: targetImportId,
          userId,
          deckId:
            mappedDeckId && validOwnedDeckIds.has(mappedDeckId)
              ? mappedDeckId
              : null,
          raw: imp.raw,
          inputType: imp.inputType,
          method: imp.method,
          sourceName: imp.sourceName,
          sourceHash: imp.sourceHash,
          preview: null,
          commitHash: imp.commitHash,
          status: imp.status,
          result: imp.result ?? null,
          createdAt: safeDate(imp.createdAt),
        })
        .onConflictDoNothing()
        .returning({ id: imports.id });
      if (inserted.length) {
        validImportIds.add(targetImportId);
      }
    }

    // Restore questions (active + trash).
    const questionMap = new Map<string, string>();
    const validQuestionIds = new Set<string>();
    const currentOwnedQuestions = await tx
      .select({
        id: questions.id,
        deckId: questions.deckId,
        groupId: questions.groupId,
        contentHash: questions.contentHash,
      })
      .from(questions)
      .where(and(eq(questions.ownerId, userId), isNull(questions.purgedAt)));
    const ownedHashLookup = new Map<string, string>();
    for (const q of currentOwnedQuestions) {
      validQuestionIds.add(q.id);
      if (q.deckId) {
        ownedHashLookup.set(
          `${q.deckId}\0${q.groupId ?? ""}\0${q.contentHash}`,
          q.id,
        );
      }
    }

    let restoredQuestions = 0;
    let skippedQuestions = 0;
    const seenQuestions = new Set<string>();

    for (const q of allQuestionCandidates) {
      if (seenQuestions.has(q.id)) continue;
      seenQuestions.add(q.id);

      const isSubAccessible =
        !q.isOwner &&
        q.deckId !== null &&
        accessibleSubDeckIds.has(q.deckId);
      const existing = existingQuestionById.get(q.id);

      if (isSubAccessible) {
        if (existing && !existing.purgedAt) {
          questionMap.set(q.id, q.id);
          validQuestionIds.add(q.id);
        }
        skippedQuestions += 1;
        continue;
      }

      if (existing && existing.ownerId === userId && !existing.purgedAt) {
        questionMap.set(q.id, q.id);
        validQuestionIds.add(q.id);
        skippedQuestions += 1;
        continue;
      }

      let resolvedCollisionId: string | null = null;
      if (existing) {
        const remappedId = deterministicRemapId(userId, "question", q.id);
        const existingRemapped = existingQuestionById.get(remappedId);
        if (
          existingRemapped &&
          existingRemapped.ownerId === userId &&
          !existingRemapped.purgedAt
        ) {
          questionMap.set(q.id, remappedId);
          validQuestionIds.add(remappedId);
          skippedQuestions += 1;
          continue;
        }
        resolvedCollisionId = existingRemapped
          ? crypto.randomUUID()
          : remappedId;
      }

      const mappedDeckId = q.deckId ? (deckMap.get(q.deckId) ?? null) : null;
      const targetDeckId =
        mappedDeckId && validOwnedDeckIds.has(mappedDeckId)
          ? mappedDeckId
          : null;
      const mappedGroupId =
        targetDeckId && q.groupId ? (groupMap.get(q.groupId) ?? null) : null;
      const targetGroupId =
        mappedGroupId && validGroupIds.has(mappedGroupId)
          ? mappedGroupId
          : null;
      const mappedImportId = q.importId
        ? (importMap.get(q.importId) ?? null)
        : null;
      const targetImportId =
        mappedImportId && validImportIds.has(mappedImportId)
          ? mappedImportId
          : null;

      const normalizedTags = mergeQuestionTags([], q.tags ?? []);
      const answer = q.answer ?? "";
      const hash = contentHash(q.title, answer);
      const isTrashed = Boolean(q.deletedAt);

      if (!isTrashed && targetDeckId) {
        const dupId = ownedHashLookup.get(
          `${targetDeckId}\0${targetGroupId ?? ""}\0${hash}`,
        );
        if (dupId) {
          questionMap.set(q.id, dupId);
          validQuestionIds.add(dupId);
          skippedQuestions += 1;
          continue;
        }
      }

      const targetQuestionId = resolvedCollisionId ?? q.id;
      questionMap.set(q.id, targetQuestionId);
      const inserted = await tx
        .insert(questions)
        .values({
          id: targetQuestionId,
          ownerId: userId,
          deckId: targetDeckId,
          groupId: targetGroupId,
          position: q.position ?? 0,
          deletedAt: q.deletedAt ? safeDate(q.deletedAt) : null,
          purgedAt: null,
          parentId: q.parentId ? (questionMap.get(q.parentId) ?? null) : null,
          title: (q.title || "未命名题目").slice(0, 500),
          answer,
          tags: normalizedTags,
          sourceText: q.sourceText ?? "",
          importId: targetImportId,
          validation: (q.validation as ContentValidation | null) ?? null,
          contentHash: hash,
          revision: Math.max(1, q.revision ?? 1),
          needsEditing: q.needsEditing ?? !answer.trim(),
          archived: q.archived ?? false,
          majorRevision: Math.max(0, q.majorRevision ?? 0),
          createdAt: safeDate(q.createdAt),
          updatedAt: safeDate(q.updatedAt),
        })
        .onConflictDoNothing()
        .returning({ id: questions.id });

      if (inserted.length) {
        restoredQuestions += 1;
        validQuestionIds.add(targetQuestionId);
        if (!isTrashed && targetDeckId) {
          ownedHashLookup.set(
            `${targetDeckId}\0${targetGroupId ?? ""}\0${hash}`,
            targetQuestionId,
          );
        }
      } else {
        skippedQuestions += 1;
      }
    }

    // Restore published release snapshots for newly restored owned decks.
    let restoredReleases = 0;
    for (const rel of data.releases) {
      const targetDeckId = deckMap.get(rel.deckId);
      if (!targetDeckId || !newlyInsertedOwnedDeckIds.has(targetDeckId)) {
        continue;
      }
      const mappedGroups = rel.groups
        .filter(
          (g): g is PublishedDeckGroup =>
            Boolean(g) &&
            typeof g === "object" &&
            typeof (g as { id?: unknown }).id === "string",
        )
        .map((g) => ({
          ...g,
          id: groupMap.get(g.id) ?? g.id,
        }));
      const mappedQuestions = rel.questions
        .filter(
          (q): q is PublishedQuestion =>
            Boolean(q) &&
            typeof q === "object" &&
            typeof (q as { id?: unknown }).id === "string",
        )
        .map((q) => ({
          ...q,
          id: questionMap.get(q.id) ?? q.id,
          deckId: targetDeckId,
          groupId: q.groupId ? (groupMap.get(q.groupId) ?? q.groupId) : null,
        }));
      const inserted = await tx
        .insert(releases)
        .values({
          deckId: targetDeckId,
          version: rel.version,
          title: rel.title.slice(0, 120),
          description: (rel.description ?? "").slice(0, 2000),
          summary: (rel.summary ?? "").slice(0, 1000),
          groups: mappedGroups,
          questions: mappedQuestions,
          createdAt: safeDate(rel.createdAt),
        })
        .onConflictDoNothing()
        .returning({ version: releases.version });
      if (inserted.length) restoredReleases += 1;
    }

    // Merge personal study cards (never overwrite existing study cards).
    let restoredStudyCards = 0;
    let skippedStudyCards = 0;
    const studyCardInputs = new Map<
      string,
      z.infer<typeof studyCardBackupSchema>
    >();
    for (const card of data.personalStudyState) {
      studyCardInputs.set(card.questionId, card);
    }
    for (const q of data.questions) {
      if (studyCardInputs.has(q.id)) continue;
      if (
        q.fsrs ||
        q.note?.trim() ||
        (q.annotations && q.annotations.length > 0) ||
        q.favorite
      ) {
        studyCardInputs.set(q.id, {
          questionId: q.id,
          fsrs: q.fsrs ?? null,
          version: q.studyVersion ?? 0,
          reviewedRevision: q.reviewedRevision ?? 0,
          favorite: Boolean(q.favorite),
          note: q.note ?? "",
          noteVersion: q.noteVersion ?? 0,
          annotations: q.annotations ?? [],
          annotationsVersion: q.annotationsVersion ?? 0,
        });
      }
    }

    for (const card of studyCardInputs.values()) {
      const targetQuestionId = questionMap.get(card.questionId);
      if (!targetQuestionId || !validQuestionIds.has(targetQuestionId)) {
        skippedStudyCards += 1;
        continue;
      }
      if (existingStudySet.has(targetQuestionId)) {
        skippedStudyCards += 1;
        continue;
      }
      const inserted = await tx
        .insert(studyCards)
        .values({
          userId,
          questionId: targetQuestionId,
          fsrs: sanitizeFsrs(card.fsrs),
          version: card.version ?? 0,
          reviewedRevision: card.reviewedRevision ?? 0,
          favorite: Boolean(card.favorite),
          note: card.note ?? "",
          noteVersion: card.noteVersion ?? 0,
          annotations: sanitizeAnnotations(card.annotations ?? []),
          annotationsVersion: card.annotationsVersion ?? 0,
          updatedAt: safeDate(card.updatedAt),
        })
        .onConflictDoNothing()
        .returning({ questionId: studyCards.questionId });
      if (inserted.length) {
        existingStudySet.add(targetQuestionId);
        restoredStudyCards += 1;
      } else {
        skippedStudyCards += 1;
      }
    }

    // Merge review events (preserving snapshots).
    let restoredReviews = 0;
    let skippedReviews = 0;
    for (const rev of data.reviews) {
      const targetQuestionId = questionMap.get(rev.questionId);
      if (!targetQuestionId || !validQuestionIds.has(targetQuestionId)) {
        skippedReviews += 1;
        continue;
      }
      const existing = existingReviewById.get(rev.id);
      if (existing && existing.userId === userId) {
        skippedReviews += 1;
        continue;
      }
      let targetReviewId = rev.id;
      if (existing) {
        const remappedId = deterministicRemapId(userId, "review", rev.id);
        const existingRemapped = existingReviewById.get(remappedId);
        if (existingRemapped && existingRemapped.userId === userId) {
          skippedReviews += 1;
          continue;
        }
        targetReviewId = existingRemapped ? crypto.randomUUID() : remappedId;
      }
      const inserted = await tx
        .insert(reviewEvents)
        .values({
          id: targetReviewId,
          userId,
          questionId: targetQuestionId,
          questionTitle: rev.questionTitle ?? null,
          questionAnswer: rev.questionAnswer ?? null,
          rating: rev.rating,
          answer: rev.answer ?? null,
          questionRevision: rev.questionRevision ?? 1,
          before: rev.before ?? null,
          after: rev.after,
          createdAt: safeDate(rev.createdAt),
        })
        .onConflictDoNothing()
        .returning({ id: reviewEvents.id });
      if (inserted.length) restoredReviews += 1;
      else skippedReviews += 1;
    }

    // Merge conversations and messages.
    let restoredConversations = 0;
    let skippedConversations = 0;
    for (const conv of data.conversations) {
      const existing = existingConvById.get(conv.id);
      if (existing && existing.userId === userId) {
        skippedConversations += 1;
        continue;
      }
      let targetConvId = conv.id;
      if (existing) {
        const remappedId = deterministicRemapId(userId, "conv", conv.id);
        const existingRemapped = existingConvById.get(remappedId);
        if (existingRemapped && existingRemapped.userId === userId) {
          skippedConversations += 1;
          continue;
        }
        targetConvId = existingRemapped ? crypto.randomUUID() : remappedId;
      }
      const targetDeckId = conv.deckId
        ? (deckMap.get(conv.deckId) ?? null)
        : null;
      const targetQuestionId = conv.questionId
        ? (questionMap.get(conv.questionId) ?? null)
        : null;
      const hasValidQuestion =
        targetQuestionId !== null && validQuestionIds.has(targetQuestionId);
      if (conv.scope === "question" && !hasValidQuestion) {
        skippedConversations += 1;
        continue;
      }
      const hasValidDeck =
        targetDeckId !== null &&
        (validOwnedDeckIds.has(targetDeckId) ||
          accessibleSubDeckIds.has(targetDeckId));
      const inserted = await tx
        .insert(conversations)
        .values({
          id: targetConvId,
          userId,
          scope: conv.scope,
          deckId: hasValidDeck ? targetDeckId : null,
          questionId: hasValidQuestion ? targetQuestionId : null,
          quote: conv.quote ?? "",
          attempt: conv.attempt ?? "",
          questionTitle: conv.questionTitle ?? "",
          answerSnapshot: conv.answerSnapshot ?? "",
          questionRevision: conv.questionRevision ?? 0,
          createdAt: safeDate(conv.createdAt),
          updatedAt: safeDate(conv.updatedAt),
        })
        .onConflictDoNothing()
        .returning({ id: conversations.id });
      if (!inserted.length) {
        skippedConversations += 1;
        continue;
      }
      restoredConversations += 1;
      for (const msg of conv.messages) {
        let targetMsgId = msg.id;
        if (existingMsgSet.has(msg.id)) {
          const remappedId = deterministicRemapId(userId, "msg", msg.id);
          targetMsgId = existingMsgSet.has(remappedId)
            ? crypto.randomUUID()
            : remappedId;
        }
        existingMsgSet.add(targetMsgId);
        await tx
          .insert(messages)
          .values({
            id: targetMsgId,
            conversationId: targetConvId,
            role: msg.role,
            content: msg.content,
            edits: (msg.edits as ChatEdit[] | null) ?? null,
            meta: (msg.meta as ChatMessageMeta | null) ?? null,
            createdAt: safeDate(msg.createdAt),
          })
          .onConflictDoNothing();
      }
    }

    return {
      ok: true,
      restored: {
        decks: restoredDecks,
        groups: restoredGroups,
        questions: restoredQuestions,
        releases: restoredReleases,
        studyCards: restoredStudyCards,
        reviews: restoredReviews,
        conversations: restoredConversations,
        preferencesRestored,
      },
      skipped: {
        decks: skippedDecks,
        questions: skippedQuestions,
        studyCards: skippedStudyCards,
        reviews: skippedReviews,
        conversations: skippedConversations,
      },
    };
  });
}
