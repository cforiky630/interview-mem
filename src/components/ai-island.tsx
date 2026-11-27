"use client";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftToLine,
  ArrowRightFromLine,
  ArrowUp,
  BookOpen,
  BookmarkPlus,
  Check,
  ChevronDown,
  Copy,
  FileText,
  Folder,
  Globe,
  History,
  KeyRound,
  Layers2,
  Link2,
  Loader2,
  Maximize2,
  PanelRight,
  PenLine,
  PictureInPicture2,
  Plus,
  Quote,
  Search,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { createUuid } from "@/lib/utils";
import { getDeviceProfile, useDeviceProfile } from "@/lib/device-profile";
import {
  formatQuotePreview,
  formatThreadLabel,
  isFullAnswerQuote,
} from "@/lib/ai-quote";
import {
  appendToStoredNote,
  buildChatUrl,
  buildScopeKey,
  clampAiDockWidth,
  parseSseBlocks,
  suggestCardTitle,
  type AiScope,
} from "@/lib/ai-stream";
import type {
  ChatEdit,
  ChatMessage,
  Conversation,
  DeckView,
  QuestionView,
  Workspace,
} from "@/lib/types";
import type { AiReaderTarget } from "./ai-reader-dialog";
const AiReaderDialog = dynamic(
  () => import("./ai-reader-dialog").then((m) => m.AiReaderDialog),
  { ssr: false },
);
import { AiSaveDialog, type AiSaveTarget } from "./ai-save-dialog";
import { ReasoningDisclosure, ScopeLauncher } from "./ai-scope-launcher";
import { ChatEditCard, chatEditState } from "./chat-edit-card";
import { Markdown } from "./markdown";
import { Button } from "./ui/button";
import { useDiscretePresence } from "./use-discrete-presence";
import type { Mutate } from "./dialogs";

export { clampAiDockWidth, type AiScope };
export type AiIslandMode = "collapsed" | "floating" | "docked";
export type AiTrigger = {
  quote: string;
  prompt: string;
  attempt?: string;
  nonce: number;
};

export type AiStreamSession = {
  scope: AiScope;
  scopeKey: string;
  label: string;
  questionId?: string;
  deckId?: string;
  status: "streaming" | "completed";
};

export function shouldDeferAiScopeReload(state: {
  inFlight: boolean;
  streamSession: AiStreamSession | null;
}): boolean {
  return state.inFlight || state.streamSession !== null;
}

export function resolveAiStreamCompletion(state: {
  mode: AiIslandMode;
  hidden: boolean;
  targetKey: string;
  currentScopeKey: string;
}): {
  finishedInBackground: boolean;
  markUnread: boolean;
  keepPinnedCompleted: boolean;
  showToastAction: boolean;
} {
  const finishedInBackground = state.mode === "collapsed" || state.hidden;
  return {
    finishedInBackground,
    markUnread: finishedInBackground,
    keepPinnedCompleted:
      finishedInBackground || state.targetKey !== state.currentScopeKey,
    showToastAction: finishedInBackground && !state.hidden,
  };
}

