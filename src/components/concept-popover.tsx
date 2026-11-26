"use client";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowUpRight,
  BookMarked,
  Check,
  ChevronDown,
  Folder,
  Loader2,
  PencilLine,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type {
  ConceptFolderView,
  ConceptView,
  QuestionAnnotationColor,
} from "@/lib/types";
import { ANNOTATION_COLORS } from "@/lib/annotations";
import {
  CONCEPT_ROOT_LABEL,
  MAX_CONCEPT_DEFINITION_LENGTH,
  buildConceptFolderIndex,
  parseConceptAliasesInput,
} from "@/lib/concepts";
import { RequestError, editConcept } from "@/lib/client";
import type { Mutate } from "./dialogs";
import { Button } from "./ui/button";
import { useDiscretePresence } from "./use-discrete-presence";

export type ConceptAnchorRect = {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
};

type PopoverPosition = {
  left: number;
  top: number;
  placement: "below" | "above";
};

export function ConceptPopover({
  concept,
  conceptFolders = [],
  anchorEl,
  anchorRect,
  isMobileShell,
  mutate,
  onClose,
  onOpenConcept,
  onEditingChange,
}: {
  concept: ConceptView | null;
  concepts?: readonly ConceptView[];
  conceptFolders?: readonly ConceptFolderView[];
  anchorEl: HTMLElement | null;
  anchorRect: ConceptAnchorRect | null;
  isMobileShell: boolean;
  mutate: Mutate;
  onClose: () => void;
  onOpenConcept?: (conceptId: string) => void;
  onEditingChange?: (editing: boolean) => void;
}) {
  const open = Boolean(concept);
  const [lastConcept, setLastConcept] = useState<ConceptView | null>(concept);
  useEffect(() => {
    if (concept) setLastConcept(concept);
  }, [concept]);

  const displayConcept = concept ?? lastConcept;
  const openDesktop = open && !isMobileShell;
  const openMobile = open && isMobileShell;

  const desktopPresence = useDiscretePresence<HTMLDivElement>(openDesktop);
  const mobileBackdropPresence =
    useDiscretePresence<HTMLButtonElement>(openMobile);
  const mobileSheetPresence = useDiscretePresence<HTMLDivElement>(openMobile);

  const [editing, setEditing] = useState(false);
  const [editExtrasOpen, setEditExtrasOpen] = useState(false);
  const [draftDefinition, setDraftDefinition] = useState("");
  const [draftFolderId, setDraftFolderId] = useState<string | null>(null);
  const [draftAliases, setDraftAliases] = useState("");
  const [draftColor, setDraftColor] =
    useState<QuestionAnnotationColor>("accent");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [position, setPosition] = useState<PopoverPosition>({
    left: 16,
    top: 84,
    placement: "below",
  });

  const defFieldId = useId();
  const folderFieldId = useId();
  const aliasFieldId = useId();
  const defTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;

  const folderIndex = useMemo(
    () => buildConceptFolderIndex(conceptFolders),
    [conceptFolders],
  );

  // Exit edit mode whenever the popover closes or switches to a different concept.
  useEffect(() => {
    setEditing(false);
    setEditExtrasOpen(false);
    setError("");
  }, [concept?.id, open]);

  // Pause reader keyboard shortcuts while typing inside popover edit mode.
  useEffect(() => {
    onEditingChange?.(open && editing);
  }, [open, editing, onEditingChange]);

  useEffect(() => {
    return () => {
      onEditingChange?.(false);
    };
  }, [onEditingChange]);

  const updatePosition = useCallback(() => {
    if (typeof window === "undefined") return;
    const rect =
      anchorEl && anchorEl.isConnected
        ? anchorEl.getBoundingClientRect()
        : anchorRect;
    const popW = Math.min(364, window.innerWidth - 24);
    if (!rect) {
      setPosition({
        left: Math.max(12, Math.round((window.innerWidth - popW) / 2)),
        top: 84,
        placement: "below",
      });
      return;
    }

    const popEl = desktopPresence.ref.current;
    const measuredH =
      popEl && popEl.offsetHeight > 0
        ? popEl.offsetHeight
        : editingRef.current
          ? 348
          : 210;

    const spaceBelow = window.innerHeight - rect.bottom - 16;
    const spaceAbove = rect.top - 16;
    const placement: "below" | "above" =
      spaceBelow >= measuredH || spaceBelow >= spaceAbove ? "below" : "above";

    const left = Math.max(
      12,
      Math.min(
        window.innerWidth - popW - 12,
        rect.left + rect.width / 2 - popW / 2,
      ),
    );
    const rawTop =
      placement === "below" ? rect.bottom + 10 : rect.top - measuredH - 10;
    const top = Math.max(
      12,
      Math.min(window.innerHeight - measuredH - 12, rawTop),
    );

    setPosition({
      left: Math.round(left),
      top: Math.round(top),
      placement,
    });
  }, [anchorEl, anchorRect, desktopPresence.ref]);

  useLayoutEffect(() => {
    if (!openDesktop) return;
    updatePosition();
    const raf = window.requestAnimationFrame(updatePosition);
    const settleTimer = editing
      ? window.setTimeout(updatePosition, 220)
      : null;
    return () => {
      window.cancelAnimationFrame(raf);
      if (settleTimer !== null) window.clearTimeout(settleTimer);
    };
  }, [
    openDesktop,
    updatePosition,
    concept?.id,
    editing,
    editExtrasOpen,
    displayConcept?.definition,
    displayConcept?.aliases.length,
    displayConcept?.folderId,
    displayConcept?.folderPath,
  ]);

  useEffect(() => {
    if (!openDesktop) return;
    let rafId: number | null = null;
    function scheduleReposition() {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        if (anchorEl && anchorEl.isConnected && !editingRef.current) {
          const rect = anchorEl.getBoundingClientRect();
          if (rect.bottom < 0 || rect.top > window.innerHeight) {
            onClose();
            return;
          }
        }
        updatePosition();
      });
    }
    window.addEventListener("resize", scheduleReposition);
    window.addEventListener("scroll", scheduleReposition, true);
    return () => {
      window.removeEventListener("resize", scheduleReposition);
      window.removeEventListener("scroll", scheduleReposition, true);
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
  }, [openDesktop, anchorEl, onClose, updatePosition]);

  // Dismiss on Esc (or cancel edit mode first) and outside click on desktop.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (editingRef.current) {
        setEditing(false);
        setError("");
      } else {
        onClose();
      }
    }
    function onPointerDown(event: PointerEvent) {
      if (isMobileShell) return;
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (desktopPresence.ref.current?.contains(target)) return;
      if (target.closest("[data-sonner-toaster]")) return;
      if (
        target.closest(
          ".prose-concept-link, mark.prose-annotation-mark[data-concept-id]",
        )
      ) {
        return;
      }
      onClose();
    }
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, isMobileShell, onClose, desktopPresence.ref]);

  function startEdit() {
    if (!displayConcept) return;
    setDraftDefinition(displayConcept.definition);
    setDraftFolderId(displayConcept.folderId ?? null);
    setDraftAliases(displayConcept.aliases.join("，"));
    setDraftColor(displayConcept.color);
    setEditExtrasOpen(
      Boolean(displayConcept.folderId || displayConcept.aliases.length > 0),
    );
    setError("");
    setEditing(true);
    requestAnimationFrame(() => {
      const el = defTextareaRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
  }

  async function saveEdit() {
    if (!displayConcept || saving) return;
    const trimmedDefinition = draftDefinition.trim();
    if (!trimmedDefinition) {
      setError("请填写概念释义。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const nextAliases = parseConceptAliasesInput(
        draftAliases,
        displayConcept.term,
      );
      const result = await editConcept(
        mutate,
        {
          id: displayConcept.id,
          definition: trimmedDefinition.slice(0, MAX_CONCEPT_DEFINITION_LENGTH),
          folderId: draftFolderId,
          aliases: nextAliases,
          color: draftColor,
        },
        { throwOnCodes: ["CONCEPT_EXISTS"] },
      );
      if (result) {
        setEditing(false);
        toast.success("概念已更新。");
      }
    } catch (err) {
      if (err instanceof RequestError) {
        setError(err.message);
      } else {
        setError("保存失败，请稍后重试。");
      }
    } finally {
      setSaving(false);
    }
  }

  if (!displayConcept) return null;

  const displayFolderPath = displayConcept.folderId
    ? displayConcept.folderPath || folderIndex.pathOf(displayConcept.folderId)
    : "";

  const content = (
    <>
      <div className="concept-popover-head">
        <div className="concept-popover-title-wrap">
          <span
            className={`concept-popover-dot color-${editing ? draftColor : displayConcept.color}`}
            aria-hidden="true"
          />
          <h3 className="concept-popover-term">{displayConcept.term}</h3>
          {displayFolderPath && !editing && (
            <span className="concept-popover-group" title={displayFolderPath}>
              <Folder size={11} aria-hidden="true" />
              <span>{displayFolderPath}</span>
            </span>
          )}
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭概念释义"
          title="关闭 (Esc)"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>

      {!editing && displayConcept.aliases.length > 0 && (
        <div className="concept-popover-aliases" aria-label="概念别名">
          {displayConcept.aliases.map((alias) => (
            <span key={alias} className="concept-popover-alias">
              {alias}
            </span>
          ))}
        </div>
      )}

      <div className="concept-popover-body">
        {editing ? (
          <div className="concept-popover-edit-form">
            <div className="concept-popover-field">
              <label htmlFor={defFieldId} className="sr-only">
                概念释义
              </label>
              <textarea
                id={defFieldId}
                ref={defTextareaRef}
                className="concept-popover-textarea"
                value={draftDefinition}
                maxLength={MAX_CONCEPT_DEFINITION_LENGTH}
                disabled={saving}
                placeholder="输入释义（Ctrl/⌘ + Enter 保存）…"
                onChange={(event) => {
                  setDraftDefinition(event.target.value);
                  if (error) setError("");
                }}
                onKeyDown={(event) => {
                  if (
                    (event.ctrlKey || event.metaKey) &&
                    event.key === "Enter" &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void saveEdit();
                  }
                }}
              />
            </div>

            <div className="concept-popover-edit-meta">
              <div
                className="annotation-color-dots"
                role="radiogroup"
                aria-label="概念颜色"
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
                    disabled={saving}
                    onClick={() => setDraftColor(c.id)}
                  />
                ))}
              </div>
              <button
                type="button"
                className={`concept-popover-more-btn${
                  editExtrasOpen ? " is-open" : ""
                }${draftFolderId || draftAliases.trim() ? " has-value" : ""}`}
                aria-expanded={editExtrasOpen}
                disabled={saving}
                onClick={() => setEditExtrasOpen((prev) => !prev)}
              >
                <span>文件夹 / 别名</span>
                <ChevronDown size={12} aria-hidden="true" />
              </button>
            </div>

            <div
              className="concept-popover-extras-collapse"
              data-open={editExtrasOpen ? "true" : "false"}
              aria-hidden={!editExtrasOpen}
              inert={!editExtrasOpen}
            >
              <div className="concept-popover-extras-inner">
                <div className="concept-popover-edit-row">
                  <div className="concept-popover-field">
                    <label htmlFor={folderFieldId} className="sr-only">
                      所属文件夹
                    </label>
                    <select
                      id={folderFieldId}
                      className="concept-popover-select"
                      aria-label="所属文件夹"
                      value={draftFolderId ?? ""}
                      disabled={saving}
                      onChange={(event) =>
                        setDraftFolderId(event.target.value || null)
                      }
                    >
                      <option value="">{CONCEPT_ROOT_LABEL}（根目录）</option>
                      {folderIndex.flatList.map((item) => (
                        <option key={item.folder.id} value={item.folder.id}>
                          {item.depth > 0
                            ? `${"\u3000".repeat(item.depth)}${item.path}`
                            : item.path}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="concept-popover-field">
                    <label htmlFor={aliasFieldId} className="sr-only">
                      概念别名
                    </label>
                    <input
                      id={aliasFieldId}
                      type="text"
                      className="concept-popover-input"
                      value={draftAliases}
                      disabled={saving}
                      placeholder="别名（逗号分隔）"
                      onChange={(event) => setDraftAliases(event.target.value)}
                    />
                  </div>
                </div>
              </div>
            </div>

            {error && (
              <p className="concept-popover-error" role="alert">
                {error}
              </p>
            )}
          </div>
        ) : (
          <p className="concept-popover-definition">
            {displayConcept.definition}
          </p>
        )}
      </div>

      <div className="concept-popover-foot">
        {editing ? (
          <div className="concept-popover-foot-actions">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => {
                setEditing(false);
                setError("");
              }}
            >
              取消
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={saving || !draftDefinition.trim()}
              onClick={() => void saveEdit()}
            >
              {saving ? (
                <Loader2 size={13} className="spin" />
              ) : (
                <Check size={13} />
              )}
              保存
            </Button>
          </div>
        ) : (
          <>
            <button
              type="button"
              className="concept-popover-action"
              onClick={startEdit}
            >
              <PencilLine size={13} />
              编辑
            </button>
            {onOpenConcept && (
              <button
                type="button"
                className="concept-popover-action is-primary"
                onClick={() => {
                  const id = displayConcept.id;
                  onClose();
                  onOpenConcept(id);
                }}
              >
                <BookMarked size={13} />
                概念库
                <ArrowUpRight size={13} />
              </button>
            )}
          </>
        )}
      </div>
    </>
  );

  if (isMobileShell) {
    return (
      <>
        <button
          ref={mobileBackdropPresence.ref}
          type="button"
          hidden={mobileBackdropPresence.isHidden}
          data-closing={mobileBackdropPresence.isClosing ? "" : undefined}
          aria-hidden="true"
          tabIndex={-1}
          inert={!openMobile || mobileBackdropPresence.isClosing}
          className="concept-sheet-backdrop"
          onClick={onClose}
        />
        <div
          ref={mobileSheetPresence.ref}
          hidden={mobileSheetPresence.isHidden}
          data-closing={mobileSheetPresence.isClosing ? "" : undefined}
          aria-hidden={!openMobile}
          inert={!openMobile || mobileSheetPresence.isClosing}
          className="concept-mobile-sheet"
          role="dialog"
          aria-modal="true"
          aria-label={`概念释义：${displayConcept.term}`}
        >
          <div className="sheet-grabber" aria-hidden="true" />
          {content}
        </div>
      </>
    );
  }

  return (
    <div
      ref={desktopPresence.ref}
      hidden={desktopPresence.isHidden}
      data-closing={desktopPresence.isClosing ? "" : undefined}
      data-placement={position.placement}
      aria-hidden={!openDesktop}
      inert={!openDesktop || desktopPresence.isClosing}
      className="concept-popover"
      style={{
        left: position.left,
        top: position.top,
      }}
      role="dialog"
      aria-label={`概念释义：${displayConcept.term}`}
    >
      {content}
    </div>
  );
}
