"use client";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  Check,
  Eye,
  FileText,
  Loader2,
  MessageSquarePlus,
  PencilLine,
  Undo2,
} from "lucide-react";
import type { QuestionView } from "@/lib/types";
import { parseQuestions } from "@/lib/importer";
import { markdownDocument, mergeQuestionTags } from "@/lib/markdown-source";
import { studyDocument } from "@/lib/study-document";
import {
  markAsFollowup,
  replaceWithBlock,
  sourceSelection,
} from "@/lib/editor-document";
import type { ImportSeed } from "./import-dialog";
import { Markdown, ObsidianProperties } from "./markdown";
import { Button } from "./ui/button";

const Editor = dynamic(() => import("./editor").then((m) => m.Editor), {
  ssr: false,
  loading: () => <div className="editor-loading">正在加载编辑器…</div>,
});

export type InlineQuestionDraft = {
  title: string;
  answer: string;
  tags: string;
  major: boolean;
  baseRevision: number;
  pasted: boolean;
  keepWhole: boolean;
};

export function InlineAnswerEditor({
  question,
  draft,
  patch,
  tags,
  dirty,
  busy,
  error,
  setError,
  storageError,
  restored,
  onDiscardDraft,
  onCancel,
  onSave,
  onBatchImport,
  onCommittedImport,
}: {
  question: QuestionView;
  draft: InlineQuestionDraft;
  patch: (partial: Partial<InlineQuestionDraft>) => void;
  tags: string[];
  dirty: boolean;
  busy: boolean;
  error: string;
  setError: (msg: string) => void;
  storageError: boolean;
  restored: boolean;
  onDiscardDraft: () => void;
  onCancel: () => void;
  onSave: (merged?: boolean) => Promise<void>;
  onBatchImport?: (seed: ImportSeed, onCommitted: () => void) => void;
  onCommittedImport: () => void;
}) {
  const [mode, setMode] = useState<"source" | "document" | "preview">("source");
  const [previewTab, setPreviewTab] = useState<"body" | "followups">("body");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [markUndo, setMarkUndo] = useState<{
    before: string;
    after: string;
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!confirmDiscard) return;
    const timer = window.setTimeout(() => setConfirmDiscard(false), 3500);
    return () => window.clearTimeout(timer);
  }, [confirmDiscard]);

  useEffect(() => {
    requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true });
    });
  }, []);

  const deferredAnswer = useDeferredValue(draft.answer);
  const analyzing = deferredAnswer !== draft.answer;
  const analysis = useMemo(
    () => ({
      view: studyDocument(deferredAnswer, draft.title),
      questions: parseQuestions(deferredAnswer, "qa", { preserveSource: true }),
      meta: markdownDocument(deferredAnswer),
    }),
    [deferredAnswer, draft.title],
  );
  const unsyncedFrontmatterTags = useMemo(
    () => analysis.meta.tags.filter((tag) => !tags.includes(tag)),
    [analysis.meta.tags, tags],
  );

  const invalid =
    !draft.title.trim() ||
    draft.title.length > 200 ||
    draft.answer.length > 100_000 ||
    tags.length > 12 ||
    tags.some((tag) => tag.length > 30);
  const conflict = question.revision !== draft.baseRevision;
  const multiple =
    draft.pasted && analysis.questions.length > 1 && !draft.keepWhole;
  const single = analysis.questions[0];

  function wholePaste(value: string) {
    if (value.length > 100_000 || value.includes("\0")) {
      setError("内容超过 10 万字符或含无效字符，请分批粘贴。");
      return;
    }
    patch({ answer: value, pasted: true, keepWhole: false });
    setMode("source");
  }

  function addFollowup() {
    const element = textareaRef.current;
    const { to: position } =
      mode === "source" && element
        ? sourceSelection(
            draft.answer,
            element.selectionStart,
            element.selectionEnd,
          )
        : { to: draft.answer.length };
    const template = "## 追问\nQ：\nA：";
    const answer = replaceWithBlock(draft.answer, position, position, template);
    patch({ answer });
    setMode("source");
    const cursor = answer
      .slice(
        0,
        answer.indexOf(template, position) + template.indexOf("Q：") + 2,
      )
      .replace(/\r\n?/g, "\n").length;
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(cursor, cursor);
    });
  }

  function markSelection() {
    const element = textareaRef.current;
    if (!element || element.selectionStart === element.selectionEnd) {
      setError("先选中一段问答，再指定为追问。");
      return;
    }
    const { from, to } = sourceSelection(
      draft.answer,
      element.selectionStart,
      element.selectionEnd,
    );
    const marked = markAsFollowup(draft.answer.slice(from, to));
    const answer = replaceWithBlock(draft.answer, from, to, marked);
    if (answer.length > 100_000) {
      setError("标记后超过 10 万字符，请先缩短内容。");
      return;
    }
    setMarkUndo({ before: draft.answer, after: answer });
    patch({ answer });
  }

  return (
    <section className="inline-answer-editor" aria-label="原地编辑答案">
      {restored && (
        <div className="editor-notice">
          已恢复上次未保存的草稿。
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={onDiscardDraft}
          >
            放弃草稿
          </button>
        </div>
      )}

      {conflict && (
        <div className="editor-conflict" role="alert">
          <strong>题目已在其他页面更新，当前草稿已保留。</strong>
          <details>
            <summary>查看当前云端保存版本</summary>
            <h3>{question.title}</h3>
            <Markdown>{question.answer}</Markdown>
          </details>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || analyzing || invalid || multiple}
            onClick={() => void onSave(true)}
          >
            已合并，保存到新版本
          </Button>
        </div>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <div className="inline-editor-toolbar">
        <div className="editor-modes" role="group" aria-label="编辑方式">
          <button
            type="button"
            aria-pressed={mode === "source"}
            disabled={busy}
            onClick={() => setMode("source")}
          >
            <FileText size={14} /> 原文
          </button>
          <button
            type="button"
            aria-pressed={mode === "document"}
            disabled={busy}
            onClick={() => setMode("document")}
          >
            <PencilLine size={14} /> 文档
          </button>
          <button
            type="button"
            aria-pressed={mode === "preview"}
            disabled={busy}
            onClick={() => setMode("preview")}
          >
            <Eye size={14} /> 预览
          </button>
        </div>
        {mode === "source" && (
          <>
            <button
              type="button"
              className="text-button editor-source-action"
              disabled={busy}
              onClick={markSelection}
            >
              <MessageSquarePlus size={14} /> 指定追问
            </button>
            <button
              type="button"
              className="text-button editor-source-action"
              disabled={busy}
              onClick={addFollowup}
            >
              <MessageSquarePlus size={14} /> 插入追问
            </button>
          </>
        )}
        {markUndo && markUndo.after === draft.answer && (
          <button
            type="button"
            className="text-button editor-source-action"
            disabled={busy}
            onClick={() => {
              patch({ answer: markUndo.before });
              setMarkUndo(null);
            }}
          >
            <Undo2 size={14} /> 撤销指定
          </button>
        )}
        <span className="inline-editor-detected">
          正文 {analysis.view.blocks.filter((b) => b.practice).length} 段 · 追问{" "}
          {analysis.view.followups.length}
        </span>
      </div>

      {multiple && !analyzing && (
        <div className="editor-paste-review">
          <span>
            识别到 {analysis.questions.length} 道主问题，请先确认粘贴方式。
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => patch({ keepWhole: true })}
          >
            保留为当前一题
          </Button>
          {onBatchImport && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() =>
                onBatchImport(
                  {
                    raw: draft.answer,
                    deckId: question.deckId,
                    editQuestion: {
                      id: question.id,
                      title: draft.title,
                      revision: draft.baseRevision,
                      major: draft.major,
                      tags,
                    },
                  },
                  onCommittedImport,
                )
              }
            >
              预览切分
            </Button>
          )}
        </div>
      )}

      {!multiple &&
        draft.pasted &&
        analysis.questions.length === 1 &&
        single &&
        single.title !== draft.title &&
        /^\uFEFF?\s*#{1,3}\s/.test(draft.answer) &&
        single.title.length <= 200 && (
          <div className="editor-paste-review">
            <span>检测到题目：{single.title}</span>
            <button
              type="button"
              className="text-button"
              onClick={() => patch({ title: single.title, pasted: false })}
            >
              采用这个标题
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => patch({ pasted: false })}
            >
              保留原标题
            </button>
          </div>
        )}

      <div className="inline-editor-surface">
        {mode === "source" ? (
          <textarea
            ref={textareaRef}
            aria-label="题目原文"
            spellCheck={false}
            rows={14}
            value={draft.answer}
            maxLength={100_000}
            disabled={busy}
            onChange={(e) => {
              setConfirmDiscard(false);
              patch({ answer: e.target.value });
            }}
            onKeyDown={(e) => {
              if (
                (e.ctrlKey || e.metaKey) &&
                (e.key === "Enter" || e.key.toLowerCase() === "s") &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                if (
                  !invalid &&
                  !busy &&
                  !analyzing &&
                  !conflict &&
                  !multiple &&
                  dirty
                ) {
                  void onSave();
                }
              }
            }}
            onPaste={(e) => {
              const value = e.clipboardData.getData("text/plain");
              if (
                value &&
                (draft.answer.length -
                  (e.currentTarget.selectionEnd -
                    e.currentTarget.selectionStart) +
                  value.length >
                  100_000 ||
                  value.includes("\0"))
              ) {
                e.preventDefault();
                setError("内容超过 10 万字符或含无效字符，请分批粘贴。");
                return;
              }
              if (
                value &&
                (!draft.answer.trim() ||
                  (e.currentTarget.selectionStart === 0 &&
                    e.currentTarget.selectionEnd ===
                      e.currentTarget.value.length))
              ) {
                e.preventDefault();
                wholePaste(value);
              } else if (/\n|\r/.test(value)) {
                patch({ pasted: true, keepWhole: false });
              }
            }}
            placeholder="支持完整 Markdown 编写参考答案与代码示例；可用「插入追问」生成抽认卡，或直接粘贴面经资料自动识别。"
          />
        ) : mode === "document" ? (
          <Editor
            key={`inline-doc:${question.id}`}
            disabled={busy}
            value={draft.answer}
            onChange={(answer) => {
              setConfirmDiscard(false);
              patch({ answer });
            }}
            onWholePaste={wholePaste}
            onPartialPaste={() => patch({ pasted: true, keepWhole: false })}
            onSelectionRequired={() =>
              setError("先选中一段问答，再指定为追问。")
            }
          />
        ) : (
          <div className="inline-editor-preview">
            <div
              className="editor-preview-tabs"
              role="tablist"
              aria-label="预览内容"
            >
              <button
                type="button"
                role="tab"
                aria-selected={previewTab === "body"}
                onClick={() => setPreviewTab("body")}
              >
                正文
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={previewTab === "followups"}
                onClick={() => setPreviewTab("followups")}
              >
                追问 {analysis.view.followups.length}
              </button>
            </div>
            {analysis.view.unresolvedFollowups > 0 && (
              <p className="editor-notice">
                有 {analysis.view.unresolvedFollowups}{" "}
                处追问尚未配齐问答，仍保留在正文。
              </p>
            )}
            <div className="editor-preview-content">
              {previewTab === "body" ? (
                draft.answer.trim() ? (
                  <Markdown>
                    {analysis.view.blocks
                      .map((block) => block.markdown)
                      .join("\n\n") +
                      "\n\n" +
                      analysis.view.references}
                  </Markdown>
                ) : (
                  <p className="quiet-empty">尚未输入参考答案内容。</p>
                )
              ) : analysis.view.followups.length ? (
                analysis.view.followups.map((item, index) => (
                  <article className="editor-followup-preview" key={item.id}>
                    <span className="card-number">
                      Q{String(index + 1).padStart(2, "0")}
                    </span>
                    <Markdown>{item.question}</Markdown>
                    <div>
                      <Markdown>{item.answer}</Markdown>
                    </div>
                  </article>
                ))
              ) : (
                <p className="quiet-empty">
                  尚未识别到面试追问。可在「原文」用「插入追问」快速添加问答模板。
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      <details className="inline-editor-extra">
        <summary>标签与复习提醒</summary>
        <label className="field">
          标签
          <input
            aria-label="标签"
            value={draft.tags}
            disabled={busy}
            placeholder="例如：高频, React, 并发（用逗号分隔，最多 12 个）"
            onChange={(e) => {
              setConfirmDiscard(false);
              patch({ tags: e.target.value });
            }}
          />
        </label>
        {tags.length > 0 && (
          <div className="editor-tag-chips" aria-label="已选标签">
            {tags.map((tag) => (
              <button
                key={tag}
                type="button"
                className="editor-tag-chip"
                disabled={busy}
                aria-label={`移除标签 ${tag}`}
                onClick={() =>
                  patch({
                    tags: tags.filter((item) => item !== tag).join(", "),
                  })
                }
              >
                <span>#{tag}</span>
                <span aria-hidden="true">×</span>
              </button>
            ))}
          </div>
        )}
        {unsyncedFrontmatterTags.length > 0 && (
          <div className="editor-tag-sync">
            <span>
              正文 Obsidian 笔记属性包含标签：
              {unsyncedFrontmatterTags.map((t) => `#${t}`).join(" ")}
            </span>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => {
                const merged = mergeQuestionTags(
                  tags,
                  unsyncedFrontmatterTags,
                ).slice(0, 12);
                patch({ tags: merged.join(", ") });
              }}
            >
              从笔记属性同步标签 (+{unsyncedFrontmatterTags.length})
            </button>
          </div>
        )}
        {(analysis.meta.properties.length > 0 ||
          analysis.meta.tags.length > 0) && (
          <div className="editor-obsidian-properties">
            <ObsidianProperties
              source={deferredAnswer}
              includeTags
              defaultExpanded={false}
            />
          </div>
        )}
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={draft.major}
            disabled={busy}
            onChange={(e) => patch({ major: e.target.checked })}
          />
          重要修正，提醒重新复习
        </label>
      </details>

      <div className="inline-editor-footer">
        <span className={storageError ? "form-error-inline" : "muted"}>
          {storageError
            ? "本地草稿保存失败"
            : dirty
              ? "未保存修改 · Ctrl/⌘ + S 保存"
              : "未修改"}
        </span>
        <div className="inline-editor-actions">
          <Button
            type="button"
            variant={confirmDiscard ? "danger" : "ghost"}
            size="sm"
            disabled={busy}
            onClick={() => {
              if (!dirty) {
                onCancel();
                return;
              }
              if (!confirmDiscard) setConfirmDiscard(true);
              else {
                setConfirmDiscard(false);
                onCancel();
              }
            }}
          >
            {!dirty ? "取消" : confirmDiscard ? "确认放弃" : "放弃修改"}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={
              invalid || busy || analyzing || conflict || multiple || !dirty
            }
            onClick={() => void onSave()}
          >
            {busy ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <Check size={14} />
            )}
            保存修改
          </Button>
        </div>
      </div>
    </section>
  );
}
