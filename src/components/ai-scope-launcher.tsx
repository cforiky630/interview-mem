"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, ChevronRight, Search, Sparkles } from "lucide-react";
import type { DeckView, QuestionView, Workspace } from "@/lib/types";

type DeckFilter = "all" | "needsEditing" | "due";

export function ReasoningDisclosure({
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
    if ((hasContent || !busy) && !userToggledRef.current) {
      setOpen(false);
    }
  }, [hasContent, busy]);

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

export function ScopeLauncher({
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
        const haystack =
          `${q.title}\n${q.tags.join(" ")}\n${q.deckTitle}\n${q.answer.slice(0, 600)}`.toLowerCase();
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
                {!item.fsrs && <span className="ai-launcher-tag">未学</span>}
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
        点题目直接打开；需要查重或排复习可切到「AI 整理」。
      </p>
    </div>
  );
}
