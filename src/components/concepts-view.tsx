"use client";

import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  ArrowUpRight,
  BookMarked,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderInput,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  Home,
  Loader2,
  PenLine,
  PencilLine,
  Plus,
  Search,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type {
  ConceptFolderView,
  ConceptView,
  FolderConflictItem,
  QuestionAnnotationColor,
  QuestionView,
  Workspace,
} from "@/lib/types";
import { ANNOTATION_COLORS } from "@/lib/annotations";
import {
  CONCEPT_ROOT_LABEL,
  MAX_CONCEPTS,
  MAX_CONCEPT_DEFINITION_LENGTH,
  MAX_CONCEPT_TERM_LENGTH,
  buildConceptFolderIndex,
  findMatchingConcept,
  normalizeConceptKey,
  parseConceptAliasesInput,
  sortConceptsNatural,
  type ConceptFolderFlatItem,
} from "@/lib/concepts";
import { MAX_FOLDER_DEPTH } from "@/lib/folders";
import {
  RequestError,
  createConcept,
  deleteConcept,
  editConcept,
  importConceptsFromAnnotations,
  moveConceptFolder,
  moveConceptsToFolder,
  type WorkspaceMutate,
} from "@/lib/client";
import { cn } from "@/lib/utils";
import {
  CONCEPT_DRAG_MIME,
  ConceptFolderTree,
  parseConceptDragPayload,
  type ConceptDragPayload,
} from "./concept-folder-tree";
import {
  ConceptFolderMoveDialog,
  CreateConceptFolderDialog,
  DeleteConceptFolderDialog,
  DissolveConceptFolderDialog,
  EditConceptFolderDialog,
  GroupIntoNewConceptFolderDialog,
  type ConceptMoveSelection,
} from "./concept-folder-dialogs";
import { ActionMenu } from "./ui/action-menu";
import { Button } from "./ui/button";
import { useDiscretePresence } from "./use-discrete-presence";
import "./concepts.css";

type ConflictInfo = {
  message: string;
  existing: ConceptView | null;
};

function nextConceptColor(
  current: QuestionAnnotationColor,
): QuestionAnnotationColor {
  const idx = ANNOTATION_COLORS.findIndex((c) => c.id === current);
  return ANNOTATION_COLORS[(idx + 1) % ANNOTATION_COLORS.length]!.id;
}

function colorLabel(color: QuestionAnnotationColor): string {
  return ANNOTATION_COLORS.find((c) => c.id === color)?.label ?? "主题色";
}

