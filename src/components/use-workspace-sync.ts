"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, RequestError, type WorkspaceMutate } from "@/lib/client";
import { recomputeConceptFolderState } from "@/lib/concepts";
import { ROOT_FOLDER_LABEL, buildFolderIndex } from "@/lib/folders";
import { isQuestionDue } from "@/lib/review-queue";
import { dateKey } from "@/lib/utils";
import type {
  ConceptFolderView,
  ConceptView,
  DeckView,
  QuestionAnnotation,
  QuestionView,
  StoredCard,
  Workspace,
} from "@/lib/types";

const FOCUS_STALE_MS = 25_000;
const POLL_INTERVAL_MS = 60_000;

function computeStreakFromActivity(
  activity: { date: string; count: number }[],
  today: string,
): number {
  const counts = new Map(activity.map((row) => [row.date, row.count]));
  let streak = 0;
  const cursor = new Date(`${today}T12:00:00Z`);
  if (!counts.has(today)) cursor.setUTCDate(cursor.getUTCDate() - 1);
  while (counts.has(cursor.toISOString().slice(0, 10))) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

function recomputeDeckCounts(
  decks: DeckView[],
  questions: QuestionView[],
  now: number,
): { decks: DeckView[]; total: number; due: number; newCount: number } {
  const grouped = new Map<string, QuestionView[]>();
  let total = 0;
  let due = 0;
  let newCount = 0;
  for (const q of questions) {
    if (q.archived) continue;
    total += 1;
    const answered = !!q.answer.trim();
    if (answered) {
      if (isQuestionDue(q, now)) due += 1;
      else if (!q.fsrs) newCount += 1;
    }
    if (q.deckId) {
      const list = grouped.get(q.deckId);
      if (list) list.push(q);
      else grouped.set(q.deckId, [q]);
    }
  }
  const folderIndex = buildFolderIndex(decks);
  const nextDecks = decks.map((deck) => {
    if (deck.isOwner) {
      const subtreeIds = folderIndex.subtreeOwnedIds(deck.id);
      const directActive = grouped.get(deck.id) ?? [];
      let count = 0;
      let folderDue = 0;
      let folderNew = 0;
      for (const fid of subtreeIds) {
        const list = grouped.get(fid);
        if (!list) continue;
        for (const q of list) {
          count += 1;
          if (!q.answer.trim()) continue;
          if (isQuestionDue(q, now)) folderDue += 1;
          else if (!q.fsrs) folderNew += 1;
        }
      }
      return {
        ...deck,
        directCount: directActive.length,
        count,
        due: folderDue,
        newCount: folderNew,
      };
    }
    const active = grouped.get(deck.id) ?? [];
    const eligible = active.filter((q) => q.answer.trim());
    return {
      ...deck,
      directCount: active.length,
      count: active.length,
      due: eligible.filter((q) => isQuestionDue(q, now)).length,
      newCount: eligible.filter((q) => !q.fsrs).length,
    };
  });
  return { decks: nextDecks, total, due, newCount };
}

function refreshQuestionPaths(
  decks: DeckView[],
  questions: QuestionView[],
): QuestionView[] {
  const folderIndex = buildFolderIndex(decks);
  let anyChanged = false;
  const next = questions.map((q) => {
    if (q.isOwner) {
      const folder = q.deckId ? folderIndex.ownedById.get(q.deckId) : undefined;
      const deckTitle = folder ? folder.title : ROOT_FOLDER_LABEL;
      const folderPath = folderIndex.formatPath(q.deckId, null);
      if (q.deckTitle === deckTitle && q.folderPath === folderPath) return q;
      anyChanged = true;
      return { ...q, deckTitle, folderPath };
    }
    const folderPath = folderIndex.formatPath(q.deckId, q.groupId);
    if (q.folderPath === folderPath) return q;
    anyChanged = true;
    return { ...q, folderPath };
  });
  return anyChanged ? next : questions;
}

function upsertById<T extends { id: string }>(
  list: readonly T[],
  item: T,
): T[] {
  const idx = list.findIndex((entry) => entry.id === item.id);
  if (idx === -1) return [...list, item];
  const next = [...list];
  next[idx] = item;
  return next;
}

function syncAnnotationsForConcept(
  questions: QuestionView[],
  conceptId: string,
  patch: {
    comment?: string;
    color?: QuestionAnnotation["color"];
    unlink?: boolean;
    updatedAt?: string;
  },
  excludeQuestionId?: string,
): QuestionView[] {
  const nowIso = patch.updatedAt ?? new Date().toISOString();
  const nextComment =
    patch.comment !== undefined ? patch.comment.slice(0, 2000) : undefined;
  let anyChanged = false;
  const nextQuestions = questions.map((q) => {
    if (excludeQuestionId && q.id === excludeQuestionId) return q;
    if (!q.annotations.length) return q;
    let qChanged = false;
    const nextAnns = q.annotations.map((ann) => {
      if (ann.conceptId !== conceptId) return ann;
      qChanged = true;
      if (patch.unlink) {
        return { ...ann, conceptId: null, updatedAt: nowIso };
      }
      return {
        ...ann,
        ...(nextComment !== undefined ? { comment: nextComment } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        updatedAt: nowIso,
      };
    });
    if (!qChanged) return q;
    anyChanged = true;
    return {
      ...q,
      annotations: nextAnns,
      annotationsVersion: q.annotationsVersion + 1,
    };
  });
  return anyChanged ? nextQuestions : questions;
}

function unlinkAnnotationsForConcepts(
  questions: QuestionView[],
  conceptIds: ReadonlySet<string>,
): QuestionView[] {
  if (!conceptIds.size) return questions;
  const nowIso = new Date().toISOString();
  let anyChanged = false;
  const nextQuestions = questions.map((q) => {
    if (!q.annotations.length) return q;
    let qChanged = false;
    const nextAnns = q.annotations.map((ann) => {
      if (!ann.conceptId || !conceptIds.has(ann.conceptId)) return ann;
      qChanged = true;
      return { ...ann, conceptId: null, updatedAt: nowIso };
    });
    if (!qChanged) return q;
    anyChanged = true;
    return {
      ...q,
      annotations: nextAnns,
      annotationsVersion: q.annotationsVersion + 1,
    };
  });
  return anyChanged ? nextQuestions : questions;
}

function buildCreatedQuestionView(
  prev: Workspace,
  raw: Record<string, unknown>,
): QuestionView | null {
  if (
    typeof raw.id !== "string" ||
    typeof raw.title !== "string" ||
    typeof raw.answer !== "string"
  ) {
    return null;
  }
  const deckId = typeof raw.deckId === "string" ? raw.deckId : null;
  const folderIndex = buildFolderIndex(prev.decks);
  const folder = deckId ? folderIndex.ownedById.get(deckId) : undefined;
  const nowIso = new Date().toISOString();
  return {
    id: raw.id,
    deckId,
    groupId: null,
    position: typeof raw.position === "number" ? raw.position : 0,
    parentId: typeof raw.parentId === "string" ? raw.parentId : null,
    title: raw.title,
    answer: raw.answer,
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((t): t is string => typeof t === "string")
      : [],
    revision: typeof raw.revision === "number" ? raw.revision : 1,
    majorRevision:
      typeof raw.majorRevision === "number" ? raw.majorRevision : 0,
    needsEditing:
      typeof raw.needsEditing === "boolean"
        ? raw.needsEditing
        : !raw.answer.trim(),
    archived: typeof raw.archived === "boolean" ? raw.archived : false,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : nowIso,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : nowIso,
    isOwner: true,
    deckTitle: folder ? folder.title : ROOT_FOLDER_LABEL,
    folderPath: folderIndex.formatPath(deckId, null),
    note: "",
    noteVersion: 0,
    annotations: [],
    annotationsVersion: 0,
    favorite: false,
    fsrs: null,
    studyVersion: 0,
    reviewedRevision: 0,
    validation: null,
  };
}

export function applyLocalWorkspacePatch(
  prev: Workspace | null,
  url: string,
  payload: unknown,
  result: Record<string, unknown>,
): Workspace | null {
  if (!prev || !payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;
  const action = body.action;

  if (url === "/api/reviews") {
    const questionId = typeof body.questionId === "string" ? body.questionId : "";
    const card = result.card as StoredCard | undefined;
    const studyVersion = result.studyVersion;
    const reviewedRevision = result.reviewedRevision;
    if (
      !questionId ||
      !card ||
      typeof card !== "object" ||
      typeof studyVersion !== "number" ||
      typeof reviewedRevision !== "number"
    ) {
      return null;
    }
    const prevQ = prev.questions.find((q) => q.id === questionId);
    const shouldKeepExistingCard =
      Boolean(prevQ) && studyVersion < prevQ!.studyVersion;
    const nextQuestions = prev.questions.map((q) =>
      q.id === questionId && !shouldKeepExistingCard
        ? {
            ...q,
            fsrs: card,
            studyVersion,
            reviewedRevision,
          }
        : q,
    );
    const { decks, total, due, newCount } = recomputeDeckCounts(
      prev.decks,
      nextQuestions,
      Date.now(),
    );
    if (result.duplicate === true) {
      return {
        ...prev,
        decks,
        questions: nextQuestions,
        stats: {
          ...prev.stats,
          total,
          due,
          new: newCount,
        },
      };
    }
    const timeZone = prev.settings.timeZone || "Asia/Shanghai";
    const createdAt =
      typeof result.createdAt === "string"
        ? result.createdAt
        : new Date().toISOString();
    const today = dateKey(createdAt, timeZone);
    const alreadyReviewedToday =
      Boolean(
        prevQ?.fsrs?.last_review &&
          dateKey(String(prevQ.fsrs.last_review), timeZone) === today,
      ) ||
      prev.recentReviews.some(
        (r) => r.questionId === questionId && dateKey(r.createdAt, timeZone) === today,
      );
    const existingDay = prev.activity.find((a) => a.date === today);
    const nextActivity = existingDay
      ? prev.activity.map((a) =>
          a.date === today ? { ...a, count: a.count + 1 } : a,
        )
      : [...prev.activity, { date: today, count: 1 }];
    const nextStreak = computeStreakFromActivity(nextActivity, today);
    const recentItem = {
      id: typeof body.eventId === "string" ? body.eventId : String(Date.now()),
      questionId,
      title:
        typeof result.questionTitle === "string"
          ? result.questionTitle
          : (prevQ?.title ?? "已归档题目"),
      questionAnswer:
        typeof result.questionAnswer === "string"
          ? result.questionAnswer
          : (prevQ?.answer ?? null),
      questionRevision:
        typeof result.questionRevision === "number"
          ? result.questionRevision
          : prevQ?.revision,
      rating: Number(body.rating ?? result.rating ?? 3),
      answer:
        typeof body.answer === "string" && body.answer ? body.answer : null,
      createdAt,
      due: String(card.due),
    };
    const nextRecentReviews = [
      recentItem,
      ...prev.recentReviews.filter((r) => r.id !== recentItem.id),
    ].slice(0, 30);
    return {
      ...prev,
      decks,
      questions: nextQuestions,
      activity: nextActivity,
      recentReviews: nextRecentReviews,
      stats: {
        ...prev.stats,
        total,
        due,
        new: newCount,
        reviewedToday: prev.stats.reviewedToday + (alreadyReviewedToday ? 0 : 1),
        newLearnedToday:
          prev.stats.newLearnedToday + (result.isFirstLearn === true ? 1 : 0),
        totalReviews: prev.stats.totalReviews + 1,
        streak: nextStreak,
      },
    };
  }

  if (url === "/api/concepts") {
    const prevFolders = prev.conceptFolders ?? [];
    const prevConcepts = prev.concepts ?? [];

    if (
      (action === "moveFolder" ||
        action === "groupIntoNewFolder" ||
        action === "dissolveFolder" ||
        action === "renameGroup" ||
        action === "moveGroup") &&
      Array.isArray(result.conceptFolders) &&
      Array.isArray(result.concepts)
    ) {
      return {
        ...prev,
        conceptFolders: result.conceptFolders as ConceptFolderView[],
        concepts: result.concepts as ConceptView[],
      };
    }

    if (
      action === "deleteFolder" &&
      Array.isArray(result.conceptFolders) &&
      Array.isArray(result.concepts)
    ) {
      const deletedIds = new Set(
        Array.isArray(result.deletedConceptIds)
          ? (result.deletedConceptIds as unknown[]).filter(
              (id): id is string => typeof id === "string",
            )
          : [],
      );
      return {
        ...prev,
        conceptFolders: result.conceptFolders as ConceptFolderView[],
        concepts: result.concepts as ConceptView[],
        questions: unlinkAnnotationsForConcepts(prev.questions, deletedIds),
      };
    }

    if (
      action === "importFromAnnotations" &&
      Array.isArray(result.conceptFolders) &&
      Array.isArray(result.allConcepts)
    ) {
      let nextQuestions = prev.questions;
      if (Array.isArray(result.updatedCards) && result.updatedCards.length) {
        const cardMap = new Map<
          string,
          { annotations: QuestionAnnotation[]; version: number }
        >();
        for (const entry of result.updatedCards) {
          if (!entry || typeof entry !== "object") continue;
          const item = entry as Record<string, unknown>;
          if (
            typeof item.questionId === "string" &&
            Array.isArray(item.annotations) &&
            typeof item.version === "number"
          ) {
            cardMap.set(item.questionId, {
              annotations: item.annotations as QuestionAnnotation[],
              version: item.version,
            });
          }
        }
        if (cardMap.size) {
          nextQuestions = prev.questions.map((q) => {
            const card = cardMap.get(q.id);
            return card
              ? {
                  ...q,
                  annotations: card.annotations,
                  annotationsVersion: card.version,
                }
              : q;
          });
        }
      }
      return {
        ...prev,
        conceptFolders: result.conceptFolders as ConceptFolderView[],
        concepts: result.allConcepts as ConceptView[],
        questions: nextQuestions,
      };
    }

    if (
      action === "create" &&
      result.concept &&
      typeof result.concept === "object"
    ) {
      const created = result.concept as ConceptView;
      const nextFolders =
        result.folder && typeof result.folder === "object"
          ? upsertById(prevFolders, result.folder as ConceptFolderView)
          : prevFolders;
      const nextConcepts = upsertById(prevConcepts, created);
      const recomputed = recomputeConceptFolderState(nextFolders, nextConcepts);
      return {
        ...prev,
        ...recomputed,
      };
    }

    if (
      action === "edit" &&
      result.concept &&
      typeof result.concept === "object"
    ) {
      const updated = result.concept as ConceptView;
      const nextFolders =
        result.folder && typeof result.folder === "object"
          ? upsertById(prevFolders, result.folder as ConceptFolderView)
          : prevFolders;
      const nextConcepts = upsertById(prevConcepts, updated);
      const recomputed = recomputeConceptFolderState(nextFolders, nextConcepts);
      const nextQuestions = syncAnnotationsForConcept(
        prev.questions,
        updated.id,
        {
          comment: updated.definition,
          color: updated.color,
          updatedAt: updated.updatedAt,
        },
      );
      return {
        ...prev,
        ...recomputed,
        questions: nextQuestions,
      };
    }

    if (action === "delete" && typeof body.id === "string") {
      const deletedId = body.id;
      const nextConcepts = prevConcepts.filter((c) => c.id !== deletedId);
      const recomputed = recomputeConceptFolderState(prevFolders, nextConcepts);
      const nextQuestions = syncAnnotationsForConcept(
        prev.questions,
        deletedId,
        { unlink: true },
      );
      return {
        ...prev,
        ...recomputed,
        questions: nextQuestions,
      };
    }

    if (action === "moveConcepts" && Array.isArray(body.ids)) {
      const idSet = new Set(
        body.ids.filter((id): id is string => typeof id === "string"),
      );
      const folderId = typeof body.folderId === "string" ? body.folderId : null;
      const nowIso = new Date().toISOString();
      const nextConcepts = prevConcepts.map((c) =>
        idSet.has(c.id) ? { ...c, folderId, updatedAt: nowIso } : c,
      );
      const recomputed = recomputeConceptFolderState(prevFolders, nextConcepts);
      return {
        ...prev,
        ...recomputed,
      };
    }

    if (
      action === "createFolder" &&
      result.folder &&
      typeof result.folder === "object"
    ) {
      const folder = result.folder as ConceptFolderView;
      const nextFolders = upsertById(prevFolders, folder);
      const recomputed = recomputeConceptFolderState(nextFolders, prevConcepts);
      return {
        ...prev,
        ...recomputed,
      };
    }

    if (
      action === "editFolder" &&
      result.folder &&
      typeof result.folder === "object"
    ) {
      const folder = result.folder as ConceptFolderView;
      const nextFolders = upsertById(prevFolders, folder);
      const recomputed = recomputeConceptFolderState(nextFolders, prevConcepts);
      return {
        ...prev,
        ...recomputed,
      };
    }
  }

  if (url === "/api/decks") {
    if (
      action === "create" &&
      result.deck &&
      typeof result.deck === "object"
    ) {
      const raw = result.deck as Record<string, unknown>;
      if (typeof raw.id === "string" && typeof raw.title === "string") {
        const nowIso = new Date().toISOString();
        const newDeck: DeckView = {
          id: raw.id,
          parentId: typeof raw.parentId === "string" ? raw.parentId : null,
          title: raw.title,
          description:
            typeof raw.description === "string" ? raw.description : "",
          groups: [],
          color: typeof raw.color === "string" ? raw.color : "sage",
          visibility:
            typeof raw.visibility === "string" ? raw.visibility : "private",
          isOwner: true,
          ownerId: prev.user.id,
          ownerName: prev.user.name,
          publishedVersion:
            typeof raw.publishedVersion === "number" ? raw.publishedVersion : 0,
          seenVersion: 0,
          syncedVersion: 0,
          dismissedVersion: 0,
          pendingUpdate: null,
          publishStatus: "unpublished",
          unpublishedDiff: null,
          directCount: 0,
          count: 0,
          due: 0,
          newCount: 0,
          updatedAt:
            typeof raw.updatedAt === "string" ? raw.updatedAt : nowIso,
          releaseSummary: "",
          sourceDeleted: false,
        };
        return {
          ...prev,
          decks: upsertById(prev.decks, newDeck),
        };
      }
    }

    if (
      action === "edit" &&
      typeof body.deckId === "string" &&
      typeof body.title === "string" &&
      typeof body.description === "string"
    ) {
      const deckId = body.deckId;
      const updatedAt =
        typeof result.updatedAt === "string"
          ? result.updatedAt
          : new Date().toISOString();
      const nextDecks = prev.decks.map((d) => {
        if (d.id !== deckId) return d;
        const metaChanged =
          d.publishedVersion > 0 &&
          (d.title !== body.title || d.description !== body.description);
        return {
          ...d,
          title: body.title as string,
          description: body.description as string,
          ...(typeof body.color === "string" ? { color: body.color } : {}),
          updatedAt,
          ...(metaChanged
            ? {
                publishStatus: "changes" as const,
                unpublishedDiff: {
                  ...(d.unpublishedDiff ?? {
                    added: 0,
                    updated: 0,
                    removed: 0,
                    groupsChanged: false,
                  }),
                  metaChanged: true,
                },
              }
            : {}),
        };
      });
      const nextQuestions = refreshQuestionPaths(nextDecks, prev.questions);
      return {
        ...prev,
        decks: nextDecks,
        questions: nextQuestions,
      };
    }

    if (
      action === "moveFolder" &&
      typeof body.folderId === "string" &&
      !result.mergedIntoId
    ) {
      const folderId = body.folderId;
      const targetParentId =
        typeof body.targetParentId === "string" ? body.targetParentId : null;
      const renamedTitle =
        typeof result.renamedTitle === "string"
          ? result.renamedTitle
          : undefined;
      const nowIso = new Date().toISOString();
      const updatedDecks = prev.decks.map((d) =>
        d.id === folderId
          ? {
              ...d,
              parentId: targetParentId,
              ...(renamedTitle ? { title: renamedTitle } : {}),
              updatedAt: nowIso,
            }
          : d,
      );
      const nextQuestions = refreshQuestionPaths(updatedDecks, prev.questions);
      const { decks, total, due, newCount } = recomputeDeckCounts(
        updatedDecks,
        nextQuestions,
        Date.now(),
      );
      return {
        ...prev,
        decks,
        questions: nextQuestions,
        stats: {
          ...prev.stats,
          total,
          due,
          new: newCount,
        },
      };
    }

    if (action === "placeSubscription" && typeof body.deckId === "string") {
      const deckId = body.deckId;
      const folderId = typeof body.folderId === "string" ? body.folderId : null;
      const nextDecks = prev.decks.map((d) =>
        d.id === deckId ? { ...d, parentId: folderId } : d,
      );
      const nextQuestions = refreshQuestionPaths(nextDecks, prev.questions);
      return {
        ...prev,
        decks: nextDecks,
        questions: nextQuestions,
      };
    }

    if (action === "unpublish" && typeof body.deckId === "string") {
      const deckId = body.deckId;
      const nowIso = new Date().toISOString();
      return {
        ...prev,
        decks: prev.decks.map((d) =>
          d.id === deckId
            ? { ...d, visibility: "private", updatedAt: nowIso }
            : d,
        ),
      };
    }
  }

  if (url === "/api/questions") {
    if (
      (action === "create" || action === "copy") &&
      result.question &&
      typeof result.question === "object"
    ) {
      const created = buildCreatedQuestionView(
        prev,
        result.question as Record<string, unknown>,
      );
      if (created) {
        const nextQuestions = upsertById(prev.questions, created);
        const { decks, total, due, newCount } = recomputeDeckCounts(
          prev.decks,
          nextQuestions,
          Date.now(),
        );
        return {
          ...prev,
          decks,
          questions: nextQuestions,
          stats: {
            ...prev.stats,
            total,
            due,
            new: newCount,
          },
        };
      }
    }

    if (action === "batch" && Array.isArray(body.ids)) {
      const op = body.operation;
      const ids = body.ids.filter((x): x is string => typeof x === "string");
      if (!ids.length) return prev;

      if (op === "delete") {
        const idSet = new Set(ids);
        const nextQuestions = prev.questions.filter((q) => !idSet.has(q.id));
        const { decks, total, due, newCount } = recomputeDeckCounts(
          prev.decks,
          nextQuestions,
          Date.now(),
        );
        return {
          ...prev,
          decks,
          questions: nextQuestions,
          stats: { ...prev.stats, total, due, new: newCount },
        };
      }

      if (op === "archive" || op === "unarchive") {
        const idSet = new Set(ids);
        const archived = op === "archive";
        const nowIso = new Date().toISOString();
        const nextQuestions = prev.questions.map((q) =>
          idSet.has(q.id) ? { ...q, archived, updatedAt: nowIso } : q,
        );
        const { decks, total, due, newCount } = recomputeDeckCounts(
          prev.decks,
          nextQuestions,
          Date.now(),
        );
        return {
          ...prev,
          decks,
          questions: nextQuestions,
          stats: { ...prev.stats, total, due, new: newCount },
        };
      }

      if (op === "move") {
        const movedIds = Array.isArray(result.movedIds)
          ? (result.movedIds as unknown[]).filter(
              (x): x is string => typeof x === "string",
            )
          : result.updated === 0
            ? []
            : ids;
        if (!movedIds.length) return prev;
        const movedSet = new Set(movedIds);
        const targetDeckId =
          typeof body.deckId === "string" ? body.deckId : null;
        const updatedAt =
          typeof result.updatedAt === "string"
            ? result.updatedAt
            : new Date().toISOString();
        const folderIndex = buildFolderIndex(prev.decks);
        const folder = targetDeckId
          ? folderIndex.ownedById.get(targetDeckId)
          : undefined;
        const deckTitle = folder ? folder.title : ROOT_FOLDER_LABEL;
        const folderPath = folderIndex.formatPath(targetDeckId, null);
        const nextQuestions = prev.questions.map((q) =>
          movedSet.has(q.id)
            ? { ...q, deckId: targetDeckId, deckTitle, folderPath, updatedAt }
            : q,
        );
        const { decks, total, due, newCount } = recomputeDeckCounts(
          prev.decks,
          nextQuestions,
          Date.now(),
        );
        return {
          ...prev,
          decks,
          questions: nextQuestions,
          stats: { ...prev.stats, total, due, new: newCount },
        };
      }
    }

    const id = typeof body.id === "string" ? body.id : "";
    if (!id) return null;
    if (action === "delete") {
      const nextQuestions = prev.questions.filter((q) => q.id !== id);
      const { decks, total, due, newCount } = recomputeDeckCounts(
        prev.decks,
        nextQuestions,
        Date.now(),
      );
      return {
        ...prev,
        decks,
        questions: nextQuestions,
        stats: {
          ...prev.stats,
          total,
          due,
          new: newCount,
        },
      };
    }
    if (action === "move") {
      if (result.updated === 0) return prev;
      const targetDeckId =
        typeof body.deckId === "string" ? body.deckId : null;
      const updatedAt =
        typeof result.updatedAt === "string"
          ? result.updatedAt
          : new Date().toISOString();
      const folderIndex = buildFolderIndex(prev.decks);
      const folder = targetDeckId
        ? folderIndex.ownedById.get(targetDeckId)
        : undefined;
      const deckTitle = folder ? folder.title : ROOT_FOLDER_LABEL;
      const folderPath = folderIndex.formatPath(targetDeckId, null);
      const nextQuestions = prev.questions.map((q) =>
        q.id === id
          ? {
              ...q,
              deckId: targetDeckId,
              deckTitle,
              folderPath,
              ...(typeof result.position === "number"
                ? { position: result.position }
                : {}),
              updatedAt,
            }
          : q,
      );
      const { decks, total, due, newCount } = recomputeDeckCounts(
        prev.decks,
        nextQuestions,
        Date.now(),
      );
      return {
        ...prev,
        decks,
        questions: nextQuestions,
        stats: {
          ...prev.stats,
          total,
          due,
          new: newCount,
        },
      };
    }
    if (action === "favorite" && typeof body.favorite === "boolean") {
      return {
        ...prev,
        questions: prev.questions.map((q) =>
          q.id === id ? { ...q, favorite: body.favorite as boolean } : q,
        ),
      };
    }
    if (
      action === "note" &&
      typeof body.note === "string" &&
      typeof result.version === "number" &&
      Number.isFinite(result.version)
    ) {
      return {
        ...prev,
        questions: prev.questions.map((q) =>
          q.id === id
            ? {
                ...q,
                note: body.note as string,
                noteVersion: result.version as number,
              }
            : q,
        ),
      };
    }
    if (
      (action === "addAnnotation" ||
        action === "editAnnotation" ||
        action === "deleteAnnotation") &&
      Array.isArray(result.annotations) &&
      typeof result.version === "number" &&
      Number.isFinite(result.version)
    ) {
      let nextQuestions = prev.questions.map((q) =>
        q.id === id
          ? {
              ...q,
              annotations: result.annotations as QuestionAnnotation[],
              annotationsVersion: result.version as number,
            }
          : q,
      );
      let nextConcepts = prev.concepts ?? [];
      let nextConceptFolders = prev.conceptFolders ?? [];
      if (result.concept && typeof result.concept === "object") {
        const savedConcept = result.concept as ConceptView;
        if (result.conceptFolder && typeof result.conceptFolder === "object") {
          nextConceptFolders = upsertById(
            nextConceptFolders,
            result.conceptFolder as ConceptFolderView,
          );
        }
        const recomputed = recomputeConceptFolderState(
          nextConceptFolders,
          upsertById(nextConcepts, savedConcept),
        );
        nextConceptFolders = recomputed.conceptFolders;
        nextConcepts = recomputed.concepts;
        if (
          action === "editAnnotation" ||
          (action === "addAnnotation" && body.updateExistingConcept === true)
        ) {
          nextQuestions = syncAnnotationsForConcept(
            nextQuestions,
            savedConcept.id,
            {
              comment: savedConcept.definition,
              color: savedConcept.color,
              updatedAt: savedConcept.updatedAt,
            },
            id,
          );
        }
      }
      return {
        ...prev,
        questions: nextQuestions,
        concepts: nextConcepts,
        conceptFolders: nextConceptFolders,
      };
    }
    if (
      action === "edit" &&
      typeof body.title === "string" &&
      typeof body.answer === "string" &&
      typeof result.revision === "number"
    ) {
      const nextQuestions = prev.questions.map((q) =>
        q.id === id
          ? {
              ...q,
              title: body.title as string,
              answer: body.answer as string,
              tags: Array.isArray(result.tags)
                ? (result.tags as string[])
                : q.tags,
              revision: result.revision as number,
              majorRevision:
                typeof result.majorRevision === "number"
                  ? result.majorRevision
                  : q.majorRevision,
              needsEditing: !(body.answer as string).trim(),
              updatedAt:
                typeof result.updatedAt === "string"
                  ? result.updatedAt
                  : new Date().toISOString(),
            }
          : q,
      );
      const { decks, total, due, newCount } = recomputeDeckCounts(
        prev.decks,
        nextQuestions,
        Date.now(),
      );
      return {
        ...prev,
        decks,
        questions: nextQuestions,
        stats: {
          ...prev.stats,
          total,
          due,
          new: newCount,
        },
      };
    }
    if (action === "archive" && typeof body.archived === "boolean") {
      const archived = body.archived;
      const nowIso = new Date().toISOString();
      const nextQuestions = prev.questions.map((q) =>
        q.id === id ? { ...q, archived, updatedAt: nowIso } : q,
      );
      const { decks, total, due, newCount } = recomputeDeckCounts(
        prev.decks,
        nextQuestions,
        Date.now(),
      );
      return {
        ...prev,
        decks,
        questions: nextQuestions,
        stats: {
          ...prev.stats,
          total,
          due,
          new: newCount,
        },
      };
    }
  }

  if (url === "/api/settings") {
    if (action === "preferences") {
      return {
        ...prev,
        settings: {
          ...prev.settings,
          ...(typeof body.dailyGoal === "number"
            ? { dailyGoal: body.dailyGoal }
            : {}),
          ...(typeof body.dailyNewLimit === "number"
            ? { dailyNewLimit: body.dailyNewLimit }
            : {}),
          ...(typeof body.theme === "string" ? { theme: body.theme } : {}),
          ...(typeof body.timeZone === "string"
            ? { timeZone: body.timeZone }
            : {}),
        },
      };
    }
    if (action === "model" && typeof body.model === "string") {
      return {
        ...prev,
        settings: {
          ...prev.settings,
          model: body.model,
        },
      };
    }
  }

  return null;
}

export function useWorkspaceSync(sessionId: string) {
  const [data, setWorkspace] = useState<Workspace | null>(null);
  const dataRef = useRef<Workspace | null>(null);
  const setData = useCallback((value: Workspace | null) => {
    dataRef.current = value;
    setWorkspace(value);
  }, []);
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState(false);
  const [pending, setPending] = useState(0);
  const pendingCount = useRef(0);
  const lifetime = useRef<AbortController | null>(null);
  const refreshAbort = useRef<AbortController | null>(null);
  const refreshSeq = useRef(0);
  const mutationEpoch = useRef(0);
  const lastSyncedAt = useRef(0);
  const etagRef = useRef<string | null>(null);
  const reconcileAfterMutations = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      refreshAbort.current?.abort();
      lifetime.current = null;
    };
  }, []);

  const refresh = useCallback(
    async (silent = false) => {
      const lifeSignal = lifetime.current?.signal;
      if (!lifeSignal || lifeSignal.aborted) return null;
      refreshAbort.current?.abort();
      const controller = new AbortController();
      refreshAbort.current = controller;
      const seq = ++refreshSeq.current;
      const startEpoch = mutationEpoch.current;
      const signal = AbortSignal.any([lifeSignal, controller.signal]);
      try {
        const sendIfNoneMatch =
          silent && dataRef.current !== null && Boolean(etagRef.current);
        const response = await fetch("/api/workspace", {
          method: "GET",
          headers: {
            ...(sessionId ? { "X-Workspace-User": sessionId } : {}),
            ...(sendIfNoneMatch && etagRef.current
              ? { "If-None-Match": etagRef.current }
              : {}),
          },
          cache: "no-store",
          signal,
        });
        if (response.status === 304 && dataRef.current) {
          if (
            signal.aborted ||
            seq !== refreshSeq.current ||
            startEpoch !== mutationEpoch.current
          ) {
            return null;
          }
          lastSyncedAt.current = Date.now();
          setError("");
          setSyncError(false);
          return dataRef.current;
        }
        const rawText = await response.text();
        let parsed: Record<string, unknown> | null = null;
        if (rawText.trim()) {
          try {
            const json = JSON.parse(rawText);
            if (json && typeof json === "object") {
              parsed = json as Record<string, unknown>;
            }
          } catch {
            if (response.ok) {
              throw new RequestError("服务器返回格式异常，请稍后重试。", response.status);
            }
          }
        }
        if (!response.ok) {
          throw new RequestError(
            typeof parsed?.error === "string" && parsed.error
              ? parsed.error
              : response.status >= 500
                ? "服务暂时不可用，请稍后重试。"
                : "请求失败，请重试。",
            response.status,
            typeof parsed?.code === "string" ? parsed.code : undefined,
          );
        }
        if (!parsed) {
          throw new RequestError("服务器返回为空，请稍后重试。", response.status);
        }
        const result = parsed as unknown as Workspace;
        if (result.user.id !== sessionId) {
          window.location.reload();
          return null;
        }
        if (
          signal.aborted ||
          seq !== refreshSeq.current ||
          startEpoch !== mutationEpoch.current
        ) {
          return null;
        }
        etagRef.current = response.headers.get("etag");
        reconcileAfterMutations.current = false;
        lastSyncedAt.current = Date.now();
        setData(result);
        setError("");
        setSyncError(false);
        return result;
      } catch (e) {
        if (
          signal.aborted ||
          (e instanceof DOMException && e.name === "AbortError")
        ) {
          return null;
        }
        if (e instanceof RequestError && e.code === "ACCOUNT_CHANGED") {
          window.location.reload();
          return null;
        }
        if (e instanceof RequestError && e.status === 401) {
          setData(null);
          window.location.reload();
        } else if (silent) {
          setSyncError(true);
        } else {
          setError(e instanceof Error ? e.message : "资料暂时无法读取。");
        }
        return null;
      } finally {
        if (refreshAbort.current === controller) {
          refreshAbort.current = null;
        }
      }
    },
    [sessionId, setData],
  );

  useEffect(() => {
    setData(null);
    setError("");
    lastSyncedAt.current = 0;
    etagRef.current = null;
    reconcileAfterMutations.current = false;
    if (!sessionId) return;
    void refresh();

    function onFocus() {
      if (document.visibilityState !== "visible") return;
      if (pendingCount.current > 0) return;
      if (Date.now() - lastSyncedAt.current < FOCUS_STALE_MS) return;
      void refresh(true);
    }
    function onOnline() {
      if (pendingCount.current > 0) return;
      if (document.visibilityState === "visible") void refresh(true);
    }
    const timer = window.setInterval(() => {
      if (pendingCount.current > 0) return;
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      void refresh(true);
    }, POLL_INTERVAL_MS);

    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      window.clearInterval(timer);
    };
  }, [sessionId, refresh, setData]);

  const mutate: WorkspaceMutate = useCallback(
    async (url, payload, options) => {
      const signal = lifetime.current?.signal;
      if (!signal || signal.aborted) return null;
      pendingCount.current += 1;
      setPending((n) => n + 1);
      // Invalidate any already-in-flight workspace refresh BEFORE the mutation starts
      // so stale server snapshots can never race back and overwrite optimistic/fresh state.
      mutationEpoch.current += 1;
      refreshAbort.current?.abort();
      try {
        const result = await api<Record<string, unknown>>(url, payload, {
          userId: sessionId,
          signal,
        });
        if (signal.aborted) return null;
        mutationEpoch.current += 1;
        refreshAbort.current?.abort();
        // A mutation only describes its own changes, which may omit other clients' writes.
        etagRef.current = null;
        reconcileAfterMutations.current = true;
        const patched =
          dataRef.current !== null
            ? applyLocalWorkspacePatch(dataRef.current, url, payload, result)
            : null;
        if (patched) {
          setData(patched);
        } else {
          const refreshed = await refresh(true);
          if (!refreshed && !signal.aborted) {
            toast.warning("操作已保存，但刷新列表失败，请稍后重试同步。");
          }
        }
        return result;
      } catch (e) {
        if (signal.aborted) return null;
        if (e instanceof RequestError && e.status === 401) {
          window.location.reload();
          return null;
        }
        if (e instanceof RequestError && e.code === "ACCOUNT_CHANGED") {
          window.location.reload();
          return null;
        }
        if (
          e instanceof RequestError &&
          e.code &&
          options?.throwOnCodes?.includes(e.code)
        ) {
          throw e;
        }
        toast.error(e instanceof Error ? e.message : "操作失败，请重试。");
        if (e instanceof RequestError && e.status === 409) {
          etagRef.current = null;
          await refresh(true);
        }
        return null;
      } finally {
        pendingCount.current = Math.max(0, pendingCount.current - 1);
        setPending((n) => Math.max(0, n - 1));
        if (
          !pendingCount.current &&
          reconcileAfterMutations.current &&
          !signal.aborted
        ) {
          void refresh(true);
        }
      }
    },
    [sessionId, refresh, setData],
  );

  return {
    data,
    setData,
    error,
    syncError,
    pending,
    pendingCount,
    lifetime,
    refresh,
    mutate,
  };
}