export function AiIsland({
  data,
  question,
  activeDeck,
  mode,
  allowDock = false,
  hidden = false,
  trigger,
  dockWidth = null,
  onDockWidthChange,
  onResizingDockChange,
  onModeChange,
  onOpenQuestion,
  onSettings,
  onBusyChange,
  onUnreadChange,
  mutate,
}: {
  data: Workspace;
  question?: QuestionView;
  activeDeck?: DeckView;
  mode: AiIslandMode;
  allowDock?: boolean;
  hidden?: boolean;
  trigger: AiTrigger | null;
  dockWidth?: number | null;
  onDockWidthChange?: (width: number | null) => void;
  onResizingDockChange?: (resizing: boolean) => void;
  onModeChange: (next: AiIslandMode) => void;
  onOpenQuestion: (question: QuestionView) => void;
  onSettings: (anchor?: HTMLElement | null) => void;
  onBusyChange?: (busy: boolean) => void;
  onUnreadChange?: (unread: boolean) => void;
  mutate: Mutate;
}) {
  const contextDeck = useMemo(
    () =>
      activeDeck ??
      (question?.deckId
        ? data.decks.find((d) => d.id === question.deckId)
        : undefined),
    [activeDeck, question?.deckId, data.decks],
  );
  const [scope, setScope] = useState<AiScope>(
    question ? "question" : contextDeck ? "deck" : "workspace",
  );
  const [scopedView, setScopedView] = useState<"chat" | "launcher">("chat");
  const [threads, setThreads] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [items, setItems] = useState<ChatMessage[]>([]);
  const [quote, setQuote] = useState("");
  const [quoteExpanded, setQuoteExpanded] = useState(false);
  const [attempt, setAttempt] = useState("");
  const [attemptExpanded, setAttemptExpanded] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [streamSession, setStreamSession] = useState<AiStreamSession | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [applying, setApplying] = useState<string | null>(null);
  const [noteSaveBusy, setNoteSaveBusy] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [readerTarget, setReaderTarget] = useState<AiReaderTarget | null>(null);
  const [saveTarget, setSaveTarget] = useState<AiSaveTarget | null>(null);
  const { isMobileShell } = useDeviceProfile();
  const [dragY, setDragY] = useState(0);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const historyWrapRef = useRef<HTMLDivElement>(null);

  const sheetTouch = useRef<{
    x: number;
    y: number;
    time: number;
    locked: "v" | "h" | null;
  } | null>(null);
  const loadedTargetRef = useRef<{
    key: string;
    userId: string;
  }>({ key: "", userId: data.user.id });
  const lastQuestionIdRef = useRef<string | null>(question?.id ?? null);
  const inFlightTargetKeyRef = useRef("");
  const lastAutoKey = useRef("");
  const lastTrigger = useRef(0);
  const editInFlight = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const loadAbort = useRef<AbortController | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(false);
  const streamSessionRef = useRef<AiStreamSession | null>(null);
  const modeRef = useRef<AiIslandMode>(mode);
  modeRef.current = mode;
  const hiddenRef = useRef<boolean>(hidden);
  hiddenRef.current = hidden;
  const onModeChangeRef = useRef(onModeChange);
  onModeChangeRef.current = onModeChange;
  const onUnreadChangeRef = useRef(onUnreadChange);
  onUnreadChangeRef.current = onUnreadChange;
  const lastOpenSurfaceRef = useRef<"floating" | "docked">(
    allowDock ? "docked" : "floating",
  );
  const latestScopeKeyRef = useRef("");
  const userStoppedRef = useRef(false);
  const viewedCompletedSessionRef = useRef(false);

  function updateStreamSession(next: AiStreamSession | null) {
    streamSessionRef.current = next;
    setStreamSession(next);
  }

  function stopStreaming() {
    userStoppedRef.current = true;
    abort.current?.abort();
  }

  const autoKey = question
    ? `q:${question.id}`
    : contextDeck
      ? `d:${contextDeck.id}`
      : "workspace";

  useEffect(() => {
    if (question?.id) {
      lastQuestionIdRef.current = question.id;
    }
  }, [question?.id]);

  useEffect(() => {
    if (
      shouldDeferAiScopeReload({
        inFlight: inFlight.current,
        streamSession,
      })
    ) {
      return;
    }
    if (lastAutoKey.current === autoKey) return;
    lastAutoKey.current = autoKey;
    setScope(question ? "question" : contextDeck ? "deck" : "workspace");
  }, [autoKey, question, contextDeck, streamSession]);

  const effectiveScope: AiScope =
    question && scope === "question"
      ? "question"
      : contextDeck &&
          (scope === "deck" || (scope === "question" && !question))
        ? "deck"
        : "workspace";

  const scopeKey = buildScopeKey(
    effectiveScope,
    data.user.id,
    question?.id,
    contextDeck?.id,
  );
  latestScopeKeyRef.current = scopeKey;

  const displayScope: AiScope = streamSession
    ? streamSession.scope
    : effectiveScope;
  const displayQuestion: QuestionView | undefined = streamSession
    ? streamSession.scope === "question" && streamSession.questionId
      ? data.questions.find((q) => q.id === streamSession.questionId)
      : undefined
    : question;
  const displayDeck: DeckView | undefined = streamSession
    ? streamSession.scope === "deck" && streamSession.deckId
      ? data.decks.find((d) => d.id === streamSession.deckId)
      : displayQuestion?.deckId
        ? data.decks.find((d) => d.id === displayQuestion.deckId)
        : undefined
    : contextDeck;
  const isCrossContextStream = Boolean(
    streamSession && streamSession.scopeKey !== scopeKey,
  );

  useEffect(() => {
    if (displayScope === "question") {
      setScopedView("chat");
    }
  }, [displayScope]);

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  useEffect(() => {
    const visibleOpen = !hidden && mode !== "collapsed";
    if (visibleOpen) {
      onUnreadChangeRef.current?.(false);
      if (streamSessionRef.current?.status === "completed") {
        viewedCompletedSessionRef.current = true;
        if (streamSessionRef.current.scopeKey === scopeKey) {
          viewedCompletedSessionRef.current = false;
          updateStreamSession(null);
        }
      }
    } else if (
      streamSessionRef.current?.status === "completed" &&
      viewedCompletedSessionRef.current
    ) {
      viewedCompletedSessionRef.current = false;
      updateStreamSession(null);
    }
  }, [mode, hidden, scopeKey]);

  useEffect(
    () => () => {
      abort.current?.abort();
      loadAbort.current?.abort();
      resizeCleanupRef.current?.();
    },
    [],
  );

  useEffect(() => {
    if (mode !== "collapsed" || !isMobileShell) {
      setDragY(0);
    }
  }, [mode, isMobileShell]);

  useEffect(() => {
    setHistoryOpen(false);
  }, [scopeKey, mode, hidden]);

  useEffect(() => {
    if (!historyOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (
        historyWrapRef.current &&
        !historyWrapRef.current.contains(event.target as Node)
      ) {
        setHistoryOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setHistoryOpen(false);
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [historyOpen]);

  useEffect(() => {
    if (
      shouldDeferAiScopeReload({
        inFlight: inFlight.current,
        streamSession: streamSessionRef.current,
      })
    ) {
      return;
    }
    if (effectiveScope === "question" && !question?.id) return;
    if (effectiveScope === "deck" && !contextDeck?.id) return;
    if (
      loadedTargetRef.current.key === scopeKey &&
      loadedTargetRef.current.userId === data.user.id
    ) {
      return;
    }
    if (mode === "collapsed") {
      loadedTargetRef.current = { key: "", userId: data.user.id };
      setThreads([]);
      setActiveId(null);
      setItems([]);
      setQuote("");
      setQuoteExpanded(false);
      setAttempt("");
      setAttemptExpanded(false);
      setError("");
      return;
    }
    loadedTargetRef.current = {
      key: scopeKey,
      userId: data.user.id,
    };
    loadAbort.current?.abort();
    setThreads([]);
    setActiveId(null);
    setItems([]);
    setQuote("");
    setQuoteExpanded(false);
    setAttempt("");
    setAttemptExpanded(false);
    setError("");
    const controller = new AbortController();
    loadAbort.current = controller;
    setLoading(true);
    void api<Conversation[]>(
      buildChatUrl(effectiveScope, question?.id, contextDeck?.id),
      undefined,
      { userId: data.user.id, signal: controller.signal },
    )
      .then((rows) => {
        if (!controller.signal.aborted) {
          setThreads(rows);
        }
      })
      .catch((e) => {
        if (
          !controller.signal.aborted &&
          !(e instanceof DOMException && e.name === "AbortError")
        ) {
          setError(e.message);
        }
      })
      .finally(() => {
        if (loadAbort.current === controller) {
          loadAbort.current = null;
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
      if (loadAbort.current === controller) {
        loadAbort.current = null;
      }
      setLoading(false);
    };
  }, [
    scopeKey,
    effectiveScope,
    question?.id,
    contextDeck?.id,
    data.user.id,
    mode,
    streamSession,
  ]);

  useEffect(() => {
    if (
      mode === "collapsed" ||
      (displayScope !== "question" && scopedView !== "chat")
    )
      return;
    const container = scroll.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < 96) {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: "auto",
      });
    }
  }, [items, busy, mode, displayScope, scopedView]);

  useEffect(() => {
    if (!trigger || trigger.nonce === lastTrigger.current) return;
    if (!question) return;
    if (inFlight.current) {
      lastTrigger.current = trigger.nonce;
      toast.info("当前回答还未结束，请稍候或先停止");
      return;
    }
    lastTrigger.current = trigger.nonce;
    viewedCompletedSessionRef.current = false;
    updateStreamSession(null);
    onUnreadChangeRef.current?.(false);
    loadAbort.current?.abort();
    loadAbort.current = null;
    setLoading(false);
    loadedTargetRef.current = {
      key: `q:${question.id}`,
      userId: data.user.id,
    };
    setScope("question");
    if (!data.settings.hasKey) {
      return;
    }
    const nextAttempt = trigger.attempt ?? "";
    setQuote(trigger.quote);
    setQuoteExpanded(false);
    setAttempt(nextAttempt);
    setAttemptExpanded(false);
    setActiveId(null);
    setItems([]);
    setInput(trigger.prompt);
    if (trigger.prompt.trim()) {
      void send(
        trigger.prompt,
        trigger.quote,
        null,
        true,
        nextAttempt,
        "question",
        question.id,
        undefined,
      );
    } else {
      requestAnimationFrame(() => composerRef.current?.focus());
    }
  }, [trigger?.nonce]); // selection or critique trigger intentionally starts a fresh thread

  function selectThread(id: string) {
    const thread = threads.find((t) => t.id === id);
    setActiveId(thread?.id ?? null);
    setHistoryOpen(false);
    setQuote(thread?.quote ?? "");
    setQuoteExpanded(false);
    setAttempt("");
    setAttemptExpanded(false);
    setItems(thread?.messages ?? []);
    setError("");
  }

  async function send(
    text = input,
    selectedQuote = quote,
    conversationId = activeId,
    fresh = false,
    submittedAttempt = attempt,
    targetScope = displayScope,
    targetQuestionId = displayQuestion?.id,
    targetDeckId = displayDeck?.id,
  ) {
    if (!text.trim() || inFlight.current || !data.settings.hasKey) return;
    if (targetScope === "question" && !targetQuestionId) return;
    if (targetScope === "deck" && !targetDeckId) return;

    const targetKey = buildScopeKey(
      targetScope,
      data.user.id,
      targetQuestionId,
      targetDeckId,
    );
    const targetLabel =
      targetScope === "question"
        ? (data.questions.find((q) => q.id === targetQuestionId)?.title ??
          "当前题目")
        : targetScope === "deck"
          ? (data.decks.find((d) => d.id === targetDeckId)?.title ?? "当前文件夹")
          : "全局资料工作区";
    const controller = new AbortController();
    abort.current = controller;
    inFlight.current = true;
    inFlightTargetKeyRef.current = targetKey;
    loadedTargetRef.current = { key: targetKey, userId: data.user.id };
    userStoppedRef.current = false;
    viewedCompletedSessionRef.current = false;
    onUnreadChangeRef.current?.(false);
    setScopedView("chat");
    updateStreamSession({
      scope: targetScope,
      scopeKey: targetKey,
      label: targetLabel,
      questionId: targetQuestionId,
      deckId: targetDeckId,
      status: "streaming",
    });
    setBusy(true);
    setInput("");
    setError("");
    const assistantId = createUuid();
    const userMessage: ChatMessage = {
      id: createUuid(),
      role: "user",
      content: text.trim(),
      createdAt: new Date().toISOString(),
    };
    setItems((previous) => [
      ...(fresh ? [] : previous),
      userMessage,
      {
        id: assistantId,
        role: "assistant",
        content: "",
        createdAt: new Date().toISOString(),
      },
    ]);

    const threadUrl = buildChatUrl(targetScope, targetQuestionId, targetDeckId);
    let resolvedId = conversationId;
    let sawTerminalEvent = false;
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Workspace-User": data.user.id,
        },
        body: JSON.stringify({
          scope: targetScope,
          ...(targetScope === "question" && targetQuestionId
            ? { questionId: targetQuestionId }
            : {}),
          ...(targetScope === "deck" && targetDeckId
            ? { deckId: targetDeckId }
            : {}),
          ...(conversationId ? { conversationId } : {}),
          message: text.trim(),
          quote: targetScope === "question" ? selectedQuote : "",
          ...(targetScope === "question" &&
          !conversationId &&
          submittedAttempt.trim()
            ? { attempt: submittedAttempt.trim() }
            : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const rawText = await response.text();
        let message = "AI 请求未完成。";
        try {
          const parsed = JSON.parse(rawText) as { error?: string };
          if (typeof parsed.error === "string" && parsed.error) {
            message = parsed.error;
          }
        } catch {
          /* Non-JSON proxy error page. */
        }
        throw new Error(message);
      }
      if (!response.body) throw new Error("浏览器未能读取回答。");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let bufferedAnswer = "";
      let bufferedReasoning = "";
      let flushRafId: number | null = null;
      let flushTimerId: number | null = null;

      const cancelScheduledFlush = () => {
        if (flushRafId !== null && typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(flushRafId);
          flushRafId = null;
        }
        if (flushTimerId !== null) {
          clearTimeout(flushTimerId);
          flushTimerId = null;
        }
      };

      const flushBufferedText = () => {
        cancelScheduledFlush();
        if (!bufferedAnswer && !bufferedReasoning) return;
        const answerAppend = bufferedAnswer;
        const reasoningAppend = bufferedReasoning;
        bufferedAnswer = "";
        bufferedReasoning = "";
        if (loadedTargetRef.current.key !== targetKey) return;
        setItems((previous) =>
          previous.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  ...(answerAppend ? { content: m.content + answerAppend } : {}),
                  ...(reasoningAppend
                    ? { reasoning: (m.reasoning ?? "") + reasoningAppend }
                    : {}),
                }
              : m,
          ),
        );
      };

      const scheduleBufferedFlush = () => {
        if (flushRafId !== null || flushTimerId !== null) return;
        if (typeof requestAnimationFrame === "function") {
          flushRafId = requestAnimationFrame(() => {
            flushRafId = null;
            flushBufferedText();
          });
        } else {
          flushTimerId = window.setTimeout(() => {
            flushTimerId = null;
            flushBufferedText();
          }, 50);
        }
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          pending += done
            ? decoder.decode()
            : decoder.decode(value, { stream: true });
          const { events, rest } = parseSseBlocks(pending, done);
          pending = rest;
          for (const { event, payload } of events) {
            if (event === "meta") {
              resolvedId =
                typeof payload.conversationId === "string"
                  ? payload.conversationId
                  : resolvedId;
              if (loadedTargetRef.current.key === targetKey) {
                setActiveId(resolvedId);
              }
            } else if (event === "reasoning") {
              const textChunk =
                typeof payload.text === "string" ? payload.text : "";
              if (textChunk && loadedTargetRef.current.key === targetKey) {
                bufferedReasoning += textChunk;
                scheduleBufferedFlush();
              }
            } else if (event === "tool") {
              flushBufferedText();
              const step = {
                name: String(payload.name ?? ""),
                label: String(payload.label ?? ""),
              };
              if (loadedTargetRef.current.key === targetKey) {
                setItems((previous) =>
                  previous.map((m) =>
                    m.id === assistantId
                      ? { ...m, toolSteps: [...(m.toolSteps ?? []), step] }
                      : m,
                  ),
                );
              }
            } else if (event === "references") {
              flushBufferedText();
              if (
                Array.isArray(payload.refs) &&
                loadedTargetRef.current.key === targetKey
              ) {
                setItems((previous) =>
                  previous.map((m) =>
                    m.id === assistantId
                      ? {
                          ...m,
                          references: payload.refs as ChatMessage["references"],
                        }
                      : m,
                  ),
                );
              }
            } else if (event === "edits") {
              flushBufferedText();
              if (
                Array.isArray(payload.edits) &&
                loadedTargetRef.current.key === targetKey
              ) {
                setItems((previous) =>
                  previous.map((m) =>
                    m.id === assistantId
                      ? { ...m, edits: payload.edits as ChatEdit[] }
                      : m,
                  ),
                );
              }
            } else if (event === "delta") {
              const textChunk =
                typeof payload.text === "string" ? payload.text : "";
              if (textChunk && loadedTargetRef.current.key === targetKey) {
                bufferedAnswer += textChunk;
                scheduleBufferedFlush();
              }
            } else if (event === "done") {
              flushBufferedText();
              sawTerminalEvent = true;
            } else if (event === "error") {
              flushBufferedText();
              sawTerminalEvent = true;
              throw new Error(
                typeof payload.error === "string"
                  ? payload.error
                  : "回答未完成。",
              );
            }
          }
          if (done) break;
        }
      } finally {
        flushBufferedText();
        await reader.cancel().catch(() => {});
      }
      if (!sawTerminalEvent && !controller.signal.aborted) {
        throw new Error("连接在回答结束前意外断开。");
      }
      const rows = await api<Conversation[]>(threadUrl, undefined, {
        userId: data.user.id,
        signal: controller.signal,
      });
      if (loadedTargetRef.current.key === targetKey) {
        setThreads(rows);
        const current = rows.find((t) => t.id === resolvedId);
        if (current) {
          setItems(current.messages);
          setAttempt("");
        }
      }
      if (abort.current === controller) {
        const completion = resolveAiStreamCompletion({
          mode: modeRef.current,
          hidden: hiddenRef.current,
          targetKey,
          currentScopeKey: latestScopeKeyRef.current,
        });
        if (completion.keepPinnedCompleted) {
          viewedCompletedSessionRef.current = !completion.finishedInBackground;
          updateStreamSession({
            scope: targetScope,
            scopeKey: targetKey,
            label: targetLabel,
            questionId: targetQuestionId,
            deckId: targetDeckId,
            status: "completed",
          });
        } else {
          viewedCompletedSessionRef.current = false;
          updateStreamSession(null);
        }
        if (completion.markUnread) {
          onUnreadChangeRef.current?.(true);
          toast.success("AI 已回复完成", {
            action: completion.showToastAction
              ? {
                  label: "查看",
                  onClick: () => {
                    onUnreadChangeRef.current?.(false);
                    onModeChangeRef.current(lastOpenSurfaceRef.current);
                  },
                }
              : undefined,
          });
        }
      }
    } catch (e) {
      const wasAbort = e instanceof DOMException && e.name === "AbortError";
      if (loadedTargetRef.current.key === targetKey) {
        setItems((previous) =>
          previous.filter(
            (m) => m.id !== assistantId || m.content.trim().length > 0,
          ),
        );
        if (resolvedId) {
          void api<Conversation[]>(threadUrl, undefined, {
            userId: data.user.id,
          })
            .then((rows) => {
              if (loadedTargetRef.current.key === targetKey) {
                setThreads(rows);
              }
            })
            .catch(() => {});
        }
      }
      if (abort.current === controller) {
        const staysCrossContext = targetKey !== latestScopeKeyRef.current;
        if (staysCrossContext && (!wasAbort || userStoppedRef.current)) {
          viewedCompletedSessionRef.current =
            modeRef.current !== "collapsed" && !hiddenRef.current;
          updateStreamSession({
            scope: targetScope,
            scopeKey: targetKey,
            label: targetLabel,
            questionId: targetQuestionId,
            deckId: targetDeckId,
            status: "completed",
          });
        } else {
          viewedCompletedSessionRef.current = false;
          updateStreamSession(null);
        }
      }
      if (!wasAbort) {
        const message = e instanceof Error ? e.message : "回答未完成。";
        setError(message);
        toast.error(message);
      }
    } finally {
      if (abort.current === controller) {
        setBusy(false);
        inFlight.current = false;
        inFlightTargetKeyRef.current = "";
        userStoppedRef.current = false;
        abort.current = null;
      }
    }
  }

  const active = threads.find((t) => t.id === activeId);
  const ownedDeck = displayQuestion
    ? data.decks.find((d) => d.id === displayQuestion.deckId && d.isOwner)
    : undefined;
  const visibleAttempt = (active ? active.attempt : attempt).trim();
  const resolvedReaderTarget: AiReaderTarget | null =
    readerTarget?.kind === "edit"
      ? displayQuestion && displayQuestion.id === readerTarget.question.id
        ? { ...readerTarget, question: displayQuestion, deck: ownedDeck }
        : readerTarget
      : readerTarget;

  async function applyEdit(edit: ChatEdit, key: string) {
    if (
      !displayQuestion ||
      inFlight.current ||
      editInFlight.current ||
      chatEditState(edit, displayQuestion, ownedDeck) !== "ready"
    )
      return;
    editInFlight.current = true;
    setApplying(key);
    try {
      if (edit.target === "question") {
        const result = await mutate("/api/questions", {
          action: "edit",
          id: edit.id,
          expectedRevision: edit.revision,
          title: displayQuestion.title,
          answer: displayQuestion.answer,
          tags: displayQuestion.tags,
          ...edit.fields,
        });
        if (result) toast.success("已应用到题目");
      } else if (edit.target === "note") {
        const result = await mutate("/api/questions", {
          action: "note",
          id: edit.id,
          note: edit.fields.note,
          expectedVersion: edit.expectedVersion,
        });
        if (result) {
          try {
            localStorage.removeItem(`shiyi:note:${data.user.id}:${edit.id}`);
          } catch {
            /* Ignore storage restrictions. */
          }
          window.dispatchEvent(
            new CustomEvent("shiyi:note-updated", {
              detail: {
                questionId: edit.id,
                note: edit.fields.note,
                version: Number(result.version),
              },
            }),
          );
          toast.success("已更新笔记");
        }
      } else {
        const result = await mutate("/api/decks", {
          action: "edit",
          deckId: edit.id,
          expected: edit.expected,
          ...edit.expected,
          ...edit.fields,
        });
        if (result) toast.success("已更新文件夹信息");
      }
    } finally {
      editInFlight.current = false;
      setApplying(null);
    }
  }

  async function appendAssistantToNote(
    content: string,
    heading = "AI 补充",
  ): Promise<boolean> {
    if (!displayQuestion || editInFlight.current) return false;
    editInFlight.current = true;
    setNoteSaveBusy(true);
    try {
      const { nextNote, expectedVersion } = appendToStoredNote(
        data.user.id,
        displayQuestion,
        content,
        heading,
      );
      const result = await mutate("/api/questions", {
        action: "note",
        id: displayQuestion.id,
        note: nextNote,
        expectedVersion,
      });
      if (result) {
        try {
          localStorage.removeItem(
            `shiyi:note:${data.user.id}:${displayQuestion.id}`,
          );
        } catch {
          /* Ignore storage restrictions. */
        }
        window.dispatchEvent(
          new CustomEvent("shiyi:note-updated", {
            detail: {
              questionId: displayQuestion.id,
              note: nextNote,
              version: Number(result.version),
              switchToNotes: true,
            },
          }),
        );
        toast.success("已存为笔记");
        return true;
      }
      return false;
    } finally {
      editInFlight.current = false;
      setNoteSaveBusy(false);
    }
  }

  async function copyMessageContent(message: ChatMessage) {
    if (!message.content.trim()) return;
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedMsgId(message.id);
      toast.success("已复制");
      window.setTimeout(() => {
        setCopiedMsgId((curr) => (curr === message.id ? null : curr));
      }, 1800);
    } catch {
      toast.error("复制失败，请手动复制");
    }
  }

  async function saveMessageAsCard(
    message: ChatMessage,
    options: { title: string; deckId: string | null },
  ): Promise<boolean> {
    if (!displayQuestion || copyBusy) return false;
    setCopyBusy(true);
    try {
      const response = await mutate("/api/questions", {
        action: "copy",
        id: displayQuestion.id,
        deckId: options.deckId,
        title: options.title.trim().slice(0, 200),
        answer: message.content,
      });
      if (response) {
        toast.success("已存为卡片");
        return true;
      }
      return false;
    } finally {
      setCopyBusy(false);
    }
  }

  function startDockResize(event: React.PointerEvent<HTMLDivElement>) {
    if (
      !allowDock ||
      !isDocked ||
      !onDockWidthChange ||
      getDeviceProfile().isMobileShell ||
      window.matchMedia("(max-width: 1239px)").matches
    ) {
      return;
    }
    event.preventDefault();
    resizeCleanupRef.current?.();
    onResizingDockChange?.(true);
    const rightInset = window.innerWidth >= 1600 ? 20 : 16;

    const handleMove = (moveEvent: PointerEvent) => {
      const candidate = window.innerWidth - rightInset - moveEvent.clientX;
      onDockWidthChange(clampAiDockWidth(candidate, window.innerWidth));
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      resizeCleanupRef.current = null;
      onResizingDockChange?.(false);
    };

    resizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
  }

  function handleOpenQuestion(target: QuestionView) {
    if (getDeviceProfile().isMobileShell) {
      onModeChange("collapsed");
    }
    onOpenQuestion(target);
  }

  const isOpen = !hidden && mode !== "collapsed";
  const isDockedNow = mode === "docked" && allowDock;
  const [lastOpenSurface, setLastOpenSurface] = useState<"floating" | "docked">(
    allowDock ? "docked" : "floating",
  );
  useEffect(() => {
    if (mode !== "collapsed") {
      const surface = mode === "docked" && allowDock ? "docked" : "floating";
      lastOpenSurfaceRef.current = surface;
      setLastOpenSurface(surface);
    }
  }, [mode, allowDock]);

  const showThreadActions =
    displayScope !== "question"
      ? scopedView === "chat"
      : Boolean(displayQuestion);
  const canShowHistoryPopover = Boolean(showThreadActions && threads.length > 0);
  const historyPopoverOpen = Boolean(
    !hidden && historyOpen && canShowHistoryPopover,
  );
  const backdropPresence = useDiscretePresence<HTMLButtonElement>(isOpen);
  const panelPresence = useDiscretePresence<HTMLElement>(isOpen);
  const historyPopoverPresence =
    useDiscretePresence<HTMLDivElement>(historyPopoverOpen);

  if (hidden) return null;

  const recentQuestion =
    !displayQuestion && lastQuestionIdRef.current
      ? data.questions.find(
          (q) => q.id === lastQuestionIdRef.current && !q.archived,
        )
      : undefined;

  const scopeTabs: { id: AiScope; label: string }[] = [
    ...(question ? [{ id: "question" as const, label: "当前题目" }] : []),
    ...(contextDeck ? [{ id: "deck" as const, label: "当前文件夹" }] : []),
    { id: "workspace", label: "全部资料" },
  ];

  const isDocked = isOpen ? isDockedNow : lastOpenSurface === "docked";

  return (
    <>
      <button
        ref={backdropPresence.ref}
        type="button"
        hidden={backdropPresence.isHidden}
        data-closing={backdropPresence.isClosing ? "" : undefined}
        aria-hidden="true"
        tabIndex={-1}
        inert={!isOpen || backdropPresence.isClosing}
        className="ai-sheet-backdrop"
        onClick={() => onModeChange("collapsed")}
      />
      <aside
        ref={panelPresence.ref}
        hidden={panelPresence.isHidden}
        data-closing={panelPresence.isClosing ? "" : undefined}
        aria-hidden={!isOpen}
        inert={!isOpen || panelPresence.isClosing}
        className={`ai-island-panel ${isDocked ? "is-docked" : "is-floating"}`}
        aria-label="AI 助手"
        style={
          dragY > 0
            ? { translate: `0 ${dragY}px`, transition: "none" }
            : undefined
        }
      >
        {allowDock && isDocked && onDockWidthChange && (
          <div
            className="ai-dock-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="拖拽调整 AI 面板宽度，双击恢复默认"
            title="拖拽调整宽度，双击恢复默认"
            onDoubleClick={() => onDockWidthChange(null)}
            onPointerDown={startDockResize}
          />
        )}
        <div
          ref={historyWrapRef}
          className="ai-panel-sheet-handle"
          onTouchStart={(event) => {
            if (event.touches.length !== 1) return;
            if (!getDeviceProfile().isMobileShell) return;
            const touch = event.touches[0];
            sheetTouch.current = {
              x: touch.clientX,
              y: touch.clientY,
              time: Date.now(),
              locked: null,
            };
          }}
          onTouchMove={(event) => {
            const state = sheetTouch.current;
            if (!state || event.touches.length !== 1) return;
            const touch = event.touches[0];
            const dx = touch.clientX - state.x;
            const dy = touch.clientY - state.y;
            if (!state.locked) {
              if (Math.hypot(dx, dy) < 8) return;
              state.locked =
                dy > 0 && Math.abs(dy) > Math.abs(dx) * 1.2 ? "v" : "h";
            }
            if (state.locked === "v") {
              setDragY(Math.max(0, dy));
            }
          }}
          onTouchEnd={(event) => {
            const state = sheetTouch.current;
            sheetTouch.current = null;
            if (!state || state.locked !== "v") {
              setDragY(0);
              return;
            }
            const endY = event.changedTouches[0]?.clientY ?? state.y;
            const dy = endY - state.y;
            const velocity = dy / Math.max(1, Date.now() - state.time);
            if (dy > 90 || velocity > 0.45) {
              onModeChange("collapsed");
            } else {
              setDragY(0);
            }
          }}
          onTouchCancel={() => {
            sheetTouch.current = null;
            setDragY(0);
          }}
        >
          <div className="sheet-grabber" aria-hidden="true" />
          <div className="ai-panel-heading">
            <div className="ai-panel-title-group">
              <span className="ai-avatar">
                <Sparkles size={17} />
              </span>
              <strong>AI 助手</strong>
              <span className={`ai-live-dot ${busy ? "is-pulsing" : ""}`} />
            </div>
            <div className="ai-panel-controls">
              {showThreadActions && threads.length > 0 && (
                <Button
                  variant="ghost"
                  size="icon"
                  className={historyOpen ? "is-active" : undefined}
                  title="历史对话"
                  aria-label="历史对话"
                  aria-expanded={historyOpen}
                  disabled={busy}
                  onClick={() => setHistoryOpen((open) => !open)}
                >
                  <History size={16} />
                </Button>
              )}
              {showThreadActions && (
                <Button
                  variant="ghost"
                  size="icon"
                  title="新对话"
                  aria-label="新对话"
                  disabled={busy}
                  onClick={() => {
                    setActiveId(null);
                    setHistoryOpen(false);
                    setQuote("");
                    setQuoteExpanded(false);
                    setAttempt("");
                    setAttemptExpanded(false);
                    setItems([]);
                    setInput("");
                    setError("");
                  }}
                >
                  <Plus size={17} />
                </Button>
              )}
              {allowDock && isDocked && onDockWidthChange && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="ai-width-toggle"
                  title={
                    dockWidth !== null && dockWidth >= 480
                      ? "恢复默认宽度"
                      : "加宽阅读面板"
                  }
                  aria-label={
                    dockWidth !== null && dockWidth >= 480
                      ? "恢复默认宽度"
                      : "加宽阅读面板"
                  }
                  onClick={() =>
                    onDockWidthChange(
                      dockWidth !== null && dockWidth >= 480
                        ? null
                        : clampAiDockWidth(540),
                    )
                  }
                >
                  {dockWidth !== null && dockWidth >= 480 ? (
                    <ArrowRightFromLine size={16} />
                  ) : (
                    <ArrowLeftToLine size={16} />
                  )}
                </Button>
              )}
              {allowDock && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="ai-dock-toggle"
                  title={isDocked ? "切为悬浮覆盖" : "切为并排布局"}
                  aria-label={isDocked ? "切为悬浮覆盖" : "切为并排布局"}
                  onClick={() =>
                    onModeChange(isDocked ? "floating" : "docked")
                  }
                >
                  {isDocked ? (
                    <PictureInPicture2 size={16} />
                  ) : (
                    <PanelRight size={16} />
                  )}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                title="收起 AI 助手"
                aria-label="收起 AI 助手"
                onClick={() => onModeChange("collapsed")}
              >
                <X size={17} />
              </Button>
            </div>
          </div>
          {canShowHistoryPopover && (
            <div
              ref={historyPopoverPresence.ref}
              hidden={historyPopoverPresence.isHidden}
              data-closing={historyPopoverPresence.isClosing ? "" : undefined}
              aria-hidden={!historyPopoverOpen}
              inert={!historyPopoverOpen || historyPopoverPresence.isClosing}
              className="ai-history-popover"
              role="menu"
              aria-label="历史对话列表"
            >
              <button
                type="button"
                role="menuitem"
                className={!activeId ? "is-active" : undefined}
                disabled={busy}
                onClick={() => {
                  setActiveId(null);
                  setHistoryOpen(false);
                  setQuote("");
                  setQuoteExpanded(false);
                  setAttempt("");
                  setAttemptExpanded(false);
                  setItems([]);
                  setInput("");
                  setError("");
                }}
              >
                <Plus size={14} aria-hidden="true" />
                <span>新对话</span>
                {!activeId && <Check size={14} className="ai-history-check" aria-hidden="true" />}
              </button>
              {threads.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="menuitem"
                  className={activeId === t.id ? "is-active" : undefined}
                  disabled={busy}
                  onClick={() => selectThread(t.id)}
                >
                  <span>
                    {formatThreadLabel(t, displayScope, displayQuestion?.answer)}
                  </span>
                  {activeId === t.id && (
                    <Check size={14} className="ai-history-check" aria-hidden="true" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {scopeTabs.length > 1 && (
          <div className="ai-scope-bar" role="tablist" aria-label="AI 上下文范围">
            {scopeTabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={displayScope === item.id && !isCrossContextStream}
                className={
                  displayScope === item.id && !isCrossContextStream
                    ? "is-active"
                    : ""
                }
                onClick={() => {
                  if (busy) {
                    toast.info("当前回答还未结束，请稍候或先停止");
                    return;
                  }
                  viewedCompletedSessionRef.current = false;
                  updateStreamSession(null);
                  setScope(item.id);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}

        {isCrossContextStream && streamSession && (
          <div className="ai-bg-stream-banner" role="status" aria-live="polite">
            <span
              className={`ai-bg-stream-dot ${streamSession.status === "streaming" ? "is-pulsing" : ""}`}
              aria-hidden="true"
            />
            <span className="ai-bg-stream-text">
              {streamSession.status === "streaming"
                ? `正在后台回复「${streamSession.label}」…`
                : `已完成「${streamSession.label}」的回复`}
            </span>
            {streamSession.status === "completed" && (
              <button
                type="button"
                className="ai-bg-stream-return"
                onClick={() => {
                  viewedCompletedSessionRef.current = false;
                  updateStreamSession(null);
                }}
              >
                切回当前页
              </button>
            )}
          </div>
        )}

        {displayScope !== "question" && (
          <div className="ai-scope-subtabs" role="tablist" aria-label="资料助手视图">
            <button
              type="button"
              role="tab"
              aria-selected={scopedView === "chat"}
              className={scopedView === "chat" ? "is-active" : ""}
              onClick={() => setScopedView("chat")}
            >
              <Sparkles size={12} />
              AI 整理
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={scopedView === "launcher"}
              className={scopedView === "launcher" ? "is-active" : ""}
              onClick={() => setScopedView("launcher")}
            >
              <Search size={12} />
              快捷直达
            </button>
          </div>
        )}

        {displayScope !== "question" && scopedView === "launcher" ? (
          <ScopeLauncher
            key={displayScope === "deck" ? (displayDeck?.id ?? "deck") : "workspace"}
            scope={displayScope}
            data={data}
            deck={displayDeck}
            recentQuestion={recentQuestion}
            onOpenQuestion={handleOpenQuestion}
          />
        ) : displayScope !== "question" || displayQuestion ? (
          <>
            <div
              className={`ai-context-chip ${displayScope === "question" ? "is-question-scope" : ""}`}
              title={
                displayScope === "question" && displayQuestion
                  ? displayQuestion.title
                  : displayScope === "deck" && displayDeck
                    ? displayDeck.title
                    : "全部资料"
              }
            >
              <span className="ai-context-icon" aria-hidden="true">
                {displayScope === "question" ? (
                  <FileText size={13} />
                ) : displayScope === "deck" ? (
                  <Folder size={13} />
                ) : (
                  <Globe size={13} />
                )}
              </span>
              <strong>
                {displayScope === "question" && displayQuestion
                  ? displayQuestion.title
                  : displayScope === "deck" && displayDeck
                    ? displayDeck.title
                    : "全局资料工作区"}
              </strong>
              {displayScope === "question" &&
                displayQuestion?.answer.trim() &&
                !quote.trim() && (
                  <span
                    className="ai-context-ref"
                    title="已关联参考答案"
                    aria-label="已关联参考答案"
                  >
                    <Link2 size={13} aria-hidden="true" />
                  </span>
                )}
            </div>
            {displayScope === "question" &&
              quote.trim() &&
              (() => {
                const trimmedQuote = quote.trim();
                const fullAnswerQuoted = isFullAnswerQuote(
                  trimmedQuote,
                  active?.answerSnapshot || displayQuestion?.answer,
                );
                const inlineHighlight =
                  !fullAnswerQuoted &&
                  trimmedQuote.length <= 44 &&
                  !trimmedQuote.includes("\n");
                return (
                  <div
                    className={`ai-quote-card ${inlineHighlight ? "is-inline" : ""}`}
                  >
                    <div className="ai-quote-head">
                      <Quote size={14} />
                      <span
                        className={
                          inlineHighlight
                            ? "ai-quote-inline"
                            : "ai-quote-meta"
                        }
                      >
                        {fullAnswerQuoted
                          ? "已引用参考答案"
                          : inlineHighlight
                            ? trimmedQuote
                            : `引用片段 · ${trimmedQuote.length} 字`}
                      </span>
                      {!inlineHighlight && (
                        <button
                          type="button"
                          className="icon-button ai-collapse-toggle"
                          aria-expanded={quoteExpanded}
                          aria-label={quoteExpanded ? "收起引用" : "展开引用"}
                          title={quoteExpanded ? "收起" : "展开"}
                          onClick={() => setQuoteExpanded((v) => !v)}
                        >
                          <ChevronDown size={14} />
                        </button>
                      )}
                      {!busy && !activeId && (
                        <button
                          type="button"
                          aria-label="移除引用"
                          title="移除引用"
                          className="icon-button"
                          onClick={() => {
                            setQuote("");
                            setQuoteExpanded(false);
                          }}
                        >
                          <X size={13} />
                        </button>
                      )}
                    </div>
                    {!inlineHighlight && !fullAnswerQuoted && !quoteExpanded && (
                      <p className="ai-quote-preview">
                        {formatQuotePreview(trimmedQuote, 58)}
                      </p>
                    )}
                    {!inlineHighlight && quoteExpanded && (
                      <div className="ai-quote-body">{trimmedQuote}</div>
                    )}
                  </div>
                );
              })()}
            {displayScope === "question" && visibleAttempt && (
              <div className="ai-attempt-card">
                <div className="ai-attempt-head">
                  <PenLine size={14} />
                  <span>
                    本次默写 · {visibleAttempt.length} 字
                  </span>
                  <button
                    type="button"
                    className="icon-button ai-collapse-toggle"
                    aria-expanded={attemptExpanded}
                    aria-label={attemptExpanded ? "收起作答" : "展开作答"}
                    title={attemptExpanded ? "收起" : "展开"}
                    onClick={() => setAttemptExpanded((v) => !v)}
                  >
                    <ChevronDown size={14} />
                  </button>
                  {!busy && !activeId && (
                    <button
                      type="button"
                      aria-label="移除默写作答"
                      title="移除默写作答"
                      className="icon-button"
                      onClick={() => {
                        setAttempt("");
                        setAttemptExpanded(false);
                      }}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
                {attemptExpanded && (
                  <pre className="ai-attempt-body">{visibleAttempt}</pre>
                )}
              </div>
            )}
            <div className="ai-messages" ref={scroll}>
              {loading && !items.length && (
                <div className="ai-loading">
                  <Loader2 size={17} className="spin" /> 正在读取对话…
                </div>
              )}
              {!items.length && !loading && (
                <div className="ai-welcome">
                  <span className="ai-welcome-spark">
                    <Sparkles size={30} strokeWidth={1.2} />
                  </span>
                  <h3>
                    {displayScope === "question"
                      ? "哪里没想明白？"
                      : displayScope === "deck"
                        ? "梳理当前文件夹"
                        : "盘点全部资料"}
                  </h3>
                  <p>
                    {displayScope === "question" && displayQuestion
                      ? displayQuestion.isOwner
                        ? "围绕本题提问，或让我帮你润色答案、整理笔记。"
                        : "围绕本题提问，也可以划选正文追问。"
                      : displayScope === "deck" && displayDeck
                        ? `围绕「${displayDeck.title}」查找内容、排查重复或安排复习。`
                        : "跨文件夹查重、梳理知识结构，或安排今天的复习顺序。"}
                  </p>
                  {data.settings.hasKey ? (
                    <div className="prompt-suggestions">
                      {(displayScope === "question"
                        ? [
                            "用生活比喻或代码示例讲透底层机制",
                            "两分钟面试口述，这段答案怎么凝练？",
                            "这道题最容易答偏或被深挖的点有哪些？",
                          ]
                        : displayScope === "deck"
                          ? [
                              "梳理当前文件夹的知识脉络与重点结构",
                              "排查当前文件夹中可能重复或相似的内容",
                              "挑出待复习和待完善的内容，排出优先级",
                            ]
                          : [
                              "盘点全部资料分布，目前哪些方向急需复习？",
                              "排查全部资料中的重复项或高度相似卡片",
                              "结合待完善内容，帮我定今天的整理计划",
                            ]
                      ).map((p) => (
                        <button key={p} onClick={() => void send(p)}>
                          {p}
                          <ArrowUp size={13} />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="ai-key-prompt">
                      <KeyRound size={18} />
                      <p>配置模型接口后即可开始提问与划词追问。</p>
                      <Button
                        variant="outline"
                        size="sm"
                        data-settings-trigger="true"
                        onClick={(event) => onSettings(event.currentTarget)}
                      >
                        配置 AI
                      </Button>
                    </div>
                  )}
                </div>
              )}
              {items.map((message) => (
                <div
                  key={message.id}
                  className={`chat-message role-${message.role}`}
                >
                  {message.role === "assistant" && (
                    <div className="message-author">
                      <Sparkles size={13} /> AI 助手
                    </div>
                  )}
                  {message.role === "assistant" &&
                    Boolean(message.toolSteps?.length) && (
                      <div className="ai-tool-steps" aria-label="AI 检索过程">
                        {message.toolSteps!.map((step, idx) => (
                          <span
                            key={`${message.id}:tool:${idx}`}
                            className="ai-tool-step-pill"
                          >
                            <Search size={11} />
                            {step.label}
                          </span>
                        ))}
                      </div>
                    )}
                  {message.role === "assistant" && message.reasoning && (
                    <ReasoningDisclosure
                      reasoning={message.reasoning}
                      hasContent={Boolean(message.content)}
                      busy={busy}
                    />
                  )}
                  {message.content ? (
                    <Markdown>{message.content}</Markdown>
                  ) : busy ? (
                    <span className="thinking-dots">
                      正在思考<span>···</span>
                    </span>
                  ) : (
                    <span className="muted small">已停止回答</span>
                  )}
                  {message.role === "assistant" &&
                    Boolean(message.references?.length) && (
                      <div className="ai-ref-list">
                        <span className="ai-ref-heading">引用题目</span>
                        <div className="ai-ref-chips">
                          {message.references!.map((ref) => {
                            const target = data.questions.find(
                              (q) => q.id === ref.id,
                            );
                            return (
                              <button
                                key={ref.id}
                                type="button"
                                className="ai-ref-chip"
                                disabled={!target}
                                onClick={() => target && handleOpenQuestion(target)}
                                title={
                                  target ? `打开：${ref.title}` : ref.title
                                }
                              >
                                <BookOpen size={12} />
                                <span>{ref.title}</span>
                                <small>{ref.deckTitle}</small>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  {displayQuestion &&
                    message.edits?.map((edit) => {
                      const key = `${message.id}:${edit.target}`;
                      return (
                        <ChatEditCard
                          key={key}
                          edit={edit}
                          question={displayQuestion}
                          deck={ownedDeck}
                          busy={busy || applying !== null}
                          applying={applying === key}
                          onApply={() => void applyEdit(edit, key)}
                          onInspect={() =>
                            setReaderTarget({
                              kind: "edit",
                              edit,
                              question: displayQuestion,
                              deck: ownedDeck,
                              keyId: key,
                            })
                          }
                        />
                      );
                    })}
                  {message.role === "assistant" &&
                    message.content &&
                    !busy && (
                      <div className="message-actions">
                        {(!message.edits?.length ||
                          message.content.length >= 120) && (
                          <button
                            type="button"
                            title="宽屏阅读"
                            aria-label="宽屏阅读"
                            onClick={() =>
                              setReaderTarget({
                                kind: "message",
                                message,
                                title:
                                  displayScope === "question" && displayQuestion
                                    ? displayQuestion.title
                                    : displayScope === "deck" && displayDeck
                                      ? displayDeck.title
                                      : "AI 回答阅读",
                              })
                            }
                          >
                            <Maximize2 size={14} />
                          </button>
                        )}
                        <button
                          type="button"
                          className={
                            copiedMsgId === message.id ? "is-done" : undefined
                          }
                          title={copiedMsgId === message.id ? "已复制" : "复制"}
                          aria-label={
                            copiedMsgId === message.id ? "已复制" : "复制回答"
                          }
                          onClick={() => void copyMessageContent(message)}
                        >
                          {copiedMsgId === message.id ? (
                            <Check size={14} />
                          ) : (
                            <Copy size={14} />
                          )}
                        </button>
                        {displayQuestion && !message.edits?.length && (
                          <>
                            <button
                              type="button"
                              title="存为笔记"
                              aria-label="存为笔记"
                              onClick={() =>
                                setSaveTarget({ kind: "note", message })
                              }
                            >
                              <BookmarkPlus size={14} />
                            </button>
                            <button
                              type="button"
                              title="存为卡片"
                              aria-label="存为卡片"
                              disabled={copyBusy}
                              onClick={() =>
                                setSaveTarget({ kind: "card", message })
                              }
                            >
                              <Layers2 size={14} />
                            </button>
                          </>
                        )}
                      </div>
                    )}
                </div>
              ))}
              {error && (
                <div className="ai-error" role="alert">
                  {error}
                </div>
              )}
            </div>
            <div className="ai-composer">
              <div className="ai-composer-box">
                <textarea
                  ref={composerRef}
                  aria-label="给 AI 助手发消息"
                  placeholder={
                    !data.settings.hasKey
                      ? "请先配置 AI 模型后提问"
                      : displayScope === "question" && displayQuestion
                        ? displayQuestion.isOwner
                          ? "提问，或让我帮你优化答案和笔记…"
                          : "围绕本题或划选内容追问…"
                        : displayScope === "deck"
                          ? "查重、归纳考点或安排本文件夹复习…"
                          : "在全部资料中搜索、查重或制定复习计划…"
                  }
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  disabled={busy || !data.settings.hasKey}
                  maxLength={4000}
                  rows={2}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <div>
                  <button
                    type="button"
                    className={`ai-model-chip ${data.settings.hasKey ? "is-connected" : ""}`}
                    data-settings-trigger="true"
                    aria-label="配置 AI 模型连接"
                    title={
                      data.settings.hasKey
                        ? `当前模型：${data.settings.model || "已配置"}（点击修改配置）`
                        : "点击配置 AI 模型连接"
                    }
                    onClick={(event) => onSettings(event.currentTarget)}
                  >
                    <span className="ai-model-chip-dot" aria-hidden="true" />
                    <span>
                      {data.settings.hasKey
                        ? data.settings.model || "已配置 AI"
                        : "配置 AI 连接"}
                    </span>
                  </button>
                  {busy ? (
                    <button
                      type="button"
                      className="send-button"
                      title="停止回答"
                      aria-label="停止回答"
                      onClick={stopStreaming}
                    >
                      <Square size={13} fill="currentColor" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="send-button"
                      title="发送 (Enter · Shift+Enter 换行)"
                      aria-label="发送问题"
                      disabled={!input.trim() || !data.settings.hasKey}
                      onClick={() => void send()}
                    >
                      <ArrowUp size={17} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </>
        ) : null}
      </aside>
      <AiReaderDialog
        target={resolvedReaderTarget}
        onClose={() => setReaderTarget(null)}
        busy={busy}
        applyingKey={applying}
        copyBusy={copyBusy}
        onApplyEdit={applyEdit}
        onSaveToNote={
          displayQuestion
            ? (message) => setSaveTarget({ kind: "note", message })
            : undefined
        }
        onSaveAsCard={
          displayQuestion
            ? (message) => setSaveTarget({ kind: "card", message })
            : undefined
        }
      />
      <AiSaveDialog
        target={saveTarget}
        question={displayQuestion}
        ownedDecks={data.decks.filter((d) => d.isOwner)}
        defaultCardTitle={
          displayQuestion && saveTarget?.kind === "card"
            ? suggestCardTitle(displayQuestion.title, items, saveTarget.message)
            : ""
        }
        defaultDeckId={
          (
            data.decks.find(
              (d) => d.isOwner && d.id === displayQuestion?.deckId,
            ) ?? data.decks.find((d) => d.isOwner)
          )?.id ?? null
        }
        busy={noteSaveBusy || copyBusy}
        onClose={() => setSaveTarget(null)}
        onConfirmNote={(heading) =>
          saveTarget?.kind === "note"
            ? appendAssistantToNote(saveTarget.message.content, heading)
            : Promise.resolve(false)
        }
        onConfirmCard={(options) =>
          saveTarget?.kind === "card"
            ? saveMessageAsCard(saveTarget.message, options)
            : Promise.resolve(false)
        }
      />
    </>
  );
}
