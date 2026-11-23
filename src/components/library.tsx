"use client";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Search,
  Plus,
  ArrowUpRight,
  Star,
  ArrowLeft,
  Rss,
  Check,
  CircleDashed,
  Sparkles,
  Trash2,
  FolderInput,
  PenLine,
  PencilLine,
  Play,
  Tags,
  X,
  ChevronDown,
  Archive,
  ArchiveRestore,
  CheckSquare,
  Square,
  Flame,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import type { Workspace, QuestionView, CatalogDeck } from "@/lib/types";
import { markdownDocument, mergeQuestionTags } from "@/lib/markdown-source";
import { relativeDue } from "@/lib/utils";
import { Button } from "./ui/button";
import { ActionMenu } from "./ui/action-menu";
import { Dialog } from "./ui/dialog";
import { LibraryTrash } from "./library-trash";
import type { Mutate } from "./dialogs";

type SortKey = "default" | "due" | "lapses" | "updated";

export function Library({
  data,
  deckId,
  filter,
  onQuestion,
  onPractice,
  onCram,
  onDeck,
  onImport,
  onCreateQuestion,
  onCreate,
  onEditDeck,
  onReview,
  onPublish,
  onFavorite,
  onGenerateAnswer,
  onAcknowledge,
  onUnsubscribe,
  onDelete,
  onDeleteQuestion,
  onMoveQuestion,
  mutate,
  searchToken = 0,
}: {
  data: Workspace;
  deckId?: string | null;
  filter?: string;
  onQuestion: (q: QuestionView, orderedIds?: string[]) => void;
  onPractice?: (q: QuestionView) => void;
  onCram: (questions: QuestionView[], label: string) => void;
  onDeck: (id?: string | null) => void;
  onImport: () => void;
  onCreateQuestion: () => void;
  onCreate: () => void;
  onEditDeck: (deck: Workspace["decks"][number]) => void;
  onReview: (deckId?: string) => void;
  onPublish: (id: string) => void;
  onFavorite: (q: QuestionView) => void;
  onGenerateAnswer: (q: QuestionView) => void;
  onAcknowledge: (id: string, version: number) => void;
  onUnsubscribe: (id: string) => void;
  onDelete: (deck: Workspace["decks"][number]) => void;
  onDeleteQuestion: (q: QuestionView) => void;
  onMoveQuestion: (q: QuestionView) => void;
  mutate: Mutate;
  searchToken?: number;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [sortBy, setSortBy] = useState<SortKey>("default");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [mobileTagsOpen, setMobileTagsOpen] = useState(false);
  const [hasTagOverflow, setHasTagOverflow] = useState(false);
  const [section, setSection] = useState("decks");
  const [visibleCount, setVisibleCount] = useState(40);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchDialog, setBatchDialog] = useState<"move" | "delete" | null>(null);
  const [batchTargetDeckId, setBatchTargetDeckId] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const tagChipsRef = useRef<HTMLDivElement>(null);
  const query = useDeferredValue(search.trim().toLowerCase());
  useEffect(() => {
    if (searchToken) {
      setSection("questions");
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }, [searchToken]);
  useEffect(() => {
    setSelectedTag(null);
    setTagsExpanded(false);
    setMobileTagsOpen(false);
  }, [deckId, filter, section]);
  const root = deckId === undefined && !filter;
  const unfiled = deckId === null || (root && section === "unfiled");
  const archived = filter === "archived" || (root && section === "archived");
  const listVisible = !root || (section !== "decks" && section !== "trash");
  useEffect(() => {
    if (!listVisible) return;
    function onSlash(event: KeyboardEvent) {
      if (
        event.key !== "/" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.isComposing
      )
        return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, select, [contenteditable='true'], [role='dialog']:not([hidden])",
        ) ||
        document.querySelector(
          "[role='dialog']:not([hidden]), .action-menu[open]",
        )
      )
        return;
      event.preventDefault();
      searchInputRef.current?.focus();
    }
    window.addEventListener("keydown", onSlash);
    return () => window.removeEventListener("keydown", onSlash);
  }, [listVisible]);
  const deck = data.decks.find((d) => d.id === deckId);
  const scopedQuestions = useMemo(
    () =>
      data.questions.filter((q) => {
        if (deckId !== undefined && q.deckId !== deckId) return false;
        if (unfiled && (!q.isOwner || q.deckId !== null)) return false;
        if (archived ? !q.archived : q.archived) return false;
        if (filter === "favorites" && !q.favorite) return false;
        if (filter === "inbox" && !q.needsEditing) return false;
        return true;
      }),
    [data.questions, deckId, unfiled, archived, filter],
  );
  const tagsByQuestionId = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const q of scopedQuestions) {
      const noteTags =
        q.answer.startsWith("---") || q.answer.startsWith("\uFEFF---")
          ? markdownDocument(q.answer).tags
          : [];
      map.set(q.id, mergeQuestionTags(q.tags, noteTags));
    }
    return map;
  }, [scopedQuestions]);
  const availableTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tags of tagsByQuestionId.values()) {
      for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "zh-CN"));
  }, [tagsByQuestionId]);
  useEffect(() => {
    if (!listVisible || !availableTags.length) {
      setHasTagOverflow(false);
      return;
    }
    const el = tagChipsRef.current;
    if (!el) return;
    const measure = () => {
      if (!tagsExpanded) {
        setHasTagOverflow(el.scrollWidth > el.clientWidth + 4);
      }
    };
    measure();
    const raf = requestAnimationFrame(measure);
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    ro?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [listVisible, availableTags, tagsExpanded, section, deckId, filter]);
  useEffect(() => {
    if (!selectedTag || tagsExpanded) return;
    const el = tagChipsRef.current;
    const active = el?.querySelector<HTMLElement>('[data-active-tag="true"]');
    active?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "smooth",
    });
  }, [selectedTag, tagsExpanded]);
  const filtered = useMemo(
    () =>
      scopedQuestions.filter((q) => {
        const tags = tagsByQuestionId.get(q.id) ?? q.tags;
        if (selectedTag && !tags.includes(selectedTag)) return false;
        if (status === "new" && q.fsrs) return false;
        if (
          status === "due" &&
          (!q.fsrs || new Date(q.fsrs.due).getTime() > Date.now())
        )
          return false;
        if (!query) return true;
        const tagTerms = tags.map((t) => `${t} #${t}`).join(" ");
        return `${q.title} ${q.answer} ${tagTerms}`
          .toLowerCase()
          .includes(query);
      }),
    [scopedQuestions, tagsByQuestionId, selectedTag, status, query],
  );
  const sorted = useMemo(() => {
    if (sortBy === "default") {
      return [...filtered].sort((a, b) => {
        const diff =
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        return diff !== 0 ? diff : a.id.localeCompare(b.id);
      });
    }
    const now = Date.now();
    const withMeta = filtered.map((q) => ({
      q,
      dueMs: q.fsrs ? new Date(q.fsrs.due).getTime() : Number.POSITIVE_INFINITY,
      updatedMs: new Date(q.updatedAt).getTime(),
    }));
    if (sortBy === "due") {
      const bucket = (entry: (typeof withMeta)[number]) =>
        !entry.q.fsrs ? 1 : entry.dueMs <= now ? 0 : 2;
      withMeta.sort((a, b) => {
        const diff = bucket(a) - bucket(b);
        if (diff !== 0) return diff;
        if (a.q.fsrs && b.q.fsrs) return a.dueMs - b.dueMs;
        return b.updatedMs - a.updatedMs;
      });
    } else if (sortBy === "lapses") {
      withMeta.sort((a, b) => {
        const diff = (b.q.fsrs?.lapses ?? 0) - (a.q.fsrs?.lapses ?? 0);
        if (diff !== 0) return diff;
        if (a.q.fsrs && b.q.fsrs) return a.dueMs - b.dueMs;
        return a.q.fsrs ? -1 : b.q.fsrs ? 1 : 0;
      });
    } else if (sortBy === "updated") {
      withMeta.sort((a, b) => b.updatedMs - a.updatedMs);
    }
    return withMeta.map((entry) => entry.q);
  }, [filtered, sortBy]);
  const orderedIds = useMemo(() => sorted.map((item) => item.id), [sorted]);
  const cramEligible = useMemo(
    () => sorted.filter((q) => !q.archived && q.answer.trim()),
    [sorted],
  );
  const ownedFiltered = useMemo(
    () => sorted.filter((q) => q.isOwner),
    [sorted],
  );
  const ownedVisibleIds = useMemo(
    () => ownedFiltered.map((q) => q.id),
    [ownedFiltered],
  );
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const activeSelectedIds = useMemo(
    () => ownedVisibleIds.filter((id) => selectedSet.has(id)),
    [ownedVisibleIds, selectedSet],
  );
  function toggleSelect(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  }
  useEffect(() => {
    setBatchMode(false);
    setSelectedIds([]);
  }, [deckId, filter, section]);
  useEffect(
    () => setVisibleCount(40),
    [deckId, filter, status, sortBy, selectedTag, query, section],
  );
  useEffect(() => {
    const button = more.current;
    if (!button || visibleCount >= sorted.length) return;
    // 长题库逐步展开，保留已展开的条目以便返回时恢复滚动。
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          setVisibleCount((count) => count + 40);
      },
      { rootMargin: "400px" },
    );
    observer.observe(button);
    return () => observer.disconnect();
  }, [visibleCount, sorted.length, section, deckId, filter]);
  const heading =
    (deckId === null ? "未分类" : deck?.title) ??
    (filter === "favorites"
      ? "我的收藏"
      : filter === "inbox"
        ? "待整理"
        : filter === "archived"
          ? "已归档"
          : "我的题库");
  const missingDeck = typeof deckId === "string" && !deck;
  const cramLabel = selectedTag
    ? `#${selectedTag}`
    : query
      ? `搜索：${search.trim().slice(0, 12)}`
      : heading;
  const ownedDecks = data.decks.filter((d) => d.isOwner);
  async function runBatch(
    operation: "move" | "archive" | "unarchive" | "delete",
    targetDeckId?: string | null,
  ) {
    if (!activeSelectedIds.length || batchBusy) return;
    setBatchBusy(true);
    try {
      const result = await mutate("/api/questions", {
        action: "batch",
        ids: activeSelectedIds,
        operation,
        ...(operation === "move" ? { deckId: targetDeckId ?? null } : {}),
      });
      if (result) {
        const updated = Number(result.updated ?? 0);
        const skipped = Number(result.skipped ?? 0);
        if (operation === "move") {
          toast.success(
            skipped > 0
              ? `已移动 ${updated} 题，跳过 ${skipped} 题（已在目标题库或内容重复）。`
              : `已移动 ${updated} 道题目。`,
          );
        } else if (operation === "archive") {
          toast.success(`已归档 ${updated} 道题目。`);
        } else if (operation === "unarchive") {
          toast.success(`已恢复 ${updated} 道题目。`);
        } else {
          toast.success(`已将 ${updated} 道题目移入回收站。`);
        }
        setBatchDialog(null);
        setSelectedIds([]);
        setBatchMode(false);
      }
    } finally {
      setBatchBusy(false);
    }
  }
  if (missingDeck) {
    return (
      <div className="page library-page">
        <div className="empty-state">
          <BookOpen size={34} />
          <h3>题库不存在或已删除</h3>
          <p>该题库可能已被移除，原收录的题目已安全保留在「未分类」中。</p>
          <Button variant="outline" onClick={() => onDeck()}>
            返回我的题库
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="page library-page">
      <div className="page-heading">
        <div>
          {(deck || deckId === null || filter) && (
            <button className="back-link" onClick={() => onDeck()}>
              <ArrowLeft size={14} /> 全部题库
            </button>
          )}
          <h1>{heading}</h1>
        </div>
        <div className="heading-actions">
          {deck?.isOwner && (
            <ActionMenu label="管理当前题库">
              <button onClick={() => onEditDeck(deck)}>
                <PencilLine size={15} />
                编辑题库
              </button>
              <button onClick={() => onPublish(deck.id)}>
                <Rss size={15} />
                {deck.publishedVersion ? "发布更新" : "发布题库"}
              </button>
              <button className="danger-text" onClick={() => onDelete(deck)}>
                <Trash2 size={15} />
                删除题库
              </button>
            </ActionMenu>
          )}
          {root && (
            <Button variant="outline" onClick={onCreate}>
              <Plus size={16} /> 新建题库
            </Button>
          )}
          {(!deck || deck.isOwner) && filter !== "archived" && (
            <Button variant="outline" onClick={onCreateQuestion}>
              <PenLine size={15} /> 新建单题
            </Button>
          )}
          <Button onClick={onImport}>
            <Plus size={16} /> 导入题目
          </Button>
        </div>
      </div>
      {root && (
        <div className="library-sections" role="tablist" aria-label="题库内容">
          {[
            ["decks", "题库"],
            ["questions", "全部题目"],
            ["unfiled", "未分类"],
            ["archived", "已归档"],
            ["trash", "回收站"],
          ].map(([id, label]) => (
            <button
              role="tab"
              aria-selected={section === id}
              key={id}
              onClick={() => {
                setSection(id);
                setSearch("");
                setStatus("all");
                setSelectedTag(null);
                setTagsExpanded(false);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {deck && !deck.isOwner && (
        <div className="subscription-banner">
          <Rss size={17} />
          <div>
            <strong>
              {deck.sourceDeleted ? "已停止更新" : "持续订阅"} ·{" "}
              {deck.ownerName}
            </strong>
            <span>v{deck.publishedVersion}</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onUnsubscribe(deck.id)}
          >
            取消订阅
          </Button>
        </div>
      )}
      {deck && !deck.isOwner && deck.publishedVersion > deck.seenVersion && (
        <div className="update-banner">
          <div>
            <strong>题库已更新到 v{deck.publishedVersion}</strong>
            <p>{deck.releaseSummary || "作者发布了新的内容，已为你同步。"}</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onAcknowledge(deck.id, deck.publishedVersion)}
          >
            <Check size={14} /> 知道了
          </Button>
        </div>
      )}
      {root && section === "decks" && (
        <div className="library-book-grid">
          {data.decks.map((d) => (
            <article className={`library-book color-${d.color}`} key={d.id}>
              <button
                className="library-book-main"
                onClick={() => onDeck(d.id)}
              >
                <span className="deck-icon">
                  <BookOpen size={23} />
                </span>
                <div className="library-book-meta">
                  <h3>{d.title}</h3>
                  <p>
                    {d.count} 道题
                    {d.due > 0 ? ` · ${d.due} 待复习` : ""}
                    {!d.isOwner ? ` · ${d.ownerName}` : ""}
                  </p>
                </div>
                <ArrowUpRight size={17} />
              </button>
              <ActionMenu label={`管理题库：${d.title}`}>
                {d.isOwner ? (
                  <>
                    <button onClick={() => onEditDeck(d)}>
                      <PencilLine size={15} />
                      编辑题库
                    </button>
                    <button onClick={() => onPublish(d.id)}>
                      <Rss size={15} />
                      {d.publishedVersion ? "发布更新" : "发布题库"}
                    </button>
                    <button className="danger-text" onClick={() => onDelete(d)}>
                      <Trash2 size={15} />
                      删除题库
                    </button>
                  </>
                ) : (
                  <button onClick={() => onUnsubscribe(d.id)}>取消订阅</button>
                )}
              </ActionMenu>
            </article>
          ))}
          {!data.decks.length && (
            <div className="empty-state">
              <BookOpen size={32} />
              <h3>新建一个题库，开始整理</h3>
              <p>按技术栈或面试专题拆分题库，也可公开发布供同伴订阅。</p>
              <Button onClick={onCreate}>新建题库</Button>
            </div>
          )}
        </div>
      )}
      {root && section === "trash" && (
        <LibraryTrash userId={data.user.id} mutate={mutate} />
      )}
      {(!root || (section !== "decks" && section !== "trash")) && (
        <div className="question-list-panel">
          <div className="library-filter-dock">
            <div className="list-toolbar">
              <div className={`search-field ${search ? "has-query" : ""}`}>
                <Search size={17} />
                <input
                  ref={searchInputRef}
                  aria-label="搜索题目"
                  placeholder="搜索题目标题、答案关键词或 #标签…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search ? (
                  <button
                    type="button"
                    className="search-clear"
                    aria-label="清空搜索"
                    onClick={() => {
                      setSearch("");
                      searchInputRef.current?.focus();
                    }}
                  >
                    <X size={14} />
                  </button>
                ) : (
                  <kbd>/</kbd>
                )}
              </div>
              {!archived && (
                <>
                  <select
                    className="desktop-status-select"
                    aria-label="筛选学习状态"
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                  >
                    <option value="all">全部状态</option>
                    <option value="due">待复习</option>
                    <option value="new">未学习</option>
                  </select>
                  <div
                    className="mobile-status-pills"
                    role="group"
                    aria-label="筛选学习状态"
                  >
                    {[
                      ["all", "全部"],
                      ["due", "待复习"],
                      ["new", "未学习"],
                    ].map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        className={status === val ? "is-active" : ""}
                        aria-pressed={status === val}
                        onClick={() => setStatus(val)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </>
              )}
              <select
                className="library-sort-select"
                aria-label="排序方式"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortKey)}
              >
                <option value="default">默认排序</option>
                <option value="due">到期优先</option>
                <option value="lapses">易忘优先</option>
                <option value="updated">最近更新</option>
              </select>
              <span className="list-count">{sorted.length} 道题</span>
              {!archived && cramEligible.length > 0 && !batchMode && (
                <Button
                  variant="outline"
                  size="sm"
                  className="cram-trigger-btn"
                  onClick={() => onCram(cramEligible, cramLabel)}
                >
                  <Flame size={14} /> 突击当前 ({cramEligible.length})
                </Button>
              )}
              {deck && filter !== "archived" && !batchMode && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onReview(deck.id)}
                >
                  复习题库
                  <ArrowRightIcon />
                </Button>
              )}
              {ownedFiltered.length > 0 && (
                <button
                  type="button"
                  className={`icon-button batch-toggle-btn ${batchMode ? "is-active" : ""}`}
                  title={batchMode ? "退出批量整理" : "批量整理"}
                  aria-label={batchMode ? "退出批量整理" : "批量整理"}
                  aria-pressed={batchMode}
                  onClick={() => {
                    if (batchMode) {
                      setBatchMode(false);
                      setSelectedIds([]);
                    } else {
                      setBatchMode(true);
                    }
                  }}
                >
                  <CheckSquare size={15} />
                </button>
              )}
              {availableTags.length > 0 && (
                <button
                  type="button"
                  className={`icon-button mobile-tag-toggle ${mobileTagsOpen || selectedTag ? "is-active" : ""}`}
                  title="按标签筛选"
                  aria-label="按标签筛选"
                  aria-expanded={mobileTagsOpen || Boolean(selectedTag)}
                  onClick={() => setMobileTagsOpen((v) => !v)}
                >
                  <Tags size={15} />
                </button>
              )}
            </div>
            {availableTags.length > 0 && (
              <div
                className={`library-tag-bar ${tagsExpanded ? "is-expanded" : ""} ${hasTagOverflow && !tagsExpanded ? "has-overflow" : ""} ${mobileTagsOpen || selectedTag ? "is-mobile-open" : ""}`}
                role="region"
                aria-label="按标签筛选"
              >
                <span className="tag-bar-label" aria-hidden="true">
                  <Tags size={14} />
                </span>
                <div className="tag-bar-chips" ref={tagChipsRef}>
                  <button
                    type="button"
                    className={`tag-filter-pill ${selectedTag === null ? "is-active" : ""}`}
                    aria-pressed={selectedTag === null}
                    onClick={() => setSelectedTag(null)}
                  >
                    全部标签
                  </button>
                  {availableTags.map(({ tag, count }) => (
                    <button
                      type="button"
                      key={tag}
                      data-active-tag={selectedTag === tag ? "true" : undefined}
                      className={`tag-filter-pill ${selectedTag === tag ? "is-active" : ""}`}
                      aria-pressed={selectedTag === tag}
                      title={`#${tag} (${count})`}
                      onClick={() =>
                        setSelectedTag((current) =>
                          current === tag ? null : tag,
                        )
                      }
                    >
                      <span className="tag-pill-label">
                        <span className="tag-hash" aria-hidden="true">
                          #
                        </span>
                        {tag}
                      </span>
                      <small>{count}</small>
                    </button>
                  ))}
                </div>
                {(hasTagOverflow || tagsExpanded) && (
                  <button
                    type="button"
                    className="tag-bar-toggle"
                    aria-expanded={tagsExpanded}
                    title={
                      tagsExpanded
                        ? "收起标签"
                        : `展开全部 ${availableTags.length} 个标签`
                    }
                    aria-label={
                      tagsExpanded
                        ? "收起标签"
                        : `展开全部 ${availableTags.length} 个标签`
                    }
                    onClick={() => setTagsExpanded((open) => !open)}
                  >
                    {!tagsExpanded && <span>+{availableTags.length}</span>}
                    <ChevronDown size={13} />
                  </button>
                )}
              </div>
            )}
          </div>
          {sorted.length ? (
            <div className="question-list">
              {sorted.slice(0, visibleCount).map((q, i) => {
                const questionTags = tagsByQuestionId.get(q.id) ?? [];
                const batchSelectable = batchMode && q.isOwner;
                const isSelected = batchSelectable && selectedSet.has(q.id);
                return (
                  <div
                    className={`question-row ${batchMode ? "is-batch-mode" : ""} ${batchSelectable ? "is-selectable" : ""} ${isSelected ? "is-selected" : ""}`}
                    key={q.id}
                    onClick={
                      batchSelectable ? () => toggleSelect(q.id) : undefined
                    }
                  >
                    <div className="question-row-head">
                      <div className="question-row-head-left">
                        {batchMode &&
                          (q.isOwner ? (
                            <button
                              type="button"
                              className={`batch-check-btn ${isSelected ? "is-checked" : ""}`}
                              aria-label={
                                isSelected
                                  ? `取消选中：${q.title}`
                                  : `选中：${q.title}`
                              }
                              aria-pressed={isSelected}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleSelect(q.id);
                              }}
                            >
                              {isSelected ? (
                                <CheckSquare size={18} />
                              ) : (
                                <Square size={18} />
                              )}
                            </button>
                          ) : (
                            <span className="tag">订阅题</span>
                          ))}
                        <span className="row-index">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        {!deckId && (
                          <span className="question-deck-name">
                            {q.deckTitle}
                          </span>
                        )}
                        {q.fsrs && q.fsrs.lapses > 0 && (
                          <span
                            className={`tag ${q.fsrs.lapses >= 2 ? "tag-warn" : "tag-lapses"}`}
                          >
                            易忘 {q.fsrs.lapses} 次
                          </span>
                        )}
                        {q.needsEditing && (
                          <span className="tag tag-warn">待整理</span>
                        )}
                        {q.majorRevision > q.reviewedRevision && q.fsrs && (
                          <span className="tag tag-warn">内容已更新</span>
                        )}
                      </div>
                      {!batchMode && (
                        <div className="question-row-tools">
                          <button
                            className={`icon-button favorite-button ${q.favorite ? "is-favorite" : ""}`}
                            aria-label={q.favorite ? "取消收藏" : "收藏题目"}
                            onClick={() => onFavorite(q)}
                          >
                            <Star
                              size={17}
                              fill={q.favorite ? "currentColor" : "none"}
                            />
                          </button>
                          {q.isOwner && (
                            <ActionMenu label={`更多题目操作：${q.title}`}>
                              <button onClick={() => onMoveQuestion(q)}>
                                <FolderInput size={15} />
                                移动到题库
                              </button>
                              <button
                                className="danger-text"
                                onClick={() => onDeleteQuestion(q)}
                              >
                                <Trash2 size={15} />
                                删除题目
                              </button>
                            </ActionMenu>
                          )}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="question-row-main"
                      onClick={(e) => {
                        if (batchSelectable) {
                          e.stopPropagation();
                          toggleSelect(q.id);
                        } else if (!batchMode) {
                          onQuestion(q, orderedIds);
                        }
                      }}
                    >
                      <strong>{q.title}</strong>
                    </button>
                    {questionTags.length > 0 && (
                      <div className="question-row-tags" aria-label="题目标签">
                        {questionTags.slice(0, 4).map((tag) =>
                          batchMode ? (
                            <span
                              key={tag}
                              title={`#${tag}`}
                              className={`tag ${selectedTag === tag ? "tag-active" : ""}`}
                            >
                              <span className="tag-hash" aria-hidden="true">
                                #
                              </span>
                              <span className="tag-text">{tag}</span>
                            </span>
                          ) : (
                            <button
                              type="button"
                              key={tag}
                              title={`#${tag}`}
                              className={`tag tag-interactive ${selectedTag === tag ? "tag-active" : ""}`}
                              aria-pressed={selectedTag === tag}
                              onClick={() =>
                                setSelectedTag((current) =>
                                  current === tag ? null : tag,
                                )
                              }
                            >
                              <span className="tag-hash" aria-hidden="true">
                                #
                              </span>
                              <span className="tag-text">{tag}</span>
                            </button>
                          ),
                        )}
                        {questionTags.length > 4 && (
                          <span
                            className="tag tag-more"
                            title={questionTags
                              .slice(4)
                              .map((t) => `#${t}`)
                              .join(" ")}
                          >
                            +{questionTags.length - 4}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="question-row-foot">
                      {!batchMode && q.isOwner && !q.archived && !q.answer.trim() ? (
                        <Button
                          className="row-generate-answer"
                          variant="ghost"
                          size="sm"
                          onClick={() => onGenerateAnswer(q)}
                          aria-label={`AI 写答案：${q.title}`}
                        >
                          <Sparkles size={15} />
                          <span>AI 写答案</span>
                        </Button>
                      ) : (
                        <span
                          className={`row-study-status ${!q.fsrs ? "is-new" : new Date(q.fsrs.due).getTime() <= Date.now() ? "is-due" : ""}`}
                        >
                          <span />
                          {q.archived
                            ? "已归档"
                            : !q.answer.trim()
                              ? "待补答案"
                              : relativeDue(q.fsrs?.due)}
                        </span>
                      )}
                      {!batchMode &&
                        (!q.archived && q.answer.trim() && onPractice ? (
                          <button
                            type="button"
                            className="icon-button row-action-btn is-practice"
                            title="开始答题"
                            aria-label={`开始答题：${q.title}`}
                            onClick={() => onPractice(q)}
                          >
                            <Play size={14} />
                          </button>
                        ) : !q.archived && !q.answer.trim() ? (
                          <button
                            type="button"
                            className="icon-button row-action-btn"
                            title="补全答案"
                            aria-label={`补全答案：${q.title}`}
                            onClick={() => onQuestion(q, orderedIds)}
                          >
                            <PencilLine size={14} />
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="icon-button row-action-btn"
                            title="查看题目"
                            aria-label={`查看题目：${q.title}`}
                            onClick={() => onQuestion(q, orderedIds)}
                          >
                            <ArrowUpRight size={15} />
                          </button>
                        ))}
                    </div>
                  </div>
                );
              })}
              {visibleCount < sorted.length && (
                <button
                  ref={more}
                  className="load-more-questions"
                  onClick={() => setVisibleCount((count) => count + 40)}
                >
                  加载更多题目
                </button>
              )}
            </div>
          ) : (
            <div className="empty-state">
              <CircleDashed size={34} />
              <h3>
                {search || status !== "all" || selectedTag !== null
                  ? "没有找到匹配的题目"
                  : "这里还没有题目"}
              </h3>
              <p>
                {search || status !== "all" || selectedTag !== null
                  ? "没有匹配题目，试试调整搜索词、标签或状态筛选。"
                  : archived
                    ? "归档的题目存放在这里，随时可恢复练习。"
                    : filter === "favorites"
                      ? "在题目页点击星标收藏重点题，方便集中复习。"
                      : filter === "inbox"
                        ? "当前没有缺答案的题目；导入「只有题目」的清单会汇集到这里。"
                        : "导入 Markdown / txt 笔记，自动识别题目与 Obsidian 标签。"}
              </p>
              {search || status !== "all" || selectedTag !== null ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSearch("");
                    setStatus("all");
                    setSelectedTag(null);
                  }}
                >
                  清除筛选
                </Button>
              ) : (
                !archived &&
                filter !== "favorites" &&
                (!deck || deck.isOwner) && (
                  <Button variant="outline" size="sm" onClick={onImport}>
                    导入题目
                  </Button>
                )
              )}
            </div>
          )}
        </div>
      )}
      {batchMode && (
        <div
          className="batch-action-bar"
          role="region"
          aria-label="批量整理操作栏"
        >
          <div className="batch-bar-meta">
            <strong>
              已选 {activeSelectedIds.length} / {ownedVisibleIds.length}
            </strong>
            <button
              type="button"
              className="text-button"
              disabled={batchBusy || ownedVisibleIds.length === 0}
              onClick={() =>
                setSelectedIds(
                  activeSelectedIds.length === ownedVisibleIds.length
                    ? []
                    : ownedVisibleIds,
                )
              }
            >
              {activeSelectedIds.length === ownedVisibleIds.length
                ? "清空"
                : "全选"}
            </button>
          </div>
          <div className="batch-bar-actions">
            <Button
              variant="outline"
              size="sm"
              disabled={!activeSelectedIds.length || batchBusy}
              onClick={() => {
                const candidate = ownedDecks.find((d) => d.id !== deckId);
                setBatchTargetDeckId(candidate?.id ?? "");
                setBatchDialog("move");
              }}
            >
              <FolderInput size={14} /> 移动
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!activeSelectedIds.length || batchBusy}
              onClick={() =>
                void runBatch(archived ? "unarchive" : "archive")
              }
            >
              {archived ? (
                <ArchiveRestore size={14} />
              ) : (
                <Archive size={14} />
              )}{" "}
              {archived ? "恢复" : "归档"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="danger-text"
              disabled={!activeSelectedIds.length || batchBusy}
              onClick={() => setBatchDialog("delete")}
            >
              <Trash2 size={14} /> 删除
            </Button>
            <Button
              size="sm"
              disabled={batchBusy}
              onClick={() => {
                setBatchMode(false);
                setSelectedIds([]);
              }}
            >
              完成
            </Button>
          </div>
        </div>
      )}
      <Dialog
        open={batchDialog !== null}
        onOpenChange={(open) => {
          if (!open && !batchBusy) setBatchDialog(null);
        }}
        title={batchDialog === "delete" ? "批量删除题目" : "批量移动题目"}
        description={`已选 ${activeSelectedIds.length} 道题`}
      >
        <div className="dialog-form">
          {batchDialog === "delete" ? (
            <p className="muted">
              选中的 {activeSelectedIds.length}{" "}
              道题目将移入回收站保留 30 天，到期前随时可以恢复。
            </p>
          ) : (
            <label className="field">
              目标题库
              <select
                aria-label="批量移动目标题库"
                value={batchTargetDeckId}
                disabled={batchBusy}
                onChange={(e) => setBatchTargetDeckId(e.target.value)}
              >
                <option value="">未分类</option>
                {ownedDecks.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="dialog-footer">
          <Button
            variant="ghost"
            disabled={batchBusy}
            onClick={() => setBatchDialog(null)}
          >
            取消
          </Button>
          <Button
            variant={batchDialog === "delete" ? "danger" : "default"}
            disabled={batchBusy || !activeSelectedIds.length}
            onClick={() =>
              void runBatch(
                batchDialog === "delete" ? "delete" : "move",
                batchDialog === "move" ? batchTargetDeckId || null : undefined,
              )
            }
          >
            {batchBusy ? (
              <Loader2 size={15} className="spin" />
            ) : batchDialog === "delete" ? (
              <Trash2 size={15} />
            ) : (
              <FolderInput size={15} />
            )}{" "}
            {batchDialog === "delete" ? "移入回收站" : "移动"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
function ArrowRightIcon() {
  return <ArrowUpRight size={14} />;
}

export function Catalog({
  entries,
  busy,
  onSubscribe,
  onOpen,
  onCreate,
  onRefresh,
}: {
  entries: CatalogDeck[];
  busy: boolean;
  onSubscribe: (id: string) => void;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onRefresh: () => void;
}) {
  const [search, setSearch] = useState("");
  const visible = entries.filter((e) =>
    `${e.title} ${e.description} ${e.ownerName}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <div className="page catalog-page">
      <div className="page-heading">
        <div>
          <h1>
            发现题库
            <span className="greeting-sprout">
              <Rss size={25} />
            </span>
          </h1>
        </div>
        <Button variant="outline" onClick={onRefresh}>
          刷新题库
        </Button>
      </div>
      <div
        className={`search-field catalog-search ${search ? "has-query" : ""}`}
      >
        <Search size={17} />
        <input
          aria-label="搜索公开题库"
          placeholder="搜索公开题库名称、技术方向或创作者…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <button
            type="button"
            className="search-clear"
            aria-label="清空搜索"
            onClick={() => setSearch("")}
          >
            <X size={14} />
          </button>
        )}
      </div>
      {visible.length ? (
        <div className="catalog-grid">
          {visible.map((deck) => (
            <article
              key={deck.id}
              className={`catalog-deck color-${deck.color}`}
            >
              <div className="catalog-deck-top">
                <span className="deck-icon">
                  <BookOpen size={25} />
                </span>
              </div>
              <h2>{deck.title}</h2>
              {deck.description && <p>{deck.description}</p>}
              <div className="catalog-author">
                <span>{deck.ownerName.slice(0, 1)}</span>
                {deck.ownerName}
                <small>{deck.count} 道题</small>
              </div>
              <Button
                variant={
                  deck.subscribed || deck.isOwner ? "outline" : "default"
                }
                disabled={busy}
                onClick={() =>
                  deck.subscribed || deck.isOwner
                    ? onOpen(deck.id)
                    : onSubscribe(deck.id)
                }
              >
                {deck.isOwner
                  ? "查看我的题库"
                  : deck.subscribed
                    ? "开始学习"
                    : "订阅题库"}
                <ArrowUpRight size={15} />
              </Button>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state catalog-empty">
          <Rss size={38} />
          <h3>{search ? "没有找到这个题库" : "还没有公开题库"}</h3>
          <p>
            {search
              ? "没有匹配到公开题库，换个关键词试试。"
              : "在我的题库中选择任一题库发布，即可共享给他人订阅。"}
          </p>
          <Button variant="outline" onClick={onCreate}>
            查看我的题库
            <ArrowUpRight size={16} />
          </Button>
        </div>
      )}
    </div>
  );
}
