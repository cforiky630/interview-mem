"use client";

import { useMemo, useState } from "react";
import {
  CheckCircle2,
  CopyCheck,
  ExternalLink,
  Loader2,
  Merge,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import type { QuestionView } from "@/lib/types";
import { findExactDuplicateClusters } from "@/lib/folders";
import { mergeDuplicateQuestionsApi, type WorkspaceMutate } from "@/lib/client";
import { Button } from "./ui/button";

export function DuplicatesView({
  questions,
  mutate,
  onOpenQuestion,
  onOpenAiDedup,
}: {
  questions: readonly QuestionView[];
  mutate: WorkspaceMutate;
  onOpenQuestion: (id: string) => void;
  onOpenAiDedup?: () => void;
}) {
  const clusters = useMemo(
    () => findExactDuplicateClusters(questions),
    [questions],
  );
  const [primaryByKey, setPrimaryByKey] = useState<Record<string, string>>({});
  const [appendNotes, setAppendNotes] = useState(true);
  const [keepStrongerFsrs, setKeepStrongerFsrs] = useState(true);
  const [mergeTags, setMergeTags] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function handleMerge(
    key: string,
    primaryId: string,
    items: QuestionView[],
  ) {
    const duplicateIds = items
      .filter((q) => q.id !== primaryId)
      .map((q) => q.id);
    if (!duplicateIds.length || busyKey) return;
    setBusyKey(key);
    try {
      const res = await mergeDuplicateQuestionsApi(mutate, {
        primaryId,
        duplicateIds,
        appendNotes,
        keepStrongerFsrs,
        mergeTags,
      });
      if (res) {
        toast.success(
          `已合并 ${duplicateIds.length} 条重复内容，多余副本已移入 30 天回收站。`,
        );
      }
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <section className="duplicates-view" aria-label="重复内容清理">
      <div className="duplicates-header">
        <div>
          <h2>重复内容</h2>
          <p className="muted small">
            自动识别全局标题与答案完全相同的自有资料；由你决定保留哪一张主卡，其余副本移入 30 天回收站，绝不静默丢弃复习记录。
          </p>
        </div>
        {onOpenAiDedup && (
          <Button variant="outline" size="sm" onClick={onOpenAiDedup}>
            <Sparkles size={14} /> AI 语义查重
          </Button>
        )}
      </div>

      {clusters.length > 0 && (
        <div className="duplicates-options">
          <label className="checkbox-inline">
            <input
              type="checkbox"
              checked={appendNotes}
              onChange={(e) => setAppendNotes(e.target.checked)}
            />
            <span>追加合并个人笔记与批注</span>
          </label>
          <label className="checkbox-inline">
            <input
              type="checkbox"
              checked={keepStrongerFsrs}
              onChange={(e) => setKeepStrongerFsrs(e.target.checked)}
            />
            <span>保留更强的 FSRS 复习进度</span>
          </label>
          <label className="checkbox-inline">
            <input
              type="checkbox"
              checked={mergeTags}
              onChange={(e) => setMergeTags(e.target.checked)}
            />
            <span>合并标签</span>
          </label>
        </div>
      )}

      {clusters.length === 0 ? (
        <div className="empty-state-card">
          <CheckCircle2 size={28} />
          <h3>没有发现完全重复的资料</h3>
          <p className="muted small">
            你的资料库目前很整洁。如果需要查找标题不同但含义相近的题目，可以使用 AI 语义查重。
          </p>
          {onOpenAiDedup && (
            <Button variant="outline" size="sm" onClick={onOpenAiDedup}>
              <Sparkles size={14} /> 启动 AI 语义查重
            </Button>
          )}
        </div>
      ) : (
        <div className="duplicates-list">
          {clusters.map((cluster) => {
            const items = cluster.questions;
            const primaryId =
              primaryByKey[cluster.key] &&
              items.some((q) => q.id === primaryByKey[cluster.key])
                ? primaryByKey[cluster.key]
                : cluster.suggestedPrimaryId;
            const busy = busyKey === cluster.key;
            return (
              <article key={cluster.key} className="duplicate-cluster-card">
                <div className="duplicate-cluster-head">
                  <div className="duplicate-cluster-title">
                    <CopyCheck size={16} />
                    <strong>{items[0]?.title ?? "重复内容"}</strong>
                    <span className="pill-badge">{items.length} 份</span>
                  </div>
                  <Button
                    size="sm"
                    disabled={Boolean(busyKey)}
                    onClick={() => void handleMerge(cluster.key, primaryId, items)}
                  >
                    {busy ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <Merge size={14} />
                    )}{" "}
                    保留主卡并清理副本
                  </Button>
                </div>

                <div className="duplicate-cluster-items">
                  {items.map((q) => {
                    const isPrimary = q.id === primaryId;
                    const reps = Number(q.fsrs?.reps ?? 0);
                    return (
                      <div
                        key={q.id}
                        className={`duplicate-item-row ${isPrimary ? "is-primary" : ""}`}
                      >
                        <label className="duplicate-item-radio">
                          <input
                            type="radio"
                            name={`dup-${cluster.key}`}
                            checked={isPrimary}
                            disabled={busy}
                            onChange={() =>
                              setPrimaryByKey((prev) => ({
                                ...prev,
                                [cluster.key]: q.id,
                              }))
                            }
                          />
                          <span className="duplicate-item-path">
                            {q.folderPath || q.deckTitle}
                          </span>
                          {isPrimary && (
                            <span className="pill-badge is-accent">保留为主卡</span>
                          )}
                        </label>
                        <div className="duplicate-item-meta">
                          <span>
                            {reps > 0 ? `已复习 ${reps} 次` : "新题"}
                          </span>
                          {q.note.trim() && (
                            <span>笔记 {q.note.trim().length} 字</span>
                          )}
                          {q.annotations.length > 0 && (
                            <span>{q.annotations.length} 条批注</span>
                          )}
                          {q.tags.length > 0 && (
                            <span>{q.tags.slice(0, 3).join(" · ")}</span>
                          )}
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => onOpenQuestion(q.id)}
                          >
                            <ExternalLink size={12} /> 查看
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
