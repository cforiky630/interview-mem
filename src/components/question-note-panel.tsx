"use client";
import { useEffect, useId, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Check, Loader2, PencilLine, PenLine } from "lucide-react";
import { toast } from "sonner";
import {
  NOTE_DRAFT_CHANGE_EVENT,
  clearNoteDraft,
  isNoteDraftKey,
  noteDraftKey,
  pendingNoteDrafts,
  readNoteDrafts,
  saveNoteDraft,
  selectNoteDraft,
  selectedNoteDraft,
  type NoteDraft,
  type NoteUpdated,
} from "@/lib/drafts";
import type { QuestionView } from "@/lib/types";
import { createUuid } from "@/lib/utils";
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
  onSwitchToNotes?: () => void;
  onEditingChange?: (editing: boolean) => void;
}) {
  const noteInputId = useId();
  const draftKey = noteDraftKey(userId, question.id);
  const [note, setNote] = useState(question.note);
  const [noteBase, setNoteBase] = useState(question.noteVersion);
  const [noteDirty, setNoteDirty] = useState(false);
  const [noteBusy, setNoteBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [noteView, setNoteView] = useState<"rich" | "source">("rich");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [drafts, setDrafts] = useState<NoteDraft[]>([]);
  const activeDraft = useRef<NoteDraft | null>(null);
  const writerKey = useRef<string | null>(null);
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
      const detail = (event as CustomEvent<NoteUpdated>).detail;
      if (!detail || detail.questionId !== question.id) return;
      const consumed = detail.consumedDraft;
      const currentDraft = activeDraft.current;
      if (
        noteDirty &&
        note !== detail.note &&
        (!consumed ||
          !currentDraft ||
          consumed.key !== currentDraft.key ||
          consumed.stored !== currentDraft.stored ||
          consumed.content !== note)
      ) {
        return;
      }
      activeDraft.current = null;
      writerKey.current = null;
      setNote(detail.note);
      setNoteBase(detail.version);
      setNoteDirty(false);
      setEditing(false);
      setNoteView("rich");
      setConfirmDiscard(false);
      if (detail.switchToNotes) onSwitchToNotes?.();
    }
    window.addEventListener("shiyi:note-updated", onNoteUpdated);
    return () => window.removeEventListener("shiyi:note-updated", onNoteUpdated);
  }, [question.id, note, noteDirty, onSwitchToNotes]);

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (!event.key || isNoteDraftKey(draftKey, event.key)) {
        setDrafts(readNoteDrafts(draftKey));
      }
    }
    function onDraftChanged(event: Event) {
      if (isNoteDraftKey(draftKey, (event as CustomEvent<string>).detail)) {
        setDrafts(readNoteDrafts(draftKey));
      }
    }
    const available = readNoteDrafts(draftKey);
    setDrafts(available);
    const unsaved = available.filter((draft) => draft.content !== question.note);
    const selected = selectedNoteDraft(draftKey, unsaved);
    const draft = selected === undefined ? unsaved[0] : selected;
    activeDraft.current = draft ?? null;
    writerKey.current = null;
    setNote(draft?.content ?? question.note);
    setNoteBase(draft?.version ?? question.noteVersion);
    setNoteDirty(Boolean(draft));
    setEditing(Boolean(draft));
    setNoteView("rich");
    window.addEventListener("storage", onStorage);
    window.addEventListener(NOTE_DRAFT_CHANGE_EVENT, onDraftChanged);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(NOTE_DRAFT_CHANGE_EVENT, onDraftChanged);
    };
  }, [draftKey]);

  useEffect(() => {
    if (!noteDirty && !activeDraft.current) {
      setNote(question.note);
      setNoteBase(question.noteVersion);
    }
  }, [question.note, question.noteVersion, noteDirty]);

  function enterEdit() {
    setNoteView("rich");
    setConfirmDiscard(false);
    setEditing(true);
  }

  function openDraft(draft: NoteDraft) {
    if (noteDirty && activeDraft.current?.content !== note) {
      toast.warning("当前修改还未保存到本地，请先保存笔记。");
      return;
    }
    activeDraft.current = draft;
    writerKey.current = null;
    selectNoteDraft(draftKey, draft.key);
    setNote(draft.content);
    setNoteBase(draft.version);
    setNoteDirty(true);
    setConfirmDiscard(false);
    setEditing(true);
  }

  function clearActiveDraft() {
    clearNoteDraft(draftKey, activeDraft.current);
    activeDraft.current = null;
    writerKey.current = null;
  }

  function discardAndClose() {
    clearActiveDraft();
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
      clearActiveDraft();
    } else {
      setNoteDirty(true);
      // Every editor writes its own record, including when continuing a saved draft.
      writerKey.current ??= `${draftKey}:draft:${createUuid()}`;
      const saved = saveNoteDraft(
        draftKey, writerKey.current, nextVal, noteBase, activeDraft.current,
      );
      if (saved) activeDraft.current = saved;
      else {
        toast.warning("本地草稿无法保存，当前内容仍可提交到云端。", { id: draftKey });
      }
    }
  }

  async function saveNote(value = note, version = noteBase) {
    const draft = activeDraft.current;
    setNoteBusy(true);
    try {
      const result = await mutate("/api/questions", {
        action: "note",
        id: question.id,
        note: value,
        expectedVersion: version,
      });
      if (result) {
        if (draft?.content === value) {
          clearNoteDraft(draftKey, draft);
        }
        activeDraft.current = null;
        writerKey.current = null;
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

  const draftOptions = pendingNoteDrafts(drafts).filter((draft) =>
    draft.key !== activeDraft.current?.key &&
    draft.content !== note &&
    draft.content !== question.note,
  );
  const otherDrafts = draftOptions.length > 0 ? (
    <div className="note-conflict">
      <details>
        <summary>其他本地草稿（{draftOptions.length}）</summary>
        {draftOptions.map((draft) => (
          <div key={draft.key}>
            <p>{draft.content.slice(0, 100) || "空笔记"}</p>
            <Button variant="outline" size="sm" disabled={noteBusy} onClick={() => openDraft(draft)}>
              加载此草稿
            </Button>
          </div>
        ))}
      </details>
    </div>
  ) : null;
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
        {otherDrafts}
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
    <section
      className="personal-notes personal-notes-editing"
      onFocusCapture={() => {
        const draft = activeDraft.current;
        if (draft) selectNoteDraft(draftKey, draft.key);
      }}
    >
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

      {otherDrafts}
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
