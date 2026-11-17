"use client";
import { useEffect, useState } from "react";
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
} from "lucide-react";
import type { Workspace, QuestionView, CatalogDeck } from "@/lib/types";
import { relativeDue } from "@/lib/utils";
import { Button } from "./ui/button";
import { ActionMenu } from "./ui/action-menu";
import { LibraryTrash } from "./library-trash";
import type { Mutate } from "./dialogs";

export function Library({
  data,
  deckId,
  filter,
  onQuestion,
  onDeck,
  onImport,
  onCreate,
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
  onQuestion: (q: QuestionView) => void;
  onDeck: (id?: string | null) => void;
  onImport: () => void;
  onCreate: () => void;
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
  const [section, setSection] = useState("decks");
  useEffect(() => {
    if (searchToken) {
      setSection("questions");
      setTimeout(
        () =>
          document
            .querySelector<HTMLInputElement>("input[aria-label='搜索题目']")
            ?.focus(),
        0,
      );
    }
  }, [searchToken]);
  const root = deckId === undefined && !filter;
  const unfiled = deckId === null || (root && section === "unfiled");
  const archived = filter === "archived" || (root && section === "archived");
  const deck = data.decks.find((d) => d.id === deckId);
  const filtered = data.questions.filter((q) => {
    if (deckId !== undefined && q.deckId !== deckId) return false;
    if (unfiled && (!q.isOwner || q.deckId !== null)) return false;
    if (archived ? !q.archived : q.archived) return false;
    if (filter === "favorites" && !q.favorite) return false;
    if (filter === "inbox" && !q.needsEditing) return false;
    if (status === "new" && q.fsrs) return false;
    if (
      status === "due" &&
      (!q.fsrs || new Date(q.fsrs.due).getTime() > Date.now())
    )
      return false;
    return `${q.title} ${q.answer} ${q.tags.join(" ")}`
      .toLowerCase()
      .includes(search.toLowerCase());
  });
  const heading =
    (deckId === null ? "未分类" : deck?.title) ??
    (filter === "favorites"
      ? "我的收藏"
      : filter === "inbox"
        ? "待整理"
        : filter === "archived"
          ? "已归档"
          : "我的题库");
  return (
    <div className="page library-page">
      <div className="page-heading">
        <div>
          {(deck || deckId === null) && (
            <button className="back-link" onClick={() => onDeck()}>
              <ArrowLeft size={14} /> 全部题库
            </button>
          )}
          <h1>{heading}</h1>
        </div>
        <div className="heading-actions">
          {deck?.isOwner && (
            <ActionMenu label="管理当前题库">
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
                <h3>{d.title}</h3>
                <p>
                  {d.count} 道题{!d.isOwner ? ` · ${d.ownerName}` : ""}
                </p>
                <ArrowUpRight size={17} />
              </button>
              <ActionMenu label={`管理题库：${d.title}`}>
                {d.isOwner ? (
                  <>
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
          <div className="list-toolbar">
            <div className="search-field">
              <Search size={17} />
              <input
                aria-label="搜索题目"
                placeholder="搜索题目、答案或标签…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <kbd>/</kbd>
            </div>
            <select
              aria-label="筛选学习状态"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="all">全部状态</option>
              <option value="due">待复习</option>
              <option value="new">未学习</option>
            </select>
            <span className="list-count">{filtered.length} 道题</span>
            {deck && filter !== "archived" && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onReview(deck.id)}
              >
                复习题库
                <ArrowRightIcon />
              </Button>
            )}
          </div>
          {filtered.length ? (
            <div className="question-list">
              {filtered.map((q, i) => (
                <div className="question-row" key={q.id}>
                  <span className="row-index">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <button
                    className="question-row-main"
                    onClick={() => onQuestion(q)}
                  >
                    <strong>{q.title}</strong>
                    <div>
                      {!deckId && (
                        <span className="question-deck-name">
                          {q.deckTitle}
                        </span>
                      )}
                      {q.needsEditing && (
                        <span className="tag tag-warn">待整理</span>
                      )}
                      {q.majorRevision > q.reviewedRevision && q.fsrs && (
                        <span className="tag tag-warn">内容已更新</span>
                      )}
                    </div>
                  </button>
                  {q.isOwner && !q.archived && !q.answer.trim() ? (
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
                      {q.archived ? "已归档" : relativeDue(q.fsrs?.due)}
                    </span>
                  )}
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
                  <button
                    className="icon-button row-open"
                    aria-label={`打开 ${q.title}`}
                    onClick={() => onQuestion(q)}
                  >
                    <ArrowUpRight size={17} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <CircleDashed size={34} />
              <h3>
                {search || status !== "all"
                  ? "没有找到匹配的题目"
                  : "这里还没有题目"}
              </h3>
              {!search && (
                <Button variant="outline" size="sm" onClick={onImport}>
                  导入题目
                </Button>
              )}
            </div>
          )}
        </div>
      )}
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
      <div className="search-field catalog-search">
        <Search size={17} />
        <input
          aria-label="搜索公开题库"
          placeholder="寻找感兴趣的题库或作者…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
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
          <Button variant="outline" onClick={onCreate}>
            查看我的题库
            <ArrowUpRight size={16} />
          </Button>
        </div>
      )}
    </div>
  );
}
