"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BookmarkPlus,
  Check,
  Copy,
  FileDiff,
  FileText,
  Layers2,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { computeLineDiff } from "@/lib/text-diff";
import type {
  ChatEdit,
  ChatMessage,
  DeckView,
  QuestionView,
} from "@/lib/types";
import { chatEditState } from "./chat-edit-card";
import { Markdown } from "./markdown";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

export type AiReaderTarget =
  | {
      kind: "message";
      message: ChatMessage;
      title: string;
    }
  | {
      kind: "edit";
      edit: ChatEdit;
      question: QuestionView;
      deck?: DeckView;
      keyId: string;
    };

export function AiReaderDialog({
  target,
  onClose,
  busy,
  applyingKey,
  copyBusy,
  onApplyEdit,
  onSaveToNote,
  onSaveAsCard,
}: {
  target: AiReaderTarget | null;
  onClose: () => void;
  busy: boolean;
  applyingKey: string | null;
  copyBusy: boolean;
  onApplyEdit: (edit: ChatEdit, keyId: string) => Promise<void>;
  onSaveToNote?: (message: ChatMessage) => void;
  onSaveAsCard?: (message: ChatMessage) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [editView, setEditView] = useState<"diff" | "preview">("diff");

  const targetKey =
    target?.kind === "message"
      ? `m:${target.message.id}`
      : target?.kind === "edit"
        ? `e:${target.keyId}`
        : "";

  const editMeta = useMemo(() => {
    if (target?.kind !== "edit") return null;
    const { edit, question, deck } = target;
    if (edit.target === "question") {
      const metaRows: { label: string; before: string; after: string }[] = [];
      if (edit.fields.title !== undefined) {
        metaRows.push({
          label: "标题",
          before: question.title,
          after: edit.fields.title || "（空）",
        });
      }
      if (edit.fields.tags !== undefined) {
        metaRows.push({
          label: "标签",
          before: question.tags.join("、") || "无",
          after: edit.fields.tags.join("、") || "无",
        });
      }
      return {
        heading: "修改题目",
        applyLabel: "应用到题目",
        metaRows,
        beforeText:
          edit.fields.answer !== undefined ? question.answer : undefined,
        afterText: edit.fields.answer,
      };
    }
    if (edit.target === "note") {
      return {
        heading: "修改笔记",
        applyLabel: "应用到笔记",
        metaRows: [] as { label: string; before: string; after: string }[],
        beforeText: question.note,
        afterText: edit.fields.note,
      };
    }
    const metaRows: { label: string; before: string; after: string }[] = [];
    if (edit.fields.title !== undefined) {
      metaRows.push({
        label: "文件夹名称",
        before: deck?.title ?? edit.expected.title,
        after: edit.fields.title || "（空）",
      });
    }
    if (edit.fields.description !== undefined) {
      metaRows.push({
        label: "文件夹简介",
        before: deck?.description ?? edit.expected.description,
        after: edit.fields.description || "（清空）",
      });
    }
    return {
      heading: "修改文件夹",
      applyLabel: "应用到文件夹",
      metaRows,
      beforeText: undefined,
      afterText: undefined,
    };
  }, [target]);

  useEffect(() => {
    setCopied(false);
    if (target?.kind === "edit") {
      const hasBefore = Boolean(editMeta?.beforeText?.trim());
      setEditView(hasBefore ? "diff" : "preview");
    }
  }, [targetKey, target?.kind, editMeta?.beforeText]);

  const diff = useMemo(() => {
    if (editMeta?.afterText === undefined) return null;
    return computeLineDiff(editMeta.beforeText ?? "", editMeta.afterText);
  }, [editMeta?.beforeText, editMeta?.afterText]);

  const copyPayload =
    target?.kind === "message"
      ? target.message.content
      : target?.kind === "edit"
        ? (editMeta?.afterText ??
          editMeta?.metaRows.map((r) => `${r.label}：${r.after}`).join("\n") ??
          "")
        : "";

  async function handleCopy() {
    if (!copyPayload) return;
    try {
      await navigator.clipboard.writeText(copyPayload);
      setCopied(true);
      toast.success("已复制");
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("复制失败，请手动复制");
    }
  }

  const editState =
    target?.kind === "edit"
      ? chatEditState(target.edit, target.question, target.deck)
      : null;

  const dialogTitle =
    target?.kind === "message"
      ? target.title || "AI 回答"
      : (editMeta?.heading ?? "修改对比");

  const dialogDescription =
    target?.kind === "message"
      ? `共 ${target.message.content.length} 字`
      : editMeta?.afterText !== undefined
        ? `共 ${editMeta.afterText.length} 字`
        : undefined;

  return (
    <Dialog
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={dialogTitle}
      description={dialogDescription}
      className="ai-reader-dialog"
    >
      {target?.kind === "message" && (
        <>
          <div className="ai-reader-body">
            {target.message.reasoning && (
              <details className="reasoning-disclosure ai-reader-reasoning">
                <summary>思考过程</summary>
                <div className="reasoning-body">
                  <Markdown>{target.message.reasoning}</Markdown>
                </div>
              </details>
            )}
            <div className="ai-reader-canvas">
              <Markdown>{target.message.content}</Markdown>
            </div>
          </div>
          <div className="ai-reader-footer">
            <div className="ai-reader-footer-left">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void handleCopy()}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? "已复制" : "复制全文"}
              </Button>
              {onSaveToNote && !target.message.edits?.length && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onSaveToNote(target.message)}
                >
                  <BookmarkPlus size={14} />
                  存为笔记
                </Button>
              )}
              {onSaveAsCard && !target.message.edits?.length && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={copyBusy}
                  onClick={() => onSaveAsCard(target.message)}
                >
                  {copyBusy ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <Layers2 size={14} />
                  )}
                  存为卡片
                </Button>
              )}
            </div>
            <Button type="button" size="sm" variant="ghost" onClick={onClose}>
              关闭
            </Button>
          </div>
        </>
      )}

      {target?.kind === "edit" && editMeta && (
        <>
          {editMeta.afterText !== undefined && (
            <div className="ai-reader-toolbar">
              <div
                className="ai-reader-mode-tabs"
                role="tablist"
                aria-label="修改建议视图"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={editView === "diff"}
                  className={editView === "diff" ? "is-active" : ""}
                  onClick={() => setEditView("diff")}
                >
                  <FileDiff size={14} />
                  对比
                  {diff && (
                    <span className="ai-diff-stats">
                      <em className="is-add">+{diff.added}</em>
                      <em className="is-del">-{diff.removed}</em>
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={editView === "preview"}
                  className={editView === "preview" ? "is-active" : ""}
                  onClick={() => setEditView("preview")}
                >
                  <FileText size={14} />
                  预览
                </button>
              </div>
              <button
                type="button"
                className={`icon-button ai-reader-copy-btn ${copied ? "is-copied" : ""}`}
                title={copied ? "已复制" : "复制内容"}
                aria-label={copied ? "已复制" : "复制内容"}
                onClick={() => void handleCopy()}
              >
                {copied ? <Check size={15} /> : <Copy size={15} />}
              </button>
            </div>
          )}

          <div className="ai-reader-body">
            {editMeta.metaRows.length > 0 && (
              <div className="ai-reader-meta-changes">
                {editMeta.metaRows.map((row) => (
                  <div key={row.label} className="ai-reader-meta-row">
                    <span className="ai-reader-meta-label">{row.label}</span>
                    <div className="ai-reader-meta-values">
                      <div className="is-old">
                        <small className="ai-meta-sign" aria-label="改前">
                          −
                        </small>
                        <span>{row.before || "（空）"}</span>
                      </div>
                      <div className="is-new">
                        <small className="ai-meta-sign" aria-label="改后">
                          +
                        </small>
                        <span>{row.after}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {editMeta.afterText !== undefined &&
              (editView === "diff" && diff ? (
                <div className="ai-diff-view" role="region" aria-label="逐行变更对比">
                  {diff.lines.length === 0 ? (
                    <p className="muted">（空内容）</p>
                  ) : (
                    diff.lines.map((line, index) => (
                      <div
                        key={index}
                        className={`ai-diff-line is-${line.type}`}
                      >
                        <span className="ai-diff-gutter">
                          {line.type === "add"
                            ? "+"
                            : line.type === "remove"
                              ? "-"
                              : " "}
                        </span>
                        <span className="ai-diff-ln">
                          {line.newLine ?? line.oldLine ?? ""}
                        </span>
                        <span className="ai-diff-text">
                          {line.text || " "}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <div className="ai-reader-canvas">
                  {editMeta.afterText.trim() ? (
                    <Markdown>{editMeta.afterText}</Markdown>
                  ) : (
                    <p className="muted">（建议清空原有内容）</p>
                  )}
                </div>
              ))}
          </div>

          <div className="ai-reader-footer">
            <div className="ai-reader-footer-left">
              {editState === "ready" ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || applyingKey !== null}
                  onClick={() => void onApplyEdit(target.edit, target.keyId)}
                >
                  {applyingKey === target.keyId && (
                    <Loader2 size={14} className="spin" />
                  )}
                  {editMeta.applyLabel}
                </Button>
              ) : (
                <span className="muted small" role="status">
                  {editState === "matched"
                    ? "已应用"
                    : editState === "stale"
                      ? "原题已改动，请重新让 AI 生成"
                      : "仅自有文件夹支持直接应用"}
                </span>
              )}
            </div>
            <Button type="button" size="sm" variant="ghost" onClick={onClose}>
              关闭
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
