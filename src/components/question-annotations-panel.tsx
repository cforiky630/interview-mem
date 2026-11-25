"use client";
import { useEffect, useId, useRef, useState } from "react";
import {
  Check,
  Loader2,
  PencilLine,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type {
  QuestionAnnotation,
  QuestionAnnotationColor,
  QuestionView,
} from "@/lib/types";
import { ANNOTATION_COLORS } from "@/lib/annotations";
import {
  addQuestionAnnotation,
  deleteQuestionAnnotation,
  editQuestionAnnotation,
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
}: {
  question: QuestionView;
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
}) {
  const composerId = useId();
  const [composerOpen, setComposerOpen] = useState(Boolean(pendingQuote));
  const [draftQuote, setDraftQuote] = useState(pendingQuote ?? "");
  const [draftComment, setDraftComment] = useState("");
  const [draftColor, setDraftColor] =
    useState<QuestionAnnotationColor>("accent");
  const [savingNew, setSavingNew] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editComment, setEditComment] = useState("");
  const [editColor, setEditColor] = useState<QuestionAnnotationColor>("accent");
  const [savingEdit, setSavingEdit] = useState(false);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [noteEditing, setNoteEditing] = useState(false);

  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const annotations = question.annotations ?? [];
  const atLimit = annotations.length >= MAX_ANNOTATIONS;

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
    if (!pendingQuote) {
      setComposerOpen(false);
      setDraftQuote("");
      setDraftComment("");
    }
  }, [question.id]);

  // Open composer automatically whenever the user clicks "加批注" on a text selection.
  useEffect(() => {
    if (pendingQuote === null) return;
    setDraftQuote(pendingQuote);
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
    setComposerOpen(true);
    requestAnimationFrame(() => {
      composerTextareaRef.current?.focus({ preventScroll: true });
    });
  }

  function closeComposer() {
    setComposerOpen(false);
    setDraftQuote("");
    setDraftComment("");
    onClearPendingQuote();
  }

  async function submitNewAnnotation() {
    const trimmedComment = draftComment.trim();
    if (!trimmedComment || savingNew) return;
    if (atLimit) {
      toast.error("单道题最多添加 50 条批注。");
      return;
    }
    setSavingNew(true);
    try {
      const result = await addQuestionAnnotation(mutate, {
        id: question.id,
        quote: draftQuote.trim().slice(0, 600),
        comment: trimmedComment.slice(0, 2000),
        color: draftColor,
      });
      if (result) {
        const created = result.annotation as QuestionAnnotation | undefined;
        setComposerOpen(false);
        setDraftQuote("");
        setDraftComment("");
        onClearPendingQuote();
        if (created?.id) onSelectAnnotation(created.id);
        toast.success("批注已添加。");
      }
    } finally {
      setSavingNew(false);
    }
  }

  function startEdit(item: QuestionAnnotation) {
    setComposerOpen(false);
    onClearPendingQuote();
    setConfirmDeleteId(null);
    setEditingId(item.id);
    setEditComment(item.comment);
    setEditColor(item.color);
    requestAnimationFrame(() => {
      editTextareaRef.current?.focus({ preventScroll: true });
    });
  }

  async function submitEdit(annotationId: string) {
    const trimmed = editComment.trim();
    if (!trimmed || savingEdit) return;
    setSavingEdit(true);
    try {
      const result = await editQuestionAnnotation(mutate, {
        id: question.id,
        annotationId,
        comment: trimmed.slice(0, 2000),
        color: editColor,
      });
      if (result) {
        setEditingId(null);
        toast.success("批注已更新。");
      }
    } finally {
      setSavingEdit(false);
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
              {draftQuote.trim() && (
                <div
                  className="annotation-quote-box"
                  title={draftQuote.trim()}
                >
                  {draftQuote.trim()}
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
                {draftQuote.trim() && (
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
              <label htmlFor={composerId} className="sr-only">
                批注内容
              </label>
              <textarea
                id={composerId}
                ref={composerTextareaRef}
                value={draftComment}
                maxLength={2000}
                placeholder={
                  draftQuote.trim()
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
                    保存批注
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
                Boolean(item.quote.trim()) && Boolean(unmatchedIds?.has(item.id));
              const isConfirmingDelete = confirmDeleteId === item.id;
              const isDeletingThis = deletingId === item.id;
              return (
                <div
                  key={item.id}
                  role="listitem"
                  ref={(el) => {
                    if (el) cardRefs.current.set(item.id, el);
                    else cardRefs.current.delete(item.id);
                  }}
                  className={`annotation-card color-${item.color}${
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
                  {isUnmatched && (
                    <span className="annotation-unmatched-badge">
                      原文已变动
                    </span>
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
                            void submitEdit(item.id);
                          } else if (
                            event.key === "Escape" &&
                            !event.nativeEvent.isComposing
                          ) {
                            event.preventDefault();
                            setEditingId(null);
                          }
                        }}
                      />
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
                          onClick={() => void submitEdit(item.id)}
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
                      <p className="annotation-card-comment">{item.comment}</p>
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
                          <button
                            type="button"
                            className="icon-button"
                            aria-label="编辑批注"
                            title="编辑批注"
                            disabled={Boolean(deletingId)}
                            onClick={() => startEdit(item)}
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
                              disabled={Boolean(deletingId)}
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
              选中参考答案中的任意文字，点击「加批注」即可在侧边沉淀理解；收起侧栏后正文即恢复纯净阅读。
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
