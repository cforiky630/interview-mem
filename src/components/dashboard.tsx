"use client";
import { useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Flame,
  Folder,
  Plus,
  PenLine,
  Rss,
  Sprout,
} from "lucide-react";
import type { QuestionView, Workspace } from "@/lib/types";
import { buildFolderIndex, ROOT_FOLDER_LABEL } from "@/lib/folders";
import {
  buildReviewQueue,
  isQuestionMajorRevisionDue,
} from "@/lib/review-queue";
import { dateKey } from "@/lib/utils";
import { Button } from "./ui/button";
import { NotebookSketch } from "./sketch";

export function Activity({
  data,
  days = 91,
}: {
  data: Workspace;
  days?: number;
}) {
  const counts = new Map(data.activity.map((row) => [row.date, row.count]));
  const today = new Date(
    `${dateKey(new Date(), data.settings.timeZone)}T12:00:00Z`,
  );
  const cells = Array.from({ length: days }, (_, index) => {
    const day = new Date(today);
    day.setUTCDate(today.getUTCDate() - (days - 1 - index));
    const date = day.toISOString().slice(0, 10);
    return { date, count: counts.get(date) ?? 0 };
  });
  return (
    <div
      className="activity-grid"
      style={{ gridTemplateColumns: `repeat(${Math.ceil(days / 7)}, 1fr)` }}
    >
      {cells.map((cell) => (
        <span
          key={cell.date}
          className={`activity-cell level-${cell.count === 0 ? 0 : cell.count < 3 ? 1 : cell.count < 8 ? 2 : cell.count < 15 ? 3 : 4}`}
          title={`${cell.date} · ${cell.count} 次复习`}
          aria-label={`${cell.date}，${cell.count} 次复习`}
        />
      ))}
    </div>
  );
}

