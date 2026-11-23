"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, RequestError } from "@/lib/client";
import type { DeckView, QuestionView, Workspace } from "@/lib/types";
import type { Mutate } from "./dialogs";

const FOCUS_STALE_MS = 25_000;
const POLL_INTERVAL_MS = 60_000;

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
      if (q.fsrs && new Date(q.fsrs.due).getTime() <= now) due += 1;
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
      due: eligible.filter(
        (q) => q.fsrs && new Date(q.fsrs.due).getTime() <= now,
      ).length,
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

  if (
    url === "/api/decks" &&
    action === "acknowledge" &&
    typeof body.deckId === "string" &&
    typeof body.version === "number"
  ) {
    return {
      ...prev,
      decks: prev.decks.map((d) =>
        d.id === body.deckId ? { ...d, seenVersion: body.version as number } : d,
      ),
    };
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
  pendingCount.current = pending;
  const lifetime = useRef<AbortController | null>(null);
  const refreshAbort = useRef<AbortController | null>(null);
  const refreshSeq = useRef(0);
  const mutationEpoch = useRef(0);
  const lastSyncedAt = useRef(0);

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
        const result = await api<Workspace>("/api/workspace", undefined, {
          userId: sessionId,
          signal,
        });
        if (result.user.id !== sessionId) {
          window.location.reload();
          return null;
        }
        if (seq !== refreshSeq.current || startEpoch !== mutationEpoch.current) {
          return null;
        }
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
    if (!sessionId) return;
    void refresh();

    function onFocus() {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastSyncedAt.current < FOCUS_STALE_MS) return;
      void refresh(true);
    }
    function onOnline() {
      if (document.visibilityState === "visible") void refresh(true);
    }
    const timer = window.setInterval(() => {
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
      setPending((n) => n + 1);
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
        setPending((n) => n - 1);
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
