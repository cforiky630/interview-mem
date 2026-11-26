"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  BookMarked,
  Check,
  ChevronDown,
  Loader2,
  PencilLine,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type {
  ConceptFolderView,
  ConceptView,
  QuestionAnnotation,
  QuestionAnnotationColor,
  QuestionView,
} from "@/lib/types";
import { ANNOTATION_COLORS } from "@/lib/annotations";
import {
  CONCEPT_ROOT_LABEL,
  MAX_CONCEPT_TERM_LENGTH,
  buildConceptFolderIndex,
  findMatchingConcept,
  parseConceptAliasesInput,
} from "@/lib/concepts";
import {
  addQuestionAnnotation,
  deleteQuestionAnnotation,
  editQuestionAnnotation,
  importConceptsFromAnnotations,
} from "@/lib/client";
import type { Mutate } from "./dialogs";
import { QuestionNotePanel } from "./question-note-panel";
import { Button } from "./ui/button";

const MAX_ANNOTATIONS = 50;

function formatAnnotationTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch {
    return iso.slice(0, 10);
  }
}

export function QuestionAnnotationsPanel({
  question,
  concepts = [],
  conceptFolders = [],
  userId,
  mutate,
  open = true,
  pendingQuote,
  activeAnnotationId,
  unmatchedIds,
  onClearPendingQuote,
  onSelectAnnotation,
  onClose,
  onEditingChange,
  onSwitchToNotes,
  onConceptLinked,
  onOpenConcept,
}: {
  question: QuestionView;
  concepts?: readonly ConceptView[];
  conceptFolders?: readonly ConceptFolderView[];
  userId: string;
  mutate: Mutate;
  open?: boolean;
  pendingQuote: string | null;
  activeAnnotationId: string | null;
  unmatchedIds?: Set<string>;
  onClearPendingQuote: () => void;
  onSelectAnnotation: (id: string | null) => void;
  onClose: () => void;
  onEditingChange?: (editing: boolean) => void;
  onSwitchToNotes?: () => void;
  onConceptLinked?: () => void;
  onOpenConcept?: (conceptId: string) => void;
}) {
  const composerId = useId();
  const [composerOpen, setComposerOpen] = useState(Boolean(pendingQuote));
  const [draftQuote, setDraftQuote] = useState(pendingQuote ?? "");
  const [draftComment, setDraftComment] = useState("");
  const [draftColor, setDraftColor] =
    useState<QuestionAnnotationColor>("accent");
  const [saveAsConcept, setSaveAsConcept] = useState(true);
  const [conceptFolderId, setConceptFolderId] = useState<string | null>(null);
  const [conceptAliases, setConceptAliases] = useState("");
  const [conceptExtrasOpen, setConceptExtrasOpen] = useState(false);
  const [updateExistingConcept, setUpdateExistingConcept] = useState(false);
  const [savingNew, setSavingNew] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editComment, setEditComment] = useState("");
  const [editColor, setEditColor] = useState<QuestionAnnotationColor>("accent");
  const [editSyncConcept, setEditSyncConcept] = useState(true);
  const [savingEdit, setSavingEdit] = useState(false);

  const [promotingId, setPromotingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [noteEditing, setNoteEditing] = useState(false);

  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const annotations = question.annotations ?? [];
  const atLimit = annotations.length >= MAX_ANNOTATIONS;

  const conceptById = useMemo(
    () => new Map(concepts.map((c) => [c.id, c])),
    [concepts],
  );
  const folderIndex = useMemo(
    () => buildConceptFolderIndex(conceptFolders),
    [conceptFolders],
  );

  const trimmedDraftQuote = draftQuote.trim();
  const canSaveAsConcept =
    trimmedDraftQuote.length >= 1 &&
    trimmedDraftQuote.length <= MAX_CONCEPT_TERM_LENGTH;
  const matchedConcept = useMemo(
    () =>
      canSaveAsConcept
        ? findMatchingConcept(concepts, trimmedDraftQuote)
        : undefined,
    [canSaveAsConcept, concepts, trimmedDraftQuote],
  );

  // Report editing state to QuestionReader so global shortcuts pause while typing.
  useEffect(() => {
    onEditingChange?.(
      open && (composerOpen || editingId !== null || noteEditing),
    );
  }, [open, composerOpen, editingId, noteEditing, onEditingChange]);

  useEffect(() => {
    if (!open) setConfirmDeleteId(null);
  }, [open]);

  useEffect(() => {
    return () => {
      onEditingChange?.(false);
    };
  }, [onEditingChange]);

  // Reset per-question ephemeral editing state when switching questions.
  useEffect(() => {
    setEditingId(null);
    setConfirmDeleteId(null);
    setDeletingId(null);
    setPromotingId(null);
    if (!pendingQuote) {
      setComposerOpen(false);
      setDraftQuote("");
      setDraftComment("");
      setSaveAsConcept(true);
      setConceptFolderId(null);
      setConceptAliases("");
      setConceptExtrasOpen(false);
      setUpdateExistingConcept(false);
    }
  }, [question.id]);

  // Open composer automatically whenever the user selects prose to annotate / save as concept.
  useEffect(() => {
    if (pendingQuote === null) return;
    setDraftQuote(pendingQuote);
    setSaveAsConcept(true);
    setConceptFolderId(null);
    setConceptAliases("");
    setConceptExtrasOpen(false);
    setUpdateExistingConcept(false);
    setComposerOpen(true);
    setEditingId(null);
    requestAnimationFrame(() => {
      composerTextareaRef.current?.focus({ preventScroll: true });
    });
  }, [pendingQuote]);

  // Auto-reset two-step delete confirmation after 3.5 seconds.
  useEffect(() => {
    if (!confirmDeleteId) return;
    const timer = window.setTimeout(() => setConfirmDeleteId(null), 3500);
    return () => window.clearTimeout(timer);
  }, [confirmDeleteId]);

  // Gently scroll active annotation card into view when selected from prose highlight.
  useEffect(() => {
    if (!open || !activeAnnotationId) return;
    const node = cardRefs.current.get(activeAnnotationId);
    if (node) {
      node.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [open, activeAnnotationId]);

  function openStandaloneComposer() {
    if (atLimit) return;
    setEditingId(null);
    setDraftQuote("");
    setDraftComment("");
    setSaveAsConcept(true);
    setConceptFolderId(null);
    setConceptAliases("");
    setConceptExtrasOpen(false);
    setUpdateExistingConcept(false);
    setComposerOpen(true);
    requestAnimationFrame(() => {
      composerTextareaRef.current?.focus({ preventScroll: true });
    });
  }

  function closeComposer() {
    setComposerOpen(false);
    setDraftQuote("");
    setDraftComment("");
    setSaveAsConcept(true);
    setConceptFolderId(null);
    setConceptAliases("");
    setConceptExtrasOpen(false);
    setUpdateExistingConcept(false);
    onClearPendingQuote();
  }

  async function submitNewAnnotation() {
    const trimmedComment = draftComment.trim();
    if (!trimmedComment || savingNew) return;
    if (atLimit) {
      toast.error("单道题最多添加 50 条批注。");
      return;
    }
    const shouldSaveConcept = canSaveAsConcept && saveAsConcept;
    const parsedAliases =
      shouldSaveConcept && !matchedConcept
        ? parseConceptAliasesInput(conceptAliases, trimmedDraftQuote)
        : [];

    setSavingNew(true);
    try {
      const result = await addQuestionAnnotation(mutate, {
        id: question.id,
        quote: trimmedDraftQuote.slice(0, 600),
        comment: trimmedComment.slice(0, 2000),
        color: draftColor,
        ...(shouldSaveConcept
          ? {
              saveAsConcept: true,
              ...(!matchedConcept || updateExistingConcept
                ? { conceptFolderId }
                : {}),
              ...(parsedAliases.length > 0 ? { aliases: parsedAliases } : {}),
              ...(matchedConcept
                ? { updateExistingConcept }
                : {}),
            }
          : {}),
      });
      if (result) {
        const created = result.annotation as QuestionAnnotation | undefined;
        setComposerOpen(false);
        setDraftQuote("");
        setDraftComment("");
        setSaveAsConcept(true);
        setConceptFolderId(null);
        setConceptAliases("");
        setConceptExtrasOpen(false);
        setUpdateExistingConcept(false);
        onClearPendingQuote();
        if (created?.id) onSelectAnnotation(created.id);
        if (shouldSaveConcept || result.concept) {
          onConceptLinked?.();
          toast.success(
            matchedConcept && !updateExistingConcept
              ? "批注已添加，并关联到已有概念。"
              : "批注已添加，并同步到概念库。",
          );
        } else {
          toast.success("批注已添加。");
        }
      }
    } finally {
      setSavingNew(false);
    }
  }

  function startEdit(
    item: QuestionAnnotation,
    linkedConcept: ConceptView | undefined,
  ) {
    setComposerOpen(false);
    onClearPendingQuote();
    setConfirmDeleteId(null);
    setEditingId(item.id);
    setEditComment(linkedConcept ? linkedConcept.definition : item.comment);
    setEditColor(linkedConcept ? linkedConcept.color : item.color);
    setEditSyncConcept(Boolean(linkedConcept));
    requestAnimationFrame(() => {
      editTextareaRef.current?.focus({ preventScroll: true });
    });
  }

  async function submitEdit(
    annotationId: string,
    hasLinkedConcept: boolean,
  ) {
    const trimmed = editComment.trim();
    if (!trimmed || savingEdit) return;
    setSavingEdit(true);
    try {
      const result = await editQuestionAnnotation(mutate, {
        id: question.id,
        annotationId,
        comment: trimmed.slice(0, 2000),
        color: editColor,
        ...(hasLinkedConcept ? { syncConcept: editSyncConcept } : {}),
      });
      if (result) {
        setEditingId(null);
        toast.success(
          hasLinkedConcept && editSyncConcept
            ? "批注与概念已同步更新。"
            : "批注已更新。",
        );
      }
    } finally {
      setSavingEdit(false);
    }
  }

  async function promoteToConcept(item: QuestionAnnotation) {
    if (promotingId || deletingId) return;
    setPromotingId(item.id);
    try {
      const result = await importConceptsFromAnnotations(mutate, {
        items: [{ questionId: question.id, annotationId: item.id }],
      });
      if (result) {
        onConceptLinked?.();
        toast.success("已存入概念库。");
      }
    } finally {
      setPromotingId(null);
    }
  }

  async function confirmRemove(annotationId: string) {
    if (deletingId) return;
    setDeletingId(annotationId);
    try {
      const result = await deleteQuestionAnnotation(mutate, {
        id: question.id,
        annotationId,
      });
      if (result) {
        setConfirmDeleteId(null);
        if (editingId === annotationId) setEditingId(null);
        if (activeAnnotationId === annotationId) onSelectAnnotation(null);
        toast.success("批注已删除。");
      }
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <aside className="annotations-rail" aria-label="侧边批注与笔记">
      <div className="annotations-rail-head">
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <h2>批注与笔记</h2>
          {annotations.length > 0 && (
            <span className="reader-annotations-count">
              {annotations.length}
            </span>
          )}
        </div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          {!composerOpen && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={atLimit}
              title={atLimit ? "单道题最多添加 50 条批注" : "新建批注"}
              onClick={openStandaloneComposer}
            >
              <Plus size={14} /> 新建批注
            </Button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="收起侧边批注"
            title="收起侧边批注 (N)"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="annotations-rail-body">
        <div
          className="annotation-composer-collapse"
          data-open={composerOpen ? "true" : "false"}
          aria-hidden={!composerOpen}
          inert={!composerOpen}
        >
          <div className="annotation-composer-collapse-inner">
            <div className="annotation-composer">
              {trimmedDraftQuote && (
                <div
                  className="annotation-quote-box"
                  title={trimmedDraftQuote}
                >
                  {trimmedDraftQuote}
                </div>
              )}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <div
                  className="annotation-color-dots"
                  role="radiogroup"
                  aria-label="批注颜色"
                >
                  {ANNOTATION_COLORS.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={`annotation-color-dot color-${c.id}${
                        draftColor === c.id ? " is-selected" : ""
                      }`}
                      aria-label={c.label}
                      aria-pressed={draftColor === c.id}
                      title={c.label}
                      onClick={() => setDraftColor(c.id)}
                    />
                  ))}
                </div>
                {trimmedDraftQuote && (
                  <button
                    type="button"
                    className="text-button"
                    style={{ fontSize: "0.72rem" }}
                    onClick={() => {
                      setDraftQuote("");
                      onClearPendingQuote();
                    }}
                  >
                    移除摘录
                  </button>
                )}
              </div>

              {canSaveAsConcept && (() => {
                const canConfigureExtras =
                  saveAsConcept && (!matchedConcept || updateExistingConcept);
                const hasPopulatedExtras = Boolean(
                  conceptFolderId || (!matchedConcept && conceptAliases.trim()),
                );
                const showExtras = canConfigureExtras && conceptExtrasOpen;
                const matchedFolderLabel = matchedConcept?.folderId
                  ? matchedConcept.folderPath ||
                    folderIndex.pathOf(matchedConcept.folderId)
                  : "";
                return (
                  <>
                    <div className="annotation-concept-toggle-row">
                      <label className="annotation-concept-check">
                        <input
                          type="checkbox"
                          checked={saveAsConcept}
                          disabled={savingNew}
                          onChange={(event) =>
                            setSaveAsConcept(event.target.checked)
                          }
                        />
                        <BookMarked size={13} aria-hidden="true" />
                        <span>同步到概念库</span>
                      </label>
                      {canConfigureExtras && (
                        <button
                          type="button"
                          className={`annotation-concept-more-btn${
                            showExtras ? " is-open" : ""
                          }${hasPopulatedExtras ? " has-value" : ""}`}
                          aria-expanded={showExtras}
                          disabled={savingNew}
                          onClick={() => setConceptExtrasOpen((prev) => !prev)}
                        >
                          <span>
                            {matchedConcept ? "文件夹" : "文件夹 / 别名"}
                          </span>
                          <ChevronDown size={12} aria-hidden="true" />
                        </button>
                      )}
                    </div>

                    {matchedConcept && (
                      <div className="annotation-concept-match">
                        <div className="annotation-concept-match-head">
                          <span title={matchedConcept.term}>
                            <BookMarked size={12} aria-hidden="true" />
                            概念库已有「{matchedConcept.term}」
                            {matchedFolderLabel ? ` · ${matchedFolderLabel}` : ""}
                          </span>
                          {onOpenConcept && (
                            <button
                              type="button"
                              className="text-button"
                              style={{ fontSize: "0.71rem", flexShrink: 0 }}
                              onClick={() => onOpenConcept(matchedConcept.id)}
                            >
                              查看
                            </button>
                          )}
                        </div>
                        <p className="annotation-concept-match-def">
                          {matchedConcept.definition}
                        </p>
                        <div className="annotation-concept-match-actions">
                          <button
                            type="button"
                            className="text-button"
                            style={{ fontSize: "0.72rem" }}
                            onClick={() => {
                              setDraftComment(matchedConcept.definition);
                              setDraftColor(matchedConcept.color);
                              if (
                                matchedConcept.folderId &&
                                !conceptFolderId
                              ) {
                                setConceptFolderId(matchedConcept.folderId);
                              }
                              composerTextareaRef.current?.focus({
                                preventScroll: true,
                              });
                            }}
                          >
                            复用已有释义
                          </button>
                          {saveAsConcept && (
                            <label
                              className="annotation-concept-check"
                              style={{ fontSize: "0.72rem" }}
                            >
                              <input
                                type="checkbox"
                                checked={updateExistingConcept}
                                disabled={savingNew}
                                onChange={(event) => {
                                  const checked = event.target.checked;
                                  setUpdateExistingConcept(checked);
                                  if (
                                    checked &&
                                    !conceptFolderId &&
                                    matchedConcept.folderId
                                  ) {
                                    setConceptFolderId(matchedConcept.folderId);
                                    setConceptExtrasOpen(true);
                                  }
                                }}
                              />
                              <span>更新概念库释义</span>
                            </label>
                          )}
                        </div>
                      </div>
                    )}

                    {canConfigureExtras && (
                      <div
                        className="annotation-concept-extras-collapse"
                        data-open={showExtras ? "true" : "false"}
                        aria-hidden={!showExtras}
                        inert={!showExtras}
                      >
                        <div className="annotation-concept-extras-inner">
                          <div
                            className={`annotation-concept-fields${
                              matchedConcept ? " is-single" : ""
                            }`}
                          >
                            <select
                              className="annotation-concept-select"
                              aria-label="概念文件夹"
                              value={conceptFolderId ?? ""}
                              disabled={savingNew}
                              onChange={(event) =>
                                setConceptFolderId(event.target.value || null)
                              }
                            >
                              <option value="">
                                {CONCEPT_ROOT_LABEL}（根目录）
                              </option>
                              {folderIndex.flatList.map((item) => (
                                <option
                                  key={item.folder.id}
                                  value={item.folder.id}
                                >
                                  {item.depth > 0
                                    ? `${"\u3000".repeat(item.depth)}${item.path}`
                                    : item.path}
                                </option>
                              ))}
                            </select>
                            {!matchedConcept && (
                              <input
                                type="text"
                                className="annotation-concept-input"
                                aria-label="概念别名"
                                placeholder="别名（逗号分隔）"
                                value={conceptAliases}
                                disabled={savingNew}
                                onChange={(event) =>
                                  setConceptAliases(event.target.value)
                                }
                              />
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}

              <label htmlFor={composerId} className="sr-only">
                批注内容
              </label>
              <textarea
                id={composerId}
                ref={composerTextareaRef}
                value={draftComment}
                maxLength={2000}
                placeholder={
                  canSaveAsConcept && saveAsConcept
                    ? "写下这个概念的释义、作用或易混点…"
                    : trimmedDraftQuote
                      ? "写下你对这段话的理解、反问或易混点…"
                      : "记录一条侧边批注…"
                }
                disabled={savingNew}
                onChange={(event) => setDraftComment(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    (event.ctrlKey || event.metaKey) &&
                    event.key === "Enter" &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void submitNewAnnotation();
                  } else if (
                    event.key === "Escape" &&
                    !event.nativeEvent.isComposing &&
                    !draftComment.trim()
                  ) {
                    event.preventDefault();
                    closeComposer();
                  }
                }}
              />
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span style={{ fontSize: "0.71rem", color: "var(--muted)" }}>
                  Ctrl/⌘ + Enter 保存
                </span>
                <div style={{ display: "inline-flex", gap: 6 }}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={savingNew}
                    onClick={closeComposer}
                  >
                    取消
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={savingNew || !draftComment.trim()}
                    onClick={() => void submitNewAnnotation()}
                  >
                    {savingNew ? (
                      <Loader2 size={13} className="spin" />
                    ) : (
                      <Check size={13} />
                    )}
                    {canSaveAsConcept && saveAsConcept
                      ? "保存并同步"
                      : "保存批注"}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {annotations.length > 0 ? (
          <div className="annotation-list" role="list" aria-label="批注列表">
            {annotations.map((item) => {
              const isActive = activeAnnotationId === item.id;
              const isEditingThis = editingId === item.id;
              const isUnmatched =
                Boolean(item.quote.trim()) &&
                Boolean(unmatchedIds?.has(item.id));
              const isConfirmingDelete = confirmDeleteId === item.id;
              const isDeletingThis = deletingId === item.id;
              const isPromotingThis = promotingId === item.id;
              const linkedConcept = item.conceptId
                ? conceptById.get(item.conceptId)
                : undefined;
              const linkedFolderPath = linkedConcept?.folderId
                ? linkedConcept.folderPath ||
                  folderIndex.pathOf(linkedConcept.folderId)
                : "";
              const displayComment = linkedConcept
                ? linkedConcept.definition
                : item.comment;
              const displayColor = linkedConcept
                ? linkedConcept.color
                : item.color;
              const canPromote =
                !linkedConcept &&
                item.quote.trim().length > 0 &&
                item.quote.trim().length <= MAX_CONCEPT_TERM_LENGTH;

              return (
                <div
                  key={item.id}
                  role="listitem"
                  ref={(el) => {
                    if (el) cardRefs.current.set(item.id, el);
                    else cardRefs.current.delete(item.id);
                  }}
                  className={`annotation-card color-${displayColor}${
                    isActive ? " is-active" : ""
                  }`}
                  onClick={() => {
                    if (!isEditingThis) onSelectAnnotation(item.id);
                  }}
                >
                  {item.quote.trim() && (
                    <div
                      className="annotation-card-quote"
                      title={item.quote.trim()}
                    >
                      {item.quote.trim()}
                    </div>
                  )}
                  {(linkedConcept || isUnmatched) && (
                    <div className="annotation-card-badges">
                      {linkedConcept &&
                        (onOpenConcept ? (
                          <button
                            type="button"
                            className="annotation-concept-badge"
                            title={`在概念库查看「${linkedConcept.term}」${linkedFolderPath ? `（${linkedFolderPath}）` : ""}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              onOpenConcept(linkedConcept.id);
                            }}
                          >
                            <BookMarked size={11} aria-hidden="true" />
                            <span>
                              概念
                              {linkedFolderPath ? ` · ${linkedFolderPath}` : ""}
                            </span>
                            <ArrowUpRight size={11} aria-hidden="true" />
                          </button>
                        ) : (
                          <span className="annotation-concept-badge">
                            <BookMarked size={11} aria-hidden="true" />
                            <span>
                              概念
                              {linkedFolderPath ? ` · ${linkedFolderPath}` : ""}
                            </span>
                          </span>
                        ))}
                      {isUnmatched && (
                        <span className="annotation-unmatched-badge">
                          原文已变动
                        </span>
                      )}
                    </div>
                  )}

                  {isEditingThis ? (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                      }}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <div
                        className="annotation-color-dots"
                        role="radiogroup"
                        aria-label="批注颜色"
                      >
                        {ANNOTATION_COLORS.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            className={`annotation-color-dot color-${c.id}${
                              editColor === c.id ? " is-selected" : ""
                            }`}
                            aria-label={c.label}
                            aria-pressed={editColor === c.id}
                            title={c.label}
                            onClick={() => setEditColor(c.id)}
                          />
                        ))}
                      </div>
                      <textarea
                        ref={editTextareaRef}
                        value={editComment}
                        maxLength={2000}
                        aria-label="编辑批注内容"
                        disabled={savingEdit}
                        onChange={(event) => setEditComment(event.target.value)}
                        onKeyDown={(event) => {
                          if (
                            (event.ctrlKey || event.metaKey) &&
                            event.key === "Enter" &&
                            !event.nativeEvent.isComposing
                          ) {
                            event.preventDefault();
                            void submitEdit(item.id, Boolean(linkedConcept));
                          } else if (
                            event.key === "Escape" &&
                            !event.nativeEvent.isComposing
                          ) {
                            event.preventDefault();
                            setEditingId(null);
                          }
                        }}
                      />
                      {linkedConcept && (
                        <label
                          className="annotation-concept-check"
                          style={{ fontSize: "0.73rem" }}
                        >
                          <input
                            type="checkbox"
                            checked={editSyncConcept}
                            disabled={savingEdit}
                            onChange={(event) =>
                              setEditSyncConcept(event.target.checked)
                            }
                          />
                          <span>同步更新概念库「{linkedConcept.term}」</span>
                        </label>
                      )}
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "flex-end",
                          gap: 6,
                        }}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={savingEdit}
                          onClick={() => setEditingId(null)}
                        >
                          取消
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          disabled={savingEdit || !editComment.trim()}
                          onClick={() =>
                            void submitEdit(item.id, Boolean(linkedConcept))
                          }
                        >
                          {savingEdit && (
                            <Loader2 size={13} className="spin" />
                          )}
                          保存
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="annotation-card-comment">
                        {displayComment}
                      </p>
                      <div
                        className="annotation-card-foot"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <span>{formatAnnotationTime(item.updatedAt)}</span>
                        <div
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                          }}
                        >
                          {canPromote && (
                            <button
                              type="button"
                              className="annotation-promote-btn"
                              title="将此批注归入概念库，跨题自动联动释义"
                              disabled={
                                Boolean(promotingId) || Boolean(deletingId)
                              }
                              onClick={() => void promoteToConcept(item)}
                            >
                              {isPromotingThis ? (
                                <Loader2 size={11} className="spin" />
                              ) : (
                                <BookMarked size={11} aria-hidden="true" />
                              )}
                              存入概念库
                            </button>
                          )}
                          <button
                            type="button"
                            className="icon-button"
                            aria-label="编辑批注"
                            title="编辑批注"
                            disabled={
                              Boolean(deletingId) || Boolean(promotingId)
                            }
                            onClick={() => startEdit(item, linkedConcept)}
                          >
                            <PencilLine size={13} />
                          </button>
                          {isConfirmingDelete ? (
                            <Button
                              type="button"
                              variant="danger"
                              size="sm"
                              disabled={isDeletingThis}
                              onClick={() => void confirmRemove(item.id)}
                            >
                              {isDeletingThis && (
                                <Loader2 size={12} className="spin" />
                              )}
                              确认删除
                            </Button>
                          ) : (
                            <button
                              type="button"
                              className="icon-button"
                              aria-label="删除批注"
                              title="删除批注"
                              disabled={
                                Boolean(deletingId) || Boolean(promotingId)
                              }
                              onClick={() => setConfirmDeleteId(item.id)}
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          !composerOpen && (
            <div className="annotations-empty">
              选中参考答案中的词句，点击「批注·概念」即可沉淀理解并自动存入概念库，在其他题目中也能一键查看释义。
            </div>
          )
        )}

        <div className="annotations-note-section">
          <QuestionNotePanel
            question={question}
            userId={userId}
            mutate={mutate}
            onSwitchToNotes={onSwitchToNotes ?? (() => {})}
            onEditingChange={setNoteEditing}
          />
        </div>
      </div>
    </aside>
  );
}