export function Dashboard({
  data,
  onReview,
  onPractice,
  onDeck,
  onImport,
  onCatalog,
  onSeed,
  onLibrary,
  onInbox,
  onCram,
  onQuestion,
  onApplyAllUpdates,
}: {
  data: Workspace;
  onReview: () => void;
  onPractice: (question: QuestionView) => void;
  onDeck: (id: string | null) => void;
  onImport: () => void;
  onCatalog: () => void;
  onSeed: () => void;
  onLibrary: () => void;
  onInbox: () => void;
  onCram?: (questions: QuestionView[], label: string) => void;
  onQuestion?: (q: QuestionView, orderedIds?: string[]) => void;
  onApplyAllUpdates?: (deckIds?: string[]) => void;
}) {
  const [index, setIndex] = useState(0);
  const [dragX, setDragX] = useState(0);
  const cardTouch = useRef<{
    x: number;
    y: number;
    locked: "h" | "v" | null;
  } | null>(null);
  const { active, queue, remainingNew } = buildReviewQueue(data.questions, {
    dailyNewLimit: data.settings.dailyNewLimit,
    newLearnedToday: data.stats.newLearnedToday,
  });
  const unanswered = data.questions.filter(
    (question) => !question.archived && !question.answer.trim(),
  );
  const missing = unanswered.filter((question) => question.isOwner).length;
  const cards = queue.slice(0, 12);
  const selectedIndex = cards.length ? index % cards.length : 0;
  const question = cards[selectedIndex];

  const queueWindowStart =
    cards.length <= 4
      ? 0
      : Math.max(0, Math.min(selectedIndex - 1, cards.length - 4));
  const queueChips = cards
    .slice(queueWindowStart, queueWindowStart + 4)
    .map((item, offset) => ({ item, idx: queueWindowStart + offset }));

  const percent = Math.min(
    100,
    (data.stats.reviewedToday / data.settings.dailyGoal) * 100,
  );

  // Smart 2-row top-level folder ordering: due > 0, pendingUpdate, count > 0, up to 8 folders.
  const folderIndex = buildFolderIndex(data.decks);
  const topLevelDecks = [
    ...(folderIndex.ownedChildren.get(null) ?? []),
    ...(folderIndex.subscriptionsByFolder.get(null) ?? []),
  ];
  const sortedDecks = [...topLevelDecks].sort((a, b) => {
    const aHasDue = a.due > 0 ? 1 : 0;
    const bHasDue = b.due > 0 ? 1 : 0;
    if (aHasDue !== bHasDue) return bHasDue - aHasDue;
    if (a.due !== b.due) return b.due - a.due;
    const aHasUpdate = a.pendingUpdate ? 1 : 0;
    const bHasUpdate = b.pendingUpdate ? 1 : 0;
    if (aHasUpdate !== bHasUpdate) return bHasUpdate - aHasUpdate;
    const aNonEmpty = a.count > 0 ? 1 : 0;
    const bNonEmpty = b.count > 0 ? 1 : 0;
    if (aNonEmpty !== bNonEmpty) return bNonEmpty - aNonEmpty;
    if (a.newCount !== b.newCount) return b.newCount - a.newCount;
    return b.count - a.count;
  });
  const activeDecks = sortedDecks.filter(
    (deck) => deck.count > 0 || Boolean(deck.pendingUpdate),
  );
  const decks = (activeDecks.length ? activeDecks : sortedDecks).slice(0, 8);

  // Weak/lapsed questions (Priority 1) or favorite / owned unanswered fallback.
  const weakList = active
    .filter((q) => (q.fsrs?.lapses ?? 0) >= 1)
    .sort(
      (a, b) =>
        (b.fsrs?.lapses ?? 0) - (a.fsrs?.lapses ?? 0) ||
        (b.fsrs?.difficulty ?? 0) - (a.fsrs?.difficulty ?? 0),
    )
    .slice(0, 5);
  const weakIds = weakList.map((q) => q.id);

  const fallbackFocusList: QuestionView[] = [];
  if (weakList.length === 0) {
    const seenIds = new Set<string>();
    for (const q of data.questions) {
      if (q.archived || !q.favorite || seenIds.has(q.id)) continue;
      seenIds.add(q.id);
      fallbackFocusList.push(q);
      if (fallbackFocusList.length >= 4) break;
    }
    if (fallbackFocusList.length < 4) {
      for (const q of unanswered) {
        if (!q.isOwner || seenIds.has(q.id)) continue;
        seenIds.add(q.id);
        fallbackFocusList.push(q);
        if (fallbackFocusList.length >= 4) break;
      }
    }
  }
  const fallbackFocusIds = fallbackFocusList.map((q) => q.id);

  // Mastery breakdown across all active studyable questions.
  const masteredCount = active.filter(
    (q) => q.fsrs && q.fsrs.reps >= 2 && q.fsrs.stability >= 14,
  ).length;
  const learningCount = active.filter(
    (q) => q.fsrs && !(q.fsrs.reps >= 2 && q.fsrs.stability >= 14),
  ).length;
  const unseenCount = active.length - masteredCount - learningCount;

  const pendingUpdates = data.decks.filter(
    (deck) => !deck.isOwner && Boolean(deck.pendingUpdate),
  );

  const today = dateKey(new Date(), data.settings.timeZone);
  const days = Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(`${today}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() - (6 - offset));
    const key = date.toISOString().slice(0, 10);
    return {
      key,
      label: ["日", "一", "二", "三", "四", "五", "六"][date.getUTCDay()],
      count: data.activity.find((row) => row.date === key)?.count ?? 0,
    };
  });
  const weekTotal = days.reduce((sum, day) => sum + day.count, 0);
  return (
    <div className="page dashboard-page notebook-dashboard">
      <div className="page-heading">
        <div>
          <p className="notebook-date">
            {new Intl.DateTimeFormat("zh-CN", {
              timeZone: data.settings.timeZone,
              month: "long",
              day: "numeric",
              weekday: "long",
            }).format(new Date())}
          </p>
          <h1>
            今天，<span className="sketch-underline">记住一点。</span>
            <Sprout size={27} strokeWidth={1.4} />
          </h1>
        </div>
        <Button variant="outline" onClick={onImport}>
          <Plus size={16} /> 导入面试题
        </Button>
      </div>
      <section className="mobile-today-strip" aria-label="今日进度">
        <div className="mobile-today-progress">
          <div
            className="plan-ring mobile-plan-ring"
            role="progressbar"
            aria-label="今日目标"
            aria-valuenow={Math.round(percent)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <svg viewBox="0 0 54 54" width="48" height="48" aria-hidden="true">
              <circle className="plan-ring-track" cx="27" cy="27" r="22" />
              <circle
                className="plan-ring-fill"
                cx="27"
                cy="27"
                r="22"
                strokeDasharray="138.23"
                strokeDashoffset={138.23 * (1 - percent / 100)}
              />
            </svg>
            <span>{Math.round(percent)}%</span>
          </div>
          <div className="mobile-today-meta">
            <strong>
              今日 {data.stats.reviewedToday} / {data.settings.dailyGoal} 道
            </strong>
            <span>
              待复习 {data.stats.due} · 新学 {data.stats.newLearnedToday}/
              {data.settings.dailyNewLimit}
            </span>
            {missing > 0 && cards.length > 0 && (
              <button
                type="button"
                className="mobile-today-missing"
                onClick={onInbox}
              >
                待补答案 {missing} 题 <ArrowUpRight size={12} />
              </button>
            )}
          </div>
        </div>
        {cards.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            className="mobile-today-cta"
            onClick={onReview}
          >
            开始复习
            <ArrowRight size={14} />
          </Button>
        )}
      </section>
      <div className="notebook-home-grid">
        <div className="notebook-home-main">
          <section className="focus-section" aria-label="今日练习">
            <div className="section-heading">
              <h2>今日练习</h2>
              {cards.length > 0 && (
                <div className="carousel-controls">
                  {cards.length > 1 && (
                    <button
                      type="button"
                      className="carousel-step-btn"
                      aria-label="上一张题目卡片"
                      onClick={() =>
                        setIndex(
                          (selectedIndex - 1 + cards.length) % cards.length,
                        )
                      }
                    >
                      <ChevronLeft size={15} />
                    </button>
                  )}
                  <span aria-live="polite">
                    {selectedIndex + 1} / {cards.length}
                  </span>
                  {cards.length > 1 && (
                    <button
                      type="button"
                      className="carousel-step-btn"
                      aria-label="下一张题目卡片"
                      onClick={() =>
                        setIndex((selectedIndex + 1) % cards.length)
                      }
                    >
                      <ChevronRight size={15} />
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className={`focus-stack ${question ? "has-cards" : ""}`}>
              {question ? (
                <article
                  className="focus-card"
                  key={question.id}
                  aria-roledescription="卡片"
                  style={
                    dragX !== 0
                      ? {
                          touchAction: "pan-y",
                          transform: `translateX(${dragX * 0.42}px) rotate(${dragX * 0.012}deg)`,
                          transition: "none",
                        }
                      : { touchAction: "pan-y" }
                  }
                  onTouchStart={(event) => {
                    if (cards.length <= 1 || event.touches.length !== 1) return;
                    const touch = event.touches[0];
                    cardTouch.current = {
                      x: touch.clientX,
                      y: touch.clientY,
                      locked: null,
                    };
                  }}
                  onTouchMove={(event) => {
                    const state = cardTouch.current;
                    if (!state || event.touches.length !== 1) return;
                    const touch = event.touches[0];
                    const dx = touch.clientX - state.x;
                    const dy = touch.clientY - state.y;
                    if (!state.locked) {
                      if (Math.hypot(dx, dy) < 10) return;
                      state.locked =
                        Math.abs(dx) > Math.abs(dy) * 1.25 ? "h" : "v";
                    }
                    if (state.locked === "h") {
                      setDragX(dx);
                    }
                  }}
                  onTouchEnd={(event) => {
                    const state = cardTouch.current;
                    cardTouch.current = null;
                    if (state?.locked === "h") {
                      const dx =
                        (event.changedTouches[0]?.clientX ?? state.x) - state.x;
                      if (dx < -48) {
                        setIndex((selectedIndex + 1) % cards.length);
                      } else if (dx > 48) {
                        setIndex(
                          (selectedIndex - 1 + cards.length) % cards.length,
                        );
                      }
                    }
                    setDragX(0);
                  }}
                  onTouchCancel={() => {
                    cardTouch.current = null;
                    setDragX(0);
                  }}
                >
                  <div className="focus-card-top">
                    <span className="card-number">
                      Q{String(selectedIndex + 1).padStart(2, "0")}
                    </span>
                    <span title={question.folderPath}>{question.folderPath}</span>
                    <span className="focus-card-state">
                      {isQuestionMajorRevisionDue(question)
                        ? "答案已更新"
                        : question.fsrs
                          ? "待复习"
                          : "新题"}
                    </span>
                  </div>
                  <h3>{question.title}</h3>
                  {question.tags.length > 0 && (
                    <div className="focus-card-tags">
                      {question.tags.slice(0, 3).map((tag) => (
                        <span key={tag}>#{tag}</span>
                      ))}
                    </div>
                  )}
                  <div className="focus-card-bottom">
                    <button
                      className="text-button"
                      onClick={() => onDeck(question.deckId)}
                    >
                      <BookOpen size={15} /> 查看题库
                    </button>
                    <Button onClick={() => onPractice(question)}>
                      <PenLine size={16} /> 开始答题
                      <ArrowRight size={16} />
                    </Button>
                  </div>
                  <span className="card-corner" aria-hidden="true">
                    <Sprout size={54} strokeWidth={1.1} />
                  </span>
                </article>
              ) : (
                <div className="focus-card empty-focus">
                  <NotebookSketch />
                  <div>
                    <h3>
                      {missing
                        ? "先补上参考答案"
                        : data.stats.total
                          ? remainingNew === 0 && data.stats.new > 0
                            ? "今天的新题先学到这里"
                            : "今天的复习完成了"
                          : "放进你的第一道题"}
                    </h3>
                    <p>
                      {missing
                        ? `还有 ${missing} 道只录了题干，补全答案即可加入每日复习。`
                        : data.stats.total
                          ? remainingNew === 0 && data.stats.new > 0
                            ? "今日新题上限已学完，暂无到期复习题；可去题库自由练习。"
                            : "今日到期复习已全部完成，明天按遗忘曲线继续巩固。"
                          : "导入 Markdown / txt 笔记，或先载入示例题库开始记忆。"}
                    </p>
                    <div className="empty-focus-actions">
                      <Button
                        onClick={
                          missing
                            ? onInbox
                            : data.stats.total
                              ? onLibrary
                              : onImport
                        }
                      >
                        {missing ? <PenLine size={15} /> : <Plus size={15} />}{" "}
                        {missing
                          ? "去补答案"
                          : data.stats.total
                            ? "去题库自由练习"
                            : "导入题目"}
                      </Button>
                      {!data.stats.total && (
                        <button className="text-button" onClick={onSeed}>
                          载入示例题库
                          <ArrowUpRight size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
            {cards.length > 1 && (
              <div className="focus-queue-strip" aria-label="今日队列预览">
                {queueChips.map(({ item, idx }) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`focus-queue-chip${idx === selectedIndex ? " is-active" : ""}`}
                    aria-current={idx === selectedIndex ? "true" : undefined}
                    title={item.title}
                    onClick={() => setIndex(idx)}
                  >
                    <span>Q{String(idx + 1).padStart(2, "0")}</span>
                    <span>{item.title}</span>
                  </button>
                ))}
              </div>
            )}
            {cards.length > 1 && (
              <div className="focus-swipe-dots" aria-label="滑动切换练习卡">
                {cards.map((item, i) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-label={`第 ${i + 1} 张练习卡`}
                    aria-current={i === selectedIndex ? "true" : undefined}
                    onClick={() => setIndex(i)}
                  />
                ))}
              </div>
            )}
          </section>
          <section className="section-block notebook-decks">
            <div className="section-heading">
              <h2>{ROOT_FOLDER_LABEL}</h2>
              <button className="text-button" onClick={onLibrary}>
                查看全部
                <ArrowUpRight size={15} />
              </button>
            </div>
            {decks.length ? (
              <div className="deck-grid">
                {decks.map((deck) => (
                  <button
                    key={deck.id}
                    className={`deck-card color-${deck.color}`}
                    onClick={() => onDeck(deck.id)}
                  >
                    <div className="deck-card-top">
                      <span className="deck-icon">
                        {deck.isOwner ? (
                          <Folder size={22} strokeWidth={1.5} />
                        ) : (
                          <Rss size={20} strokeWidth={1.6} />
                        )}
                      </span>
                      <div className="deck-card-top-right">
                        {!deck.isOwner && (
                          <span className="deck-group-badge">订阅</span>
                        )}
                        <ArrowUpRight size={16} />
                      </div>
                    </div>
                    <h3>{deck.title}</h3>
                    <div className="deck-card-foot">
                      <span>{deck.count} 条资料</span>
                      <span>
                        {deck.due
                          ? `${deck.due} 题待复习`
                          : deck.pendingUpdate
                            ? `v${deck.pendingUpdate.toVersion} 可更新`
                            : deck.newCount
                              ? `${deck.newCount} 道新题`
                              : (() => {
                                  const scope = folderIndex.subtreeDeckIds(
                                    deck.id,
                                  );
                                  const missingInFolder = unanswered.filter(
                                    (q) => scope.has(q.deckId),
                                  ).length;
                                  return missingInFolder > 0
                                    ? `${missingInFolder} 道待补答案`
                                    : "已学完";
                                })()}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <button
                className="empty-deck-link"
                onClick={data.stats.total ? () => onDeck(null) : onImport}
              >
                <Plus size={18} />{" "}
                {data.stats.total ? `打开${ROOT_FOLDER_LABEL}` : "导入资料或新建文件夹"}
              </button>
            )}
          </section>
          {weakList.length > 0 ? (
            <section
              className="section-block dashboard-focus-list"
              aria-label="薄弱易忘"
            >
              <div className="section-heading">
                <h2>薄弱易忘</h2>
                {onCram && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onCram(weakList, "薄弱易忘题")}
                  >
                    <Flame size={14} /> 突击薄弱题
                  </Button>
                )}
              </div>
              <div className="focus-list-card">
                {weakList.map((item) => (
                  <div key={item.id} className="focus-list-row">
                    <button
                      type="button"
                      className="focus-list-main"
                      onClick={() =>
                        onQuestion
                          ? onQuestion(item, weakIds)
                          : onPractice(item)
                      }
                    >
                      <span className="focus-list-title">{item.title}</span>
                      <span className="focus-list-meta">
                        <span title={item.folderPath}>{item.folderPath}</span>
                        <span className="focus-list-lapse">
                          易忘 {item.fsrs?.lapses ?? 0} 次
                        </span>
                      </span>
                    </button>
                    <div className="focus-list-actions">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onPractice(item)}
                      >
                        开练
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : fallbackFocusList.length > 0 ? (
            <section
              className="section-block dashboard-focus-list"
              aria-label="快捷关注"
            >
              <div className="section-heading">
                <h2>快捷关注</h2>
                <button
                  type="button"
                  className="text-button"
                  onClick={missing > 0 ? onInbox : onLibrary}
                >
                  {missing > 0 ? "去补答案" : "查看全部"}
                  <ArrowUpRight size={15} />
                </button>
              </div>
              <div className="focus-list-card">
                {fallbackFocusList.map((item) => {
                  const hasAnswer = Boolean(item.answer.trim());
                  return (
                    <div key={item.id} className="focus-list-row">
                      <button
                        type="button"
                        className="focus-list-main"
                        onClick={() =>
                          onQuestion
                            ? onQuestion(item, fallbackFocusIds)
                            : onDeck(item.deckId)
                        }
                      >
                        <span className="focus-list-title">{item.title}</span>
                        <span className="focus-list-meta">
                          <span title={item.folderPath}>{item.folderPath}</span>
                          <span>{item.favorite ? "已收藏" : "待补答案"}</span>
                        </span>
                      </button>
                      {hasAnswer && (
                        <div className="focus-list-actions">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => onPractice(item)}
                          >
                            开练
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}
        </div>
        <aside className="notebook-home-aside">
          <section className="today-plan sketch-card">
            <div className="section-heading">
              <h2>今日安排</h2>
              <span className="pencil-mark" aria-hidden="true">
                ↗
              </span>
            </div>
            <div className="plan-hero">
              <div className="plan-count">
                <strong>{data.stats.reviewedToday}</strong>
                <span>/ {data.settings.dailyGoal} 道</span>
              </div>
              <div
                className="plan-ring"
                role="progressbar"
                aria-label="今日目标"
                aria-valuenow={Math.round(percent)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <svg
                  viewBox="0 0 54 54"
                  width="54"
                  height="54"
                  aria-hidden="true"
                >
                  <circle className="plan-ring-track" cx="27" cy="27" r="22" />
                  <circle
                    className="plan-ring-fill"
                    cx="27"
                    cy="27"
                    r="22"
                    strokeDasharray="138.23"
                    strokeDashoffset={138.23 * (1 - percent / 100)}
                  />
                </svg>
                <span>{Math.round(percent)}%</span>
              </div>
            </div>
            <div className="plan-stats-grid">
              <div className="plan-stat-tile">
                <span>待复习</span>
                <strong>{data.stats.due}</strong>
              </div>
              <div className="plan-stat-tile">
                <span>今日新学</span>
                <strong>
                  {data.stats.newLearnedToday} / {data.settings.dailyNewLimit}
                </strong>
              </div>
            </div>
            {active.length > 0 && (
              <div className="mastery-bar-wrap" aria-label="总体掌握进度">
                <div className="mastery-bar-track">
                  {masteredCount > 0 && (
                    <span
                      className="seg-mastered"
                      style={{
                        width: `${(masteredCount / active.length) * 100}%`,
                      }}
                    />
                  )}
                  {learningCount > 0 && (
                    <span
                      className="seg-learning"
                      style={{
                        width: `${(learningCount / active.length) * 100}%`,
                      }}
                    />
                  )}
                  {unseenCount > 0 && (
                    <span
                      className="seg-new"
                      style={{
                        width: `${(unseenCount / active.length) * 100}%`,
                      }}
                    />
                  )}
                </div>
                <div className="mastery-bar-legend">
                  <span>
                    <i className="seg-mastered" aria-hidden="true" />
                    已掌握 {masteredCount}
                  </span>
                  <span>
                    <i className="seg-learning" aria-hidden="true" />
                    复习中 {learningCount}
                  </span>
                  <span>
                    <i className="seg-new" aria-hidden="true" />
                    未学 {unseenCount}
                  </span>
                </div>
              </div>
            )}
            {pendingUpdates.length > 0 && (
              <button
                type="button"
                className="plan-item plan-item-link is-update"
                onClick={() =>
                  onApplyAllUpdates ? onApplyAllUpdates() : onLibrary()
                }
              >
                <span>{pendingUpdates.length} 个订阅题库有更新</span>
                <strong>
                  <ArrowUpRight size={13} />
                </strong>
              </button>
            )}
            {missing > 0 && (
              <button
                type="button"
                className="plan-item plan-item-link"
                onClick={onInbox}
              >
                <span>待补答案</span>
                <strong>
                  {missing} 题 <ArrowUpRight size={13} />
                </strong>
              </button>
            )}
            <Button variant="secondary" onClick={onReview}>
              开始今日复习
              <ArrowRight size={15} />
            </Button>
          </section>
          <section className="week-card sketch-card">
            <div className="section-heading">
              <h2>这一周</h2>
              <span>{data.stats.streak} 天连续</span>
            </div>
            <div className="week-days">
              {days.map((day) => (
                <div
                  key={day.key}
                  className={day.key === today ? "is-today" : ""}
                >
                  <span>{day.label}</span>
                  <i
                    className={day.count ? "has-study" : ""}
                    title={`${day.key} · ${day.count} 次`}
                  >
                    {day.count ? <Checkmark /> : "·"}
                  </i>
                </div>
              ))}
            </div>
            <div className="week-heatmap-wrap">
              <div className="week-heatmap-head">
                <span>近 10 周 · 本周 {weekTotal} 次</span>
              </div>
              <Activity data={data} days={70} />
            </div>
          </section>
          <button className="discover-note" onClick={onCatalog}>
            <span>去别人的题库逛逛</span>
            <ArrowUpRight size={18} />
          </button>
        </aside>
      </div>
    </div>
  );
}
function Checkmark() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="m3 9 4 4 8-10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