function resizeTextarea(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.max(el.scrollHeight, 28)}px`;
}

function conceptMatchesQuery(
  concept: ConceptView,
  rawQuery: string,
  normQuery: string,
): boolean {
  const lower = rawQuery.toLowerCase();
  if (concept.term.toLowerCase().includes(lower)) return true;
  if (concept.definition.toLowerCase().includes(lower)) return true;
  if (concept.folderPath.toLowerCase().includes(lower)) return true;
  for (const alias of concept.aliases) {
    if (alias.toLowerCase().includes(lower)) return true;
  }
  if (normQuery) {
    if (concept.normalizedKey.includes(normQuery)) return true;
    for (const alias of concept.aliases) {
      if (normalizeConceptKey(alias).includes(normQuery)) return true;
    }
  }
  return false;
}

function extractConflict(
  err: unknown,
  concepts: readonly ConceptView[],
  fallbackTerm: string,
): ConflictInfo | null {
  if (!(err instanceof RequestError) || err.code !== "CONCEPT_EXISTS") {
    return null;
  }
  const existingFromDetails =
    err.details?.existing &&
    typeof err.details.existing === "object" &&
    "id" in err.details.existing
      ? (err.details.existing as ConceptView)
      : null;
  const existing =
    existingFromDetails ?? findMatchingConcept(concepts, fallbackTerm) ?? null;
  const locText = existing
    ? existing.folderPath || CONCEPT_ROOT_LABEL
    : "";
  const message = existing
    ? `概念库中已存在「${existing.term}」（${locText}）`
    : err.message || "概念库中已存在相同概念。";
  return { message, existing };
}

/**
 * Isolated inline K-V creation row so typing never re-renders the folder tree or sibling rows.
 */
const ConceptKvCreateRow = memo(function ConceptKvCreateRow({
  folderId,
  concepts,
  mutate,
  openNonce,
  onCreated,
  onCancel,
  onJumpExisting,
}: {
  folderId: string | null;
  concepts: readonly ConceptView[];
  mutate: WorkspaceMutate;
  openNonce: number;
  onCreated: (created: ConceptView | undefined) => void;
  onCancel: () => void;
  onJumpExisting: (existing: ConceptView) => void;
}) {
  const [term, setTerm] = useState("");
  const [definition, setDefinition] = useState("");
  const [aliases, setAliases] = useState("");
  const [color, setColor] = useState<QuestionAnnotationColor>("accent");
  const [moreOpen, setMoreOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [focusNonce, setFocusNonce] = useState(1);
  const pendingFocusRef = useRef(true);
  const termInputRef = useRef<HTMLInputElement>(null);
  const defTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    pendingFocusRef.current = true;
    setFocusNonce((n) => n + 1);
  }, [openNonce]);

  useEffect(() => {
    if (!pendingFocusRef.current || busy) return;
    pendingFocusRef.current = false;
    resizeTextarea(defTextareaRef.current);
    termInputRef.current?.focus({ preventScroll: true });
  }, [busy, focusNonce]);

  useLayoutEffect(() => {
    resizeTextarea(defTextareaRef.current);
  }, [definition]);

  const parsedAliases = useMemo(
    () => parseConceptAliasesInput(aliases, term),
    [aliases, term],
  );
  const canSubmit = !busy && Boolean(term.trim()) && Boolean(definition.trim());

  async function handleSubmit() {
    const trimmedTerm = term.trim();
    const trimmedDef = definition.trim();
    if (!trimmedTerm || !trimmedDef || busy) return;
    setBusy(true);
    setConflict(null);
    try {
      const parsed = parseConceptAliasesInput(aliases, trimmedTerm);
      const res = await createConcept(
        mutate,
        {
          term: trimmedTerm.slice(0, MAX_CONCEPT_TERM_LENGTH),
          definition: trimmedDef.slice(0, MAX_CONCEPT_DEFINITION_LENGTH),
          aliases: parsed,
          folderId,
          color,
        },
        { throwOnCodes: ["CONCEPT_EXISTS"] },
      );
      if (res) {
        const created = res.concept as ConceptView | undefined;
        setTerm("");
        setDefinition("");
        setAliases("");
        setMoreOpen(false);
        setConflict(null);
        toast.success(`已新增概念「${trimmedTerm}」。`);
        onCreated(created);
        pendingFocusRef.current = true;
        setFocusNonce((n) => n + 1);
      }
    } catch (err) {
      const found = extractConflict(err, concepts, trimmedTerm);
      if (found) {
        setConflict(found);
      } else {
        toast.error(err instanceof Error ? err.message : "新增概念失败。");
      }
    } finally {
      setBusy(false);
    }
  }

  function handleEscape() {
    if (!term.trim() && !definition.trim()) {
      onCancel();
    } else if (moreOpen) {
      setMoreOpen(false);
    }
  }

  return (
    <tr className="concept-row concept-kv-row" data-create-row="true">
      <td className="concept-cell-term concept-kv-term-cell">
        <div className="concept-kv-term-line">
          <button
            type="button"
            className="concept-color-dot-btn"
            aria-label={`切换标记色，当前${colorLabel(color)}`}
            title={`颜色：${colorLabel(color)}（点击切换）`}
            disabled={busy}
            onClick={() => setColor(nextConceptColor(color))}
          >
            <span
              className={cn("concept-color-dot", `color-${color}`)}
              aria-hidden="true"
            />
          </button>
          <input
            ref={termInputRef}
            type="text"
            className="concept-kv-term-input"
            aria-label="概念名"
            placeholder="概念名"
            value={term}
            maxLength={MAX_CONCEPT_TERM_LENGTH}
            disabled={busy}
            onChange={(e) => {
              setTerm(e.target.value);
              if (conflict) setConflict(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                defTextareaRef.current?.focus({ preventScroll: true });
              } else if (e.key === "Escape" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleEscape();
              }
            }}
          />
        </div>
        {!moreOpen && parsedAliases.length > 0 && (
          <div className="concept-kv-term-summary">
            {parsedAliases.map((alias) => (
              <button
                key={alias}
                type="button"
                className="concept-kv-summary-chip"
                title="点击编辑别名"
                onClick={() => setMoreOpen(true)}
              >
                {alias}
              </button>
            ))}
          </div>
        )}
      </td>

      <td className="concept-cell-def concept-kv-def-cell">
        <div className="concept-kv-def-main">
          <textarea
            ref={defTextareaRef}
            rows={1}
            className="concept-kv-def-input"
            aria-label="释义"
            placeholder="输入释义，Enter 保存 · Shift+Enter 换行"
            value={definition}
            maxLength={MAX_CONCEPT_DEFINITION_LENGTH}
            disabled={busy}
            onChange={(e) => {
              setDefinition(e.target.value);
              resizeTextarea(e.currentTarget);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (
                e.key === "Enter" &&
                (!e.shiftKey || e.ctrlKey || e.metaKey)
              ) {
                e.preventDefault();
                if (canSubmit) void handleSubmit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                handleEscape();
              }
            }}
          />

          <div className="concept-kv-controls">
            <button
              type="button"
              className={cn("concept-kv-more-btn", moreOpen && "is-open")}
              aria-expanded={moreOpen}
              aria-label="展开或收起别名与颜色"
              title="别名 · 颜色"
              disabled={busy}
              onClick={() => setMoreOpen((v) => !v)}
            >
              <span>更多</span>
              {!moreOpen && Boolean(aliases.trim()) && (
                <span className="concept-kv-more-dot" aria-hidden="true" />
              )}
              <ChevronDown size={13} className="concept-kv-more-chevron" />
            </button>

            <Button
              type="button"
              size="sm"
              className="concept-kv-save-btn"
              disabled={!canSubmit}
              onClick={() => void handleSubmit()}
            >
              {busy ? (
                <Loader2 size={12} className="spin" />
              ) : (
                <Check size={12} />
              )}
              添加
            </Button>

            <button
              type="button"
              className="icon-button concept-kv-cancel-btn"
              aria-label="取消"
              title="取消"
              disabled={busy}
              onClick={onCancel}
            >
              <X size={14} />
            </button>
          </div>
        </div>

        <div
          className="concept-kv-extra-collapse"
          data-open={moreOpen ? "true" : "false"}
          aria-hidden={!moreOpen}
          inert={!moreOpen}
        >
          <div className="concept-kv-extra-inner">
            <div className="concept-kv-extra-tray">
              <input
                type="text"
                className="concept-kv-extra-input"
                aria-label="别名"
                placeholder="别名，逗号分隔"
                value={aliases}
                disabled={busy}
                onChange={(e) => setAliases(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (canSubmit) void handleSubmit();
                    else defTextareaRef.current?.focus({ preventScroll: true });
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    handleEscape();
                  }
                }}
              />

              <div
                className="concept-kv-extra-colors"
                role="radiogroup"
                aria-label="概念颜色"
              >
                {ANNOTATION_COLORS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={cn(
                      "annotation-color-dot",
                      `color-${c.id}`,
                      color === c.id && "is-selected",
                    )}
                    aria-label={c.label}
                    aria-pressed={color === c.id}
                    title={c.label}
                    disabled={busy}
                    onClick={() => setColor(c.id)}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        {conflict && (
          <div className="concepts-conflict-alert" role="alert">
            <span className="concepts-conflict-alert-text">
              <AlertCircle size={15} />
              <span>{conflict.message}</span>
            </span>
            {conflict.existing && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onJumpExisting(conflict.existing!)}
              >
                跳转到已有概念
              </Button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
});

/**
 * Isolated inline K-V edit row so typing never re-renders the folder tree or sibling rows.
 */
const ConceptKvEditRow = memo(function ConceptKvEditRow({
  concept,
  concepts,
  flatFolders,
  mutate,
  setRowRef,
  onDone,
  onCancel,
  onJumpExisting,
}: {
  concept: ConceptView;
  concepts: readonly ConceptView[];
  flatFolders: readonly ConceptFolderFlatItem[];
  mutate: WorkspaceMutate;
  setRowRef: (id: string, el: HTMLTableRowElement | null) => void;
  onDone: () => void;
  onCancel: () => void;
  onJumpExisting: (existing: ConceptView) => void;
}) {
  const [term, setTerm] = useState(concept.term);
  const [definition, setDefinition] = useState(concept.definition);
  const [aliases, setAliases] = useState(concept.aliases.join(", "));
  const [folderId, setFolderId] = useState<string | null>(
    concept.folderId ?? null,
  );
  const [color, setColor] = useState<QuestionAnnotationColor>(concept.color);
  const [moreOpen, setMoreOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const termInputRef = useRef<HTMLInputElement>(null);
  const defTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    resizeTextarea(defTextareaRef.current);
    defTextareaRef.current?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    resizeTextarea(defTextareaRef.current);
  }, [definition]);

  const parsedAliases = useMemo(
    () => parseConceptAliasesInput(aliases, term),
    [aliases, term],
  );
  const hasExtraMeta = Boolean(aliases.trim() || folderId !== (concept.folderId ?? null));
  const canSubmit = !busy && Boolean(term.trim()) && Boolean(definition.trim());

  async function handleSubmit() {
    const trimmedTerm = term.trim();
    const trimmedDef = definition.trim();
    if (!trimmedTerm || !trimmedDef || busy) return;
    setBusy(true);
    setConflict(null);
    try {
      const parsed = parseConceptAliasesInput(aliases, trimmedTerm);
      const res = await editConcept(
        mutate,
        {
          id: concept.id,
          term: trimmedTerm.slice(0, MAX_CONCEPT_TERM_LENGTH),
          definition: trimmedDef.slice(0, MAX_CONCEPT_DEFINITION_LENGTH),
          aliases: parsed,
          folderId,
          color,
        },
        { throwOnCodes: ["CONCEPT_EXISTS"] },
      );
      if (res) {
        toast.success("概念已更新。");
        onDone();
      }
    } catch (err) {
      const found = extractConflict(err, concepts, trimmedTerm);
      if (found) {
        setConflict(found);
      } else {
        toast.error(err instanceof Error ? err.message : "更新概念失败。");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr
      ref={(el) => setRowRef(concept.id, el)}
      data-concept-id={concept.id}
      className="concept-row concept-kv-row is-editing"
    >
      <td className="concept-cell-term concept-kv-term-cell">
        <div className="concept-kv-term-line">
          <button
            type="button"
            className="concept-color-dot-btn"
            aria-label={`切换标记色，当前${colorLabel(color)}`}
            title={`颜色：${colorLabel(color)}（点击切换）`}
            disabled={busy}
            onClick={() => setColor(nextConceptColor(color))}
          >
            <span
              className={cn("concept-color-dot", `color-${color}`)}
              aria-hidden="true"
            />
          </button>
          <input
            ref={termInputRef}
            type="text"
            className="concept-kv-term-input"
            aria-label="概念名"
            placeholder="概念名"
            value={term}
            maxLength={MAX_CONCEPT_TERM_LENGTH}
            disabled={busy}
            onChange={(e) => {
              setTerm(e.target.value);
              if (conflict) setConflict(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                defTextareaRef.current?.focus({ preventScroll: true });
              } else if (e.key === "Escape" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onCancel();
              }
            }}
          />
        </div>
        {!moreOpen && parsedAliases.length > 0 && (
          <div className="concept-kv-term-summary">
            {parsedAliases.map((alias) => (
              <button
                key={alias}
                type="button"
                className="concept-kv-summary-chip"
                title="点击编辑别名或文件夹"
                onClick={() => setMoreOpen(true)}
              >
                {alias}
              </button>
            ))}
          </div>
        )}
      </td>

      <td className="concept-cell-def concept-kv-def-cell">
        <div className="concept-kv-def-main">
          <textarea
            ref={defTextareaRef}
            rows={1}
            className="concept-kv-def-input"
            aria-label="编辑概念释义"
            placeholder="输入释义，Enter 保存 · Shift+Enter 换行"
            value={definition}
            maxLength={MAX_CONCEPT_DEFINITION_LENGTH}
            disabled={busy}
            onChange={(e) => {
              setDefinition(e.target.value);
              resizeTextarea(e.currentTarget);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (
                e.key === "Enter" &&
                (!e.shiftKey || e.ctrlKey || e.metaKey)
              ) {
                e.preventDefault();
                if (canSubmit) void handleSubmit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancel();
              }
            }}
          />

          <div className="concept-kv-controls">
            <button
              type="button"
              className={cn("concept-kv-more-btn", moreOpen && "is-open")}
              aria-expanded={moreOpen}
              aria-label="展开或收起文件夹、别名与颜色"
              title="文件夹 · 别名 · 颜色"
              disabled={busy}
              onClick={() => setMoreOpen((v) => !v)}
            >
              <span>更多</span>
              {!moreOpen && hasExtraMeta && (
                <span className="concept-kv-more-dot" aria-hidden="true" />
              )}
              <ChevronDown size={13} className="concept-kv-more-chevron" />
            </button>

            <Button
              type="button"
              size="sm"
              className="concept-kv-save-btn"
              disabled={!canSubmit}
              onClick={() => void handleSubmit()}
            >
              {busy ? (
                <Loader2 size={12} className="spin" />
              ) : (
                <Check size={12} />
              )}
              保存
            </Button>

            <button
              type="button"
              className="icon-button concept-kv-cancel-btn"
              aria-label="取消"
              title="取消"
              disabled={busy}
              onClick={onCancel}
            >
              <X size={14} />
            </button>
          </div>
        </div>

        <div
          className="concept-kv-extra-collapse"
          data-open={moreOpen ? "true" : "false"}
          aria-hidden={!moreOpen}
          inert={!moreOpen}
        >
          <div className="concept-kv-extra-inner">
            <div className="concept-kv-extra-tray">
              <select
                className="concept-kv-extra-select"
                aria-label="所在文件夹"
                value={folderId ?? ""}
                disabled={busy}
                onChange={(e) => setFolderId(e.target.value || null)}
              >
                <option value="">{CONCEPT_ROOT_LABEL}（根目录）</option>
                {flatFolders.map((item) => (
                  <option key={item.folder.id} value={item.folder.id}>
                    {"　".repeat(Math.max(0, item.depth - 1))}
                    {item.folder.title}
                  </option>
                ))}
              </select>

              <input
                type="text"
                className="concept-kv-extra-input"
                aria-label="别名"
                placeholder="别名，逗号分隔"
                value={aliases}
                disabled={busy}
                onChange={(e) => setAliases(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (canSubmit) void handleSubmit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    onCancel();
                  }
                }}
              />

              <div
                className="concept-kv-extra-colors"
                role="radiogroup"
                aria-label="概念颜色"
              >
                {ANNOTATION_COLORS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={cn(
                      "annotation-color-dot",
                      `color-${c.id}`,
                      color === c.id && "is-selected",
                    )}
                    aria-label={c.label}
                    aria-pressed={color === c.id}
                    title={c.label}
                    disabled={busy}
                    onClick={() => setColor(c.id)}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        {conflict && (
          <div className="concepts-conflict-alert" role="alert">
            <span className="concepts-conflict-alert-text">
              <AlertCircle size={15} />
              <span>{conflict.message}</span>
            </span>
            {conflict.existing && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onJumpExisting(conflict.existing!)}
              >
                跳转到已有概念
              </Button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
});

const ConceptDisplayRow = memo(function ConceptDisplayRow({
  concept,
  sourceQuestion,
  pathLabel,
  isFocused,
  isSelected,
  selectMode,
  isConfirmingDelete,
  isDeleting,
  deletingAny,
  setRowRef,
  onStartEdit,
  onOpenMove,
  onOpenQuestion,
  onOpenFolder,
  onStartConfirmDelete,
  onConfirmDelete,
  onToggleSelect,
  onDragStartConcept,
  onPointerDownConcept,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: {
  concept: ConceptView;
  sourceQuestion: QuestionView | null;
  pathLabel: string;
  isFocused: boolean;
  isSelected: boolean;
  selectMode: boolean;
  isConfirmingDelete: boolean;
  isDeleting: boolean;
  deletingAny: boolean;
  setRowRef: (id: string, el: HTMLTableRowElement | null) => void;
  onStartEdit: (concept: ConceptView) => void;
  onOpenMove: (concept: ConceptView) => void;
  onOpenQuestion: (q: QuestionView) => void;
  onOpenFolder: (folderId: string | null) => void;
  onStartConfirmDelete: (id: string) => void;
  onConfirmDelete: (concept: ConceptView) => void;
  onToggleSelect: (id: string) => void;
  onDragStartConcept: (e: React.DragEvent, id: string) => void;
  onPointerDownConcept: (e: React.PointerEvent, id: string) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const defRef = useRef<HTMLDivElement>(null);
  const defId = `concept-def-${concept.id}`;

  useEffect(() => {
    if (expanded) return;
    const el = defRef.current;
    if (!el) return;
    const measure = () => {
      setCanExpand(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, concept.definition]);

  return (
    <tr
      ref={(el) => setRowRef(concept.id, el)}
      data-concept-id={concept.id}
      draggable={!selectMode || isSelected}
      className={cn(
        "concept-row",
        isFocused && "is-focused",
        isSelected && "is-selected",
        isConfirmingDelete && "is-actions-pinned",
      )}
      onDragStart={(e) => onDragStartConcept(e, concept.id)}
      onPointerDown={(e) => onPointerDownConcept(e, concept.id)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClick={() => {
        if (selectMode) onToggleSelect(concept.id);
      }}
      onDoubleClick={(e) => {
        if (selectMode) return;
        if ((e.target as HTMLElement).closest("button, input, textarea, a")) {
          return;
        }
        onStartEdit(concept);
      }}
    >
      <td className="concept-cell-term">
        <div className="concept-term-header">
          {selectMode && (
            <button
              type="button"
              className={cn("concept-select-box", isSelected && "is-checked")}
              aria-label={
                isSelected
                  ? `取消选择 ${concept.term}`
                  : `选择 ${concept.term}`
              }
              aria-pressed={isSelected}
              onClick={(e) => {
                e.stopPropagation();
                onToggleSelect(concept.id);
              }}
            >
              {isSelected ? <CheckSquare size={16} /> : <Square size={16} />}
            </button>
          )}
          <span
            className={cn("concept-color-dot", `color-${concept.color}`)}
            aria-hidden="true"
          />
          <div className="concept-term-content">
            <span className="concept-term-text">{concept.term}</span>
            {pathLabel && (
              <button
                type="button"
                className="concept-path-badge"
                title={`打开所在位置：${concept.folderPath}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenFolder(concept.folderId ?? null);
                }}
              >
                <Folder size={11} />
                <span>{pathLabel}</span>
              </button>
            )}
          </div>
        </div>
      </td>

      <td className="concept-cell-def">
        <div
          ref={defRef}
          id={defId}
          className={cn("concept-def-body", !expanded && "is-clamped")}
        >
          {concept.definition}
        </div>
        {(canExpand || expanded) && (
          <button
            type="button"
            className={cn("concept-expand-btn", expanded && "is-expanded")}
            aria-expanded={expanded}
            aria-controls={defId}
            aria-label={
              expanded
                ? `收起 ${concept.term} 完整释义`
                : `展开 ${concept.term} 完整释义`
            }
            title={expanded ? "收起释义" : "展开全部释义"}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
          >
            <ChevronDown size={15} aria-hidden="true" />
          </button>
        )}

        {!selectMode && (
          <div
            className="concept-row-actions"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="concept-action-btn"
              aria-label={`编辑 ${concept.term}`}
              title="编辑"
              disabled={deletingAny}
              onClick={() => onStartEdit(concept)}
            >
              <PencilLine size={13} />
              <span>编辑</span>
            </button>

            <button
              type="button"
              className="concept-action-btn"
              aria-label={`移动 ${concept.term} 到文件夹`}
              title="移动到文件夹"
              disabled={deletingAny}
              onClick={() => onOpenMove(concept)}
            >
              <FolderInput size={13} />
              <span>移动</span>
            </button>

            {sourceQuestion && (
              <button
                type="button"
                className="concept-action-btn"
                aria-label={`查看来源题：${sourceQuestion.title}`}
                title={`来源题：${sourceQuestion.title}`}
                onClick={() => onOpenQuestion(sourceQuestion)}
              >
                <ArrowUpRight size={13} />
                <span>来源题</span>
              </button>
            )}

            {isConfirmingDelete ? (
              <button
                type="button"
                className="concept-action-btn is-confirm-danger"
                disabled={isDeleting}
                onClick={() => onConfirmDelete(concept)}
              >
                {isDeleting && <Loader2 size={12} className="spin" />}
                确认删除
              </button>
            ) : (
              <button
                type="button"
                className="concept-action-btn is-danger"
                aria-label={`删除 ${concept.term}`}
                title="删除"
                disabled={deletingAny}
                onClick={() => onStartConfirmDelete(concept.id)}
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
});

export function ConceptsView({
  data,
  mutate,
  folderId,
  focusConceptId,
  focusNonce = 0,
  onSelectFolder,
  onClearFocusConcept,
  onOpenQuestion,
}: {
  data: Workspace;
  mutate: WorkspaceMutate;
  folderId: string | null;
  focusConceptId?: string | null;
  focusNonce?: number;
  onSelectFolder: (folderId: string | null) => void;
  onClearFocusConcept?: () => void;
  onOpenQuestion: (q: QuestionView) => void;
}) {
  const concepts = data.concepts ?? [];
  const conceptFolders = data.conceptFolders ?? [];

  const index = useMemo(
    () => buildConceptFolderIndex(conceptFolders, concepts),
    [conceptFolders, concepts],
  );
  const activeFolder = folderId ? (index.byId.get(folderId) ?? null) : null;
  const currentFolderId = activeFolder ? activeFolder.id : null;

  // Search state (subtree-scoped by default inside a folder, toggleable to global).
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [searchGlobal, setSearchGlobal] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Reset folder-scoped search toggle & inline create/selection when switching folders.
  useEffect(() => {
    setSearchGlobal(false);
    setSelectMode(false);
    setSelectedFolderIds(new Set());
    setSelectedConceptIds(new Set());
    setEditingId(null);
    setCreateOpen(false);
  }, [currentFolderId]);

  // Inline create / edit triggers (typing state lives inside memoized child rows).
  const [createOpen, setCreateOpen] = useState(false);
  const [createOpenNonce, setCreateOpenNonce] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Two-step delete state.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Multi-select & drag-and-drop state.
  const [selectMode, setSelectMode] = useState(false);
  const multiselectBarPresence = useDiscretePresence<HTMLDivElement>(selectMode);
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedConceptIds, setSelectedConceptIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const longPressOrigin = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);

  // Folder dialogs state.
  const [createFolderParentId, setCreateFolderParentId] = useState<
    string | null | undefined
  >(undefined);
  const [editFolderTarget, setEditFolderTarget] =
    useState<ConceptFolderView | null>(null);
  const [moveSelection, setMoveSelection] =
    useState<ConceptMoveSelection | null>(null);
  const [groupIntoNewSelection, setGroupIntoNewSelection] = useState<{
    parentId: string | null;
    folderIds: string[];
    conceptIds: string[];
  } | null>(null);
  const [dissolveFolderTarget, setDissolveFolderTarget] =
    useState<ConceptFolderView | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] =
    useState<ConceptFolderView | null>(null);

  // Legacy annotation import state.
  const [importBannerDismissed, setImportBannerDismissed] = useState(false);
  const [importingLegacy, setImportingLegacy] = useState(false);

  // Deep-link focus pulse state.
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [pendingScrollId, setPendingScrollId] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());
  const highlightTimerRef = useRef<number | null>(null);
  const handledFocusKeyRef = useRef<string | null>(null);
  const currentFolderIdRef = useRef(currentFolderId);
  currentFolderIdRef.current = currentFolderId;
  const searchRef = useRef(search);
  searchRef.current = search;
  const onClearFocusConceptRef = useRef(onClearFocusConcept);
  onClearFocusConceptRef.current = onClearFocusConcept;

  const setRowRef = useCallback(
    (id: string, el: HTMLTableRowElement | null) => {
      if (el) rowRefs.current.set(id, el);
      else rowRefs.current.delete(id);
    },
    [],
  );

  const clearSelection = useCallback(() => {
    setSelectedFolderIds(new Set());
    setSelectedConceptIds(new Set());
    setSelectMode(false);
  }, []);

  const questionMap = useMemo(() => {
    const map = new Map<string, QuestionView>();
    for (const q of data.questions) map.set(q.id, q);
    return map;
  }, [data.questions]);

  const legacyAnnotations = useMemo(() => {
    const items: { questionId: string; annotationId: string }[] = [];
    for (const q of data.questions) {
      for (const a of q.annotations ?? []) {
        const trimmed = a.quote.trim();
        if (
          !a.conceptId &&
          trimmed.length > 0 &&
          trimmed.length <= MAX_CONCEPT_TERM_LENGTH
        ) {
          items.push({ questionId: q.id, annotationId: a.id });
        }
      }
    }
    return items;
  }, [data.questions]);

  const breadcrumbs = useMemo(
    () => (activeFolder ? index.breadcrumbsOf(activeFolder.id) : []),
    [activeFolder, index],
  );

  const currentChildFolders = useMemo(
    () => index.children.get(currentFolderId) ?? [],
    [index, currentFolderId],
  );

  const isSearching = Boolean(deferredSearch);
  const normSearch = useMemo(
    () => (deferredSearch ? normalizeConceptKey(deferredSearch) : ""),
    [deferredSearch],
  );

  const visibleConcepts = useMemo(() => {
    if (!isSearching) {
      return index.directConceptsByFolder.get(currentFolderId) ?? [];
    }
    let pool: readonly ConceptView[];
    if (searchGlobal || currentFolderId === null) {
      pool = concepts;
    } else {
      const allowedFolders = index.subtreeIds(currentFolderId);
      pool = concepts.filter((c) => allowedFolders.has(c.folderId ?? null));
    }
    const matched = pool.filter((c) =>
      conceptMatchesQuery(c, deferredSearch, normSearch),
    );
    return sortConceptsNatural(matched);
  }, [
    isSearching,
    searchGlobal,
    currentFolderId,
    concepts,
    index,
    deferredSearch,
    normSearch,
  ]);

  const atLimit = concepts.length >= MAX_CONCEPTS;
  const atMaxFolderDepth =
    currentFolderId !== null &&
    index.depthOf(currentFolderId) >= MAX_FOLDER_DEPTH;

  // Auto-reset 2-step delete confirmation after 3.5s.
  useEffect(() => {
    if (!confirmDeleteId) return;
    const timer = window.setTimeout(() => setConfirmDeleteId(null), 3500);
    return () => window.clearTimeout(timer);
  }, [confirmDeleteId]);

  // Clean up timers on unmount.
  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) {
        window.clearTimeout(highlightTimerRef.current);
      }
      if (longPressTimer.current) {
        window.clearTimeout(longPressTimer.current);
      }
    };
  }, []);

  const triggerRowPulse = useCallback(
    (conceptId: string, clearFocusProp = false) => {
      setHighlightedId(null);
      requestAnimationFrame(() => {
        setHighlightedId(conceptId);
      });
      if (highlightTimerRef.current) {
        window.clearTimeout(highlightTimerRef.current);
      }
      highlightTimerRef.current = window.setTimeout(() => {
        setHighlightedId(null);
        if (clearFocusProp) {
          onClearFocusConceptRef.current?.();
        }
      }, 2500);
    },
    [],
  );

  const focusConceptRow = useCallback(
    (conceptId: string, targetFolderId?: string | null) => {
      const target = concepts.find((c) => c.id === conceptId);
      const resolvedFolderId =
        targetFolderId !== undefined
          ? targetFolderId
          : target
            ? (target.folderId ?? null)
            : undefined;
      if (resolvedFolderId === undefined) return;
      if (searchRef.current.trim()) {
        setSearch("");
      }
      if (currentFolderIdRef.current !== resolvedFolderId) {
        onSelectFolder(resolvedFolderId);
      }
      setPendingScrollId(conceptId);
    },
    [concepts, onSelectFolder],
  );

  // Trigger deep-link focus ONCE per (focusConceptId, focusNonce) from Reader popover or URL.
  useEffect(() => {
    if (!focusConceptId) {
      handledFocusKeyRef.current = null;
      return;
    }
    const focusKey = `${focusConceptId}:${focusNonce}`;
    if (handledFocusKeyRef.current === focusKey) return;
    const target = concepts.find((c) => c.id === focusConceptId);
    if (!target) return;
    handledFocusKeyRef.current = focusKey;
    focusConceptRow(focusConceptId, target.folderId ?? null);
  }, [focusConceptId, focusNonce, concepts, focusConceptRow]);

  // Scroll & pulse target row once rendered.
  useEffect(() => {
    if (!pendingScrollId) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const node = rowRefs.current.get(pendingScrollId);
        if (node) {
          node.scrollIntoView({ behavior: "smooth", block: "center" });
          triggerRowPulse(pendingScrollId, true);
          setPendingScrollId(null);
        }
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [pendingScrollId, visibleConcepts, currentFolderId, triggerRowPulse]);

  // Prune selection if items or folders disappear.
  useEffect(() => {
    if (!selectedConceptIds.size && !selectedFolderIds.size) return;
    const validConcepts = new Set(concepts.map((c) => c.id));
    const validFolders = new Set(conceptFolders.map((f) => f.id));
    setSelectedConceptIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (validConcepts.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
    setSelectedFolderIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (validFolders.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [concepts, conceptFolders, selectedConceptIds.size, selectedFolderIds.size]);

  const handleOpenCreateRow = useCallback(() => {
    if (atLimit) {
      toast.error(`概念库最多保存 ${MAX_CONCEPTS} 条概念。`);
      return;
    }
    setEditingId(null);
    clearSelection();
    if (searchRef.current.trim()) {
      setSearch("");
    }
    setCreateOpen(true);
    setCreateOpenNonce((n) => n + 1);
  }, [atLimit, clearSelection]);

  const handleCreatedConcept = useCallback(
    (created: ConceptView | undefined) => {
      if (created?.id) {
        triggerRowPulse(created.id, false);
      }
    },
    [triggerRowPulse],
  );

  const handleStartEdit = useCallback(
    (concept: ConceptView) => {
      setCreateOpen(false);
      setConfirmDeleteId(null);
      setEditingId(concept.id);
    },
    [],
  );

  const handleOpenMoveConcept = useCallback((concept: ConceptView) => {
    setMoveSelection({
      conceptIds: [concept.id],
      label: concept.term,
      initialTargetId: concept.folderId ?? null,
    });
  }, []);

  const handleConfirmDeleteConcept = useCallback(
    async (concept: ConceptView) => {
      if (deletingId) return;
      setDeletingId(concept.id);
      try {
        const res = await deleteConcept(mutate, concept.id);
        if (res) {
          setConfirmDeleteId(null);
          setEditingId((prev) => (prev === concept.id ? null : prev));
          toast.success(`已删除概念「${concept.term}」。`);
        }
      } finally {
        setDeletingId(null);
      }
    },
    [deletingId, mutate],
  );

  const handleConfirmDeleteClick = useCallback(
    (concept: ConceptView) => {
      void handleConfirmDeleteConcept(concept);
    },
    [handleConfirmDeleteConcept],
  );

  const toggleFolderSelect = useCallback((id: string) => {
    setSelectedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleConceptSelect = useCallback((id: string) => {
    setSelectedConceptIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const startLongPress = useCallback(
    (e: React.PointerEvent, onTrigger: () => void) => {
      if (e.pointerType === "mouse" || selectMode) return;
      longPressOrigin.current = { x: e.clientX, y: e.clientY };
      if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
      longPressTimer.current = window.setTimeout(() => {
        longPressTimer.current = null;
        suppressClickRef.current = true;
        setSelectMode(true);
        onTrigger();
      }, 450);
    },
    [selectMode],
  );

  const moveLongPress = useCallback((e: React.PointerEvent) => {
    if (!longPressTimer.current || !longPressOrigin.current) return;
    if (
      Math.hypot(
        e.clientX - longPressOrigin.current.x,
        e.clientY - longPressOrigin.current.y,
      ) > 10
    ) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handlePointerDownConcept = useCallback(
    (e: React.PointerEvent, id: string) => {
      startLongPress(e, () => toggleConceptSelect(id));
    },
    [startLongPress, toggleConceptSelect],
  );

  const startDrag = useCallback(
    (e: React.DragEvent, kind: "folder" | "concept", id: string) => {
      let payload: ConceptDragPayload;
      const isInSelection =
        (kind === "folder" && selectedFolderIds.has(id)) ||
        (kind === "concept" && selectedConceptIds.has(id));
      if (selectMode && isInSelection) {
        payload = {
          kind: "mixed",
          folderIds: [...selectedFolderIds],
          conceptIds: [...selectedConceptIds],
        };
      } else {
        payload = { kind, ids: [id] };
      }
      const encoded = JSON.stringify(payload);
      e.dataTransfer.setData(CONCEPT_DRAG_MIME, encoded);
      e.dataTransfer.setData("text/plain", encoded);
      e.dataTransfer.effectAllowed = "move";
    },
    [selectMode, selectedFolderIds, selectedConceptIds],
  );

  const handleDragStartConcept = useCallback(
    (e: React.DragEvent, id: string) => startDrag(e, "concept", id),
    [startDrag],
  );

  const handleDropMove = useCallback(
    async (targetFolderId: string | null, payload: ConceptDragPayload) => {
      const rawFolderIds =
        payload.kind === "folder"
          ? payload.ids
          : payload.kind === "mixed"
            ? payload.folderIds
            : [];
      const rawConceptIds =
        payload.kind === "concept"
          ? payload.ids
          : payload.kind === "mixed"
            ? payload.conceptIds
            : [];

      if (targetFolderId) {
        const selfCycle = rawFolderIds.some((fid) =>
          index.descendantIds(fid).has(targetFolderId),
        );
        if (selfCycle) {
          if (
            rawFolderIds.length === 1 &&
            rawConceptIds.length === 0 &&
            rawFolderIds[0] === targetFolderId
          ) {
            return;
          }
          toast.error("不能将文件夹移动到自身或其子文件夹中。");
          return;
        }
      }

      const conceptById = new Map(concepts.map((c) => [c.id, c]));
      const fIds = rawFolderIds.filter((fid) => {
        const f = index.byId.get(fid);
        return Boolean(f && (f.parentId ?? null) !== targetFolderId);
      });
      const cIds = rawConceptIds.filter((cid) => {
        const c = conceptById.get(cid);
        return Boolean(c && (c.folderId ?? null) !== targetFolderId);
      });
      if (fIds.length === 0 && cIds.length === 0) return;

      const targetLabel = targetFolderId
        ? index.pathOf(targetFolderId)
        : CONCEPT_ROOT_LABEL;
      const remainingFolders = [...fIds];
      let remainingConcepts = [...cIds];

      try {
        while (remainingFolders.length > 0) {
          const fid = remainingFolders[0];
          const res = await moveConceptFolder(
            mutate,
            {
              folderId: fid,
              targetParentId: targetFolderId,
              conflictStrategy: "abort",
            },
            { throwOnCodes: ["FOLDER_NAME_CONFLICT"] },
          );
          if (!res) return;
          remainingFolders.shift();
        }
        if (remainingConcepts.length > 0) {
          const res = await moveConceptsToFolder(
            mutate,
            remainingConcepts,
            targetFolderId,
          );
          if (!res) return;
          remainingConcepts = [];
        }
        clearSelection();
        toast.success(`已移动到「${targetLabel}」。`);
      } catch (e) {
        if (e instanceof RequestError && e.code === "FOLDER_NAME_CONFLICT") {
          const conflicts = Array.isArray(e.details?.conflicts)
            ? (e.details!.conflicts as FolderConflictItem[])
            : [];
          setMoveSelection({
            folderIds: remainingFolders,
            conceptIds: remainingConcepts,
            initialTargetId: targetFolderId,
            ...(conflicts.length ? { initialFolderConflicts: conflicts } : {}),
          });
          toast.info("目标位置存在同名文件夹，请在移动面板中选择处理方式。");
        } else {
          toast.error(e instanceof Error ? e.message : "移动失败，请重试。");
        }
      }
    },
    [index, concepts, mutate, clearSelection],
  );

  async function handleImportLegacyAnnotations() {
    if (importingLegacy || !legacyAnnotations.length) return;
    setImportingLegacy(true);
    try {
      const res = await importConceptsFromAnnotations(mutate, {
        folderId: currentFolderId,
      });
      if (res) {
        const created = Number(res.created ?? 0);
        const linked = Number(res.linked ?? 0);
        toast.success(
          created > 0
            ? `已归入概念库：新增 ${created} 条概念，关联 ${linked} 条批注。`
            : `已将 ${linked} 条批注关联到概念库中的已有概念。`,
        );
      }
    } finally {
      setImportingLegacy(false);
    }
  }

  const totalSelectedCount = selectedFolderIds.size + selectedConceptIds.size;
  const currentScopeTotal = activeFolder
    ? activeFolder.count
    : concepts.length;
  const hasAnythingInScope =
    currentChildFolders.length > 0 || visibleConcepts.length > 0;

  return (
    <div className="page library-shell concepts-shell">
      <ConceptFolderTree
        userId={data.user.id}
        folders={conceptFolders}
        totalConcepts={concepts.length}
        activeFolderId={currentFolderId}
        onSelectFolder={onSelectFolder}
        onDropMove={(targetId, payload) => void handleDropMove(targetId, payload)}
      />

      <div className="library-main-pane">
        {/* Breadcrumb bar (also drag-to-move drop target) */}
        <nav className="library-breadcrumb" aria-label="概念路径">
          <button
            type="button"
            className={`library-crumb ${!activeFolder ? "is-current" : ""} ${dragOverTarget === "CRUMB_ROOT" ? "is-drag-over" : ""}`}
            onClick={() => onSelectFolder(null)}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(CONCEPT_DRAG_MIME)) {
                e.preventDefault();
                setDragOverTarget("CRUMB_ROOT");
              }
            }}
            onDragLeave={() => {
              if (dragOverTarget === "CRUMB_ROOT") setDragOverTarget(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverTarget(null);
              const p = parseConceptDragPayload(e.dataTransfer);
              if (p) void handleDropMove(null, p);
            }}
          >
            <Home size={14} />
            <span>{CONCEPT_ROOT_LABEL}</span>
          </button>

          {breadcrumbs.map((crumb, idx) => {
            const isLast = idx === breadcrumbs.length - 1;
            return (
              <span key={crumb.id} className="library-crumb-wrap">
                <ChevronRight size={13} className="library-crumb-sep" />
                <button
                  type="button"
                  className={`library-crumb ${isLast ? "is-current" : ""} ${dragOverTarget === `CRUMB_${crumb.id}` ? "is-drag-over" : ""}`}
                  onClick={() => onSelectFolder(crumb.id)}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes(CONCEPT_DRAG_MIME)) {
                      e.preventDefault();
                      setDragOverTarget(`CRUMB_${crumb.id}`);
                    }
                  }}
                  onDragLeave={() => {
                    if (dragOverTarget === `CRUMB_${crumb.id}`) {
                      setDragOverTarget(null);
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOverTarget(null);
                    const p = parseConceptDragPayload(e.dataTransfer);
                    if (p) void handleDropMove(crumb.id, p);
                  }}
                >
                  {crumb.title}
                </button>
              </span>
            );
          })}
        </nav>

        {/* Single-entry header bar: ONE 新建文件夹 + ONE 新增概念 */}
        <header className="library-pane-header">
          <div className="library-pane-title-wrap">
            <div>
              <h1>{activeFolder ? activeFolder.title : CONCEPT_ROOT_LABEL}</h1>
              <div className="concepts-heading-meta">
                <span>共 {currentScopeTotal} 条概念</span>
                {currentChildFolders.length > 0 && (
                  <>
                    <span className="concepts-heading-dot" aria-hidden="true">
                      ·
                    </span>
                    <span>{currentChildFolders.length} 个子文件夹</span>
                  </>
                )}
                {!activeFolder && (
                  <>
                    <span
                      className="concepts-heading-dot concepts-heading-hint-dot"
                      aria-hidden="true"
                    >
                      ·
                    </span>
                    <span className="concepts-heading-hint">
                      阅读题目时开启「概念」即可自动浮窗释义
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="library-pane-actions">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={atMaxFolderDepth}
              title={
                atMaxFolderDepth
                  ? `最多嵌套 ${MAX_FOLDER_DEPTH} 层文件夹`
                  : "新建文件夹"
              }
              onClick={() => setCreateFolderParentId(currentFolderId)}
            >
              <FolderPlus size={14} /> 新建文件夹
            </Button>

            <Button
              type="button"
              size="sm"
              disabled={atLimit}
              title={atLimit ? `最多保存 ${MAX_CONCEPTS} 条概念` : "新增概念"}
              onClick={handleOpenCreateRow}
            >
              <Plus size={14} /> 新增概念
            </Button>

            {activeFolder && (
              <ActionMenu label="当前文件夹操作">
                <button
                  type="button"
                  onClick={() => setEditFolderTarget(activeFolder)}
                >
                  <PenLine size={14} /> 重命名 / 颜色
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setMoveSelection({
                      folderIds: [activeFolder.id],
                      label: activeFolder.title,
                      initialTargetId: activeFolder.parentId,
                    })
                  }
                >
                  <FolderInput size={14} /> 移动到文件夹…
                </button>
                <button
                  type="button"
                  onClick={() => setDissolveFolderTarget(activeFolder)}
                >
                  <FolderMinus size={14} /> 解散文件夹
                </button>
                <button
                  type="button"
                  className="danger-text"
                  onClick={() => setDeleteFolderTarget(activeFolder)}
                >
                  <Trash2 size={14} /> 删除文件夹
                </button>
              </ActionMenu>
            )}
          </div>
        </header>

        {/* Legacy annotation import banner */}
        {legacyAnnotations.length > 0 && !importBannerDismissed && (
          <div className="concepts-import-banner" role="status">
            <div className="concepts-import-info">
              <span className="concepts-import-icon" aria-hidden="true">
                <Sparkles size={14} />
              </span>
              <div className="concepts-import-text">
                <strong>
                  发现 {legacyAnnotations.length} 条尚未同步到概念库的批注
                </strong>
                <span>
                  一键归入后，这些词条会在所有题目中自动识别并支持点击浮窗查看释义
                </span>
              </div>
            </div>
            <div className="concepts-import-actions">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={importingLegacy}
                onClick={() => void handleImportLegacyAnnotations()}
              >
                {importingLegacy ? (
                  <Loader2 size={13} className="spin" />
                ) : (
                  <BookMarked size={13} />
                )}
                一键归入概念库
              </Button>
              <button
                type="button"
                className="icon-button"
                aria-label="暂时收起提示"
                title="暂时收起"
                onClick={() => setImportBannerDismissed(true)}
              >
                <X size={15} />
              </button>
            </div>
          </div>
        )}

        {/* Search & multiselect toolbar */}
        {(concepts.length > 0 || conceptFolders.length > 0) && (
          <div className="library-toolbar">
            <div className="library-search-box">
              <Search size={15} aria-hidden="true" />
              <input
                ref={searchInputRef}
                type="search"
                aria-label="搜索概念"
                value={search}
                onChange={(e) => {
                  setPendingScrollId(null);
                  setSearch(e.target.value);
                }}
                placeholder={
                  searchGlobal || !activeFolder
                    ? "在全部概念中搜索名称、别名、释义或路径…"
                    : `在「${activeFolder.title}」及子文件夹中搜索…`
                }
              />
              {search && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="清空搜索"
                  onClick={() => {
                    setSearch("");
                    searchInputRef.current?.focus();
                  }}
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {activeFolder && isSearching && (
              <Button
                type="button"
                size="sm"
                variant={searchGlobal ? "secondary" : "outline"}
                onClick={() => setSearchGlobal((v) => !v)}
              >
                {searchGlobal
                  ? `仅搜「${activeFolder.title}」`
                  : "在全部概念中搜索"}
              </Button>
            )}

            <div className="library-toolbar-right">
              {isSearching && (
                <span className="muted small">
                  匹配 {visibleConcepts.length} 条
                </span>
              )}
              {hasAnythingInScope && (
                <Button
                  type="button"
                  size="sm"
                  variant={selectMode ? "secondary" : "ghost"}
                  onClick={() => {
                    if (selectMode) {
                      clearSelection();
                    } else {
                      setCreateOpen(false);
                      setEditingId(null);
                      setSelectMode(true);
                    }
                  }}
                >
                  <CheckSquare size={14} />{" "}
                  {selectMode ? "完成多选" : "多选"}
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Multiselect action bar */}
        <div
          ref={multiselectBarPresence.ref}
          hidden={multiselectBarPresence.isHidden}
          data-closing={multiselectBarPresence.isClosing ? "" : undefined}
          aria-hidden={!selectMode}
          inert={!selectMode || multiselectBarPresence.isClosing}
          className="library-multiselect-bar"
          role="region"
          aria-label="批量操作"
        >
          <span className="small">
            已选 <strong>{totalSelectedCount}</strong> 项
          </span>
          <div className="library-multiselect-actions">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={totalSelectedCount === 0}
              onClick={() =>
                setGroupIntoNewSelection({
                  parentId: currentFolderId,
                  folderIds: [...selectedFolderIds],
                  conceptIds: [...selectedConceptIds],
                })
              }
            >
              <FolderPlus size={14} /> 归入新文件夹
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={totalSelectedCount === 0}
              onClick={() =>
                setMoveSelection({
                  folderIds: [...selectedFolderIds],
                  conceptIds: [...selectedConceptIds],
                  initialTargetId: currentFolderId,
                })
              }
            >
              <FolderInput size={14} /> 移动
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={clearSelection}
            >
              取消
            </Button>
          </div>
        </div>

        {/* Current-level Subfolders pinned on top (hidden while searching) */}
        {!isSearching && currentChildFolders.length > 0 && (
          <section
            className="library-folders-section"
            aria-label="子文件夹"
          >
            <div className="library-folder-grid">
              {currentChildFolders.map((folder) => {
                const checked = selectedFolderIds.has(folder.id);
                const isDragOver = dragOverTarget === folder.id;
                return (
                  <div
                    key={folder.id}
                    className={`library-folder-row color-${folder.color} ${checked ? "is-selected" : ""} ${isDragOver ? "is-drag-over" : ""}`}
                    draggable={!selectMode || checked}
                    onDragStart={(e) => startDrag(e, "folder", folder.id)}
                    onDragOver={(e) => {
                      if (e.dataTransfer.types.includes(CONCEPT_DRAG_MIME)) {
                        e.preventDefault();
                        setDragOverTarget(folder.id);
                      }
                    }}
                    onDragLeave={() => {
                      if (dragOverTarget === folder.id) setDragOverTarget(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOverTarget(null);
                      const p = parseConceptDragPayload(e.dataTransfer);
                      if (p) void handleDropMove(folder.id, p);
                    }}
                    onPointerDown={(e) =>
                      startLongPress(e, () => toggleFolderSelect(folder.id))
                    }
                    onPointerMove={moveLongPress}
                    onPointerUp={cancelLongPress}
                    onPointerCancel={cancelLongPress}
                  >
                    {selectMode && (
                      <button
                        type="button"
                        className="library-row-check"
                        aria-label={`选择文件夹 ${folder.title}`}
                        aria-pressed={checked}
                        onClick={() => toggleFolderSelect(folder.id)}
                      >
                        {checked ? (
                          <CheckSquare size={16} />
                        ) : (
                          <Square size={16} />
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      className="library-folder-main"
                      onClick={() => {
                        if (suppressClickRef.current) {
                          suppressClickRef.current = false;
                          return;
                        }
                        if (selectMode) toggleFolderSelect(folder.id);
                        else onSelectFolder(folder.id);
                      }}
                    >
                      <span className="library-folder-icon">
                        <Folder size={18} />
                      </span>
                      <span className="library-folder-info">
                        <strong className="library-folder-name">
                          {folder.title}
                        </strong>
                        <small className="muted">{folder.count} 条概念</small>
                      </span>
                    </button>
                    {!selectMode && (
                      <ActionMenu label={`文件夹 ${folder.title} 的操作`}>
                        <button
                          type="button"
                          onClick={() => onSelectFolder(folder.id)}
                        >
                          <FolderOpen size={14} /> 打开
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditFolderTarget(folder)}
                        >
                          <PenLine size={14} /> 重命名 / 颜色
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setMoveSelection({
                              folderIds: [folder.id],
                              label: folder.title,
                              initialTargetId: folder.parentId,
                            })
                          }
                        >
                          <FolderInput size={14} /> 移动到…
                        </button>
                        <button
                          type="button"
                          onClick={() => setDissolveFolderTarget(folder)}
                        >
                          <FolderMinus size={14} /> 解散文件夹
                        </button>
                        <button
                          type="button"
                          className="danger-text"
                          onClick={() => setDeleteFolderTarget(folder)}
                        >
                          <Trash2 size={14} /> 删除文件夹
                        </button>
                      </ActionMenu>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Headless 2-column K-V table (current-folder concepts + inline K-V create row at top) */}
        <section className="library-items-section" aria-label="概念列表">
          {createOpen || visibleConcepts.length > 0 ? (
            <div className="concepts-table-card">
              <table className="concepts-table">
                <colgroup>
                  <col className="concepts-col-term" />
                  <col className="concepts-col-def" />
                </colgroup>
                <tbody>
                  {createOpen && (
                    <ConceptKvCreateRow
                      folderId={currentFolderId}
                      concepts={concepts}
                      mutate={mutate}
                      openNonce={createOpenNonce}
                      onCreated={handleCreatedConcept}
                      onCancel={() => setCreateOpen(false)}
                      onJumpExisting={(existing) => {
                        setCreateOpen(false);
                        focusConceptRow(existing.id, existing.folderId ?? null);
                      }}
                    />
                  )}

                  {visibleConcepts.map((concept) => {
                    if (editingId === concept.id) {
                      return (
                        <ConceptKvEditRow
                          key={concept.id}
                          concept={concept}
                          concepts={concepts}
                          flatFolders={index.flatList}
                          mutate={mutate}
                          setRowRef={setRowRef}
                          onDone={() => setEditingId(null)}
                          onCancel={() => setEditingId(null)}
                          onJumpExisting={(existing) => {
                            setEditingId(null);
                            focusConceptRow(
                              existing.id,
                              existing.folderId ?? null,
                            );
                          }}
                        />
                      );
                    }

                    const sourceQuestion = concept.sourceQuestionId
                      ? (questionMap.get(concept.sourceQuestionId) ?? null)
                      : null;
                    const pathLabel = isSearching
                      ? searchGlobal || currentFolderId === null
                        ? concept.folderId
                          ? concept.folderPath
                          : CONCEPT_ROOT_LABEL
                        : index.relativePathOf(
                            concept.folderId ?? null,
                            currentFolderId,
                          )
                      : "";

                    return (
                      <ConceptDisplayRow
                        key={concept.id}
                        concept={concept}
                        sourceQuestion={sourceQuestion}
                        pathLabel={pathLabel}
                        isFocused={highlightedId === concept.id}
                        isSelected={selectedConceptIds.has(concept.id)}
                        selectMode={selectMode}
                        isConfirmingDelete={confirmDeleteId === concept.id}
                        isDeleting={deletingId === concept.id}
                        deletingAny={Boolean(deletingId)}
                        setRowRef={setRowRef}
                        onStartEdit={handleStartEdit}
                        onOpenMove={handleOpenMoveConcept}
                        onOpenQuestion={onOpenQuestion}
                        onOpenFolder={onSelectFolder}
                        onStartConfirmDelete={setConfirmDeleteId}
                        onConfirmDelete={handleConfirmDeleteClick}
                        onToggleSelect={toggleConceptSelect}
                        onDragStartConcept={handleDragStartConcept}
                        onPointerDownConcept={handlePointerDownConcept}
                        onPointerMove={moveLongPress}
                        onPointerUp={cancelLongPress}
                        onPointerCancel={cancelLongPress}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            (isSearching || currentChildFolders.length === 0) && (
              <div className="empty-state-card">
                {isSearching ? (
                  <Search size={26} />
                ) : activeFolder ? (
                  <FolderOpen size={28} />
                ) : (
                  <BookMarked size={26} />
                )}
                <h3>
                  {isSearching
                    ? "当前范围没有匹配的概念"
                    : activeFolder
                      ? "这个文件夹还是空的"
                      : "还没有沉淀任何概念"}
                </h3>
                <p className="muted small">
                  {isSearching
                    ? activeFolder && !searchGlobal
                      ? "可点击上方「在全部概念中搜索」查看其他文件夹中的内容。"
                      : "换个关键词试试，或点击上方「新增概念」记录新词条。"
                    : "点击上方「新增概念」以键值对形式快速录入，或「新建文件夹」分级整理。"}
                </p>
                {isSearching && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setSearch("")}
                  >
                    清空搜索
                  </Button>
                )}
              </div>
            )
          )}
        </section>
      </div>

      {createFolderParentId !== undefined && (
        <CreateConceptFolderDialog
          open
          parentId={createFolderParentId}
          folders={conceptFolders}
          mutate={mutate}
          onClose={() => setCreateFolderParentId(undefined)}
          onCreated={(id) => onSelectFolder(id)}
        />
      )}

      {editFolderTarget && (
        <EditConceptFolderDialog
          folder={
            conceptFolders.find((f) => f.id === editFolderTarget.id) ??
            editFolderTarget
          }
          mutate={mutate}
          onClose={() => setEditFolderTarget(null)}
        />
      )}

      {moveSelection && (
        <ConceptFolderMoveDialog
          selection={moveSelection}
          folders={conceptFolders}
          mutate={mutate}
          onClose={() => setMoveSelection(null)}
          onDone={() => clearSelection()}
        />
      )}

      {groupIntoNewSelection && (
        <GroupIntoNewConceptFolderDialog
          open
          parentId={groupIntoNewSelection.parentId}
          folders={conceptFolders}
          folderIds={groupIntoNewSelection.folderIds}
          conceptIds={groupIntoNewSelection.conceptIds}
          mutate={mutate}
          onClose={() => setGroupIntoNewSelection(null)}
          onDone={(createdId) => {
            clearSelection();
            onSelectFolder(createdId);
          }}
        />
      )}

      {dissolveFolderTarget && (
        <DissolveConceptFolderDialog
          folder={
            conceptFolders.find((f) => f.id === dissolveFolderTarget.id) ??
            dissolveFolderTarget
          }
          folders={conceptFolders}
          mutate={mutate}
          onClose={() => setDissolveFolderTarget(null)}
          onDone={(parentId) => {
            if (currentFolderId === dissolveFolderTarget.id) {
              onSelectFolder(parentId);
            }
          }}
        />
      )}

      {deleteFolderTarget && (
        <DeleteConceptFolderDialog
          folder={
            conceptFolders.find((f) => f.id === deleteFolderTarget.id) ??
            deleteFolderTarget
          }
          folders={conceptFolders}
          mutate={mutate}
          onClose={() => setDeleteFolderTarget(null)}
          onSwitchToDissolve={(folder) => setDissolveFolderTarget(folder)}
          onDone={(parentId) => {
            if (currentFolderId === deleteFolderTarget.id) {
              onSelectFolder(parentId);
            }
          }}
        />
      )}
    </div>
  );
}
