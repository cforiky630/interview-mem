"use client";
import { useEffect, useId, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Check, Loader2, PencilLine, PenLine } from "lucide-react";
import { toast } from "sonner";
import type { QuestionView } from "@/lib/types";
import type { Mutate } from "./dialogs";
import { Markdown } from "./markdown";
import { Button } from "./ui/button";

const Editor = dynamic(() => import("./editor").then((m) => m.Editor), {
  ssr: false,
  loading: () => <div className="editor-loading">正在加载编辑器…</div>,
});

export function QuestionNotePanel({
  question,
  userId,
  mutate,
  onSwitchToNotes,
  onEditingChange,
}: {
  question: QuestionView;
  userId: string;
  mutate: Mutate;
  onSwitchToNotes: () => void;
  onEditingChange?: (editing: boolean) => void;
}) {
  const noteInputId = useId();
  const draftKey = `shiyi:note:${userId}:${question.id}`;
  const [note, setNote] = useState(question.note);
  const [noteBase, setNoteBase] = useState(question.noteVersion);
  const [noteDirty, setNoteDirty] = useState(false);
  const [noteBusy, setNoteBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [noteView, setNoteView] = useState<"rich" | "source">("rich");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    onEditingChange?.(editing);
  }, [editing, onEditingChange]);

  useEffect(() => {
    if (!confirmDiscard) return;
    const timer = window.setTimeout(() => setConfirmDiscard(false), 3500);
    return () => window.clearTimeout(timer);
  }, [confirmDiscard]);

  useEffect(() => {
    function onNoteUpdated(event: Event) {
      const detail = (
        event as CustomEvent<{
          questionId: string;
          note: string;
          version: number;
          switchToNotes?: boolean;
        }>
      ).detail;
      if (!detail || detail.questionId !== question.id) return;
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* Ignore storage restrictions. */
      }
      setNote(detail.note);
      setNoteBase(detail.version);
      setNoteDirty(false);
      setEditing(false);
      setNoteView("rich");
      setConfirmDiscard(false);
      if (detail.switchToNotes) onSwitchToNotes();
    }
    window.addEventListener("shiyi:note-updated", onNoteUpdated);
    return () => window.removeEventListener("shiyi:note-updated", onNoteUpdated);
  }, [question.id, draftKey, onSwitchToNotes]);

  useEffect(() => {
    let draft: string | null = null;
    try {
      draft = localStorage.getItem(draftKey);
    } catch {
      draft = null;
    }
    if (draft === null) {
      setNote(question.note);
      setNoteBase(question.noteVersion);
      setNoteDirty(false);
      setEditing(false);
      setNoteView("rich");
      return;
    }
    try {
      const saved = JSON.parse(draft);
      if (typeof saved.content !== "string" || !Number.isInteger(saved.version))
        throw new Error();
      if (saved.content === question.note) {
        try {
          localStorage.removeItem(draftKey);
        } catch {
          /* Ignore storage restrictions. */
        }
        setNote(question.note);
        setNoteBase(question.noteVersion);
        setNoteDirty(false);
        setEditing(false);
        return;
      }
      setNote(saved.content);
      setNoteBase(saved.version);
      setNoteDirty(true);
      setEditing(true);
    } catch {
      setNote(draft);
      setNoteBase(0);
      setNoteDirty(draft !== question.note);
      setEditing(draft !== question.note);
    }
  }, [draftKey]);

  useEffect(() => {
    let hasDraft = false;
    try {
      hasDraft = localStorage.getItem(draftKey) !== null;
    } catch {
      hasDraft = false;
    }
    if (!noteDirty && !hasDraft) {
      setNote(question.note);
      setNoteBase(question.noteVersion);
    }
  }, [question.note, question.noteVersion, noteDirty, draftKey]);

  function enterEdit() {
    setNoteView("rich");
    setConfirmDiscard(false);
    setEditing(true);
  }

  function discardAndClose() {
    try {
      localStorage.removeItem(draftKey);
    } catch {
      /* Ignore storage restrictions. */
    }
    setNote(question.note);
    setNoteBase(question.noteVersion);
    setNoteDirty(false);
    setConfirmDiscard(false);
    setNoteView("rich");
    setEditing(false);
  }

  function updateDraft(nextVal: string) {
    setNote(nextVal);
    setConfirmDiscard(false);
    if (nextVal === question.note) {
      setNoteDirty(false);
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* Ignore storage restrictions. */
      }
    } else {
      setNoteDirty(true);
      try {
        localStorage.setItem(
          draftKey,
          JSON.stringify({
            content: nextVal,
            version: noteBase,
          }),
        );
      } catch {
        /* Ignore storage restrictions. */
      }
    }
  }

  async function saveNote(value = note, version = noteBase) {
    setNoteBusy(true);
    try {
      const result = await mutate("/api/questions", {
        action: "note",
        id: question.id,
        note: value,
        expectedVersion: version,
      });
      if (result) {
        try {
          localStorage.removeItem(draftKey);
        } catch {
          /* Ignore storage restrictions. */
        }
        setNoteBase(Number(result.version));
        setNoteDirty(false);
        setConfirmDiscard(false);
        setNoteView("rich");
        setEditing(false);
        toast.success("笔记已保存。");
      }
    } finally {
      setNoteBusy(false);
    }
  }

  if (!editing) {
    return (
      <section className="personal-notes">
        <div className="personal-notes-head">
          <h2>我的笔记</h2>
          {note.trim() && (
            <button
              type="button"
              className="icon-button note-edit-btn"
              title="编辑笔记"
              aria-label="编辑笔记"
              onClick={enterEdit}
            >
              <PencilLine size={16} />
            </button>
          )}
        </div>
        {note.trim() ? (
          <div
            className="note-markdown-view"
            onDoubleClick={(event) => {
              if (
                (event.target as Element).closest(
                  "a, button, pre, .code-copy-btn",
                )
              )
                return;
              if (window.getSelection()?.toString().trim()) return;
              enterEdit();
            }}
          >
            <Markdown>{note}</Markdown>
          </div>
        ) : (
          <button
            type="button"
            className="note-empty-card"
            onClick={enterEdit}
          >
            <PenLine size={20} strokeWidth={1.5} />
            <span>记下理解要点、易混点或项目案例</span>
            <strong>
              <PencilLine size={14} /> 开始写笔记
            </strong>
          </button>
        )}
      </section>
    );
  }

  const isModified = note !== question.note;

  return (
    <section className="personal-notes personal-notes-editing">
      <div className="personal-notes-head">
        <div className="personal-notes-head-left">
          <h2>我的笔记</h2>
          <div className="segmented-control" role="group" aria-label="编辑方式">
            <button
              type="button"
              aria-pressed={noteView === "rich"}
              onClick={() => setNoteView("rich")}
            >
              排版
            </button>
            <button
              type="button"
              aria-pressed={noteView === "source"}
              onClick={() => {
                setNoteView("source");
                requestAnimationFrame(() => {
                  textareaRef.current?.focus({ preventScroll: true });
                });
              }}
            >
              源码
            </button>
          </div>
        </div>
        <div className="personal-notes-head-actions">
          <Button
            type="button"
            variant={confirmDiscard ? "danger" : "ghost"}
            size="sm"
            disabled={noteBusy}
            onClick={() => {
              if (!isModified) {
                discardAndClose();
                return;
              }
              if (!confirmDiscard) setConfirmDiscard(true);
              else discardAndClose();
            }}
          >
            {!isModified ? "取消" : confirmDiscard ? "确定放弃" : "放弃"}
          </Button>
          <Button
            type="button"
            size="sm"
            title="保存笔记 (Ctrl/⌘ + Enter)"
            disabled={noteBusy || !isModified}
            onClick={() => void saveNote()}
          >
            {noteBusy && <Loader2 size={13} className="spin" />}
            保存笔记
          </Button>
        </div>
      </div>

      {noteDirty && noteBase !== question.noteVersion && (
        <div className="note-conflict">
          <strong>云端笔记已有更新</strong>
          <details>
            <summary>查看最新笔记</summary>
            <Markdown>{question.note || "云端笔记为空。"}</Markdown>
          </details>
          <Button
            variant="outline"
            size="sm"
            disabled={noteBusy}
            onClick={() => void saveNote(note, question.noteVersion)}
          >
            覆盖保存
          </Button>
        </div>
      )}

      {noteView === "rich" ? (
        <div className="note-rich-surface">
          <Editor
            key={`note-doc:${question.id}`}
            value={note}
            onChange={(next) => {
              if (next.length <= 50_000) updateDraft(next);
            }}
            ariaLabel="个人笔记编辑器"
            placeholder="记下你的理解要点、易混边界、代码块或 $公式$…"
            autoFocus
            disabled={noteBusy}
            onSaveShortcut={() => {
              if (!noteBusy && note !== question.note) void saveNote();
            }}
            onEscapeKey={() => {
              if (!noteBusy && note === question.note) discardAndClose();
            }}
          />
        </div>
      ) : (
        <>
          <label htmlFor={noteInputId} className="sr-only">
            个人笔记（支持 Markdown）
          </label>
          <textarea
            id={noteInputId}
            ref={textareaRef}
            className="note-markdown-textarea"
            aria-label="个人笔记"
            placeholder="支持完整 Markdown 编写笔记：记下你的第一反应、易混边界、代码块或结合项目经历的话术…"
            value={note}
            maxLength={50000}
            rows={8}
            disabled={noteBusy}
            onChange={(event) => updateDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                (event.ctrlKey || event.metaKey) &&
                (event.key === "Enter" || event.key.toLowerCase() === "s") &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                if (!noteBusy && isModified) void saveNote();
              } else if (
                event.key === "Escape" &&
                !event.nativeEvent.isComposing &&
                !isModified
              ) {
                event.preventDefault();
                discardAndClose();
              }
            }}
          />
        </>
      )}

      <div className="notes-footer">
        <span
          className={`note-save-state ${isModified ? "is-dirty" : "is-saved"}`}
          role="status"
          title={
            isModified
              ? "有未保存的修改（Ctrl/⌘ + Enter 保存）"
              : "已保存"
          }
          aria-label={isModified ? "有未保存的修改" : "已保存"}
        >
          {isModified ? (
            <i className="note-dirty-dot" aria-hidden="true" />
          ) : (
            <Check size={14} aria-hidden="true" />
          )}
        </span>
        <div className="notes-footer-actions">
          <Button
            type="button"
            variant={confirmDiscard ? "danger" : "ghost"}
            size="sm"
            disabled={noteBusy}
            onClick={() => {
              if (!isModified) {
                discardAndClose();
                return;
              }
              if (!confirmDiscard) setConfirmDiscard(true);
              else discardAndClose();
            }}
          >
            {!isModified ? "收起" : confirmDiscard ? "确定放弃" : "放弃"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            title="保存笔记 (Ctrl/⌘ + Enter)"
            disabled={noteBusy || !isModified}
            onClick={() => void saveNote()}
          >
            {noteBusy && <Loader2 size={13} className="spin" />}
            保存笔记
          </Button>
        </div>
      </div>
    </section>
  );
}
