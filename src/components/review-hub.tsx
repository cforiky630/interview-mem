"use client";

import { useMemo } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  Flame,
  History,
  PenLine,
  Plus,
  RotateCcw,
} from "lucide-react";
import type { DeckView, QuestionView, Workspace } from "@/lib/types";
import { buildReviewQueue, isQuestionDue } from "@/lib/review-queue";
import { Button } from "./ui/button";

export type ReviewHubProps = {
  data: Workspace;
  onStartReview: (deckId?: string) => void;
  onStartCram: (questions: QuestionView[], label: string) => void;
  onOpenDeck: (deckId?: string | null) => void;
  onOpenHistory: () => void;
  onOpenInbox: () => void;
  onImport: () => void;
};

type DeckReviewItem = {
  deck: DeckView;
  answerable: QuestionView[];
  dueCount: number;
  newCount: number;
  weakCount: number;
  sessionReady: number;
};

export function ReviewHub({
  data,
  onStartReview,
  onStartCram,
  onOpenDeck,
  onOpenHistory,
  onOpenInbox,
  onImport,
}: ReviewHubProps) {
  const {
    active,
    dueCount,
    freshCount,
    sessionTotal,
    weakQuestions,
    missingOwned,
    deckItems,
    unfiledAnswerable,
  } = useMemo(() => {
    const now = Date.now();
    const {
      active: activeQuestions,
      dueCount: totalDueCount,
      fresh: freshReview,
      queue,
      remainingNew,
    } = buildReviewQueue(data.questions, {
      dailyNewLimit: data.settings.dailyNewLimit,
      newLearnedToday: data.stats.newLearnedToday,
      now,
    });

    const weak = activeQuestions
      .filter((q) => q.fsrs && q.fsrs.lapses > 0)
      .sort((a, b) => (b.fsrs?.lapses ?? 0) - (a.fsrs?.lapses ?? 0));

    const missing = data.questions.filter(
      (q) => !q.archived && !q.answer.trim() && q.isOwner,
    ).length;

    const byDeck = new Map<string, QuestionView[]>();
    const unfiled: QuestionView[] = [];
    for (const q of activeQuestions) {
      if (q.deckId) {
        const list = byDeck.get(q.deckId);
        if (list) list.push(q);
        else byDeck.set(q.deckId, [q]);
      } else if (q.isOwner) {
        unfiled.push(q);
      }
    }

    const decks: DeckReviewItem[] = [];
    for (const deck of data.decks) {
      const answerable = byDeck.get(deck.id) ?? [];
      if (!answerable.length) continue;
      let dueInDeck = 0;
      let newInDeck = 0;
      let weakInDeck = 0;
      for (const q of answerable) {
        if (q.fsrs) {
          if (isQuestionDue(q, now)) {
            dueInDeck++;
          }
          if (q.fsrs.lapses > 0) weakInDeck++;
        } else {
          newInDeck++;
        }
      }
      const sessionReady = dueInDeck + Math.min(newInDeck, remainingNew);
      decks.push({
        deck,
        answerable,
        dueCount: dueInDeck,
        newCount: newInDeck,
        weakCount: weakInDeck,
        sessionReady,
      });
    }

    decks.sort(
      (a, b) =>
        b.dueCount - a.dueCount ||
        b.sessionReady - a.sessionReady ||
        b.weakCount - a.weakCount ||
        b.answerable.length - a.answerable.length,
    );

    return {
      active: activeQuestions,
      dueCount: totalDueCount,
      freshCount: freshReview.length,
      sessionTotal: queue.length,
      weakQuestions: weak,
      missingOwned: missing,
      deckItems: decks,
      unfiledAnswerable: unfiled,
    };
  }, [data.questions, data.decks, data.settings.dailyNewLimit, data.stats.newLearnedToday]);

  const percent = Math.min(
    100,
    data.settings.dailyGoal > 0
      ? (data.stats.reviewedToday / data.settings.dailyGoal) * 100
      : 0,
  );

  return (
    <div className="page review-hub-page">
      <div className="page-heading">
        <div>
          <h1>复习中心</h1>
          <p className="muted">
            今日已完成 {data.stats.reviewedToday} / {data.settings.dailyGoal} 道
            {data.stats.streak > 0 ? ` · 连续 ${data.stats.streak} 天` : ""}
          </p>
        </div>
        <div className="heading-actions">
          <Button variant="outline" size="sm" onClick={onOpenHistory}>
            <History size={15} /> 回顾记录
          </Button>
        </div>
      </div>

      <div className="review-hub-overview">
        <section className="review-hub-hero" aria-label="今日复习概览">
        <div className="review-hub-hero-top">
          <div
            className="plan-ring review-hub-ring"
            role="progressbar"
            aria-label="今日复习目标"
            aria-valuenow={Math.round(percent)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <svg viewBox="0 0 54 54" width="54" height="54" aria-hidden="true">
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
          <div className="review-hub-summary">
            <h2>
              {sessionTotal > 0
                ? `本轮可复习 ${sessionTotal} 题`
                : active.length > 0
                  ? "今日间隔复习已完成"
                  : "还没有可复习的题目"}
            </h2>
            <p className="muted">
              {sessionTotal > 0
                ? dueCount > 0 && freshCount > 0
                  ? `含 ${dueCount} 道到期回顾与 ${freshCount} 道今日新题，按 FSRS 记忆曲线排程。`
                  : dueCount > 0
                    ? `共 ${dueCount} 道题到达复习节点，及时巩固效果最好。`
                    : `暂无到期旧题，准备了 ${freshCount} 道新题加入计划。`
                : active.length > 0
                  ? "你可以巩固易忘题，或任选题库开启不影响排期的突击练习。"
                  : missingOwned > 0
                    ? `还有 ${missingOwned} 道题待补全参考答案，补完后即可开始复习。`
                    : "先导入面试题或新建卡片，系统会自动安排每日复习计划。"}
            </p>
          </div>
        </div>

        <div className="review-hub-metrics">
          <div className={`review-hub-metric ${dueCount > 0 ? "is-accent" : ""}`}>
            <span>待复习</span>
            <strong>{dueCount}</strong>
          </div>
          <div className="review-hub-metric">
            <span>今日新题</span>
            <strong>{freshCount}</strong>
          </div>
          <div className={`review-hub-metric ${weakQuestions.length > 0 ? "is-warn" : ""}`}>
            <span>易忘题</span>
            <strong>{weakQuestions.length}</strong>
          </div>
        </div>

        <div className="review-hub-actions">
          {sessionTotal > 0 ? (
            <Button
              size="lg"
              className="review-hub-primary-cta"
              onClick={() => onStartReview()}
            >
              <RotateCcw size={16} />
              开始本轮复习
              <ArrowRight size={16} />
            </Button>
          ) : active.length > 0 ? (
            <Button
              size="lg"
              variant="secondary"
              className="review-hub-primary-cta"
              onClick={() =>
                onStartCram(
                  weakQuestions.length > 0 ? weakQuestions : active.slice(0, 15),
                  weakQuestions.length > 0 ? "易忘巩固" : "自由巩固",
                )
              }
            >
              <Flame size={16} />
              {weakQuestions.length > 0
                ? `巩固 ${weakQuestions.length} 道易忘题`
                : "自由突击练习"}
              <ArrowRight size={16} />
            </Button>
          ) : missingOwned > 0 ? (
            <Button
              size="lg"
              className="review-hub-primary-cta"
              onClick={onOpenInbox}
            >
              <PenLine size={16} />
              去补全答案（{missingOwned}）
            </Button>
          ) : (
            <Button
              size="lg"
              className="review-hub-primary-cta"
              onClick={onImport}
            >
              <Plus size={16} />
              导入面试题
            </Button>
          )}

          {sessionTotal > 0 && weakQuestions.length > 0 && (
            <Button
              variant="outline"
              onClick={() => onStartCram(weakQuestions, "易忘巩固")}
            >
              <Flame size={15} />
              易忘突击（{weakQuestions.length}）
            </Button>
          )}
        </div>
      </section>

      <div className="review-hub-shortcuts">
        <button
          type="button"
          className="review-hub-shortcut"
          onClick={onOpenHistory}
        >
          <span className="review-hub-shortcut-icon">
            <History size={17} />
          </span>
          <span className="review-hub-shortcut-text">
            <strong>回顾记录</strong>
            <small>
              累计 {data.stats.totalReviews} 次复习
              {data.stats.retention !== null
                ? ` · 近期掌握率 ${Math.round(data.stats.retention)}%`
                : ""}
            </small>
          </span>
          <ArrowUpRight size={16} />
        </button>

        {missingOwned > 0 && (
          <button
            type="button"
            className="review-hub-shortcut"
            onClick={onOpenInbox}
          >
            <span className="review-hub-shortcut-icon is-warn">
              <PenLine size={17} />
            </span>
            <span className="review-hub-shortcut-text">
              <strong>待整理题目</strong>
              <small>{missingOwned} 道缺参考答案，补齐即可加入排程</small>
            </span>
            <ArrowUpRight size={16} />
          </button>
        )}
      </div>
      </div>

      {deckItems.length > 0 && (
        <section className="section-block review-hub-decks" aria-label="按题库复习">
          <div className="section-heading">
            <h2>按题库复习</h2>
            <button
              type="button"
              className="text-button"
              onClick={() => onOpenDeck()}
            >
              全部题库
              <ArrowUpRight size={14} />
            </button>
          </div>
          <div className="review-hub-deck-grid">
            {deckItems.map((item) => (
              <div
                key={item.deck.id}
                className={`review-hub-deck-card color-${item.deck.color}`}
              >
                <button
                  type="button"
                  className="review-hub-deck-info"
                  onClick={() => onOpenDeck(item.deck.id)}
                >
                  <span className="deck-icon">
                    <BookOpen size={18} strokeWidth={1.6} />
                  </span>
                  <div className="review-hub-deck-meta">
                    <h3>{item.deck.title}</h3>
                    <p>
                      {item.dueCount > 0
                        ? `${item.dueCount} 待复习`
                        : item.newCount > 0
                          ? `${item.newCount} 道新题`
                          : "已学完"}
                      {item.dueCount > 0 && item.newCount > 0
                        ? ` · ${item.newCount} 新题`
                        : ""}
                      {" · "}共 {item.answerable.length} 题
                    </p>
                  </div>
                </button>
                <div className="review-hub-deck-cta">
                  {item.sessionReady > 0 ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => onStartReview(item.deck.id)}
                    >
                      复习 ({item.sessionReady})
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onStartCram(item.answerable, item.deck.title)}
                    >
                      <Check size={13} /> 突击
                    </Button>
                  )}
                </div>
              </div>
            ))}
            {unfiledAnswerable.length > 0 && (
              <div className="review-hub-deck-card">
                <button
                  type="button"
                  className="review-hub-deck-info"
                  onClick={() => onOpenDeck(null)}
                >
                  <span className="deck-icon">
                    <BookOpen size={18} strokeWidth={1.6} />
                  </span>
                  <div className="review-hub-deck-meta">
                    <h3>未分类</h3>
                    <p>共 {unfiledAnswerable.length} 道可练习题目</p>
                  </div>
                </button>
                <div className="review-hub-deck-cta">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onStartCram(unfiledAnswerable, "未分类")}
                  >
                    突击
                  </Button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
