"use client";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  ArrowLeft,
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
import { markdownDocument } from "@/lib/markdown-source";
import { studyDocument } from "@/lib/study-document";
import { readPracticeDraft, savePracticeDraft } from "@/lib/drafts";
import {
  sourceSelection,
  markAsFollowup,
  replaceWithBlock,
} from "@/lib/editor-document";
import type { Mutate } from "./dialogs";
import type { ImportSeed } from "./import-dialog";
import { Button } from "./ui/button";
import { Markdown, ObsidianProperties } from "./markdown";
import "./question-edit-page.css";

const Editor = dynamic(() => import("./editor").then((m) => m.Editor), {
  ssr: false,
  loading: () => <div className="editor-loading">正在加载编辑器…</div>,
});
type Draft = {
  title: string;
  answer: string;
  tags: string;
  major: boolean;
  baseRevision: number;
  pasted: boolean;
  keepWhole: boolean;
};
const needsSource = (source: string) =>
  /^\uFEFF?---\r?\n|\[!\w+\]|\[\[|\$[^\n]+\$|\$\$[\s\S]+?\$\$/.test(source);

export function QuestionEditPage({
  question,
  current,
  userId,
  mutate,
  onBack,
  onSaved,
  onBatchImport,
}: {
  question: QuestionView;
  current?: QuestionView;
  userId: string;
  mutate: Mutate;
  onBack: () => void;
  onSaved: () => void;
  onBatchImport: (seed: ImportSeed, onCommitted: () => void) => void;
}) {
  const initial: Draft = {
    title: question.title,
    answer: question.answer,
    tags: question.tags.join(", "),
    major: false,
    baseRevision: question.revision,
    pasted: false,
    keepWhole: false,
  };
  const [draft, setDraft] = useState<Draft>(initial);
  const [loaded, setLoaded] = useState(false);
  const [restored, setRestored] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"document" | "source">(
    needsSource(question.answer) ? "source" : "document",
  );
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewTab, setPreviewTab] = useState<"body" | "followups">("body");
  const [markUndo, setMarkUndo] = useState<{
    before: string;
    after: string;
  } | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const titleInput = useRef<HTMLTextAreaElement>(null);
  const saved = useRef(false);
  const latest = useRef(draft);
  latest.current = draft;
  const key = `shiyi:editor:${userId}:${question.id}`;
  const base = current?.revision === draft.baseRevision ? current : question;
  const dirty =
    draft.title !== base.title ||
    draft.answer !== base.answer ||
    draft.tags !== base.tags.join(", ") ||
    draft.major;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const text = useDeferredValue(draft.answer);
  const analyzing = text !== draft.answer;
  const analysis = useMemo(
    () => ({
      view: studyDocument(text, draft.title),
      questions: parseQuestions(text, "qa", { preserveSource: true }),
      meta: markdownDocument(text),
    }),
    [text, draft.title],
  );
  const tags = useMemo(
    () => [
      ...new Set(
        draft.tags
          .split(/[,，]/)
          .map((tag) => tag.trim().replace(/^#+/, ""))
          .filter(Boolean),
      ),
    ],
    [draft.tags],
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
  const conflict = !!current && current.revision !== draft.baseRevision;
  const multiple =
    draft.pasted && analysis.questions.length > 1 && !draft.keepWhole;
  function patch(value: Partial<Draft>) {
    setDraft((before) => ({
      ...before,
      // 确认只针对当前内容；继续修改后，应重新确认多题划分。
      ...(value.answer !== undefined && value.answer !== before.answer
        ? { keepWhole: false }
        : {}),
      ...value,
    }));
    setError("");
  }
  useEffect(() => {
    try {
      const value = JSON.parse(
        readPracticeDraft(key) || "null",
      ) as Draft | null;
      if (
        value &&
        typeof value.title === "string" &&
        typeof value.answer === "string" &&
        value.answer.length <= 100_000 &&
        typeof value.tags === "string" &&
        typeof value.major === "boolean" &&
        Number.isInteger(value.baseRevision) &&
        value.baseRevision > 0
      ) {
        if (
          value.title !== question.title ||
          value.answer !== question.answer ||
          value.tags !== question.tags.join(", ") ||
          value.major
        ) {
          setDraft({
            ...value,
            // 旧草稿没有粘贴状态，也需重新检查多题，防止重新打开后绕过确认。
            pasted: value.pasted ?? true,
            keepWhole: value.keepWhole === true,
          });
          setMode(needsSource(value.answer) ? "source" : "document");
          setRestored(true);
        } else savePracticeDraft(key, "");
      }
    } catch {
      /* Ignore a malformed local draft without replacing server content. */
    }
    setLoaded(true);
    setPreviewOpen(window.innerWidth > 1000);
    return () => {
      if (!saved.current && dirtyRef.current)
        savePracticeDraft(key, JSON.stringify(latest.current));
    };
  }, [key]);
  useEffect(() => {
    if (titleInput.current) {
      titleInput.current.style.height = "auto";
      titleInput.current.style.height = `${titleInput.current.scrollHeight}px`;
    }
  }, [draft.title, loaded]);
  useEffect(() => {
    if (!loaded || saved.current) return;
    const timer = setTimeout(
      () =>
        setStorageError(
          !savePracticeDraft(key, dirty ? JSON.stringify(draft) : ""),
        ),
      250,
    );
    return () => clearTimeout(timer);
  }, [draft, dirty, key, loaded]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (busy || (dirty && storageError)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty, storageError, busy]);
  function leave() {
    if (busy) return;
    if (
      storageError &&
      dirty &&
      !confirm("草稿未能保存在浏览器，离开会丢失未保存的修改。仍要离开？")
    )
      return;
    onBack();
  }
  function wholePaste(value: string) {
    if (value.length > 100_000 || value.includes("\0")) {
      setError("内容超过 10 万字符或含无效字符，请分批粘贴。");
      return;
    }
    patch({ answer: value, pasted: true, keepWhole: false });
    setMode("source");
  }
  function addFollowup() {
    const element = textarea.current;
    const { to: position } =
      mode === "source" && element
        ? sourceSelection(
            draft.answer,
            element.selectionStart,
            element.selectionEnd,
          )
        : { to: draft.answer.length };
    const template = "## 追问\nQ：\nA：";
    // “插入”放在选区后，避免用空模板替换掉用户选中的原文。
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
      textarea.current?.focus();
      textarea.current?.setSelectionRange(cursor, cursor);
    });
  }

  function markSelection() {
    const element = textarea.current;
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
  async function save(merged = false) {
    if (
      invalid ||
      busy ||
      analyzing ||
      !current ||
      (conflict && !merged) ||
      multiple
    )
      return;
    setBusy(true);
    setError("");
    try {
      const result = await mutate("/api/questions", {
        action: "edit",
        id: question.id,
        expectedRevision: merged ? current.revision : draft.baseRevision,
        title: draft.title,
        answer: draft.answer,
        tags,
        major: draft.major,
      });
      if (result) {
        saved.current = true;
        savePracticeDraft(key, "");
        onSaved();
      } else setError("没有保存成功，当前草稿已保留。");
    } finally {
      setBusy(false);
    }
  }
  const single = analysis.questions[0];
  if (!loaded)
    return (
      <div className="page question-editor-page">
        <div className="view-loading">
          <Loader2 className="spin" size={20} />
        </div>
      </div>
    );
  return (
    <div
      className="page question-editor-page"
      data-preview={previewOpen ? "open" : "closed"}
    >
      <header className="question-editor-heading">
        <div>
          <button className="back-link" onClick={leave} disabled={busy}>
            <ArrowLeft size={16} />
            返回学习
          </button>
          <h1>编辑题目</h1>
        </div>
        <div className="editor-heading-actions">
          <span className={storageError ? "form-error" : "muted"}>
            {storageError ? "本地草稿保存失败" : dirty ? "本地草稿" : "已保存"}
          </span>
          <Button
            disabled={
              invalid || busy || analyzing || !current || conflict || multiple
            }
            onClick={() => void save()}
          >
            {busy ? (
              <Loader2 size={16} className="spin" />
            ) : (
              <Check size={16} />
            )}
            保存修改
          </Button>
        </div>
      </header>
      {!current && (
        <p className="editor-notice" role="alert">
          题目已删除或不可访问，草稿仍保留在本机。
        </p>
      )}
      {restored && (
        <div className="editor-notice">
          已恢复上次未保存的草稿。
          <button
            className="text-button"
            disabled={busy}
            onClick={() => {
              const q = current ?? question;
              setDraft({
                title: q.title,
                answer: q.answer,
                tags: q.tags.join(", "),
                major: false,
                baseRevision: q.revision,
                pasted: false,
                keepWhole: false,
              });
              setRestored(false);
              savePracticeDraft(key, "");
            }}
          >
            放弃草稿
          </button>
        </div>
      )}
      {conflict && (
        <div className="editor-conflict" role="alert">
          <strong>题目已在其他页面更新，草稿已保留。</strong>
          <details>
            <summary>查看当前保存的版本</summary>
            <h3>{current.title}</h3>
            <Markdown>{current.answer}</Markdown>
          </details>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || analyzing || invalid || multiple}
            onClick={() => void save(true)}
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
      <div className="editor-title-field">
        <textarea
          ref={titleInput}
          rows={1}
          aria-label="题目"
          value={draft.title}
          maxLength={200}
          placeholder="输入清晰、完整的面试题干（最多 200 字）"
          disabled={busy}
          onChange={(e) => patch({ title: e.target.value })}
        />
      </div>
      <div className="editor-view-controls">
        <div className="editor-modes" role="group" aria-label="编辑方式">
          <button
            aria-pressed={mode === "document"}
            disabled={busy}
            onClick={() => setMode("document")}
          >
            <PencilLine size={14} />
            文档
          </button>
          <button
            aria-pressed={mode === "source"}
            disabled={busy}
            onClick={() => setMode("source")}
          >
            <FileText size={14} />
            原文
          </button>
        </div>
        {mode === "source" && (
          <button
            className="text-button editor-source-action"
            disabled={busy}
            onClick={markSelection}
          >
            <MessageSquarePlus size={15} />
            指定追问
          </button>
        )}
        <button
          className="text-button editor-source-action"
          disabled={busy}
          onClick={addFollowup}
        >
          <MessageSquarePlus size={15} />
          插入追问
        </button>
        {markUndo && markUndo.after === draft.answer && (
          <button
            className="text-button editor-source-action"
            disabled={busy}
            onClick={() => {
              patch({ answer: markUndo.before });
              setMarkUndo(null);
            }}
          >
            <Undo2 size={14} />
            撤销指定
          </button>
        )}
        <button
          className="text-button editor-preview-toggle"
          onClick={() => setPreviewOpen(!previewOpen)}
        >
          <Eye size={15} />
          {previewOpen ? "专注编辑" : "查看预览"}
        </button>
        <span className="editor-detected-count">
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
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() =>
              onBatchImport(
                {
                  raw: draft.answer,
                  deckId: current?.deckId ?? null,
                  editQuestion: {
                    id: question.id,
                    title: draft.title,
                    revision: draft.baseRevision,
                    major: draft.major,
                    tags,
                  },
                },
                () => {
                  saved.current = true;
                  savePracticeDraft(key, "");
                  onSaved();
                },
              )
            }
          >
            预览切分
          </Button>
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
              className="text-button"
              onClick={() => {
                patch({ title: single.title, pasted: false });
              }}
            >
              采用这个标题
            </button>
            <button
              className="text-button"
              onClick={() => patch({ pasted: false })}
            >
              保留原标题
            </button>
          </div>
        )}
      <div
        className={`question-editor-grid ${previewOpen ? "show-preview" : "hide-preview"}`}
      >
        <section
          className="question-editor-writing"
          aria-label="统一内容编辑区"
        >
          {mode === "source" ? (
            <textarea
              ref={textarea}
              aria-label="题目原文"
              spellCheck={false}
              value={draft.answer}
              maxLength={100000}
              disabled={busy}
              onChange={(e) => patch({ answer: e.target.value })}
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
              placeholder="支持完整 Markdown 编写参考答案与代码示例；若想生成抽认追问卡，可点上方「插入追问」或选中一段问答点击「指定追问」，也支持直接整篇粘贴面经资料自动识别。"
            />
          ) : (
            <Editor
              key={`document:${question.id}`}
              disabled={busy}
              value={draft.answer}
              onChange={(answer) => patch({ answer })}
              onWholePaste={wholePaste}
              onPartialPaste={() => patch({ pasted: true, keepWhole: false })}
              onSelectionRequired={() =>
                setError("先选中一段问答，再指定为追问。")
              }
            />
          )}
        </section>
        <aside className="question-editor-preview" aria-label="学习预览">
          <div
            className="editor-preview-tabs"
            role="tablist"
            aria-label="预览内容"
          >
            <button
              role="tab"
              aria-selected={previewTab === "body"}
              onClick={() => setPreviewTab("body")}
            >
              正文
            </button>
            <button
              role="tab"
              aria-selected={previewTab === "followups"}
              onClick={() => setPreviewTab("followups")}
            >
              追问 {analysis.view.followups.length}
            </button>
            <span>预览</span>
          </div>
          {analysis.view.unresolvedFollowups > 0 && (
            <p className="editor-notice">
              有 {analysis.view.unresolvedFollowups}{" "}
              处追问尚未配齐问答，仍保留在正文。
            </p>
          )}
          <div className="editor-preview-content">
            {previewTab === "body" ? (
              <Markdown>
                {analysis.view.blocks
                  .map((block) => block.markdown)
                  .join("\n\n") +
                  "\n\n" +
                  analysis.view.references}
              </Markdown>
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
                尚未识别到面试追问。点击上方「插入追问」快速添加问答模板，或在原文中选中一段 Q/A
                后点击「指定追问」。
              </p>
            )}
          </div>
        </aside>
      </div>
      <details className="editor-extra">
        <summary>标签与复习提醒</summary>
        <label className="field">
          标签
          <input
            aria-label="标签"
            value={draft.tags}
            disabled={busy}
            placeholder="例如：高频, React, 并发（用逗号分隔，最多 12 个）"
            onChange={(e) => patch({ tags: e.target.value })}
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
                const merged = Array.from(
                  new Set([...tags, ...unsyncedFrontmatterTags]),
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
              source={text}
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
    </div>
  );
}
