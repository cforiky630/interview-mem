"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  BookOpen,
  BookmarkPlus,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  KeyRound,
  Layers2,
  Loader2,
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
import type {
  ChatEdit,
  ChatMessage,
  ChatQuestionReference,
  ChatToolStep,
  Conversation,
  DeckView,
  QuestionView,
  Workspace,
} from "@/lib/types";
import { ChatEditCard, chatEditState } from "./chat-edit-card";
import { Markdown } from "./markdown";
import { Button } from "./ui/button";
import { useDiscretePresence } from "./use-discrete-presence";
import type { Mutate } from "./dialogs";

export type AiScope = "question" | "deck" | "workspace";
export type AiIslandMode = "collapsed" | "floating" | "docked";
export type AiTrigger = {
  quote: string;
  prompt: string;
  attempt?: string;
  nonce: number;
};

type DeckFilter = "all" | "needsEditing" | "due";
type LiveAssistantMeta = {
  reasoning?: string;
  toolSteps?: ChatToolStep[];
  references?: ChatQuestionReference[];
};

function buildScopeKey(
  scope: AiScope,
  userId: string,
  questionId?: string,
  deckId?: string,
) {
  if (scope === "question" && questionId) return `q:${questionId}`;
  if (scope === "deck" && deckId) return `d:${deckId}`;
  return `w:${userId}`;
}

function buildChatUrl(
  scope: AiScope,
  questionId?: string,
  deckId?: string,
) {
  if (scope === "question" && questionId) {
    return `/api/chat?scope=question&questionId=${encodeURIComponent(questionId)}`;
  }
  if (scope === "deck" && deckId) {
    return `/api/chat?scope=deck&deckId=${encodeURIComponent(deckId)}`;
  }
  return "/api/chat?scope=workspace";
}

function ReasoningDisclosure({
  reasoning,
  hasContent,
  busy,
}: {
  reasoning: string;
  hasContent: boolean;
  busy: boolean;
}) {
  const [open, setOpen] = useState(!hasContent && busy);
  const userToggledRef = useRef(false);

  useEffect(() => {
    if (hasContent && !userToggledRef.current) {
      setOpen(false);
    }
  }, [hasContent]);

  return (
    <details
      className="ai-reasoning-box"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        onClick={() => {
          userToggledRef.current = true;
        }}
      >
        <span className="ai-reasoning-marker" aria-hidden="true">
          <ChevronRight size={13} />
        </span>
        <span className="ai-reasoning-label">
          {!hasContent && busy
            ? "正在深度思考…"
            : `思考过程 · ${reasoning.length} 字`}
        </span>
      </summary>
      <div className="ai-reasoning-body">
        <pre>{reasoning}</pre>
      </div>
    </details>
  );
}

function appendToStoredNote(
  userId: string,
  question: QuestionView,
  addition: string,
): { nextNote: string; expectedVersion: number } {
  const draftKey = `shiyi:note:${userId}:${question.id}`;
  let baseNote = question.note;
  let expectedVersion = question.noteVersion;
  const rawDraft = localStorage.getItem(draftKey);
  if (rawDraft !== null) {
    try {
      const saved = JSON.parse(rawDraft);
      if (
        typeof saved.content === "string" &&
        Number.isInteger(saved.version)
      ) {
        baseNote = saved.content;
        expectedVersion = saved.version;
      }
    } catch {
      baseNote = rawDraft;
      expectedVersion = question.noteVersion;
    }
  }
  return { nextNote: baseNote + addition, expectedVersion };
}

