"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, RequestError } from "@/lib/client";
import { isQuestionDue } from "@/lib/review-queue";
import { dateKey } from "@/lib/utils";
import type {
  DeckView,
  QuestionAnnotation,
  QuestionView,
  StoredCard,
  Workspace,
} from "@/lib/types";
import type { Mutate } from "./dialogs";

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
  const nextDecks = decks.map((deck) => {
    const active = grouped.get(deck.id) ?? [];
    const eligible = active.filter((q) => q.answer.trim());
    return {
      ...deck,
      count: active.length,
      due: eligible.filter((q) => isQuestionDue(q, now)).length,
      newCount: eligible.filter((q) => !q.fsrs).length,
    };
  });
  return { decks: nextDecks, total, due, newCount };
}

function applyLocalWorkspacePatch(
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
    const nextQuestions = prev.questions.map((q) =>
      q.id === questionId
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

  if (url === "/api/questions") {
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) return null;
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
      return {
        ...prev,
        questions: prev.questions.map((q) =>
          q.id === id
            ? {
                ...q,
                annotations: result.annotations as QuestionAnnotation[],
                annotationsVersion: result.version as number,
              }
            : q,
        ),
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
  const [data, setData] = useState<Workspace | null>(null);
  const dataRef = useRef<Workspace | null>(null);
  dataRef.current = data;
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
          if (seq !== refreshSeq.current || startEpoch !== mutationEpoch.current) {
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
        if (seq !== refreshSeq.current || startEpoch !== mutationEpoch.current) {
          return null;
        }
        etagRef.current = response.headers.get("etag");
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
          setError(e instanceof Error ? e.message : "题库暂时无法读取。");
        }
        return null;
      } finally {
        if (refreshAbort.current === controller) {
          refreshAbort.current = null;
        }
      }
    },
    [sessionId],
  );

  useEffect(() => {
    setData(null);
    setError("");
    lastSyncedAt.current = 0;
    etagRef.current = null;
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
  }, [sessionId, refresh]);

  const mutate: Mutate = useCallback(
    async (url, payload) => {
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
        mutationEpoch.current += 1;
        refreshAbort.current?.abort();
        const patched =
          dataRef.current !== null
            ? applyLocalWorkspacePatch(dataRef.current, url, payload, result)
            : null;
        if (patched) {
          etagRef.current = null;
          lastSyncedAt.current = Date.now();
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
        toast.error(e instanceof Error ? e.message : "操作失败，请重试。");
        if (e instanceof RequestError && e.status === 409) await refresh(true);
        return null;
      } finally {
        pendingCount.current = Math.max(0, pendingCount.current - 1);
        setPending((n) => Math.max(0, n - 1));
      }
    },
    [sessionId, refresh],
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
