"use client";
import { useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Plus,
  PenLine,
  Sprout,
} from "lucide-react";
import type { QuestionView, Workspace } from "@/lib/types";
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
}) {
  const [index, setIndex] = useState(0);
  const [dragX, setDragX] = useState(0);
  const cardTouch = useRef<{
    x: number;
    y: number;
    locked: "h" | "v" | null;
  } | null>(null);
  const remainingNew = Math.max(
    0,
    data.settings.dailyNewLimit - data.stats.newLearnedToday,
  );
  const active = data.questions.filter(
    (question) => !question.archived && question.answer.trim(),
  );
  const unanswered = data.questions.filter(
    (question) => !question.archived && !question.answer.trim(),
  );
  const missing = unanswered.filter((question) => question.isOwner).length;
  const due = active
    .filter(
      (question) =>
        question.fsrs && new Date(question.fsrs.due).getTime() <= Date.now(),
    )
    .sort(
      (a, b) =>
        new Date(a.fsrs!.due).getTime() - new Date(b.fsrs!.due).getTime(),
    );
  const cards = [
    ...due,
    ...active.filter((question) => !question.fsrs).slice(0, remainingNew),
  ].slice(0, 12);
  const selectedIndex = cards.length ? index % cards.length : 0;
  const question = cards[selectedIndex];
  const percent = Math.min(
    100,
    (data.stats.reviewedToday / data.settings.dailyGoal) * 100,
  );
  const nonEmptyDecks = data.decks.filter((deck) => deck.count > 0);
  const decks = (nonEmptyDecks.length ? nonEmptyDecks : data.decks).slice(0, 4);
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
            {missing > 0 && (
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
        <Button size="sm" className="mobile-today-cta" onClick={onReview}>
          开始复习
          <ArrowRight size={14} />
        </Button>
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
                          transform: `translateX(${dragX * 0.42}px) rotate(${dragX * 0.012}deg)`,
                          transition: "none",
                        }
                      : undefined
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
                    <span>{question.deckTitle}</span>
                    <span className="focus-card-state">
                      {question.fsrs ? "待复习" : "新题"}
                    </span>
                  </div>
                  <h3>{question.title}</h3>
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
              <h2>我的题库</h2>
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
                        <BookOpen size={22} strokeWidth={1.5} />
                      </span>
                      <ArrowUpRight size={16} />
                    </div>
                    <h3>{deck.title}</h3>
                    <div className="deck-card-foot">
                      <span>{deck.count} 道题</span>
                      <span>
                        {deck.due
                          ? `${deck.due} 题待复习`
                          : deck.newCount
                            ? `${deck.newCount} 道新题`
                            : unanswered.some((q) => q.deckId === deck.id)
                              ? `${unanswered.filter((q) => q.deckId === deck.id).length} 道待补答案`
                              : "已学完"}
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
                {data.stats.total ? "查看未分类题目" : "导入题目或新建题库"}
              </button>
            )}
          </section>
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