function ScopeLauncher({
  scope,
  data,
  deck,
  recentQuestion,
  onOpenQuestion,
}: {
  scope: "deck" | "workspace";
  data: Workspace;
  deck?: DeckView;
  recentQuestion?: QuestionView;
  onOpenQuestion: (question: QuestionView) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<DeckFilter>("all");

  const activePool = useMemo(
    () =>
      data.questions.filter(
        (q) => !q.archived && (scope === "workspace" || q.deckId === deck?.id),
      ),
    [data.questions, scope, deck?.id],
  );

  const stats = useMemo(() => {
    const now = Date.now();
    let due = 0;
    let needsEditing = 0;
    for (const q of activePool) {
      if (q.needsEditing) needsEditing += 1;
      if (q.fsrs && new Date(q.fsrs.due).getTime() <= now) due += 1;
    }
    return { total: activePool.length, due, needsEditing };
  }, [activePool]);

  const matches = useMemo(() => {
    const now = Date.now();
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return activePool
      .filter((q) => {
        if (filter === "needsEditing" && !q.needsEditing) return false;
        if (
          filter === "due" &&
          (!q.fsrs || new Date(q.fsrs.due).getTime() > now)
        )
          return false;
        if (!terms.length) return true;
        const haystack = `${q.title}\n${q.tags.join(" ")}\n${q.deckTitle}\n${q.answer.slice(0, 600)}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      })
      .sort((a, b) => {
        if (a.needsEditing !== b.needsEditing) return a.needsEditing ? -1 : 1;
        return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      })
      .slice(0, 24);
  }, [activePool, query, filter]);

  return (
    <div className="ai-launcher">
      <div className="ai-scope-summary">
        <div className="ai-scope-summary-head">
          <BookOpen size={15} />
          <strong>
            {scope === "deck" && deck ? deck.title : "全部题库工作区"}
          </strong>
        </div>
        <div className="ai-scope-metrics">
          <span>{stats.total} 题</span>
          <span>{stats.due} 待复习</span>
          {stats.needsEditing > 0 && <span>{stats.needsEditing} 待完善</span>}
        </div>
      </div>

      {scope === "workspace" && recentQuestion && (
        <button
          type="button"
          className="ai-recent-question-btn"
          onClick={() => onOpenQuestion(recentQuestion)}
        >
          <Sparkles size={14} />
          <span>回到刚才浏览：{recentQuestion.title}</span>
        </button>
      )}

      <div className="ai-launcher-search">
        <Search size={14} />
        <input
          type="search"
          aria-label={
            scope === "deck" ? "检索当前题库题目" : "检索全局题库题目"
          }
          placeholder={
            scope === "deck"
              ? "筛选当前题库标题、标签或正文…"
              : "搜索全库题目、标签或关键词…"
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="ai-launcher-filters" role="group" aria-label="状态筛选">
        {(
          [
            { id: "all", label: "全部" },
            { id: "due", label: "待复习" },
            { id: "needsEditing", label: "待完善" },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            className={filter === item.id ? "is-active" : ""}
            aria-pressed={filter === item.id}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="ai-launcher-list">
        {matches.length ? (
          matches.map((item) => (
            <button
              key={item.id}
              type="button"
              className="ai-launcher-item"
              onClick={() => onOpenQuestion(item)}
            >
              <span className="ai-launcher-item-title">{item.title}</span>
              <span className="ai-launcher-item-meta">
                {scope === "workspace" && <span>{item.deckTitle}</span>}
                {item.needsEditing && (
                  <span className="ai-launcher-tag is-warn">需完善</span>
                )}
                {!item.fsrs && (
                  <span className="ai-launcher-tag">未学</span>
                )}
              </span>
            </button>
          ))
        ) : (
          <p className="ai-launcher-empty">
            没有匹配的题目，换个关键词或筛选条件试试。
          </p>
        )}
      </div>

      <p className="ai-launcher-hint">
        点击任意题目即可直达阅读页并开启单题 AI 对话；跨题库检索、查重与批量整理工具将在下一阶段接入。
      </p>
    </div>
  );
}

export function AiIsland({
  data,
  question,
  activeDeck,
  mode,
  allowDock = false,
  hidden = false,
  trigger,
  onModeChange,
  onOpen,
  onOpenQuestion,
  onSettings,
  onBusyChange,
  mutate,
}: {
  data: Workspace;
  question?: QuestionView;
  activeDeck?: DeckView;
  mode: AiIslandMode;
  allowDock?: boolean;
  hidden?: boolean;
  trigger: AiTrigger | null;
  onModeChange: (next: AiIslandMode) => void;
  onOpen?: () => void;
  onOpenQuestion: (question: QuestionView) => void;
  onSettings: (anchor?: HTMLElement | null) => void;
  onBusyChange?: (busy: boolean) => void;
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
  const [items, setItems] = useState<ChatMessage[]>([]);
  const [quote, setQuote] = useState("");
  const [attempt, setAttempt] = useState("");
  const [attemptExpanded, setAttemptExpanded] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [applying, setApplying] = useState<string | null>(null);
  const [dragY, setDragY] = useState(0);

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
  const threadMetaRef = useRef<Record<string, LiveAssistantMeta>>({});
  const lastAutoKey = useRef("");
  const lastTrigger = useRef(0);
  const editInFlight = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(false);

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
    if (lastAutoKey.current === autoKey) return;
    lastAutoKey.current = autoKey;
    setScope(question ? "question" : contextDeck ? "deck" : "workspace");
  }, [autoKey, question, contextDeck]);

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

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    if (mode === "collapsed" || hidden) return;
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 760px)");
    if (!mq.matches) return;
    const previous = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = previous;
    };
  }, [mode, hidden]);

  useEffect(() => {
    if (effectiveScope === "question" && !question?.id) return;
    if (effectiveScope === "deck" && !contextDeck?.id) return;
    if (
      loadedTargetRef.current.key === scopeKey &&
      loadedTargetRef.current.userId === data.user.id
    ) {
      return;
    }
    if (mode === "collapsed") {
      if (!inFlight.current) {
        loadedTargetRef.current = { key: "", userId: data.user.id };
        setThreads([]);
        setActiveId(null);
        setItems([]);
        setQuote("");
        setAttempt("");
        setAttemptExpanded(false);
        setError("");
      }
      return;
    }
    loadedTargetRef.current = {
      key: scopeKey,
      userId: data.user.id,
    };
    abort.current?.abort();
    inFlight.current = false;
    setBusy(false);
    setThreads([]);
    setActiveId(null);
    setItems([]);
    setQuote("");
    setAttempt("");
    setAttemptExpanded(false);
    setError("");
    let canceled = false;
    setLoading(true);
    void api<Conversation[]>(
      buildChatUrl(effectiveScope, question?.id, contextDeck?.id),
      undefined,
      { userId: data.user.id },
    )
      .then((rows) => {
        if (!canceled) {
          setThreads(
            rows.map((row) => mergeThreadMeta(row, threadMetaRef.current)),
          );
        }
      })
      .catch((e) => {
        if (!canceled) setError(e.message);
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [
    scopeKey,
    effectiveScope,
    question?.id,
    contextDeck?.id,
    data.user.id,
    mode,
  ]);

  useEffect(() => {
    if (
      mode === "collapsed" ||
      (effectiveScope !== "question" && scopedView !== "chat")
    )
      return;
    scroll.current?.scrollTo({
      top: scroll.current.scrollHeight,
      behavior: "smooth",
    });
  }, [items, busy, mode, effectiveScope, scopedView]);

  useEffect(() => {
    if (!trigger || trigger.nonce === lastTrigger.current) return;
    if (!question) return;
    if (inFlight.current) {
      lastTrigger.current = trigger.nonce;
      toast.info("请先等当前回答完成，或停止回答后再选择新的内容。");
      return;
    }
    lastTrigger.current = trigger.nonce;
    loadedTargetRef.current = {
      key: `q:${question.id}`,
      userId: data.user.id,
    };
    setScope("question");
    const nextAttempt = trigger.attempt ?? "";
    setQuote(trigger.quote);
    setAttempt(nextAttempt);
    setAttemptExpanded(false);
    setActiveId(null);
    setItems([]);
    setInput(trigger.prompt);
    if (data.settings.hasKey) {
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
    }
  }, [trigger?.nonce]); // selection or critique trigger intentionally starts a fresh thread

  function mergeThreadMeta(
    thread: Conversation,
    cache: Record<string, LiveAssistantMeta>,
  ): Conversation {
    const meta = cache[thread.id];
    if (!meta || !thread.messages.length) return thread;
    const nextMessages = [...thread.messages];
    for (let i = nextMessages.length - 1; i >= 0; i--) {
      if (nextMessages[i].role === "assistant") {
        nextMessages[i] = { ...nextMessages[i], ...meta };
        break;
      }
    }
    return { ...thread, messages: nextMessages };
  }

  function selectThread(id: string) {
    const thread = threads.find((t) => t.id === id);
    setActiveId(thread?.id ?? null);
    setQuote(thread?.quote ?? "");
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
    targetScope = effectiveScope,
    targetQuestionId = question?.id,
    targetDeckId = contextDeck?.id,
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
    inFlight.current = true;
    setBusy(true);
    setInput("");
    setError("");
    const assistantId = crypto.randomUUID();
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
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
    const controller = new AbortController();
    abort.current = controller;
    let resolvedId = conversationId;
    const liveMeta: LiveAssistantMeta = {};
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
        const payload = await response.json();
        throw new Error(payload.error ?? "AI 请求未完成。");
      }
      if (!response.body) throw new Error("浏览器未能读取回答。");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      while (true) {
        const { value, done } = await reader.read();
        pending += done
          ? decoder.decode()
          : decoder.decode(value, { stream: true });
        const blocks = pending.split("\n\n");
        pending = blocks.pop() ?? "";
        for (const block of blocks) {
          const event = block.match(/^event: (.+)$/m)?.[1];
          const json = block.match(/^data: (.+)$/m)?.[1];
          if (!json) continue;
          const payload = JSON.parse(json);
          if (event === "meta") {
            resolvedId = payload.conversationId;
            if (loadedTargetRef.current.key === targetKey) {
              setActiveId(resolvedId);
            }
          } else if (event === "reasoning") {
            const textChunk =
              typeof payload.text === "string" ? payload.text : "";
            if (textChunk) {
              liveMeta.reasoning = (liveMeta.reasoning ?? "") + textChunk;
              if (loadedTargetRef.current.key === targetKey) {
                setItems((previous) =>
                  previous.map((m) =>
                    m.id === assistantId
                      ? { ...m, reasoning: liveMeta.reasoning }
                      : m,
                  ),
                );
              }
            }
          } else if (event === "tool") {
            const step = {
              name: String(payload.name ?? ""),
              label: String(payload.label ?? ""),
            };
            liveMeta.toolSteps = [...(liveMeta.toolSteps ?? []), step];
            if (loadedTargetRef.current.key === targetKey) {
              setItems((previous) =>
                previous.map((m) =>
                  m.id === assistantId
                    ? { ...m, toolSteps: liveMeta.toolSteps }
                    : m,
                ),
              );
            }
          } else if (event === "references") {
            if (Array.isArray(payload.refs)) {
              liveMeta.references = payload.refs;
              if (loadedTargetRef.current.key === targetKey) {
                setItems((previous) =>
                  previous.map((m) =>
                    m.id === assistantId
                      ? { ...m, references: liveMeta.references }
                      : m,
                  ),
                );
              }
            }
          } else if (event === "delta") {
            if (loadedTargetRef.current.key === targetKey) {
              setItems((previous) =>
                previous.map((m) =>
                  m.id === assistantId
                    ? { ...m, content: m.content + payload.text }
                    : m,
                ),
              );
            }
          } else if (event === "error") {
            throw new Error(payload.error);
          }
        }
        if (done) break;
      }
      if (
        resolvedId &&
        (liveMeta.reasoning ||
          liveMeta.toolSteps?.length ||
          liveMeta.references?.length)
      ) {
        threadMetaRef.current[resolvedId] = { ...liveMeta };
      }
      const rows = await api<Conversation[]>(
        buildChatUrl(targetScope, targetQuestionId, targetDeckId),
        undefined,
        { userId: data.user.id, signal: controller.signal },
      );
      if (loadedTargetRef.current.key === targetKey) {
        const merged = rows.map((row) =>
          mergeThreadMeta(row, threadMetaRef.current),
        );
        setThreads(merged);
        const current = merged.find((t) => t.id === resolvedId);
        if (current) {
          setItems(current.messages);
          setAttempt("");
        }
      }
    } catch (e) {
      if (loadedTargetRef.current.key === targetKey) {
        setItems((previous) =>
          previous.filter(
            (m) => m.id !== assistantId || m.content.trim().length > 0,
          ),
        );
      }
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        const message = e instanceof Error ? e.message : "回答未完成。";
        setError(message);
        toast.error(message);
      }
    } finally {
      setBusy(false);
      inFlight.current = false;
      abort.current = null;
    }
  }

  const active = threads.find((t) => t.id === activeId);
  const ownedDeck = question
    ? data.decks.find((d) => d.id === question.deckId && d.isOwner)
    : undefined;
  const visibleAttempt = (active ? active.attempt : attempt).trim();

  async function applyEdit(edit: ChatEdit, key: string) {
    if (
      !question ||
      inFlight.current ||
      editInFlight.current ||
      chatEditState(edit, question, ownedDeck) !== "ready"
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
          title: question.title,
          answer: question.answer,
          tags: question.tags,
          ...edit.fields,
        });
        if (result) toast.success("题目修改已保存。");
      } else if (edit.target === "note") {
        const result = await mutate("/api/questions", {
          action: "note",
          id: edit.id,
          note: edit.fields.note,
          expectedVersion: edit.expectedVersion,
        });
        if (result) {
          localStorage.removeItem(`shiyi:note:${data.user.id}:${edit.id}`);
          window.dispatchEvent(
            new CustomEvent("shiyi:note-updated", {
              detail: {
                questionId: edit.id,
                note: edit.fields.note,
                version: Number(result.version),
              },
            }),
          );
          toast.success("个人笔记已更新。");
        }
      } else {
        const result = await mutate("/api/decks", {
          action: "edit",
          deckId: edit.id,
          expected: edit.expected,
          ...edit.expected,
          ...edit.fields,
        });
        if (result) toast.success("题库修改已保存。");
      }
    } finally {
      editInFlight.current = false;
      setApplying(null);
    }
  }

  async function appendAssistantToNote(content: string) {
    if (!question || editInFlight.current) return;
    editInFlight.current = true;
    try {
      const { nextNote, expectedVersion } = appendToStoredNote(
        data.user.id,
        question,
        `\n\n### AI 补充\n${content}`,
      );
      const result = await mutate("/api/questions", {
        action: "note",
        id: question.id,
        note: nextNote,
        expectedVersion,
      });
      if (result) {
        localStorage.removeItem(`shiyi:note:${data.user.id}:${question.id}`);
        window.dispatchEvent(
          new CustomEvent("shiyi:note-updated", {
            detail: {
              questionId: question.id,
              note: nextNote,
              version: Number(result.version),
              switchToNotes: true,
            },
          }),
        );
        toast.success("已追加到个人笔记。");
      }
    } finally {
      editInFlight.current = false;
    }
  }

  const isOpen = !hidden && mode !== "collapsed";
  const isDockedNow = mode === "docked" && allowDock;
  const [lastOpenSurface, setLastOpenSurface] = useState<"floating" | "docked">(
    "floating",
  );
  useEffect(() => {
    if (mode !== "collapsed") {
      setLastOpenSurface(mode === "docked" && allowDock ? "docked" : "floating");
    }
  }, [mode, allowDock]);

  const pillPresence = useDiscretePresence<HTMLButtonElement>(
    !hidden && mode === "collapsed",
  );
  const backdropPresence = useDiscretePresence<HTMLButtonElement>(isOpen);
  const panelPresence = useDiscretePresence<HTMLElement>(isOpen);

  if (hidden) return null;

  const pillScopeLabel =
    effectiveScope === "question"
      ? "当前题目"
      : effectiveScope === "deck" && contextDeck
        ? contextDeck.title
        : "全局题库";

  const recentQuestion =
    !question && lastQuestionIdRef.current
      ? data.questions.find(
          (q) => q.id === lastQuestionIdRef.current && !q.archived,
        )
      : undefined;

  const scopeTabs: { id: AiScope; label: string }[] = [
    ...(question ? [{ id: "question" as const, label: "当前题目" }] : []),
    ...(contextDeck ? [{ id: "deck" as const, label: "当前题库" }] : []),
    { id: "workspace", label: "全局题库" },
  ];

  const isDocked = isOpen ? isDockedNow : lastOpenSurface === "docked";

  return (
    <>
      <button
        ref={pillPresence.ref}
        type="button"
        hidden={pillPresence.isHidden}
        data-closing={pillPresence.isClosing ? "" : undefined}
        aria-hidden={isOpen}
        inert={isOpen || pillPresence.isClosing}
        className={`ai-island-pill ${busy ? "is-busy" : ""}`}
        aria-label={`打开 AI 助手（${pillScopeLabel}，快捷键 Ctrl/Cmd + J）`}
        onClick={() => (onOpen ? onOpen() : onModeChange("docked"))}
      >
        <span className="ai-island-pill-icon">
          <Sparkles size={15} />
        </span>
        <span className="ai-island-pill-title">
          {busy ? "AI 正在生成…" : "AI 助手"}
        </span>
        <span className="ai-scope-chip">{pillScopeLabel}</span>
        {busy && <span className="ai-live-dot" aria-hidden="true" />}
      </button>
      <button
        ref={backdropPresence.ref}
        type="button"
        hidden={backdropPresence.isHidden}
        data-closing={backdropPresence.isClosing ? "" : undefined}
        aria-hidden={!isOpen}
        inert={!isOpen || backdropPresence.isClosing}
        className="ai-sheet-backdrop"
        aria-label="收起 AI 助手"
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
        <div
          className="ai-panel-sheet-handle"
          onTouchStart={(event) => {
            if (event.touches.length !== 1) return;
            if (!window.matchMedia("(max-width: 760px)").matches) return;
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
            setDragY(0);
            if (dy > 90 || velocity > 0.45) {
              onModeChange("collapsed");
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
              {(effectiveScope !== "question" ? scopedView === "chat" : Boolean(question)) && (
                <Button
                  variant="ghost"
                  size="icon"
                  title="新对话"
                  aria-label="新对话"
                  disabled={busy}
                  onClick={() => {
                    setActiveId(null);
                    setQuote("");
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
        </div>

        {scopeTabs.length > 1 && (
          <div className="ai-scope-bar" role="tablist" aria-label="AI 上下文范围">
            {scopeTabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={effectiveScope === item.id}
                className={effectiveScope === item.id ? "is-active" : ""}
                onClick={() => setScope(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}

        {effectiveScope !== "question" && (
          <div className="ai-scope-subtabs" role="tablist" aria-label="题库助手视图">
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

        {effectiveScope !== "question" && scopedView === "launcher" ? (
          <ScopeLauncher
            key={effectiveScope === "deck" ? (contextDeck?.id ?? "deck") : "workspace"}
            scope={effectiveScope}
            data={data}
            deck={contextDeck}
            recentQuestion={recentQuestion}
            onOpenQuestion={onOpenQuestion}
          />
        ) : effectiveScope !== "question" || question ? (
          <>
            <div
              className="ai-context-chip"
              title={
                effectiveScope === "question" && question
                  ? question.title
                  : effectiveScope === "deck" && contextDeck
                    ? contextDeck.title
                    : "全局题库"
              }
            >
              <span>{effectiveScope === "question" ? "正在围绕" : "当前范围"}</span>
              <strong>
                {effectiveScope === "question" && question
                  ? question.title
                  : effectiveScope === "deck" && contextDeck
                    ? contextDeck.title
                    : "全局题库工作区"}
              </strong>
            </div>
            {threads.length > 0 && (
              <div className="thread-selector">
                <select
                  aria-label="选择历史对话"
                  value={activeId ?? ""}
                  disabled={busy}
                  onChange={(e) => selectThread(e.target.value)}
                >
                  <option value="">新的疑问，新的理解</option>
                  {threads.map((t) => {
                    const firstUser =
                      t.messages.find((m) => m.role === "user")?.content ?? "";
                    const label =
                      effectiveScope === "question"
                        ? `${
                            t.attempt.trim()
                              ? `[作答点评] ${(firstUser || "默写点评").slice(0, 22)}`
                              : t.quote
                                ? `划选：${t.quote.slice(0, 24)}`
                                : firstUser.slice(0, 28) || "题目问答"
                          } · v${t.questionRevision}`
                        : firstUser.slice(0, 32) ||
                          (effectiveScope === "deck" ? "题库整理" : "全库问答");
                    return (
                      <option key={t.id} value={t.id}>
                        {label}
                      </option>
                    );
                  })}
                </select>
              </div>
            )}
            {effectiveScope === "question" && quote && (
              <div className="ai-quote">
                <Quote size={14} />
                <p>{quote}</p>
                {!busy && !activeId && (
                  <button
                    aria-label="移除引用"
                    className="icon-button"
                    onClick={() => setQuote("")}
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            )}
            {effectiveScope === "question" && visibleAttempt && (
              <div className="ai-attempt-card">
                <div className="ai-attempt-head">
                  <PenLine size={14} />
                  <span>
                    {activeId ? "本轮默写作答" : "已附带本次默写作答"} ·{" "}
                    {visibleAttempt.length} 字
                  </span>
                  <button
                    type="button"
                    className="ai-attempt-toggle"
                    aria-expanded={attemptExpanded}
                    onClick={() => setAttemptExpanded((v) => !v)}
                  >
                    {attemptExpanded ? "收起" : "查看原文"}
                    {attemptExpanded ? (
                      <ChevronUp size={13} />
                    ) : (
                      <ChevronDown size={13} />
                    )}
                  </button>
                  {!busy && !activeId && (
                    <button
                      type="button"
                      aria-label="移除默写作答"
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
            {effectiveScope === "question" &&
              question &&
              active &&
              active.questionRevision !== question.revision && (
                <details className="quote-version">
                  <summary>
                    引用的是 v{active.questionRevision}，题目当前为 v
                    {question.revision}
                  </summary>
                  <div className="old-snapshot">
                    <Markdown>{active.answerSnapshot}</Markdown>
                  </div>
                </details>
              )}
            <div className="ai-messages" ref={scroll}>
              {loading && !items.length && (
                <div className="ai-loading">
                  <Loader2 size={17} className="spin" /> 正在读取你的对话…
                </div>
              )}
              {!items.length && !loading && (
                <div className="ai-welcome">
                  <span className="ai-welcome-spark">
                    <Sparkles size={30} strokeWidth={1.2} />
                  </span>
                  <h3>
                    {effectiveScope === "question"
                      ? "哪里没想明白？"
                      : effectiveScope === "deck"
                        ? "梳理当前题库"
                        : "盘点全局题库"}
                  </h3>
                  <p>
                    {effectiveScope === "question" && question
                      ? question.isOwner
                        ? ownedDeck
                          ? "可以围绕本题提问，也可以请我修改本题、个人笔记或所属题库。"
                          : "可以围绕本题提问，也可以请我修改本题或个人笔记。"
                        : "结合本题与参考答案拆解疑问，划选正文即可追问。"
                      : effectiveScope === "deck" && contextDeck
                        ? `只读检索「${contextDeck.title}」中的真实题目，支持查重、结构梳理与复习排期。`
                        : "检索全库真实题目、排查重复内容，或制定今天的优先复习清单。"}
                  </p>
                  {data.settings.hasKey ? (
                    <div className="prompt-suggestions">
                      {(effectiveScope === "question"
                        ? [
                            "用生活比喻或代码示例讲透底层机制",
                            "两分钟面试口述，这段答案怎么凝练？",
                            "这道题最容易答偏或被深挖的点有哪些？",
                          ]
                        : effectiveScope === "deck"
                          ? [
                              "梳理当前题库的知识脉络与重点分组",
                              "排查当前题库中可能重复或相似的题目",
                              "挑出待复习和待完善的题目，排出优先级",
                            ]
                          : [
                              "盘点全局题库分布，目前哪些方向急需复习？",
                              "排查整个题库中的重复题或高度相似卡片",
                              "结合待完善题目，帮我定今天的整理计划",
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
                      <p>
                        请先在设置中配置 OpenAI 兼容模型接口，即可开启划词追问与题库分析。
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        data-settings-trigger="true"
                        onClick={(event) => onSettings(event.currentTarget)}
                      >
                        去配置连接
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
                                onClick={() => target && onOpenQuestion(target)}
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
                  {question &&
                    message.edits?.map((edit) => {
                      const key = `${message.id}:${edit.target}`;
                      return (
                        <ChatEditCard
                          key={key}
                          edit={edit}
                          question={question}
                          deck={ownedDeck}
                          busy={busy || applying !== null}
                          applying={applying === key}
                          onApply={() => void applyEdit(edit, key)}
                        />
                      );
                    })}
                  {question &&
                    message.role === "assistant" &&
                    message.content &&
                    !message.edits?.length &&
                    !busy && (
                      <div className="message-actions">
                        <button
                          onClick={() =>
                            void appendAssistantToNote(message.content)
                          }
                        >
                          <BookmarkPlus size={13} />
                          存为笔记
                        </button>
                        <button
                          onClick={async () => {
                            const target =
                              data.decks.find(
                                (d) =>
                                  d.isOwner && d.id === question.deckId,
                              ) ?? data.decks.find((d) => d.isOwner);
                            const previousQuestion =
                              items
                                .slice(0, items.indexOf(message))
                                .reverse()
                                .find((m) => m.role === "user")?.content ??
                              "补充记忆";
                            const response = await mutate("/api/questions", {
                              action: "copy",
                              id: question.id,
                              deckId: target?.id ?? null,
                              title: `${question.title} · ${previousQuestion}`.slice(
                                0,
                                200,
                              ),
                              answer: message.content,
                            });
                            if (response) toast.success("已保存为独立复习卡片。");
                          }}
                        >
                          <Layers2 size={13} />
                          存为卡片
                        </button>
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
                      ? "请先配置模型 API Key 后提问"
                      : effectiveScope === "question" && question
                        ? question.isOwner
                          ? "输入问题，或请我优化答案、笔记与题库（Enter 发送，Shift + Enter 换行）…"
                          : "围绕当前题目或选中段落追问（Enter 发送，Shift + Enter 换行）…"
                        : effectiveScope === "deck"
                          ? "围绕当前题库提问：查重、归纳考点、规划复习（Enter 发送，Shift + Enter 换行）…"
                          : "围绕全库提问：盘点方向、找重复题、安排复习（Enter 发送，Shift + Enter 换行）…"
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
                      className="send-button"
                      aria-label="停止回答"
                      onClick={() => abort.current?.abort()}
                    >
                      <Square size={13} fill="currentColor" />
                    </button>
                  ) : (
                    <button
                      className="send-button"
                      aria-label="发送问题"
                      disabled={!input.trim() || !data.settings.hasKey}
                      onClick={() => void send()}
                    >
                      <ArrowUp size={17} />
                    </button>
                  )}
                </div>
              </div>
              <p>
                {effectiveScope === "question"
                  ? "AI 回答结合当前题目上下文生成，请对照自己的理解沉淀为个人笔记"
                  : "AI 仅在当前用户题库内只读检索与去重，点击引用题目可直达原文"}
              </p>
            </div>
          </>
        ) : null}
      </aside>
    </>
  );
}
