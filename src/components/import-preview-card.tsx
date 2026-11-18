"use client";
import { useId, useMemo, useState } from "react";
import {
  BadgeCheck,
  BookOpen,
  Check,
  ChevronDown,
  Loader2,
  Merge,
  MessageSquare,
  PencilLine,
  RotateCcw,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  applyCorrectionSpan,
  computeInlineDiff,
  PROOFREAD_CATEGORY_LABELS,
  type ProofreadCorrection,
} from "@/lib/ai-proofread";
import type { ImportPreviewItem } from "@/lib/import-preview";
import { markdownDocument, parseTagListInput } from "@/lib/markdown-source";
import { studyDocument } from "@/lib/study-document";
import { ActionMenu } from "./ui/action-menu";
import { Button } from "./ui/button";
import { Markdown, ObsidianProperties } from "./markdown";

export type ImportCandidate = Pick<
  ImportPreviewItem,
  "key" | "title" | "answer" | "tags"
> & {
  selected: boolean;
  batchId: string;
  proofreadStatus?: "checking" | "clean" | "has_issues";
  corrections?: ProofreadCorrection[];
};

export function ImportPreviewCard({
  item,
  index,
  expanded,
  replacing,
  disabled,
  onToggle,
  onChange,
  onMerge,
  onRemove,
}: {
  item: ImportCandidate;
  index: number;
  expanded: boolean;
  replacing: boolean;
  disabled: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<ImportCandidate>) => void;
  onMerge?: () => void;
  onRemove: () => void;
}) {
  const detailsId = useId();
  const [editing, setEditing] = useState(!item.title);
  const [tagsText, setTagsText] = useState(() => item.tags.join(", "));
  const [fullBody, setFullBody] = useState(false);
  const [openFollowup, setOpenFollowup] = useState<string | null>(null);
  const noteMeta = useMemo(() => markdownDocument(item.answer), [item.answer]);
  const corrections = item.corrections ?? [];
  const pendingCorrections = corrections.filter((c) => c.status === "pending");
  const appliedCorrections = corrections.filter((c) => c.status === "applied");
  const previewSource = expanded && editing ? "" : item.answer;
  // 预览和学习页从同一份内容识别追问，提交时仍保存这份可编辑的文档。
  const view = useMemo(
    () =>
      previewSource.trim() ? studyDocument(previewSource, item.title) : null,
    [previewSource, item.title],
  );
  const followups = view?.followups ?? [];
  const body = view?.blocks.length ? view.bodyMarkdown : "";
  const longBody =
    body.length > 420 || body.split(/\r\n?|\n/, 12).length === 12;
  const compact = longBody && !fullBody;
  const firstParagraph =
    view?.blocks.find((block) => block.type === "paragraph")?.markdown ?? "";
  const bodyPreview = compact
    ? firstParagraph.length <= 240
      ? firstParagraph
      : ""
    : body;
  const references = view?.references ? `\n\n${view.references}` : "";
  const position = index + 1;
  const title = item.title.trim() || "未命名题目";
  function updateCorrection(
    targetId: string,
    status: ProofreadCorrection["status"],
    fieldPatch?: Partial<Pick<ImportCandidate, "title" | "answer">>,
  ) {
    onChange({
      ...fieldPatch,
      corrections: corrections.map((c) =>
        c.id === targetId ? { ...c, status } : c,
      ),
    });
  }

  function acceptCorrection(correction: ProofreadCorrection) {
    const currentText = item[correction.field];
    if (!currentText.includes(correction.original)) return;
    const nextText = applyCorrectionSpan(
      currentText,
      correction.original,
      correction.replacement,
    );
    updateCorrection(correction.id, "applied", {
      [correction.field]: nextText,
    });
  }

  function revertCorrection(correction: ProofreadCorrection) {
    const currentText = item[correction.field];
    const nextText = currentText.includes(correction.replacement)
      ? applyCorrectionSpan(
          currentText,
          correction.replacement,
          correction.original,
        )
      : currentText;
    updateCorrection(correction.id, "pending", {
      [correction.field]: nextText,
    });
  }

  function acceptAllCorrections() {
    let nextTitle = item.title;
    let nextAnswer = item.answer;
    const nextCorrections = corrections.map((c) => {
      if (c.status !== "pending") return c;
      if (c.field === "title" && nextTitle.includes(c.original)) {
        nextTitle = applyCorrectionSpan(nextTitle, c.original, c.replacement);
        return { ...c, status: "applied" as const };
      }
      if (c.field === "answer" && nextAnswer.includes(c.original)) {
        nextAnswer = applyCorrectionSpan(nextAnswer, c.original, c.replacement);
        return { ...c, status: "applied" as const };
      }
      return c;
    });
    onChange({
      title: nextTitle,
      answer: nextAnswer,
      corrections: nextCorrections,
    });
  }

  function dismissAllCorrections() {
    onChange({
      corrections: corrections.map((c) =>
        c.status === "pending" ? { ...c, status: "dismissed" as const } : c,
      ),
    });
  }

  const editButton = (
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled}
      onClick={() => {
        if (!editing) setTagsText(item.tags.join(", "));
        setEditing(!editing);
      }}
    >
      {editing ? <Check size={15} /> : <PencilLine size={15} />}
      {editing ? "完成编辑" : "编辑内容"}
    </Button>
  );
  return (
    <article
      id={`import-card-${item.key}`}
      className="import-review-card"
      data-selected={item.selected}
      data-expanded={expanded}
    >
      <header className="import-card-header">
        <label className="import-card-check">
          <input
            type="checkbox"
            checked={item.selected}
            disabled={disabled}
            aria-label={`选择第 ${position} 题`}
            onChange={(event) => onChange({ selected: event.target.checked })}
          />
        </label>
        <h3>
          <button
            type="button"
            className="import-card-toggle"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={onToggle}
          >
            <span>
              <strong>{title}</strong>
              {(replacing ||
                !expanded ||
                item.title.length > 200 ||
                item.tags.length > 0 ||
                noteMeta.properties.length > 0 ||
                !!item.proofreadStatus) && (
                <span className="import-card-meta">
                  {replacing && <span>更新当前题</span>}
                  {item.title.length > 200 && (
                    <span>标题超过 200 字，需缩短</span>
                  )}
                  {item.proofreadStatus === "checking" && (
                    <span className="import-card-proofread-checking">
                      <Loader2 size={12} className="spin" /> AI 纠错核查中
                    </span>
                  )}
                  {item.proofreadStatus !== "checking" &&
                    pendingCorrections.length > 0 && (
                      <span className="import-card-proofread-warn">
                        {pendingCorrections.length} 处勘误待确认
                      </span>
                    )}
                  {item.proofreadStatus &&
                    item.proofreadStatus !== "checking" &&
                    pendingCorrections.length === 0 &&
                    appliedCorrections.length > 0 && (
                      <span className="import-card-proofread-ok">
                        <BadgeCheck size={12} /> 已采纳 {appliedCorrections.length} 处修正
                      </span>
                    )}
                  {item.proofreadStatus === "clean" &&
                    corrections.length === 0 && (
                      <span className="import-card-proofread-ok">
                        <BadgeCheck size={12} /> AI 核查无误
                      </span>
                    )}
                  {!expanded && followups.length > 0 && (
                    <span>{followups.length} 道追问</span>
                  )}
                  {!expanded && !item.answer.trim() && <span>待补答案</span>}
                  {noteMeta.properties.length > 0 && (
                    <span className="import-card-prop-badge">
                      {noteMeta.properties.length} 项笔记属性
                    </span>
                  )}
                  {item.tags.slice(0, 4).map((tag) => (
                    <span className="import-card-tag" key={tag}>
                      #{tag}
                    </span>
                  ))}
                  {item.tags.length > 4 && (
                    <span className="import-card-tag">
                      +{item.tags.length - 4}
                    </span>
                  )}
                </span>
              )}
            </span>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
        </h3>
        {!disabled && (
          <ActionMenu label={`第 ${position} 题的操作`}>
            {onMerge && (
              <button
                type="button"
                onClick={onMerge}
                aria-label={`合并第 ${position} 题到上一题`}
              >
                <Merge size={15} /> 合并到上一题
              </button>
            )}
            <button
              type="button"
              className="danger-text"
              onClick={onRemove}
              aria-label={`移除第 ${position} 题`}
            >
              <Trash2 size={15} /> 从预览移除
            </button>
          </ActionMenu>
        )}
      </header>
      <div id={detailsId} hidden={!expanded}>
        {expanded && (
          <div className="import-card-details">
            {(item.proofreadStatus === "checking" || corrections.length > 0) && (
              <section
                className="import-proofread-panel"
                aria-label={`第 ${position} 题的 AI 纠错建议`}
              >
                <div className="proofread-panel-header">
                  <div>
                    <strong>
                      <Sparkles size={14} aria-hidden="true" />
                      AI 纠错对照
                    </strong>
                    <span>
                      {item.proofreadStatus === "checking"
                        ? "正在检查客观错别字、术语拼写与概念硬伤…"
                        : "仅标记客观错误，未直接改动原文，请逐条确认"}
                    </span>
                  </div>
                  {pendingCorrections.length > 1 && !disabled && (
                    <div className="proofread-batch-actions">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={acceptAllCorrections}
                      >
                        <Check size={13} /> 全部采纳
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={dismissAllCorrections}
                      >
                        全部保留原文
                      </Button>
                    </div>
                  )}
                </div>
                {item.proofreadStatus === "checking" &&
                  corrections.length === 0 && (
                    <div className="proofread-checking-row">
                      <Loader2 size={14} className="spin" />
                      <span>正在比对题干与参考答案，没有错误时将保持原样…</span>
                    </div>
                  )}
                {corrections.length > 0 && (
                  <ul className="proofread-list">
                    {corrections.map((correction) => {
                      const diff = computeInlineDiff(
                        correction.original,
                        correction.replacement,
                      );
                      const canApply = item[correction.field].includes(
                        correction.original,
                      );
                      return (
                        <li
                          key={correction.id}
                          className="proofread-item"
                          data-status={correction.status}
                        >
                          <div className="proofread-item-head">
                            <span
                              className={`proofread-category cat-${correction.category}`}
                            >
                              {PROOFREAD_CATEGORY_LABELS[correction.category]}
                            </span>
                            <span className="proofread-field-badge">
                              {correction.field === "title"
                                ? "题目标题"
                                : "参考答案"}
                            </span>
                            <p className="proofread-reason">
                              {correction.reason}
                            </p>
                          </div>
                          <div
                            className="proofread-diff"
                            aria-label="原文与纠错对照"
                          >
                            <div className="diff-row diff-del">
                              <span className="diff-marker" aria-hidden="true">
                                −
                              </span>
                              <code>
                                {diff.map((seg, idx) =>
                                  seg.type === "insert" ? null : seg.type ===
                                    "delete" ? (
                                    <del key={idx}>{seg.text}</del>
                                  ) : (
                                    <span key={idx}>{seg.text}</span>
                                  ),
                                )}
                              </code>
                            </div>
                            <div className="diff-row diff-ins">
                              <span className="diff-marker" aria-hidden="true">
                                +
                              </span>
                              <code>
                                {diff.map((seg, idx) =>
                                  seg.type === "delete" ? null : seg.type ===
                                    "insert" ? (
                                    <ins key={idx}>{seg.text}</ins>
                                  ) : (
                                    <span key={idx}>{seg.text}</span>
                                  ),
                                )}
                              </code>
                            </div>
                          </div>
                          <div className="proofread-item-actions">
                            {correction.status === "pending" && (
                              <>
                                {!canApply && (
                                  <span className="proofread-stale-hint">
                                    原文片段已变动，请手动核对
                                  </span>
                                )}
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="secondary"
                                  disabled={disabled || !canApply}
                                  onClick={() => acceptCorrection(correction)}
                                >
                                  <Check size={13} /> 采纳修正
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  disabled={disabled}
                                  onClick={() =>
                                    updateCorrection(correction.id, "dismissed")
                                  }
                                >
                                  保留原文
                                </Button>
                              </>
                            )}
                            {correction.status === "applied" && (
                              <>
                                <span className="proofread-status-done">
                                  <Check size={13} /> 已采纳并写入预览
                                </span>
                                {!disabled && (
                                  <button
                                    type="button"
                                    className="text-button"
                                    onClick={() => revertCorrection(correction)}
                                  >
                                    <RotateCcw size={13} /> 撤回采纳
                                  </button>
                                )}
                              </>
                            )}
                            {correction.status === "dismissed" && (
                              <>
                                <span className="proofread-status-dismissed">
                                  已保留原文
                                </span>
                                {!disabled && (
                                  <button
                                    type="button"
                                    className="text-button"
                                    onClick={() =>
                                      updateCorrection(correction.id, "pending")
                                    }
                                  >
                                    重新查看
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            )}
            {editing ? (
              <div className="import-card-editor">
                <div className="import-card-toolbar">{editButton}</div>
                {item.title.length > 200 && (
                  <p className="import-card-notice">
                    标题超过 200 字，需缩短。
                  </p>
                )}
                <label className="field">
                  题目标题
                  <textarea
                    rows={2}
                    aria-label={`第 ${position} 题标题`}
                    placeholder="输入清晰、具体的题目标题（最多 200 字）"
                    maxLength={200}
                    value={item.title}
                    disabled={disabled}
                    onChange={(event) =>
                      onChange({ title: event.target.value })
                    }
                  />
                </label>
                <label className="field">
                  正文与追问
                  <textarea
                    className="import-card-answer-input"
                    rows={8}
                    aria-label={`第 ${position} 题答案`}
                    placeholder="输入支持 Markdown 的参考答案（可用 ## 追问 + Q：/ A： 拆分追问卡），或暂时留空存为待整理"
                    value={item.answer}
                    disabled={disabled}
                    maxLength={100000}
                    onChange={(event) =>
                      onChange({ answer: event.target.value })
                    }
                  />
                </label>
                <label className="field">
                  题目标签
                  <input
                    aria-label={`第 ${position} 题标签`}
                    placeholder="输入标签，以逗号或空格分隔（最多 12 个），或自动读取原文 YAML 笔记属性 tags"
                    value={tagsText}
                    disabled={disabled}
                    onChange={(event) => {
                      const rawValue = event.target.value;
                      setTagsText(rawValue);
                      onChange({ tags: parseTagListInput(rawValue) });
                    }}
                  />
                </label>
                {noteMeta.tags.some((t) => !item.tags.includes(t)) && (
                  <div className="import-card-tag-sync">
                    <span>
                      识别到笔记属性标签：
                      {noteMeta.tags
                        .filter((t) => !item.tags.includes(t))
                        .map((t) => `#${t}`)
                        .join(" ")}
                    </span>
                    <button
                      type="button"
                      className="text-button"
                      disabled={disabled}
                      onClick={() => {
                        const merged = Array.from(
                          new Set([...item.tags, ...noteMeta.tags]),
                        ).slice(0, 12);
                        setTagsText(merged.join(", "));
                        onChange({ tags: merged });
                      }}
                    >
                      一键同步
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <>
                {(noteMeta.properties.length > 0 || item.tags.length > 0) && (
                  <ObsidianProperties
                    source={item.answer}
                    extraTags={item.tags}
                    includeTags={item.tags.length > 0 || noteMeta.tags.length > 0}
                    defaultExpanded={false}
                  />
                )}
                <div
                  className="import-card-columns"
                  data-has-followups={followups.length > 0}
                >
                <section className="import-body-preview">
                  <div className="import-card-toolbar">
                    <h4>
                      <BookOpen size={15} /> 正文
                    </h4>
                    {editButton}
                  </div>
                  {(view?.unresolvedFollowups ?? 0) > 0 && (
                    <p className="import-card-notice">
                      有追问未能拆分，已留在正文。
                    </p>
                  )}
                  {bodyPreview ? (
                    <Markdown interactiveLinks={false}>
                      {bodyPreview + references}
                    </Markdown>
                  ) : !compact ? (
                    <p className="import-empty-answer">
                      {followups.length ? "待补主答案" : "待补答案"}
                    </p>
                  ) : null}
                  {longBody && (
                    <button
                      type="button"
                      className="text-button import-expand-body"
                      aria-expanded={fullBody}
                      onClick={() => setFullBody(!fullBody)}
                    >
                      {fullBody ? "收起正文" : "展开正文"}
                      <ChevronDown size={14} />
                    </button>
                  )}
                </section>
                {followups.length > 0 && (
                  <section
                    className="import-followup-preview"
                    aria-label="识别到的追问"
                  >
                    <h4>
                      <MessageSquare size={15} /> 追问{" "}
                      <span>{followups.length}</span>
                    </h4>
                    <ul>
                      {followups.map((followup, i) => {
                        const open = openFollowup === followup.id;
                        const answerId = `${detailsId}-followup-${i}`;
                        return (
                          <li key={followup.id}>
                            <div className="import-followup-question">
                              <Markdown interactiveLinks={false}>
                                {followup.question + references}
                              </Markdown>
                              <button
                                type="button"
                                aria-expanded={open}
                                aria-controls={answerId}
                                aria-label={`${open ? "收起" : "查看"}第 ${i + 1} 道追问的答案`}
                                onClick={() =>
                                  setOpenFollowup(open ? null : followup.id)
                                }
                              >
                                <ChevronDown size={15} />
                              </button>
                            </div>
                            <div
                              id={answerId}
                              hidden={!open}
                              className="import-followup-answer"
                            >
                              {open && (
                                <Markdown interactiveLinks={false}>
                                  {followup.answer + references}
                                </Markdown>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}
              </div>
              </>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
