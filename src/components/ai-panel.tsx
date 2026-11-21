"use client";
import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Sparkles,
  X,
  Plus,
  Quote,
  Loader2,
  BookmarkPlus,
  Layers2,
  KeyRound,
  Square,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import type {
  ChatEdit,
  ChatMessage,
  Conversation,
  QuestionView,
  Workspace,
} from "@/lib/types";
import { ChatEditCard, chatEditState } from "./chat-edit-card";
import { Markdown } from "./markdown";
import { Button } from "./ui/button";
import type { Mutate } from "./dialogs";

export type AiTrigger = { quote: string; prompt: string; nonce: number };
export function AiPanel({
  question,
  data,
  trigger,
  onClose,
  onSettings,
  onAppendNote,
  mutate,
}: {
  question: QuestionView;
  data: Workspace;
  trigger: AiTrigger | null;
  onClose: () => void;
  onSettings: () => void;
  onAppendNote: (text: string) => Promise<void>;
  mutate: Mutate;
}) {
  const [threads, setThreads] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [items, setItems] = useState<ChatMessage[]>([]);
  const [quote, setQuote] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [applying, setApplying] = useState<string | null>(null);
  const [dragY, setDragY] = useState(0);
  const sheetTouch = useRef<{
    x: number;
    y: number;
    time: number;
    locked: "v" | "h" | null;
  } | null>(null);
  const editInFlight = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(false);
  const lastTrigger = useRef(0);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 760px)");
    if (!mq.matches) return;
    const previous = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = previous;
    };
  }, []);
  useEffect(() => {
    let canceled = false;
    setLoading(true);
    void api<Conversation[]>(`/api/chat?questionId=${question.id}`, undefined, {
      userId: data.user.id,
    })
      .then((rows) => {
        if (!canceled) setThreads(rows);
      })
      .catch((e) => {
        if (!canceled) setError(e.message);
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
      abort.current?.abort();
    };
  }, [question.id, data.user.id]);
  useEffect(() => {
    scroll.current?.scrollTo({
      top: scroll.current.scrollHeight,
      behavior: "smooth",
    });
  }, [items, busy]);
  useEffect(() => {
    if (!trigger || trigger.nonce === lastTrigger.current) return;
    if (inFlight.current) {
      lastTrigger.current = trigger.nonce;
      toast.info("请先等当前回答完成，或停止回答后再选择新的内容。");
      return;
    }
    lastTrigger.current = trigger.nonce;
    setQuote(trigger.quote);
    setActiveId(null);
    setItems([]);
    setInput(trigger.prompt);
    if (data.settings.hasKey) {
      if (trigger.prompt.trim())
        void send(trigger.prompt, trigger.quote, null, true);
      else requestAnimationFrame(() => composerRef.current?.focus());
    }
  }, [trigger?.nonce]); // a selection intentionally starts an independent thread
  function selectThread(id: string) {
    const thread = threads.find((t) => t.id === id);
    setActiveId(thread?.id ?? null);
    setQuote(thread?.quote ?? "");
    setItems(thread?.messages ?? []);
    setError("");
  }
  async function send(
    text = input,
    selectedQuote = quote,
    conversationId = activeId,
    fresh = false,
  ) {
    if (!text.trim() || inFlight.current || !data.settings.hasKey) return;
    inFlight.current = true;
    setBusy(true);
    setInput("");
    setError("");
    const assistantId = crypto.randomUUID();
    const userMessage = {
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
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Workspace-User": data.user.id,
        },
        body: JSON.stringify({
          questionId: question.id,
          ...(conversationId ? { conversationId } : {}),
          message: text.trim(),
          quote: selectedQuote,
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
            setActiveId(resolvedId);
          }
          if (event === "delta")
            setItems((previous) =>
              previous.map((m) =>
                m.id === assistantId
                  ? { ...m, content: m.content + payload.text }
                  : m,
              ),
            );
          if (event === "error") throw new Error(payload.error);
        }
        if (done) break;
      }
      const rows = await api<Conversation[]>(
        `/api/chat?questionId=${question.id}`,
        undefined,
        { userId: data.user.id, signal: controller.signal },
      );
      setThreads(rows);
      const current = rows.find((t) => t.id === resolvedId);
      if (current) setItems(current.messages);
    } catch (e) {
      setItems((previous) =>
        previous.filter(
          (m) => m.id !== assistantId || m.content.trim().length > 0,
        ),
      );
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
  const ownedDeck = data.decks.find((d) => d.id === question.deckId && d.isOwner);

  async function applyEdit(edit: ChatEdit, key: string) {
    if (
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

  return (
    <aside
      className="ai-panel"
      aria-label="AI 助手"
      style={
        dragY > 0
          ? { transform: `translateY(${dragY}px)`, transition: "none" }
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
            onClose();
          }
        }}
        onTouchCancel={() => {
          sheetTouch.current = null;
          setDragY(0);
        }}
      >
        <div className="sheet-grabber" aria-hidden="true" />
        <div className="ai-panel-heading">
          <div>
            <span className="ai-avatar">
              <Sparkles size={18} />
            </span>
            <strong>AI 助手</strong>
            <span className="ai-live-dot" />
          </div>
          <div>
            <Button
              variant="ghost"
              size="icon"
              title="新对话"
              aria-label="新对话"
              disabled={busy}
              onClick={() => {
                setActiveId(null);
                setQuote("");
                setItems([]);
                setInput("");
                setError("");
              }}
            >
              <Plus size={17} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="关闭 AI 助手"
              onClick={onClose}
            >
              <X size={17} />
            </Button>
          </div>
        </div>
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
            {threads.map((t) => (
              <option key={t.id} value={t.id}>
                {t.quote
                  ? `划选：${t.quote.slice(0, 25)}`
                  : t.messages
                      .find((m) => m.role === "user")
                      ?.content.slice(0, 30) || "题目问答"}{" "}
                · v{t.questionRevision}
              </option>
            ))}
          </select>
        </div>
      )}
      {quote && (
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
      {active && active.questionRevision !== question.revision && (
        <details className="quote-version">
          <summary>
            引用的是 v{active.questionRevision}，题目当前为 v{question.revision}
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
            <h3>哪里没想明白？</h3>
            <p>
              {question.isOwner
                ? ownedDeck
                  ? "可以围绕本题提问，也可以请我修改本题或所属题库。"
                  : "可以围绕本题提问，也可以请我修改本题。"
                : "结合本题与参考答案拆解疑问，划选正文即可追问。"}
            </p>
            {data.settings.hasKey ? (
              <div className="prompt-suggestions">
                {[
                  "用生活比喻或代码示例讲透底层机制",
                  "两分钟面试口述，这段答案怎么凝练？",
                  "这道题最容易答偏或被深挖的点有哪些？",
                ].map((p) => (
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
                  请先在设置中配置 OpenAI 兼容模型接口，即可开启划词追问与生成笔记。
                </p>
                <Button variant="outline" size="sm" onClick={onSettings}>
                  去配置连接
                </Button>
              </div>
            )}
          </div>
        )}
        {items.map((message) => (
          <div key={message.id} className={`chat-message role-${message.role}`}>
            {message.role === "assistant" && (
              <div className="message-author">
                <Sparkles size={13} /> AI 助手
              </div>
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
            {message.edits?.map((edit) => {
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
            {message.role === "assistant" && message.content && !message.edits?.length && !busy && (
              <div className="message-actions">
                <button
                  onClick={() =>
                    void onAppendNote(`\n\n### AI 补充\n${message.content}`)
                  }
                >
                  <BookmarkPlus size={13} />
                  存为笔记
                </button>
                <button
                  onClick={async () => {
                    const target =
                      data.decks.find(
                        (d) => d.isOwner && d.id === question.deckId,
                      ) ?? data.decks.find((d) => d.isOwner);
                    const previousQuestion =
                      items
                        .slice(0, items.indexOf(message))
                        .reverse()
                        .find((m) => m.role === "user")?.content ?? "补充记忆";
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
              data.settings.hasKey
                ? question.isOwner
                  ? "输入问题或修改要求（Enter 发送，Shift + Enter 换行）…"
                  : "围绕当前题目或选中段落追问（Enter 发送，Shift + Enter 换行）…"
                : "请先配置模型 API Key 后提问"
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
            <span>{data.settings.model}</span>
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
        <p>AI 回答结合当前题目上下文生成，请对照自己的理解沉淀为个人笔记</p>
      </div>
    </aside>
  );
}
