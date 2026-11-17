"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  FileText,
  Loader2,
  Merge,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { api } from "@/lib/client";
import { readPracticeDraft, savePracticeDraft } from "@/lib/drafts";
import type { ImportType } from "@/lib/importer";
import type {
  ImportMethod,
  ImportPreview,
  ImportPreviewItem,
} from "@/lib/import-preview";
import type { Workspace } from "@/lib/types";
import type { Mutate } from "./dialogs";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

type Candidate = ImportPreviewItem & { selected: boolean };
export type ImportEditContext = {
  id: string;
  title: string;
  revision: number;
  major: boolean;
  tags: string[];
};
export type ImportSeed = {
  raw: string;
  deckId?: string | null;
  editQuestion?: ImportEditContext;
};
type SavedDraft = {
  raw: string;
  inputType: ImportType;
  method: ImportMethod;
  deckId: string;
  sourceName: string;
  batchId: string;
  signature: string;
  questions: Candidate[];
  replaceKey?: string;
};
export function ImportDialog({
  open,
  onClose,
  data,
  preferredDeck,
  mutate,
  onView,
  onInbox,
  onSettings,
  seed,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  data: Workspace;
  preferredDeck?: string | null;
  mutate: Mutate;
  onView: (id: string | null) => void;
  onInbox: () => void;
  onSettings: () => void;
  seed?: ImportSeed;
  onImported?: () => void;
}) {
  const own = data.decks.filter((d) => d.isOwner);
  const storage = `shiyi:import:${data.user.id}${seed?.editQuestion ? `:edit:${seed.editQuestion.id}` : ""}`;
  const [raw, setRaw] = useState("");
  const [inputType, setInputType] = useState<ImportType>("qa");
  const [method, setMethod] = useState<ImportMethod>("rules");
  const [deckId, setDeckId] = useState(
    preferredDeck === null ? "" : (preferredDeck ?? own[0]?.id ?? ""),
  );
  const [sourceName, setSourceName] = useState("");
  const [questions, setQuestions] = useState<Candidate[]>([]);
  const [replaceKey, setReplaceKey] = useState("");
  const [undo, setUndo] = useState<{
    questions: Candidate[];
    replaceKey: string;
  } | null>(null);
  const [batchId, setBatchId] = useState("");
  const [previewSignature, setPreviewSignature] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [result, setResult] = useState<{
    added: number;
    duplicates: number;
    updated: number;
  } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const committing = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const signature = useMemo(
    () => JSON.stringify([raw, inputType, method, deckId, sourceName]),
    [raw, inputType, method, deckId, sourceName],
  );
  const stale = !!batchId && signature !== previewSignature;
  const selected = questions.filter((q) => q.selected);
  const invalid =
    selected.some(
      (q) =>
        !q.title.trim() || q.title.length > 200 || q.answer.length > 100_000,
    ) ||
    (!!replaceKey && !selected.some((q) => q.key === replaceKey));
  useEffect(() => {
    try {
      const saved = JSON.parse(
        readPracticeDraft(`${storage}:review`) || "null",
      ) as SavedDraft | null;
      if (
        saved &&
        (!seed || saved.raw === seed.raw) &&
        typeof saved.raw === "string" &&
        saved.raw.length <= 100_000 &&
        ["qa", "questions"].includes(saved.inputType) &&
        ["rules", "ai", "whole"].includes(saved.method) &&
        Array.isArray(saved.questions) &&
        saved.questions.length <= 200 &&
        saved.questions.every(
          (q) =>
            typeof q.key === "string" &&
            typeof q.title === "string" &&
            typeof q.answer === "string" &&
            Array.isArray(q.tags),
        )
      ) {
        setRaw(saved.raw);
        setInputType(saved.inputType);
        setMethod(saved.method);
        setSourceName(saved.sourceName || "");
        if (!saved.deckId || own.some((d) => d.id === saved.deckId))
          setDeckId(saved.deckId);
        setBatchId(saved.batchId);
        setPreviewSignature(saved.signature);
        setQuestions(saved.questions);
        setReplaceKey(saved.replaceKey ?? "");
      } else if (seed) {
        setRaw(seed.raw);
        setInputType("qa");
        setMethod("rules");
      } else {
        setRaw(readPracticeDraft(storage));
        setInputType(
          readPracticeDraft(`${storage}:type`) === "questions"
            ? "questions"
            : "qa",
        );
      }
    } catch {
      setRaw(readPracticeDraft(storage));
    }
    setLoaded(true);
    return () => {
      controller.current?.abort();
      controller.current = null;
    };
  }, [storage]);
  useEffect(() => {
    if (!loaded || result) return;
    savePracticeDraft(storage, raw);
    savePracticeDraft(`${storage}:type`, inputType);
    savePracticeDraft(
      `${storage}:review`,
      JSON.stringify({
        raw,
        inputType,
        method,
        deckId,
        sourceName,
        batchId,
        signature: previewSignature,
        questions,
        replaceKey,
      } satisfies SavedDraft),
    );
  }, [
    loaded,
    raw,
    inputType,
    method,
    deckId,
    sourceName,
    batchId,
    previewSignature,
    questions,
    replaceKey,
    result,
    storage,
  ]);
  useEffect(() => {
    if (loaded && seed && !batchId && method === "rules") {
      const timer = setTimeout(() => void parse(), 0);
      return () => clearTimeout(timer);
    }
  }, [loaded, storage]);
  function stop() {
    const old = controller.current;
    controller.current = null;
    old?.abort();
    setBusy(false);
  }
  function close() {
    if (committing.current) return;
    stop();
    onClose();
  }
  async function parse() {
    if (controller.current || !raw.trim() || committing.current) return;
    if (method === "ai" && !data.settings.hasKey) {
      onSettings();
      return;
    }
    const next = new AbortController();
    controller.current = next;
    setBusy(true);
    setError("");
    setWarning("");
    setResult(null);
    try {
      const preview = await api<ImportPreview>(
        "/api/import/preview",
        {
          batchId: crypto.randomUUID(),
          deckId: deckId || null,
          raw,
          inputType,
          method,
          ...(sourceName ? { sourceName } : {}),
        },
        { userId: data.user.id, signal: next.signal },
      );
      if (controller.current !== next) return;
      setQuestions(preview.questions.map((q) => ({ ...q, selected: true })));
      if (seed?.editQuestion) {
        const matches = preview.questions.filter(
          (q) =>
            q.title.trim().replace(/\s+/g, " ").replace(/？/g, "?") ===
            seed
              .editQuestion!.title.trim()
              .replace(/\s+/g, " ")
              .replace(/？/g, "?"),
        );
        setReplaceKey(matches.length === 1 ? matches[0].key : "");
      }
      setBatchId(preview.batchId);
      setPreviewSignature(signature);
      setWarning(preview.warning);
      setUndo(null);
    } catch (e) {
      if (controller.current === next && !next.signal.aborted)
        setError(e instanceof Error ? e.message : "解析失败，请重试。");
    } finally {
      if (controller.current === next) {
        controller.current = null;
        setBusy(false);
      }
    }
  }
  async function commit() {
    if (!batchId || stale || !selected.length || invalid || committing.current)
      return;
    committing.current = true;
    setSaving(true);
    setError("");
    try {
      const saved = await mutate("/api/import/commit", {
        batchId,
        questions: selected.map(({ key, title, answer, tags }) => ({
          key,
          title,
          answer,
          // 切分仍在更新同一道题时，沿用编辑页的标签，而非清空成解析默认值。
          tags:
            key === replaceKey && seed?.editQuestion
              ? seed.editQuestion.tags
              : tags,
        })),
        ...(replaceKey && seed?.editQuestion
          ? {
              replace: {
                id: seed.editQuestion.id,
                key: replaceKey,
                expectedRevision: seed.editQuestion.revision,
                major: seed.editQuestion.major,
              },
            }
          : {}),
      });
      if (saved) {
        setResult({
          added: Number(saved.added),
          duplicates: Number(saved.duplicates),
          updated: Number(saved.updated ?? 0),
        });
        savePracticeDraft(storage, "");
        savePracticeDraft(`${storage}:review`, "");
        onImported?.();
      } else {
        setError("本次未能保存，预览和草稿已保留。");
      }
    } finally {
      committing.current = false;
      setSaving(false);
    }
  }
  function change(key: string, patch: Partial<Candidate>) {
    if (patch.selected === false && key === replaceKey) setReplaceKey("");
    setQuestions((items) =>
      items.map((q) => (q.key === key ? { ...q, ...patch } : q)),
    );
  }
  function remove(index: number) {
    if (questions[index]?.key === replaceKey) setReplaceKey("");
    setUndo({ questions, replaceKey });
    setQuestions((items) => items.filter((_, i) => i !== index));
  }
  function merge(index: number) {
    if (index < 1) return;
    const previous = questions[index - 1],
      current = questions[index];
    const title =
      inputType === "questions" && !previous.answer && !current.answer
        ? `${previous.title}；${current.title}`
        : previous.title;
    if (title.length > 200) {
      setError("合并后的题目超过 200 字，请先调整标题。");
      return;
    }
    if (current.key === replaceKey) setReplaceKey(previous.key);
    setUndo({ questions, replaceKey });
    setQuestions((items) =>
      items.flatMap((q, i) =>
        i === index
          ? []
          : i === index - 1
            ? [
                {
                  ...q,
                  title,
                  selected: q.selected || current.selected,
                  answer:
                    inputType === "questions" &&
                    !previous.answer &&
                    !current.answer
                      ? ""
                      : `${q.answer}\n\n## ${current.title}\n\n${current.answer}`,
                },
              ]
            : [q],
      ),
    );
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
      title="导入面试题"
      className="import-dialog import-workflow"
    >
      <div className="import-kind-tabs" role="tablist" aria-label="资料内容">
        {[
          ["qa", "题目与答案"],
          ["questions", "只有题目"],
        ].map(([id, label]) => (
          <button
            role="tab"
            aria-selected={inputType === id}
            key={id}
            disabled={busy || saving || !!result}
            onClick={() => {
              setInputType(id as ImportType);
              if (id === "questions" && method === "whole") setMethod("rules");
            }}
          >
            <FileText size={16} />
            {label}
          </button>
        ))}
      </div>
      <div className="import-workflow-options">
        <label className="field">
          保存到题库
          <select
            aria-label="保存到题库"
            value={deckId}
            disabled={busy || saving || !!result}
            onChange={(e) => setDeckId(e.target.value)}
          >
            <option value="">未分类</option>
            {own.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </select>
        </label>
        <div className="parse-methods" role="group" aria-label="解析方式">
          {(
            [
              ["rules", "自动切分"],
              ["ai", "AI 解析"],
              ...(inputType === "qa" ? [["whole", "整篇保留"]] : []),
            ] as [ImportMethod, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              aria-pressed={method === id}
              disabled={busy || saving || !!result}
              onClick={() => setMethod(id)}
            >
              {id === "ai" && <Sparkles size={14} />} {label}
            </button>
          ))}
        </div>
      </div>
      <div className="import-workflow-columns">
        <section className="import-source-pane">
          <div className="input-caption">
            <span>导入原文{sourceName ? ` · ${sourceName}` : ""}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || saving || !!result}
              onClick={() => fileInput.current?.click()}
            >
              <Upload size={13} />
              读取文件
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept=".md,.txt,text/plain,text/markdown"
              className="sr-only"
              aria-label="读取 Markdown 或文本文件"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  if (!/\.(md|txt)$/i.test(file.name) || file.size > 400_000)
                    throw new Error(
                      "请选择不超过 400 KB 的 .md 或 .txt 文件。",
                    );
                  const text = new TextDecoder("utf-8", {
                    fatal: true,
                    ignoreBOM: true,
                  }).decode(await file.arrayBuffer());
                  if (text.length > 100_000)
                    throw new Error("原文超过 10 万字符，请分批导入。");
                  setRaw(text);
                  setSourceName(file.name);
                  setError("");
                } catch (err) {
                  setError(
                    err instanceof TypeError
                      ? "请使用 UTF-8 编码的文本文件。"
                      : err instanceof Error
                        ? err.message
                        : "请使用 UTF-8 编码的文本文件。",
                  );
                }
                e.target.value = "";
              }}
            />
          </div>
          <textarea
            aria-label="面试资料"
            value={raw}
            maxLength={100000}
            disabled={busy || saving || !!result}
            placeholder={
              inputType === "questions"
                ? "每行一道题，也可以交给 AI 识别。\n\n什么是闭包？\n1. 为什么需要索引？"
                : "## 题目\n参考答案…\n\n## 下一道题\n参考答案…"
            }
            onChange={(e) => {
              setRaw(e.target.value);
              setSourceName("");
            }}
          />
          <div className="import-source-foot">
            <span>{raw.length.toLocaleString()} / 100,000</span>
            <span>解析后确认入库</span>
          </div>
        </section>
        <section className="import-review-pane">
          <div className="input-caption">
            <strong>确认题目</strong>
            <span>
              {questions.length
                ? `${selected.length} / ${questions.length} 道`
                : ""}
            </span>
            {undo && !result && (
              <button
                className="text-button"
                onClick={() => {
                  setQuestions(undo.questions);
                  setReplaceKey(undo.replaceKey);
                  setUndo(null);
                }}
              >
                <RotateCcw size={13} />
                撤销
              </button>
            )}
          </div>
          {stale && (
            <p className="import-notice">
              原文或解析方式已改变，请重新解析后保存。
            </p>
          )}
          {warning && <p className="import-notice">{warning}</p>}
          {seed?.editQuestion && !!questions.length && !result && (
            <label className="field import-replace-field">
              当前题的处理
              <select
                aria-label="当前题的处理"
                value={replaceKey}
                disabled={busy || saving}
                onChange={(e) => {
                  setReplaceKey(e.target.value);
                  if (e.target.value)
                    change(e.target.value, { selected: true });
                }}
              >
                <option value="">保留当前题，全部新增</option>
                {questions.map((q, i) => (
                  <option key={q.key} value={q.key}>
                    用第 {i + 1} 题更新当前题：{q.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="import-review-list">
            {questions.length ? (
              questions.map((q, i) => (
                <PreviewCard
                  key={q.key}
                  item={q}
                  index={i}
                  disabled={busy || saving || !!result}
                  onChange={(patch) => change(q.key, patch)}
                  onMerge={() => merge(i)}
                  onRemove={() => remove(i)}
                />
              ))
            ) : (
              <div className="preview-empty">
                <FileText size={32} />
                <p>
                  {busy
                    ? "正在识别题目…"
                    : "解析后在这里检查、修改和合并题目。"}
                </p>
              </div>
            )}
          </div>
          {!!batchId && !result && questions.length < 200 && (
            <button
              className="import-add-question text-button"
              onClick={() => {
                setUndo({ questions, replaceKey });
                setQuestions((items) => [
                  ...items,
                  {
                    key: crypto.randomUUID(),
                    title: "",
                    answer: "",
                    tags: [],
                    needsEditing: true,
                    sourceText: "",
                    selected: true,
                  },
                ]);
              }}
            >
              <Plus size={14} />
              添加题目
            </button>
          )}
        </section>
      </div>
      {error && (
        <p className="form-error import-error" role="alert">
          {error}
        </p>
      )}
      {method === "ai" && !data.settings.hasKey && (
        <p className="import-notice">
          先配置自己的 AI 连接。
          <button className="text-button" onClick={onSettings}>
            去配置
          </button>
        </p>
      )}
      {result && (
        <div className="import-result" role="status">
          <Check size={17} />
          {result.updated
            ? `已更新 ${result.updated} 道，新增 ${result.added} 道题`
            : `已入库 ${result.added} 道题`}
          {result.duplicates ? `，跳过 ${result.duplicates} 道重复内容` : ""}
          <button
            className="text-button"
            onClick={() => {
              close();
              if (selected.every((q) => !q.answer.trim())) onInbox();
              else onView(deckId || null);
            }}
          >
            {selected.every((q) => !q.answer.trim())
              ? "去补答案"
              : "去题库看看"}
            <ArrowRight size={14} />
          </button>
        </div>
      )}
      <div className="dialog-footer">
        {busy ? (
          <Button variant="ghost" onClick={stop}>
            停止解析
          </Button>
        ) : (
          <Button
            variant="outline"
            disabled={!raw.trim() || saving || !!result}
            onClick={() => void parse()}
          >
            {method === "ai" ? <Sparkles size={15} /> : <FileText size={15} />}{" "}
            {batchId ? "重新解析" : "解析并预览"}
          </Button>
        )}
        <Button
          disabled={
            !batchId ||
            stale ||
            !selected.length ||
            invalid ||
            busy ||
            saving ||
            !!result
          }
          onClick={() => void commit()}
        >
          {saving ? (
            <Loader2 size={15} className="spin" />
          ) : (
            <Check size={15} />
          )}
          {replaceKey ? "确认保存" : "确认入库"} {selected.length} 道
        </Button>
      </div>
    </Dialog>
  );
}

function PreviewCard({
  item,
  index,
  disabled,
  onChange,
  onMerge,
  onRemove,
}: {
  item: Candidate;
  index: number;
  disabled: boolean;
  onChange: (patch: Partial<Candidate>) => void;
  onMerge: () => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <article
      className={`import-review-card ${item.selected ? "" : "is-excluded"}`}
    >
      <div className="preview-card-heading">
        <input
          type="checkbox"
          checked={item.selected}
          disabled={disabled}
          aria-label={`选择第 ${index + 1} 题`}
          onChange={(e) => onChange({ selected: e.target.checked })}
        />
        <span>{String(index + 1).padStart(2, "0")}</span>
        <input
          aria-label={`第 ${index + 1} 题标题`}
          placeholder="输入题目"
          maxLength={200}
          value={item.title}
          disabled={disabled}
          onChange={(e) => onChange({ title: e.target.value })}
        />
        <button
          className="icon-button"
          aria-label={`合并第 ${index + 1} 题到上一题`}
          disabled={!index || disabled}
          onClick={onMerge}
        >
          <Merge size={14} />
        </button>
        <button
          className="icon-button"
          aria-label={`移除第 ${index + 1} 题`}
          disabled={disabled}
          onClick={onRemove}
        >
          <Trash2 size={14} />
        </button>
      </div>
      {item.title.length > 200 && (
        <p className="form-error">
          标题最多 200 字，请缩短标题，正文保留在原文中。
        </p>
      )}
      <button
        className="preview-answer-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {item.answer.trim()
          ? `${expanded ? "收起" : "编辑"}答案 · ${item.answer.length} 字`
          : "添加答案（可留空）"}
      </button>
      {expanded ? (
        <textarea
          aria-label={`第 ${index + 1} 题答案`}
          value={item.answer}
          disabled={disabled}
          maxLength={100000}
          onChange={(e) => onChange({ answer: e.target.value })}
        />
      ) : (
        item.answer && (
          <p className="preview-answer-snippet">{item.answer.slice(0, 120)}</p>
        )
      )}
    </article>
  );
}
