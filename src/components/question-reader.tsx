"use client";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";
import {
  ArrowLeft,
  ArrowRight,
  Star,
  PencilLine,
  Sparkles,
  Eye,
  EyeOff,
  MessageSquare,
  X,
  Archive,
  Copy,
  Check,
  Loader2,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  Clock,
  Play,
  Pause,
  BookOpen,
  BookMarked,
  Mic,
  PenLine,
  Trash2,
  FolderInput,
  Sun,
  Moon,
  List,
  MessageSquareText,
  Highlighter,
  Columns2,
  Rows2,
} from "lucide-react";
import { toast } from "sonner";
import type { DuplicateHit, QuestionView, Workspace } from "@/lib/types";
import { api } from "@/lib/client";
import {
  applyAnnotationHighlights,
  readAnnotationSidebarPref,
  readReviewCompareLayoutPref,
  writeAnnotationSidebarPref,
  writeReviewCompareLayoutPref,
} from "@/lib/annotations";
import {
  MAX_CONCEPT_TERM_LENGTH,
  applyConceptLinks,
  findConceptMatchesInText,
  readConceptLinksPref,
  writeConceptLinksPref,
} from "@/lib/concepts";
import { getDeviceProfile, useDeviceProfile } from "@/lib/device-profile";
import { toggleAppearanceTheme, useAppearance } from "@/lib/theme";
import { buildFolderIndex, ROOT_FOLDER_LABEL } from "@/lib/folders";
import { relativeDue } from "@/lib/utils";
import { markdownDocument, mergeQuestionTags } from "@/lib/markdown-source";
import {
  practiceDraftKey,
  readPracticeDraft,
  savePracticeDraft,
  studyDocument,
} from "@/lib/study-document";
import { Button } from "./ui/button";
import { ActionMenu } from "./ui/action-menu";
import { Dialog } from "./ui/dialog";
import { ObsidianProperties } from "./markdown";
import { ParagraphPractice, FollowupCards } from "./paragraph-practice";
import { ContentValidationPanel } from "./content-validation";
import { QuestionAnnotationsPanel } from "./question-annotations-panel";
import { ConceptPopover, type ConceptAnchorRect } from "./concept-popover";
import { QuestionNotePanel } from "./question-note-panel";
import {
  InlineAnswerEditor,
  type InlineQuestionDraft,
} from "./inline-answer-editor";
import type { Mutate } from "./dialogs";
import type { ImportSeed } from "./import-dialog";
import { useDiscretePresence } from "./use-discrete-presence";

type Insight = {
  previews: { rating: number; due: string; interval: string }[];
  curve: { day: number; retention: number }[];
};
type ReaderTab = "answer" | "followups" | "notes" | "memory";
const SourceDialog = dynamic(() =>
  import("./source-dialog").then((m) => m.SourceDialog),
);
function Curve({ curve }: { curve: Insight["curve"] }) {
  const points = curve
    .map(
      (p) =>
        `${36 + (p.day / 30) * 360},${15 + ((100 - p.retention) / 100) * 104}`,
    )
    .join(" ");
  return (
    <div className="memory-curve">
      <svg viewBox="0 0 420 145" role="img" aria-label="预测遗忘曲线">
        {[0, 50, 100].map((value) => (
          <g key={value}>
            <line
              x1="36"
              x2="396"
              y1={15 + (100 - value) * 1.04}
              y2={15 + (100 - value) * 1.04}
              stroke="var(--border)"
              strokeDasharray="3 5"
            />
            <text x="5" y={19 + (100 - value) * 1.04}>
              {value}%
            </text>
          </g>
        ))}
        {curve.length > 0 && (
          <polyline
            points={points}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
        )}
        {[0, 7, 14, 21, 30].map((value) => (
          <text
            key={value}
            x={36 + (value / 30) * 360}
            y="140"
            textAnchor="middle"
          >
            {value ? `${value}天` : "今天"}
          </text>
        ))}
      </svg>
      {!curve.length && (
        <span className="curve-empty">
          完成首次答题自评后，将绘制未来 30 天记忆曲线
        </span>
      )}
    </div>
  );
}

function ReaderMobileThemeButton() {
  const { theme } = useAppearance();
  return (
    <button
      type="button"
      className="icon-button reader-mobile-theme-btn"
      aria-label={theme === "dark" ? "切换浅色模式" : "切换深色模式"}
      onClick={toggleAppearanceTheme}
    >
      {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  );
}

export function QuestionReader({
  question,
  data,
  onBack,
  backLabel = "返回资料",
  onBatchImport,
  onDelete,
  onMove,
  onGenerateAnswer,
  onFavorite,
  mutate,
  review,
  cram,
  cramLabel,
  onGrade,
  busy,
  progress,
  prevNext,
  onSingleReview,
  aiOpen = false,
  aiDocked = false,
  onToggleAi,
  onAskAi,
  onBeforeOpenAnnotations,
  onRevealedChange,
  readingList,
  onJumpQuestion,
  onOpenFolder,
  onOpenConcept,
}: {
  question: QuestionView;
  data: Workspace;
  onBack: () => void;
  backLabel?: string;
  onBatchImport?: (seed: ImportSeed, onCommitted: () => void) => void;
  onDelete: () => void;
  onMove: () => void;
  onGenerateAnswer: (q: QuestionView) => void;
  onFavorite: () => void;
  mutate: Mutate;
  review?: boolean;
  cram?: boolean;
  cramLabel?: string;
  onGrade?: (rating: number, answer: string) => void;
  busy?: boolean;
  progress?: { current: number; total: number };
  prevNext?: {
    index: number;
    total: number;
    hasPrev: boolean;
    hasNext: boolean;
    prevTitle?: string;
    nextTitle?: string;
    onPrev: () => void;
    onNext: () => void;
  };
  onSingleReview?: () => void;
  aiOpen?: boolean;
  aiDocked?: boolean;
  onToggleAi?: (open?: boolean) => void;
  onAskAi?: (request: {
    quote: string;
    prompt: string;
    attempt?: string;
  }) => void;
  onBeforeOpenAnnotations?: () => void;
  onRevealedChange?: (revealed: boolean) => void;
  readingList?: QuestionView[];
  onJumpQuestion?: (q: QuestionView) => void;
  onOpenFolder?: (folderId: string | null) => void;
  onOpenConcept?: (conceptId: string) => void;
}) {
  const device = useDeviceProfile();
  const [outlineOpen, setOutlineOpen] = useState(false);
  const outlineWrapRef = useRef<HTMLDivElement>(null);
  const currentOutlineItemRef = useRef<HTMLButtonElement>(null);
  const [revealed, setRevealed] = useState(!review);
  const [compareLayout, setCompareLayout] = useState<"split" | "stack">(() =>
    readReviewCompareLayoutPref(),
  );
  const [oralScratchpadOpen, setOralScratchpadOpen] = useState(false);
  const [annotationsOpen, setAnnotationsOpen] = useState<boolean>(
    () =>
      !review &&
      !getDeviceProfile().isMobileShell &&
      readAnnotationSidebarPref(data.user.id),
  );
  const [pendingQuote, setPendingQuote] = useState<string | null>(null);
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(
    null,
  );
  const [unmatchedIds, setUnmatchedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [annotationEditing, setAnnotationEditing] = useState(false);
  const [conceptLinksOn, setConceptLinksOn] = useState<boolean>(() =>
    readConceptLinksPref(data.user.id),
  );
  const [domMatchedConceptCount, setDomMatchedConceptCount] = useState<
    number | null
  >(null);
  const [activeConceptAnchor, setActiveConceptAnchor] = useState<{
    conceptId: string;
    el: HTMLElement | null;
    rect: ConceptAnchorRect;
  } | null>(null);
  const [conceptPopoverEditing, setConceptPopoverEditing] = useState(false);
  const answerProseRef = useRef<HTMLDivElement>(null);
  const restoreAnnotationsAfterAiRef = useRef(false);
  const prevAiDockedRef = useRef(Boolean(aiDocked));
  const pulseTimerRef = useRef<number | null>(null);
  const noteMeta = useMemo(
    () => markdownDocument(question.answer),
    [question.answer],
  );
  const mergedTags = useMemo(
    () => mergeQuestionTags(question.tags, noteMeta.tags),
    [question.tags, noteMeta.tags],
  );
  const documentView = useMemo(
    () => studyDocument(revealed ? question.answer : "", question.title),
    [question.answer, question.title, revealed],
  );
  const canInlineEdit = !review && question.isOwner;
  const [tab, setTab] = useState<ReaderTab>("answer");
  const [inputMode, setInputMode] = useState<"written" | "oral">("written");
  const [answer, setAnswer] = useState("");
  const [oralSeconds, setOralSeconds] = useState(0);
  const [oralRunning, setOralRunning] = useState(false);
  const [hideAll, setHideAll] = useState(false);
  const [validationOpen, setValidationOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [selection, setSelection] = useState<{
    text: string;
    x: number;
    y: number;
  } | null>(null);
  const [lastSelection, setLastSelection] = useState(selection);
  useEffect(() => {
    if (selection) setLastSelection(selection);
  }, [selection]);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingAnswer, setEditingAnswer] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState("");
  const [restoredDraft, setRestoredDraft] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [editDraft, setEditDraft] = useState<InlineQuestionDraft>(() => ({
    title: question.title,
    answer: question.answer,
    tags: question.tags.join(", "),
    major: false,
    baseRevision: question.revision,
    pasted: false,
    keepWhole: false,
  }));
  const [insight, setInsight] = useState<Insight | null>(null);
  const insightVersion = useRef("");
  const answerRef = useRef<HTMLDivElement>(null);
  const titleInputId = useId();
  const titleFormRef = useRef<HTMLFormElement>(null);
  const titleTextareaRef = useRef<HTMLTextAreaElement>(null);
  const titleComposingRef = useRef(false);
  const editBusyRef = useRef(editBusy);
  editBusyRef.current = editBusy;
  const commitTitleRef = useRef<() => void>(() => {});
  const editorDraftKey = `shiyi:editor:${data.user.id}:${question.id}`;
  const draftSavedRef = useRef(false);
  const draftLoadedRef = useRef(false);
  const editDirty =
    editDraft.title !== question.title ||
    editDraft.answer !== question.answer ||
    editDraft.tags !== question.tags.join(", ") ||
    editDraft.major;
  const editDirtyRef = useRef(editDirty);
  editDirtyRef.current = editDirty;
  const latestDraftRef = useRef(editDraft);
  latestDraftRef.current = editDraft;
  const inlineEditingRef = useRef(false);
  inlineEditingRef.current =
    editingTitle ||
    editingAnswer ||
    editingNote ||
    annotationEditing ||
    conceptPopoverEditing;
  const editTags = useMemo(
    () => [
      ...new Set(
        editDraft.tags
          .split(/[,，]/)
          .map((tag) => tag.trim().replace(/^#+/, ""))
          .filter(Boolean),
      ),
    ],
    [editDraft.tags],
  );
  function patchEditDraft(value: Partial<InlineQuestionDraft>) {
    draftSavedRef.current = false;
    setEditDraft((before) => ({
      ...before,
      ...(value.answer !== undefined && value.answer !== before.answer
        ? { keepWhole: false }
        : {}),
      ...value,
    }));
    setEditError("");
  }
  useEffect(() => {
    onRevealedChange?.(revealed);
  }, [revealed, onRevealedChange]);
  useEffect(() => {
    if (editingTitle || editingAnswer || editingNote) setSelection(null);
  }, [editingTitle, editingAnswer, editingNote]);
  useEffect(() => {
    if (!canInlineEdit) return;
    draftLoadedRef.current = false;
    draftSavedRef.current = false;
    try {
      const value = JSON.parse(
        readPracticeDraft(editorDraftKey) || "null",
      ) as InlineQuestionDraft | null;
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
          setEditDraft({
            ...value,
            pasted: value.pasted ?? true,
            keepWhole: value.keepWhole === true,
          });
          setRestoredDraft(true);
        } else {
          savePracticeDraft(editorDraftKey, "");
          setRestoredDraft(false);
        }
      }
    } catch {
      /* Ignore malformed local editor draft. */
    }
    draftLoadedRef.current = true;
    return () => {
      if (!draftSavedRef.current && editDirtyRef.current) {
        savePracticeDraft(editorDraftKey, JSON.stringify(latestDraftRef.current));
      }
    };
  }, [canInlineEdit, editorDraftKey]);
  useEffect(() => {
    if (
      !canInlineEdit ||
      editingTitle ||
      editingAnswer ||
      restoredDraft ||
      editDirty
    )
      return;
    setEditDraft({
      title: question.title,
      answer: question.answer,
      tags: question.tags.join(", "),
      major: false,
      baseRevision: question.revision,
      pasted: false,
      keepWhole: false,
    });
  }, [
    canInlineEdit,
    editingTitle,
    editingAnswer,
    restoredDraft,
    editDirty,
    question.title,
    question.answer,
    question.tags,
    question.revision,
  ]);
  useEffect(() => {
    if (!canInlineEdit || !draftLoadedRef.current || draftSavedRef.current)
      return;
    const timer = window.setTimeout(
      () =>
        setStorageError(
          !savePracticeDraft(
            editorDraftKey,
            editDirty ? JSON.stringify(editDraft) : "",
          ),
        ),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [canInlineEdit, editDraft, editDirty, editorDraftKey]);
  useEffect(() => {
    const el = titleTextareaRef.current;
    if (!editingTitle || !el) return;
    if (
      typeof CSS !== "undefined" &&
      CSS.supports("field-sizing", "content")
    ) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [editDraft.title, editingTitle]);
  const answerKey = practiceDraftKey(
    data.user.id,
    question.id,
    question.revision,
  );
  const paragraphPrefix = practiceDraftKey(
    data.user.id,
    question.id,
    question.revision,
    "paragraph",
  );
  const prevQuestionIdRef = useRef(question.id);
  const answerStateRef = useRef(answer);
  answerStateRef.current = answer;
  useEffect(() => {
    if (prevQuestionIdRef.current !== question.id) {
      prevQuestionIdRef.current = question.id;
      setAnswer(readPracticeDraft(answerKey));
      return;
    }
    if (answerStateRef.current.trim()) {
      savePracticeDraft(answerKey, answerStateRef.current);
    } else {
      setAnswer(readPracticeDraft(answerKey));
    }
  }, [answerKey, question.id]);
  useEffect(() => {
    // 普通阅读与突击模式不抢发曲线请求；仅正常 FSRS 答题或打开“记忆”时读取。
    if ((!review || cram) && tab !== "memory") return;
    const version = `${question.id}:${question.studyVersion}`;
    if (insightVersion.current === version) return;
    const controller = new AbortController();
    let cancelled = false;
    void api<Insight>(`/api/reviews?questionId=${question.id}`, undefined, {
      userId: data.user.id,
      signal: controller.signal,
    })
      .then((result) => {
        if (!cancelled) {
          insightVersion.current = version;
          setInsight(result);
        }
      })
      .catch((error) => {
        if (!cancelled) toast.error(error.message);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [question.id, question.studyVersion, review, cram, tab]);
  useEffect(() => {
    if (!oralRunning || revealed || inputMode !== "oral") return;
    const timer = window.setInterval(() => {
      setOralSeconds((seconds) => seconds + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [oralRunning, revealed, inputMode]);
  useEffect(() => {
    if (revealed) setOralRunning(false);
  }, [revealed]);
  useEffect(() => {
    setOutlineOpen(false);
  }, [question.id, review]);
  useEffect(() => {
    if (!outlineOpen) return;
    requestAnimationFrame(() => {
      currentOutlineItemRef.current?.scrollIntoView({ block: "nearest" });
    });
    function onPointerDown(event: PointerEvent) {
      if (device.isMobileShell) return;
      if (
        outlineWrapRef.current &&
        !outlineWrapRef.current.contains(event.target as Node)
      ) {
        setOutlineOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOutlineOpen(false);
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [outlineOpen, device.isMobileShell]);
  const folderIndex = useMemo(() => buildFolderIndex(data.decks), [data.decks]);
  const ownedBreadcrumbs = useMemo(() => {
    if (!question.isOwner) return [];
    if (!question.deckId) return [];
    return folderIndex.breadcrumbsOf(question.deckId);
  }, [question.isOwner, question.deckId, folderIndex]);

  const outlineSections = useMemo(() => {
    if (!readingList || readingList.length <= 1) return [];
    const distinctPaths = new Set(readingList.map((item) => item.folderPath));
    const showPathHeaders = distinctPaths.size > 1;
    const sections: {
      key: string;
      rawKey: string;
      label: string | null;
      items: { question: QuestionView; globalIndex: number }[];
    }[] = [];
    for (let i = 0; i < readingList.length; i++) {
      const item = readingList[i];
      const pathLabel = item.folderPath ?? item.deckTitle;
      const rawKey = showPathHeaders ? pathLabel : "__flat__";
      const label = showPathHeaders ? pathLabel : null;
      const last = sections[sections.length - 1];
      if (last && last.rawKey === rawKey) {
        last.items.push({ question: item, globalIndex: i });
      } else {
        sections.push({
          key: `${rawKey}:${i}`,
          rawKey,
          label,
          items: [{ question: item, globalIndex: i }],
        });
      }
    }
    return sections;
  }, [readingList]);
  useEffect(() => {
    if (review || !prevNext || prevNext.total <= 1) return;
    function stepKeys(event: KeyboardEvent) {
      if (
        outlineOpen ||
        inlineEditingRef.current ||
        (event.target as HTMLElement).closest(
          "input,textarea,select,[contenteditable='true'],[role='dialog']:not([hidden]),button",
        ) ||
        globalThis.document.querySelector(
          "[role='dialog']:not([hidden]), .action-menu[open], .action-menu:popover-open, .user-menu-popover:popover-open",
        ) ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        aiOpen ||
        event.isComposing
      )
        return;
      if (event.key === "[") {
        if (prevNext?.hasPrev) {
          event.preventDefault();
          prevNext.onPrev();
        }
      } else if (event.key === "]") {
        if (prevNext?.hasNext) {
          event.preventDefault();
          prevNext.onNext();
        }
      } else if (
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        !(event.target as HTMLElement).closest("[role='tablist']") &&
        !window.getSelection()?.toString()
      ) {
        if (event.key === "ArrowLeft" && prevNext?.hasPrev) {
          event.preventDefault();
          prevNext.onPrev();
        } else if (event.key === "ArrowRight" && prevNext?.hasNext) {
          event.preventDefault();
          prevNext.onNext();
        }
      }
    }
    window.addEventListener("keydown", stepKeys);
    return () => window.removeEventListener("keydown", stepKeys);
  }, [review, prevNext, aiOpen, outlineOpen]);
  useEffect(() => {
    function detect() {
      if (inlineEditingRef.current) {
        setSelection(null);
        return;
      }
      const selected = window.getSelection();
      if (
        !selected ||
        selected.isCollapsed ||
        !selected.rangeCount ||
        !answerRef.current
      ) {
        setSelection(null);
        return;
      }
      const range = selected.getRangeAt(0);
      if (
        !answerRef.current.contains(range.startContainer) ||
        !answerRef.current.contains(range.endContainer)
      ) {
        setSelection(null);
        return;
      }
      const anchor = range.startContainer.parentElement;
      if (
        !anchor?.closest(".prose-content") ||
        anchor.closest(
          "[contenteditable='true'], textarea, input, .inline-answer-editor, .personal-notes-editing",
        )
      ) {
        setSelection(null);
        return;
      }
      const text = selected.toString().trim();
      if (!text) {
        setSelection(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      const above = rect.top - 48;
      setSelection({
        text: text.slice(0, 5000),
        x: Math.max(
          12,
          Math.min(window.innerWidth - 336, rect.left + rect.width / 2 - 150),
        ),
        y:
          above >= 72
            ? above
            : Math.min(window.innerHeight - 56, Math.max(72, rect.bottom + 10)),
      });
    }
    function clear(event: Event) {
      if (
        event.target instanceof Element &&
        event.target.closest(".ai-island-panel, .table-scroll, pre")
      )
        return;
      setSelection(null);
    }
    globalThis.document.addEventListener("selectionchange", detect);
    window.addEventListener("scroll", clear, true);
    return () => {
      globalThis.document.removeEventListener("selectionchange", detect);
      window.removeEventListener("scroll", clear, true);
    };
  }, []);
  useEffect(() => {
    if (!review) return;
    function keys(event: KeyboardEvent) {
      if (
        (event.target as HTMLElement).closest(
          "input,textarea,select,[contenteditable='true'],[role='dialog']:not([hidden]),button",
        ) ||
        globalThis.document.querySelector(
          "[role='dialog']:not([hidden]), .action-menu[open], .action-menu:popover-open, .user-menu-popover:popover-open",
        ) ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        aiOpen ||
        event.isComposing
      )
        return;
      if (event.code === "Space" && !revealed) {
        event.preventDefault();
        setRevealed(true);
      } else if (
        revealed &&
        ["1", "2", "3", "4"].includes(event.key) &&
        !busy
      ) {
        event.preventDefault();
        onGrade?.(Number(event.key), answer);
      }
    }
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [review, revealed, busy, aiOpen, onGrade, answer, inputMode]);
  function ask(prompt: string, quote = selection?.text ?? "", attemptText?: string) {
    onAskAi?.({ quote, prompt, attempt: attemptText });
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }
  function enterTitleEdit() {
    if (!canInlineEdit || editBusy) return;
    setEditingTitle(true);
    setEditError("");
    requestAnimationFrame(() => {
      const el = titleTextareaRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
  }
  function cancelTitleEdit() {
    setEditDraft((prev) => ({ ...prev, title: question.title }));
    setEditError("");
    setEditingTitle(false);
  }
  function cancelAnswerEdit() {
    savePracticeDraft(editorDraftKey, "");
    setEditDraft((prev) => ({
      ...prev,
      answer: question.answer,
      tags: question.tags.join(", "),
      major: false,
      baseRevision: question.revision,
      pasted: false,
      keepWhole: false,
    }));
    setRestoredDraft(false);
    setEditError("");
    setEditingAnswer(false);
  }
  function discardAllDraft() {
    savePracticeDraft(editorDraftKey, "");
    setEditDraft({
      title: question.title,
      answer: question.answer,
      tags: question.tags.join(", "),
      major: false,
      baseRevision: question.revision,
      pasted: false,
      keepWhole: false,
    });
    setRestoredDraft(false);
    setEditError("");
    setEditingTitle(false);
    setEditingAnswer(false);
  }
  async function saveInlineQuestion(options?: {
    merged?: boolean;
    closeTitle?: boolean;
    closeAnswer?: boolean;
    titleOnly?: boolean;
    titleOverride?: string;
  }) {
    if (!canInlineEdit || editBusy) return;
    const titleSource = options?.titleOverride ?? editDraft.title;
    const trimmedTitle = titleSource.trim();
    if (!trimmedTitle) {
      setEditError("请输入面试题目。");
      return;
    }
    if (trimmedTitle.length > 200) {
      setEditError("题目最多 200 字。");
      return;
    }
    if (question.revision !== editDraft.baseRevision && !options?.merged) {
      setEditError("题目已在其他页面更新，请先在编辑区确认合并。");
      return;
    }
    if (options?.titleOnly) {
      if (trimmedTitle === question.title) {
        setEditDraft((prev) => ({ ...prev, title: question.title }));
        setEditError("");
        if (options?.closeTitle) setEditingTitle(false);
        return;
      }
      setEditBusy(true);
      setEditError("");
      try {
        const result = await mutate("/api/questions", {
          action: "edit",
          id: question.id,
          expectedRevision: options?.merged
            ? question.revision
            : editDraft.baseRevision,
          title: trimmedTitle,
          answer: question.answer,
          tags: question.tags,
          major: false,
        });
        if (result) {
          const nextRevision =
            typeof result.revision === "number"
              ? result.revision
              : question.revision + 1;
          const hasAnswerDraft =
            editDraft.answer !== question.answer ||
            editDraft.tags !== question.tags.join(", ") ||
            editDraft.major;
          if (!hasAnswerDraft) {
            draftSavedRef.current = true;
            savePracticeDraft(editorDraftKey, "");
            setRestoredDraft(false);
          }
          setEditDraft((prev) => ({
            ...prev,
            title: trimmedTitle,
            baseRevision: nextRevision,
          }));
          if (options?.closeTitle) setEditingTitle(false);
          const dups = Array.isArray(result.duplicates)
            ? (result.duplicates as DuplicateHit[])
            : [];
          if (dups.length > 0) {
            toast.info(
              `修改已保存。提示：在「${dups[0].path}」已有相同内容，可在「重复内容」中合并整理。`,
            );
          } else {
            toast.success("修改已保存。");
          }
        } else {
          setEditError("没有保存成功，当前草稿已保留。");
        }
      } finally {
        setEditBusy(false);
      }
      return;
    }
    if (editDraft.answer.length > 100_000) {
      setEditError("答案超过 10 万字符限制。");
      return;
    }
    if (editTags.length > 12 || editTags.some((tag) => tag.length > 30)) {
      setEditError("标签最多 12 个，每个不超过 30 字。");
      return;
    }
    if (!editDirty) {
      if (options?.closeTitle) setEditingTitle(false);
      if (options?.closeAnswer) setEditingAnswer(false);
      return;
    }
    setEditBusy(true);
    setEditError("");
    try {
      const result = await mutate("/api/questions", {
        action: "edit",
        id: question.id,
        expectedRevision: options?.merged
          ? question.revision
          : editDraft.baseRevision,
        title: trimmedTitle,
        answer: editDraft.answer,
        tags: editTags,
        major: editDraft.major,
      });
      if (result) {
        draftSavedRef.current = true;
        savePracticeDraft(editorDraftKey, "");
        setRestoredDraft(false);
        setEditDraft((prev) => ({
          ...prev,
          title: trimmedTitle,
          tags: editTags.join(", "),
          major: false,
          baseRevision:
            typeof result.revision === "number"
              ? result.revision
              : question.revision + 1,
          pasted: false,
          keepWhole: false,
        }));
        if (options?.closeTitle) setEditingTitle(false);
        if (options?.closeAnswer) setEditingAnswer(false);
        const dups = Array.isArray(result.duplicates)
          ? (result.duplicates as DuplicateHit[])
          : [];
        if (dups.length > 0) {
          toast.info(
            `修改已保存。提示：在「${dups[0].path}」已有相同内容，可在「重复内容」中合并整理。`,
          );
        } else {
          toast.success("修改已保存。");
        }
      } else {
        setEditError("没有保存成功，当前草稿已保留。");
      }
    } finally {
      setEditBusy(false);
    }
  }
  commitTitleRef.current = () => {
    if (
      !canInlineEdit ||
      !editingTitle ||
      editingAnswer ||
      editBusyRef.current
    ) {
      return;
    }
    const rawTitle =
      titleTextareaRef.current?.value ?? latestDraftRef.current.title;
    const trimmedTitle = rawTitle.trim();
    if (!trimmedTitle || trimmedTitle === question.title) {
      cancelTitleEdit();
      return;
    }
    void saveInlineQuestion({
      closeTitle: true,
      titleOnly: true,
      titleOverride: rawTitle,
    });
  };
  useEffect(() => {
    if (!canInlineEdit || !editingTitle || editingAnswer) return;
    let pendingOutside: { pointerId: number; x: number; y: number } | null =
      null;
    let rafId: number | null = null;

    function onPointerDown(event: PointerEvent) {
      if (editBusyRef.current) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (
        event.clientX >= globalThis.document.documentElement.clientWidth ||
        event.clientY >= globalThis.document.documentElement.clientHeight
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && titleFormRef.current?.contains(target)) return;
      if (target?.closest("[data-sonner-toaster]")) return;
      pendingOutside = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
      };
      if (titleComposingRef.current) {
        titleTextareaRef.current?.blur();
      }
    }

    function onPointerUp(event: PointerEvent) {
      if (!pendingOutside || event.pointerId !== pendingOutside.pointerId) {
        return;
      }
      const moved = Math.hypot(
        event.clientX - pendingOutside.x,
        event.clientY - pendingOutside.y,
      );
      pendingOutside = null;
      if (moved >= 10) return;
      const rawTitle =
        titleTextareaRef.current?.value ?? latestDraftRef.current.title;
      const trimmedTitle = rawTitle.trim();
      if (
        !titleComposingRef.current &&
        trimmedTitle &&
        trimmedTitle !== question.title
      ) {
        commitTitleRef.current();
        return;
      }
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        commitTitleRef.current();
      });
    }

    function onPointerCancel() {
      pendingOutside = null;
    }

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
  }, [canInlineEdit, editingTitle, editingAnswer, question.title]);
  const switchToNotesTab = useCallback(() => setTab("notes"), []);
  const annotations = useMemo(
    () => question.annotations ?? [],
    [question.annotations],
  );
  const concepts = useMemo(() => data.concepts ?? [], [data.concepts]);
  const conceptFolders = useMemo(
    () => data.conceptFolders ?? [],
    [data.conceptFolders],
  );
  const conceptById = useMemo(
    () => new Map(concepts.map((c) => [c.id, c])),
    [concepts],
  );
  const activeConcept = activeConceptAnchor
    ? (conceptById.get(activeConceptAnchor.conceptId) ?? null)
    : null;
  const activeConceptId = activeConcept?.id ?? null;
  const activeAnnotationIdRef = useRef(activeAnnotationId);
  activeAnnotationIdRef.current = activeAnnotationId;
  const activeConceptIdRef = useRef(activeConceptId);
  activeConceptIdRef.current = activeConceptId;

  useEffect(() => {
    setConceptLinksOn(readConceptLinksPref(data.user.id));
  }, [data.user.id]);

  const setConceptLinksVisible = useCallback(
    (nextOn: boolean) => {
      setConceptLinksOn(nextOn);
      writeConceptLinksPref(data.user.id, nextOn);
      if (!nextOn) setActiveConceptAnchor(null);
    },
    [data.user.id],
  );

  const ensureConceptLinksOn = useCallback(() => {
    setConceptLinksOn((prev) => {
      if (!prev) writeConceptLinksPref(data.user.id, true);
      return true;
    });
  }, [data.user.id]);

  const openConceptFromElement = useCallback(
    (el: HTMLElement, conceptId: string) => {
      if (!conceptById.has(conceptId)) return;
      setActiveConceptAnchor((prev) => {
        if (
          prev &&
          prev.conceptId === conceptId &&
          (prev.el === el || !prev.el?.isConnected)
        ) {
          return null;
        }
        const rect = el.getBoundingClientRect();
        return {
          conceptId,
          el,
          rect: {
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            width: rect.width,
            height: rect.height,
          },
        };
      });
    },
    [conceptById],
  );

  const estimatedConceptCount = useMemo(() => {
    if (!revealed || !concepts.length || !documentView.blocks.length) return 0;
    const proseText = documentView.blocks
      .map((block) => block.markdown)
      .join("\n")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`[^`]*`/g, " ");
    const matches = findConceptMatchesInText(proseText, concepts);
    if (!matches.length) return 0;
    return new Set(matches.map((m) => m.concept.id)).size;
  }, [revealed, concepts, documentView.blocks]);

  const displayedConceptCount =
    conceptLinksOn && domMatchedConceptCount !== null
      ? domMatchedConceptCount
      : estimatedConceptCount;

  const annotationBadgeCount = annotations.length;
  const setAnnotationsVisible = useCallback(
    (nextOpen: boolean) => {
      if (review) return;
      restoreAnnotationsAfterAiRef.current = false;
      if (nextOpen && aiDocked) {
        onBeforeOpenAnnotations?.();
      }
      setAnnotationsOpen(nextOpen);
      if (!device.isMobileShell) {
        writeAnnotationSidebarPref(data.user.id, nextOpen);
      }
    },
    [
      review,
      aiDocked,
      onBeforeOpenAnnotations,
      device.isMobileShell,
      data.user.id,
    ],
  );
  const toggleCompareLayout = useCallback(() => {
    setCompareLayout((prev) => {
      const next = prev === "split" ? "stack" : "split";
      writeReviewCompareLayoutPref(next);
      return next;
    });
  }, []);
  const hasOutline = Boolean(
    !review &&
      prevNext &&
      prevNext.total > 1 &&
      outlineSections.length > 0 &&
      onJumpQuestion,
  );
  const desktopOutlineOpen = Boolean(
    outlineOpen && hasOutline && !device.isMobileShell,
  );
  const mobileOutlineOpen = Boolean(
    outlineOpen && hasOutline && device.isMobileShell,
  );
  const canAnnotateRail = Boolean(!review && !device.isMobileShell);
  const hasDesktopAnnotationsOpen = Boolean(annotationsOpen && canAnnotateRail);
  const mobileAnnotationsOpen = Boolean(
    annotationsOpen && !review && device.isMobileShell,
  );
  const desktopAnnotationsPresence =
    useDiscretePresence<HTMLDivElement>(hasDesktopAnnotationsOpen);
  const mobileAnnotationsBackdropPresence =
    useDiscretePresence<HTMLButtonElement>(mobileAnnotationsOpen);
  const mobileAnnotationsSheetPresence =
    useDiscretePresence<HTMLDivElement>(mobileAnnotationsOpen);
  const desktopOutlinePresence =
    useDiscretePresence<HTMLDivElement>(desktopOutlineOpen);
  const mobileOutlineBackdropPresence =
    useDiscretePresence<HTMLButtonElement>(mobileOutlineOpen);
  const mobileOutlineSheetPresence =
    useDiscretePresence<HTMLDivElement>(mobileOutlineOpen);
  const selectionPresence = useDiscretePresence<HTMLDivElement>(
    Boolean(selection),
  );
  useEffect(() => {
    setPendingQuote(null);
    setActiveAnnotationId(null);
    setActiveConceptAnchor(null);
    setConceptPopoverEditing(false);
    setUnmatchedIds(new Set());
    setOralScratchpadOpen(false);
    if (review) setAnnotationsOpen(false);
  }, [question.id, review]);
  useEffect(() => {
    if (editingAnswer || tab !== "answer" || !revealed) {
      setActiveConceptAnchor(null);
    }
  }, [editingAnswer, tab, revealed]);
  useEffect(() => {
    const wasDocked = prevAiDockedRef.current;
    const nowDocked = Boolean(aiDocked);
    prevAiDockedRef.current = nowDocked;
    if (!wasDocked && nowDocked && !review && !device.isMobileShell) {
      if (annotationsOpen) {
        restoreAnnotationsAfterAiRef.current = true;
        setAnnotationsOpen(false);
      }
    } else if (wasDocked && !nowDocked && restoreAnnotationsAfterAiRef.current) {
      restoreAnnotationsAfterAiRef.current = false;
      if (!review && !device.isMobileShell) {
        setAnnotationsOpen(true);
      }
    }
  }, [aiDocked, annotationsOpen, review, device.isMobileShell]);
  useEffect(() => {
    if (review && !revealed) return;
    function onKeyDown(event: KeyboardEvent) {
      if (
        !review &&
        event.key === "Escape" &&
        annotationsOpen &&
        device.isMobileShell &&
        !activeConceptId
      ) {
        event.preventDefault();
        event.stopPropagation();
        setAnnotationsVisible(false);
        return;
      }
      if (
        outlineOpen ||
        inlineEditingRef.current ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing
      )
        return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input,textarea,select,[contenteditable='true'],[role='dialog']:not([hidden]),button",
        ) ||
        globalThis.document.querySelector(
          "[role='dialog']:not([hidden]), .action-menu[open], .action-menu:popover-open, .user-menu-popover:popover-open",
        )
      )
        return;
      const lowerKey = event.key.toLowerCase();
      if (lowerKey === "n" && !review) {
        event.preventDefault();
        setAnnotationsVisible(!annotationsOpen);
      } else if (lowerKey === "g" && (!review || revealed)) {
        event.preventDefault();
        setConceptLinksVisible(!conceptLinksOn);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    review,
    revealed,
    outlineOpen,
    annotationsOpen,
    conceptLinksOn,
    activeConceptId,
    device.isMobileShell,
    setAnnotationsVisible,
    setConceptLinksVisible,
  ]);
  const mobileConceptSheetOpen = Boolean(activeConcept && device.isMobileShell);
  useEffect(() => {
    if (!(mobileAnnotationsOpen || mobileOutlineOpen || mobileConceptSheetOpen))
      return;
    const prevOverflow = globalThis.document.body.style.overflow;
    globalThis.document.body.style.overflow = "hidden";
    return () => {
      globalThis.document.body.style.overflow = prevOverflow;
    };
  }, [mobileAnnotationsOpen, mobileOutlineOpen, mobileConceptSheetOpen]);
  useEffect(() => {
    const container = answerProseRef.current;
    const canDecorate = Boolean(
      container && revealed && !editingAnswer && tab === "answer",
    );
    const annotationsActive = Boolean(
      canDecorate && annotationsOpen && !review && annotations.length > 0,
    );
    const conceptLinksActive = Boolean(
      canDecorate && conceptLinksOn && concepts.length > 0,
    );

    if (!container || (!annotationsActive && !conceptLinksActive)) {
      setUnmatchedIds((prev) => (prev.size ? new Set() : prev));
      setDomMatchedConceptCount(conceptLinksOn && canDecorate ? 0 : null);
      return;
    }

    let cleanupAnnotations: (() => void) | null = null;
    let cleanupConcepts: (() => void) | null = null;
    let matchedAnnotationIds: Set<string> | null = null;

    // Explicit annotations run FIRST; concept auto-links run SECOND and skip marks.
    if (annotationsActive) {
      const { matchedIds, cleanup } = applyAnnotationHighlights(
        container,
        annotations,
        activeAnnotationIdRef.current,
      );
      cleanupAnnotations = cleanup;
      matchedAnnotationIds = matchedIds;
      const nextUnmatched = new Set<string>();
      for (const item of annotations) {
        if (item.quote.trim() && !matchedIds.has(item.id)) {
          nextUnmatched.add(item.id);
        }
      }
      setUnmatchedIds(nextUnmatched);
    } else {
      setUnmatchedIds((prev) => (prev.size ? new Set() : prev));
    }

    if (conceptLinksActive) {
      const { matchedConceptIds, cleanup } = applyConceptLinks(
        container,
        concepts,
        activeConceptIdRef.current,
      );
      cleanupConcepts = cleanup;
      const combinedConceptIds = new Set(matchedConceptIds);
      if (matchedAnnotationIds) {
        for (const item of annotations) {
          if (
            item.conceptId &&
            matchedAnnotationIds.has(item.id) &&
            conceptById.has(item.conceptId)
          ) {
            combinedConceptIds.add(item.conceptId);
          }
        }
      }
      setDomMatchedConceptCount(combinedConceptIds.size);
    } else {
      setDomMatchedConceptCount(null);
    }

    return () => {
      // Unwrap in reverse (LIFO) order to restore pristine text nodes cleanly.
      cleanupConcepts?.();
      cleanupAnnotations?.();
    };
  }, [
    revealed,
    annotationsOpen,
    conceptLinksOn,
    review,
    editingAnswer,
    tab,
    annotations,
    concepts,
    conceptById,
    hideAll,
    question.answer,
  ]);
  useEffect(() => {
    const container = answerProseRef.current;
    if (!container) return;
    container
      .querySelectorAll<HTMLElement>("mark.prose-annotation-mark")
      .forEach((el) => {
        const isActiveMark =
          el.dataset.annotationId === activeAnnotationId ||
          (Boolean(activeConceptId) && el.dataset.conceptId === activeConceptId);
        el.classList.toggle("is-active", isActiveMark);
      });
    container
      .querySelectorAll<HTMLElement>(".prose-concept-link")
      .forEach((el) => {
        el.classList.toggle(
          "is-active",
          el.dataset.conceptId === activeConceptId,
        );
      });
  }, [activeAnnotationId, activeConceptId]);
  useEffect(() => {
    return () => {
      if (pulseTimerRef.current !== null) {
        window.clearTimeout(pulseTimerRef.current);
      }
    };
  }, []);
  const handleSelectAnnotation = useCallback((id: string | null) => {
    setActiveAnnotationId(id);
    if (!id) return;
    const container = answerProseRef.current;
    if (!container) return;
    const escaped =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(id)
        : id.replace(/"/g, '\\"');
    const marks = container.querySelectorAll<HTMLElement>(
      `mark.prose-annotation-mark[data-annotation-id="${escaped}"]`,
    );
    const first = marks[0];
    if (!first) return;
    first.scrollIntoView({ behavior: "smooth", block: "center" });
    marks.forEach((mark) => mark.classList.remove("is-pulse"));
    void container.offsetWidth;
    marks.forEach((mark) => mark.classList.add("is-pulse"));
    if (pulseTimerRef.current !== null) {
      window.clearTimeout(pulseTimerRef.current);
    }
    pulseTimerRef.current = window.setTimeout(() => {
      marks.forEach((mark) => mark.classList.remove("is-pulse"));
      pulseTimerRef.current = null;
    }, 760);
  }, []);
  const isReviewDrafting = Boolean(review && !revealed);
  const canSplitCompare = Boolean(
    review && revealed && !device.isMobileShell && !aiDocked,
  );
  const isCompareSplit = canSplitCompare && compareLayout === "split";
  const showOralScratchpad = Boolean(
    oralScratchpadOpen || (revealed && Boolean(answer.trim())),
  );
  const ratings = [
    { rating: 1, label: "忘了", cramHint: "再巩固", className: "again" },
    { rating: 2, label: "困难", cramHint: "有卡顿", className: "hard" },
    { rating: 3, label: "记得", cramHint: "已掌握", className: "good" },
    { rating: 4, label: "轻松", cramHint: "很流畅", className: "easy" },
  ];
  const formatTimer = (total: number) =>
    `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  const tabs: { id: ReaderTab; label: string }[] = [
    { id: "answer", label: "正文" },
    { id: "followups", label: "追问" },
    { id: "notes", label: "笔记" },
    { id: "memory", label: "记忆" },
  ];
  const answerDraftSection = review ? (
    <section className="answer-draft">
      <div className="answer-draft-heading">
        <strong>你的作答</strong>
        <div
          className="answer-draft-controls"
          style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
        >
          {canSplitCompare && (
            <button
              type="button"
              className="text-button compare-layout-toggle"
              aria-label={
                compareLayout === "split" ? "切换为上下对照" : "切换为左右对照"
              }
              title={
                compareLayout === "split" ? "切换为上下对照" : "切换为左右对照"
              }
              onClick={toggleCompareLayout}
            >
              {compareLayout === "split" ? (
                <>
                  <Rows2 size={14} /> 上下对照
                </>
              ) : (
                <>
                  <Columns2 size={14} /> 左右对照
                </>
              )}
            </button>
          )}
          {revealed && (
            <span className="answer-mode-badge">
              {inputMode === "written" ? "默写" : "口述"}
            </span>
          )}
          <div
            className="segmented-control answer-mode-switch-inline"
            aria-label="作答方式"
          >
            <button
              type="button"
              aria-pressed={inputMode === "written"}
              disabled={revealed}
              onClick={() => {
                setOralRunning(false);
                setInputMode("written");
              }}
            >
              <PenLine size={14} aria-hidden="true" /> 默写
            </button>
            <button
              type="button"
              aria-pressed={inputMode === "oral"}
              disabled={revealed}
              onClick={() => setInputMode("oral")}
            >
              <Mic size={14} aria-hidden="true" /> 口述
            </button>
          </div>
        </div>
      </div>
      {inputMode === "written" ? (
        <textarea
          aria-label="本题作答"
          placeholder="先合上参考答案，按自己的理解默写出核心结论、关键机制与举例说明（Ctrl/⌘ + Enter 对照答案）…"
          value={answer}
          maxLength={20000}
          rows={7}
          readOnly={revealed}
          onChange={(event) => {
            setAnswer(event.target.value);
            if (!savePracticeDraft(answerKey, event.target.value))
              toast.error("草稿暂时无法保存在浏览器中。");
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (event.ctrlKey || event.metaKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              setRevealed(true);
            }
          }}
        />
      ) : (
        <div className="oral-recall">
          <Mic size={26} strokeWidth={1.3} />
          <p>试着脱稿大声说一遍：先抛结论，再讲机制与取舍。</p>
          <div
            className={`oral-timer ${oralSeconds > 120 ? "is-overtime" : ""}`}
          >
            <Clock size={14} aria-hidden="true" />
            <span>{formatTimer(oralSeconds)} / 02:00</span>
            <button
              type="button"
              className={`icon-button oral-timer-btn ${oralRunning ? "is-running" : ""}`}
              disabled={revealed}
              title={
                oralRunning
                  ? "暂停计时"
                  : oralSeconds > 0
                    ? "继续计时"
                    : "开始计时"
              }
              aria-label={
                oralRunning
                  ? "暂停计时"
                  : oralSeconds > 0
                    ? "继续计时"
                    : "开始计时"
              }
              onClick={() => setOralRunning((r) => !r)}
            >
              {oralRunning ? <Pause size={14} /> : <Play size={14} />}
            </button>
            {oralSeconds > 0 && !revealed && (
              <button
                type="button"
                className="icon-button oral-timer-btn"
                title="重置计时"
                aria-label="重置计时"
                onClick={() => {
                  setOralRunning(false);
                  setOralSeconds(0);
                }}
              >
                <RotateCcw size={14} />
              </button>
            )}
          </div>
          {!revealed && (
            <button
              type="button"
              className="text-button oral-scratchpad-toggle"
              aria-expanded={oralScratchpadOpen}
              onClick={() => setOralScratchpadOpen((v) => !v)}
            >
              <PenLine size={13} />
              {oralScratchpadOpen ? "收起口述要点" : "记录口述要点"}
            </button>
          )}
          <div
            className="oral-scratchpad-collapse"
            data-open={showOralScratchpad ? "true" : "false"}
            aria-hidden={!showOralScratchpad}
            inert={!showOralScratchpad}
          >
            <div className="oral-scratchpad-collapse-inner">
              <div className="oral-scratchpad">
                <textarea
                  aria-label="口述要点草稿"
                  placeholder="随手记下关键词或要点，对照参考答案时方便自查…"
                  value={answer}
                  maxLength={20000}
                  rows={3}
                  readOnly={revealed}
                  style={{ flex: "0 0 auto", minHeight: 84 }}
                  onChange={(event) => {
                    setAnswer(event.target.value);
                    if (!savePracticeDraft(answerKey, event.target.value))
                      toast.error("草稿暂时无法保存在浏览器中。");
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      (event.ctrlKey || event.metaKey) &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      setOralRunning(false);
                      setRevealed(true);
                    }
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}
      <div
        className={`answer-submit-row ${!revealed ? "is-pre-reveal" : ""}`}
      >
        {inputMode === "written" && (
          <span className="answer-draft-meta">
            {answer.trim().length} 字
            {!revealed && !device.isMobileShell && " · Ctrl/⌘ + Enter 对照答案"}
          </span>
        )}
        {!revealed ? (
          <Button
            onClick={() => {
              setOralRunning(false);
              setRevealed(true);
            }}
          >
            <Eye size={15} /> 对照答案
          </Button>
        ) : (
          <>
            {answer.trim() && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="ai-critique-btn"
                onClick={() =>
                  ask(
                    "请从面试官视角点评我的本次作答。",
                    "",
                    answer.trim(),
                  )
                }
              >
                <Sparkles size={14} /> AI 点评作答
              </Button>
            )}
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setOralRunning(false);
                setRevealed(false);
                onToggleAi?.(false);
                setTab("answer");
              }}
            >
              <RotateCcw size={14} /> 再想一遍
            </button>
          </>
        )}
      </div>
    </section>
  ) : null;
  const revealedReferenceSection = revealed ? (
    <>
      <div className="reader-tabs" role="tablist" aria-label="题目栏目">
        {tabs.map((item) => (
          <button
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`reader-panel-${item.id}`}
            id={`reader-tab-${item.id}`}
            key={item.id}
            onClick={() => {
              setTab(item.id);
              setSelection(null);
            }}
          >
            {item.label}
            {item.id === "answer" &&
              canInlineEdit &&
              editingAnswer &&
              editDirty && (
                <i className="tab-dirty-dot" aria-label="未保存" />
              )}
            {item.id === "followups" &&
              documentView.followups.length > 0 && (
                <span>{documentView.followups.length}</span>
              )}
          </button>
        ))}
      </div>
      <div
        className="reader-tab-panel"
        id={`reader-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`reader-tab-${tab}`}
        ref={answerRef}
      >
        {tab === "answer" &&
          (canInlineEdit && editingAnswer ? (
            <InlineAnswerEditor
              question={question}
              draft={editDraft}
              patch={patchEditDraft}
              tags={editTags}
              dirty={editDirty}
              busy={editBusy}
              error={editError}
              setError={setEditError}
              storageError={storageError}
              restored={restoredDraft}
              onDiscardDraft={discardAllDraft}
              onCancel={cancelAnswerEdit}
              onSave={(merged) =>
                saveInlineQuestion({
                  merged,
                  closeAnswer: true,
                  closeTitle: true,
                })
              }
              onBatchImport={onBatchImport}
              onCommittedImport={() => {
                draftSavedRef.current = true;
                savePracticeDraft(editorDraftKey, "");
                setRestoredDraft(false);
                setEditingAnswer(false);
                setEditingTitle(false);
              }}
            />
          ) : (
            <>
              {noteMeta.properties.length > 0 && (
                <ObsidianProperties
                  source={question.answer}
                  extraTags={question.tags}
                  defaultExpanded
                />
              )}
              {(canInlineEdit || review || !device.isMobileShell) && (
                <div className="answer-actions">
                  {canInlineEdit && (
                    <button
                      type="button"
                      className="icon-button"
                      title="编辑答案"
                      aria-label="编辑答案"
                      onClick={() => {
                        setHideAll(false);
                        setEditingAnswer(true);
                      }}
                    >
                      <PencilLine size={16} />
                    </button>
                  )}
                  {(review || !device.isMobileShell) && (
                    <>
                      <button
                        type="button"
                        className={`icon-button ${hideAll ? "active" : ""}`}
                        title={hideAll ? "显示正文" : "逐段默写"}
                        aria-label={hideAll ? "显示正文" : "逐段默写"}
                        aria-pressed={hideAll}
                        onClick={() => setHideAll(!hideAll)}
                      >
                        {hideAll ? <Eye size={16} /> : <EyeOff size={16} />}
                      </button>
                      {!device.isMobileShell && (
                        <button
                          type="button"
                          className="icon-button"
                          title="问 AI"
                          aria-label="围绕本题问 AI"
                          onClick={() =>
                            ask("请解释这道题，并举一个具体的例子。", "")
                          }
                        >
                          <MessageSquare size={16} />
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
              <div
                className="answer-content"
                ref={answerProseRef}
                onClick={(event) => {
                  if (window.getSelection()?.toString().trim()) return;
                  const target = event.target as HTMLElement | null;
                  const conceptLink = target?.closest<HTMLElement>(
                    ".prose-concept-link",
                  );
                  const linkedId = conceptLink?.dataset.conceptId;
                  if (conceptLink && linkedId) {
                    event.stopPropagation();
                    openConceptFromElement(conceptLink, linkedId);
                    return;
                  }
                  const mark = target?.closest<HTMLElement>(
                    "mark.prose-annotation-mark",
                  );
                  const annId = mark?.dataset.annotationId;
                  if (mark && annId) {
                    event.stopPropagation();
                    setActiveAnnotationId(annId);
                    const markConceptId = mark.dataset.conceptId;
                    if (markConceptId && conceptLinksOn) {
                      openConceptFromElement(mark, markConceptId);
                    }
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  const target = event.target as HTMLElement | null;
                  const conceptLink = target?.closest<HTMLElement>(
                    ".prose-concept-link",
                  );
                  const linkedId = conceptLink?.dataset.conceptId;
                  if (conceptLink && linkedId) {
                    event.preventDefault();
                    event.stopPropagation();
                    openConceptFromElement(conceptLink, linkedId);
                    return;
                  }
                  const mark = target?.closest<HTMLElement>(
                    "mark.prose-annotation-mark",
                  );
                  const annId = mark?.dataset.annotationId;
                  if (mark && annId) {
                    event.preventDefault();
                    setActiveAnnotationId(annId);
                    const markConceptId = mark.dataset.conceptId;
                    if (markConceptId && conceptLinksOn) {
                      openConceptFromElement(mark, markConceptId);
                    }
                  }
                }}
              >
                {documentView.blocks.length ? (
                  documentView.blocks.map((block) => (
                    <ParagraphPractice
                      key={block.id}
                      block={block}
                      hideAll={hideAll}
                      references={documentView.references}
                      draftKey={`${paragraphPrefix}:${block.id}`}
                    />
                  ))
                ) : (
                  <div className="missing-answer-card">
                    <span className="missing-answer-mark">
                      <PenLine size={27} strokeWidth={1.4} />
                    </span>
                    <h3>先把答案补上</h3>
                    {question.isOwner && !question.archived ? (
                      <>
                        <p>
                          补全参考答案后即可加入每日复习计划并逐段默写。
                        </p>
                        <div>
                          <Button onClick={() => onGenerateAnswer(question)}>
                            <Sparkles size={16} />
                            AI 写答案
                          </Button>
                          {canInlineEdit && (
                            <Button
                              variant="ghost"
                              onClick={() => setEditingAnswer(true)}
                            >
                              自己补充
                            </Button>
                          )}
                        </div>
                      </>
                    ) : (
                      <p className="quiet-empty">
                        暂无参考答案，可在上方「笔记」中记录你的理解。
                      </p>
                    )}
                  </div>
                )}
              </div>
            </>
          ))}
        {tab === "followups" && (
          <FollowupCards
            followups={documentView.followups}
            draftPrefix={answerKey}
            onEditFollowups={
              canInlineEdit
                ? () => {
                    setTab("answer");
                    setHideAll(false);
                    setEditingAnswer(true);
                  }
                : undefined
            }
          />
        )}
        {tab === "notes" && (
          <QuestionNotePanel
            question={question}
            userId={data.user.id}
            mutate={mutate}
            onSwitchToNotes={switchToNotesTab}
            onEditingChange={setEditingNote}
          />
        )}
        {tab === "memory" && (
          <section className="memory-section">
            <div className="section-heading">
              <h2>记忆曲线</h2>
            </div>
            <Curve curve={insight?.curve ?? []} />
            <div className="memory-summary">
              <span>
                复习 <strong>{question.fsrs?.reps ?? 0}</strong> 次
              </span>
              <span>
                下次 <strong>{relativeDue(question.fsrs?.due)}</strong>
              </span>
            </div>
            <p>
              根据每次自评自动计算复习间隔，只在快忘掉前提醒巩固。
            </p>
          </section>
        )}
      </div>
    </>
  ) : null;
  return (
    <div
      className={[
        "reader-layout",
        "notebook-reader",
        isReviewDrafting && "is-review-drafting",
        isCompareSplit && "is-compare-split",
        canAnnotateRail && "can-annotate-rail",
        hasDesktopAnnotationsOpen && "has-annotations-open",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="reader-body">
        <div className="reader-toolbar">
          <button className="back-link" onClick={onBack}>
            <ArrowLeft size={16} />
            {review ? (cram ? "结束突击" : "结束答题") : backLabel}
          </button>
          {!review && prevNext && prevNext.total > 1 && (
            <div className="reader-outline-wrap" ref={outlineWrapRef}>
              <div className="reader-step-nav" role="group" aria-label="切换上下题">
                <button
                  type="button"
                  className="icon-button"
                  aria-label="上一题"
                  title="上一题 ([)"
                  disabled={!prevNext.hasPrev}
                  onClick={prevNext.onPrev}
                >
                  <ChevronLeft size={16} />
                </button>
                {outlineSections.length > 0 && onJumpQuestion ? (
                  <button
                    type="button"
                    className={`reader-outline-trigger ${outlineOpen ? "is-open" : ""}`}
                    aria-expanded={outlineOpen}
                    aria-haspopup="dialog"
                    aria-label="展开阅读目录"
                    title={`第 ${prevNext.index + 1}/${prevNext.total} 题（点击跳转）`}
                    onClick={() => setOutlineOpen((open) => !open)}
                  >
                    <List size={12} aria-hidden="true" />
                    <span>
                      {prevNext.index + 1} / {prevNext.total}
                    </span>
                  </button>
                ) : (
                  <span>
                    {prevNext.index + 1} / {prevNext.total}
                  </span>
                )}
                <button
                  type="button"
                  className="icon-button"
                  aria-label="下一题"
                  title="下一题 (])"
                  disabled={!prevNext.hasNext}
                  onClick={prevNext.onNext}
                >
                  <ChevronRight size={16} />
                </button>
              </div>
              {hasOutline && !device.isMobileShell && (
                  <div
                    ref={desktopOutlinePresence.ref}
                    hidden={desktopOutlinePresence.isHidden}
                    data-closing={
                      desktopOutlinePresence.isClosing ? "" : undefined
                    }
                    aria-hidden={!desktopOutlineOpen}
                    inert={
                      !desktopOutlineOpen || desktopOutlinePresence.isClosing
                    }
                    className="reader-outline-popover"
                    role="dialog"
                    aria-label="阅读目录"
                  >
                    <div className="reader-outline-head">
                      <strong>阅读目录</strong>
                      <span>共 {prevNext.total} 题</span>
                    </div>
                    <div className="reader-outline-list">
                      {outlineSections.map((sec) => (
                        <div className="reader-outline-section" key={sec.key}>
                          {sec.label && (
                            <div className="reader-outline-group-head">
                              <span>{sec.label}</span>
                              <small>{sec.items.length}</small>
                            </div>
                          )}
                          {sec.items.map(({ question: item, globalIndex }) => {
                            const isCurrent = item.id === question.id;
                            return (
                              <button
                                key={item.id}
                                ref={isCurrent ? currentOutlineItemRef : undefined}
                                type="button"
                                className={`reader-outline-item ${isCurrent ? "is-current" : ""}`}
                                aria-current={isCurrent ? "true" : undefined}
                                onClick={() => {
                                  setOutlineOpen(false);
                                  if (!isCurrent) onJumpQuestion?.(item);
                                }}
                              >
                                <span className="reader-outline-index">
                                  {String(globalIndex + 1).padStart(2, "0")}
                                </span>
                                <span className="reader-outline-title">
                                  {item.title}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
            </div>
          )}
          {review && progress && (
            <div className="review-position">
              <span>
                {progress.current} / {progress.total}
              </span>
              <div>
                <i
                  style={{
                    width: `${(progress.current / progress.total) * 100}%`,
                  }}
                />
              </div>
            </div>
          )}
          <div className="reader-tools">
            {(!review || revealed) && (
              <button
                type="button"
                className={`reader-desktop-tool reader-concepts-toggle ${conceptLinksOn ? "is-active" : ""}`}
                title={
                  conceptLinksOn
                    ? `关闭概念释义 (G)${displayedConceptCount > 0 ? ` · 本文命中 ${displayedConceptCount} 个概念` : ""}`
                    : `开启概念释义 (G)${displayedConceptCount > 0 ? ` · 本文命中 ${displayedConceptCount} 个概念` : ""}`
                }
                aria-label={conceptLinksOn ? "关闭概念释义" : "开启概念释义"}
                aria-pressed={conceptLinksOn}
                onClick={() => setConceptLinksVisible(!conceptLinksOn)}
              >
                <BookMarked size={16} />
                <span>概念</span>
                {displayedConceptCount > 0 && (
                  <span className="reader-annotations-count">
                    {displayedConceptCount}
                  </span>
                )}
              </button>
            )}
            {!review && (
              <button
                type="button"
                className={`reader-desktop-tool reader-annotations-toggle ${annotationsOpen ? "is-active" : ""}`}
                title={annotationsOpen ? "收起侧边批注 (N)" : "展开侧边批注 (N)"}
                aria-label={annotationsOpen ? "收起侧边批注" : "展开侧边批注"}
                aria-pressed={annotationsOpen}
                onClick={() => setAnnotationsVisible(!annotationsOpen)}
              >
                <MessageSquareText size={16} />
                <span>批注</span>
                {annotationBadgeCount > 0 ? (
                  <span className="reader-annotations-count">
                    {annotationBadgeCount}
                  </span>
                ) : (
                  question.note.trim() && (
                    <span
                      className="reader-annotations-count"
                      aria-label="已有笔记"
                    >
                      ·
                    </span>
                  )
                )}
              </button>
            )}
            <button
              type="button"
              className={`icon-button reader-desktop-tool ${question.favorite ? "is-favorite" : ""}`}
              title={question.favorite ? "取消收藏" : "收藏题目"}
              aria-label={question.favorite ? "取消收藏" : "收藏题目"}
              onClick={onFavorite}
            >
              <Star
                size={17}
                fill={question.favorite ? "currentColor" : "none"}
              />
            </button>
            {(!review || revealed) && (
              <button
                type="button"
                className={`icon-button reader-mobile-concepts-btn ${conceptLinksOn ? "is-active" : ""}`}
                aria-label={conceptLinksOn ? "关闭概念释义" : "开启概念释义"}
                aria-pressed={conceptLinksOn}
                onClick={() => setConceptLinksVisible(!conceptLinksOn)}
              >
                <BookMarked size={17} />
                {!conceptLinksOn && displayedConceptCount > 0 && (
                  <span
                    className="reader-mobile-concepts-dot"
                    aria-hidden="true"
                  />
                )}
              </button>
            )}
            {review && revealed && (
              <button
                type="button"
                className={`icon-button reader-mobile-ai-btn ${aiOpen ? "is-active" : ""}`}
                aria-label={aiOpen ? "收起 AI 助手" : "打开 AI 助手"}
                onClick={() => onToggleAi?.(!aiOpen)}
              >
                <Sparkles size={17} />
              </button>
            )}
            <ReaderMobileThemeButton />
            {(question.isOwner || !!question.validation || !review) && (
              <ActionMenu label="更多题目操作">
                {question.isOwner && !review && (
                  <button onClick={onMove}>
                    <FolderInput size={15} />
                    移动到文件夹
                  </button>
                )}
                {question.isOwner && (
                  <button onClick={() => setSourceOpen(true)}>
                    <BookOpen size={15} />
                    查看导入原文
                  </button>
                )}
                {question.isOwner && !review && (
                  <button
                    onClick={() => {
                      setTab("answer");
                      setHideAll(false);
                      setEditingTitle(true);
                      setEditingAnswer(true);
                    }}
                  >
                    <PencilLine size={15} /> 编辑题目
                  </button>
                )}
                {question.validation && (
                  <button onClick={() => setValidationOpen(true)}>
                    <Check size={15} /> 校验记录
                  </button>
                )}
                {!review &&
                  (question.isOwner ? (
                    <button
                      onClick={async () => {
                        const result = await mutate("/api/questions", {
                          action: "archive",
                          id: question.id,
                          archived: !question.archived,
                        });
                        if (result)
                          toast.success(
                            question.archived
                              ? "已恢复到我的资料。"
                              : "已归档，可在已归档中查看。",
                          );
                      }}
                    >
                      <Archive size={15} />
                      {question.archived ? "恢复题目" : "归档题目"}
                    </button>
                  ) : (
                    <button
                      onClick={async () => {
                        const target = data.decks.find((deck) => deck.isOwner);
                        const result = await mutate("/api/questions", {
                          action: "copy",
                          id: question.id,
                          deckId: target?.id ?? null,
                        });
                        if (result) {
                          const dups = Array.isArray(result.duplicates)
                            ? (result.duplicates as DuplicateHit[])
                            : [];
                          const destLabel = target?.title ?? "我的资料";
                          if (dups.length > 0) {
                            toast.info(
                              `已另存副本到「${destLabel}」。提示：在「${dups[0].path}」已有相同内容。`,
                            );
                          } else {
                            toast.success(`已另存副本到「${destLabel}」。`);
                          }
                        }
                      }}
                    >
                      <Copy size={15} /> 另存副本
                    </button>
                  ))}
                {question.isOwner && !review && (
                  <button className="danger-text" onClick={onDelete}>
                    <Trash2 size={15} />
                    删除题目
                  </button>
                )}
              </ActionMenu>
            )}
            {sourceOpen && (
              <SourceDialog
                questionId={question.id}
                userId={data.user.id}
                onClose={() => setSourceOpen(false)}
              />
            )}
          </div>
        </div>
        <div className="reader-workspace">
          <article className="question-article">
          <header className="question-card-heading">
            <div className="question-breadcrumb reader-breadcrumb">
              {!review && question.isOwner ? (
                <>
                  {onOpenFolder ? (
                    <button
                      type="button"
                      className={`reader-crumb-btn ${ownedBreadcrumbs.length === 0 ? "is-current" : ""}`}
                      onClick={() => onOpenFolder(null)}
                    >
                      {ROOT_FOLDER_LABEL}
                    </button>
                  ) : (
                    <span>{ROOT_FOLDER_LABEL}</span>
                  )}
                  {ownedBreadcrumbs.map((crumb, idx) => (
                    <span
                      key={crumb.id}
                      style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                    >
                      <ChevronRight size={12} aria-hidden="true" />
                      {onOpenFolder ? (
                        <button
                          type="button"
                          className={`reader-crumb-btn ${idx === ownedBreadcrumbs.length - 1 ? "is-current" : ""}`}
                          onClick={() => onOpenFolder(crumb.id)}
                        >
                          {crumb.title}
                        </button>
                      ) : (
                        <span>{crumb.title}</span>
                      )}
                    </span>
                  ))}
                </>
              ) : !review && onOpenFolder && question.deckId ? (
                <button
                  type="button"
                  className="reader-crumb-btn is-current"
                  onClick={() => onOpenFolder(question.deckId)}
                >
                  {question.folderPath || question.deckTitle}
                </button>
              ) : (
                <span>{question.folderPath || question.deckTitle}</span>
              )}
              {review && (
                <>
                  <ChevronRight size={12} />
                  <span>{cram ? "突击练习" : "答题"}</span>
                </>
              )}
              {review && cram && (
                <span className="cram-badge">
                  {cramLabel || "专题突击"} · 不影响记忆曲线
                </span>
              )}
            </div>
            {canInlineEdit && editingTitle ? (
              <form
                ref={titleFormRef}
                className="inline-title-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveInlineQuestion({
                    closeTitle: true,
                    titleOnly: !editingAnswer,
                  });
                }}
              >
                <label htmlFor={titleInputId} className="sr-only">
                  题目
                </label>
                <textarea
                  id={titleInputId}
                  ref={titleTextareaRef}
                  className="inline-title-input"
                  rows={1}
                  maxLength={200}
                  value={editDraft.title}
                  disabled={editBusy}
                  placeholder="输入清晰、完整的面试题干（最多 200 字）"
                  title={
                    editingAnswer
                      ? "Enter 保存 · Esc 取消"
                      : "Enter 或点击外部保存 · Esc 取消"
                  }
                  onCompositionStart={() => {
                    titleComposingRef.current = true;
                  }}
                  onCompositionEnd={() => {
                    titleComposingRef.current = false;
                  }}
                  onChange={(event) =>
                    patchEditDraft({ title: event.target.value })
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      if (
                        event.nativeEvent.isComposing ||
                        event.keyCode === 229
                      )
                        return;
                      void saveInlineQuestion({
                        closeTitle: true,
                        titleOnly: !editingAnswer,
                      });
                    } else if (
                      event.key === "Escape" &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      cancelTitleEdit();
                    }
                  }}
                />
                <div className="inline-title-actions">
                  <span>{editDraft.title.length}/200</span>
                  <div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={editBusy}
                      onClick={cancelTitleEdit}
                    >
                      取消
                    </Button>
                    <Button
                      type="submit"
                      size="sm"
                      title="保存 (Enter)"
                      disabled={editBusy || !editDraft.title.trim()}
                    >
                      {editBusy && <Loader2 size={13} className="spin" />}
                      {editingAnswer ? "保存全部" : "保存"}
                    </Button>
                  </div>
                </div>
                {!editingAnswer && editError && (
                  <p className="form-error-inline" role="alert">
                    {editError}
                  </p>
                )}
              </form>
            ) : canInlineEdit ? (
              <div className="question-title-row is-editable">
                <h1
                  onClick={() => {
                    if (getDeviceProfile().isTouchInput) return;
                    if (window.getSelection()?.toString().trim()) return;
                    enterTitleEdit();
                  }}
                >
                  {question.title}
                </h1>
                <button
                  type="button"
                  className="icon-button inline-title-trigger"
                  aria-label="编辑题目"
                  title="点击编辑标题"
                  onClick={enterTitleEdit}
                >
                  <PencilLine size={16} />
                </button>
              </div>
            ) : (
              <h1>{question.title}</h1>
            )}
            {(mergedTags.length > 0 ||
              (!review &&
                !editingTitle &&
                !editingAnswer &&
                !question.archived &&
                !!question.answer.trim())) && (
              <div className="question-card-foot">
                {mergedTags.length > 0 && (
                  <div className="question-tags">
                    {mergedTags.map((tag) => (
                      <span key={tag} title={`#${tag}`}>
                        <span className="tag-hash" aria-hidden="true">
                          #
                        </span>
                        <span className="tag-text">{tag}</span>
                      </span>
                    ))}
                  </div>
                )}
                {!review &&
                  !editingTitle &&
                  !editingAnswer &&
                  !question.archived &&
                  !!question.answer.trim() && (
                    <Button
                      size="sm"
                      className="reader-start-review"
                      onClick={onSingleReview}
                    >
                      <PenLine size={15} /> 开始答题
                    </Button>
                  )}
              </div>
            )}
          </header>
          {canInlineEdit &&
            restoredDraft &&
            !editingAnswer &&
            !editingTitle && (
              <div className="editor-notice">
                已恢复未保存的修改
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    if (
                      editDraft.answer !== question.answer ||
                      editDraft.tags !== question.tags.join(", ") ||
                      editDraft.major
                    ) {
                      setTab("answer");
                      setHideAll(false);
                      setEditingAnswer(true);
                    }
                    if (editDraft.title !== question.title) {
                      setEditingTitle(true);
                    }
                    if (
                      editDraft.title === question.title &&
                      editDraft.answer === question.answer &&
                      editDraft.tags === question.tags.join(", ") &&
                      !editDraft.major
                    ) {
                      setRestoredDraft(false);
                    }
                  }}
                >
                  继续编辑
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={discardAllDraft}
                >
                  放弃草稿
                </button>
              </div>
            )}
          {question.archived && (
            <div className="inline-notice">
              <Archive size={15} /> 已归档
            </div>
          )}
          {question.majorRevision > question.reviewedRevision &&
            question.fsrs && (
              <div className="inline-notice">
                <RotateCcw size={15} /> 答案有更新
              </div>
            )}
          {review && revealed ? (
            <div className="review-compare-grid">
              {answerDraftSection}
              <div className="review-reference-pane">
                {revealedReferenceSection}
              </div>
            </div>
          ) : (
            <>
              {answerDraftSection}
              {revealedReferenceSection}
            </>
          )}
          {review && revealed && (
            <section className="review-rating-panel">
              <div className="rating-buttons">
                {ratings.map((item) => (
                  <button
                    key={item.rating}
                    className={`rating-button rating-${item.className}`}
                    disabled={busy}
                    onClick={() => onGrade?.(item.rating, answer)}
                  >
                    <span className="rating-key">{item.rating}</span>
                    <strong>{item.label}</strong>
                    <small>
                      {cram
                        ? item.cramHint
                        : (insight?.previews.find(
                            (preview) => preview.rating === item.rating,
                          )?.interval ?? "…")}
                    </small>
                  </button>
                ))}
              </div>
            </section>
          )}
          {!review && prevNext && prevNext.total > 1 && (
            <nav className="reader-foot-pager" aria-label="题目连续阅读">
              {prevNext.hasPrev ? (
                <button
                  type="button"
                  className="reader-pager-btn"
                  onClick={prevNext.onPrev}
                >
                  <span>
                    <ChevronLeft size={14} /> 上一题
                  </span>
                  {prevNext.prevTitle && <strong>{prevNext.prevTitle}</strong>}
                </button>
              ) : (
                <div className="reader-pager-placeholder" aria-hidden="true" />
              )}
              {prevNext.hasNext ? (
                <button
                  type="button"
                  className="reader-pager-btn is-next"
                  onClick={prevNext.onNext}
                >
                  <span>
                    下一题 <ChevronRight size={14} />
                  </span>
                  {prevNext.nextTitle && <strong>{prevNext.nextTitle}</strong>}
                </button>
              ) : (
                <div className="reader-pager-placeholder" aria-hidden="true" />
              )}
            </nav>
          )}
        </article>
          {canAnnotateRail && (
            <div
              ref={desktopAnnotationsPresence.ref}
              hidden={desktopAnnotationsPresence.isHidden}
              data-closing={
                desktopAnnotationsPresence.isClosing ? "" : undefined
              }
              aria-hidden={!hasDesktopAnnotationsOpen}
              inert={
                !hasDesktopAnnotationsOpen ||
                desktopAnnotationsPresence.isClosing
              }
              className="annotations-rail-shell"
            >
              <QuestionAnnotationsPanel
                open={hasDesktopAnnotationsOpen}
                question={question}
                concepts={concepts}
                conceptFolders={conceptFolders}
                userId={data.user.id}
                mutate={mutate}
                pendingQuote={pendingQuote}
                activeAnnotationId={activeAnnotationId}
                unmatchedIds={unmatchedIds}
                onClearPendingQuote={() => setPendingQuote(null)}
                onSelectAnnotation={handleSelectAnnotation}
                onClose={() => setAnnotationsVisible(false)}
                onEditingChange={setAnnotationEditing}
                onSwitchToNotes={switchToNotesTab}
                onConceptLinked={ensureConceptLinksOn}
                onOpenConcept={onOpenConcept}
              />
            </div>
          )}
        </div>
      </div>
      {!review && !(editingTitle || editingAnswer || editingNote) && (
        <div className="mobile-reader-dock" role="toolbar" aria-label="题目快捷操作">
          <button
            type="button"
            className={`mobile-dock-btn ${question.favorite ? "is-favorite" : ""}`}
            aria-label={question.favorite ? "取消收藏" : "收藏题目"}
            onClick={onFavorite}
          >
            <Star size={17} fill={question.favorite ? "currentColor" : "none"} />
            <span>{question.favorite ? "已藏" : "收藏"}</span>
          </button>
          <button
            type="button"
            className={`mobile-dock-btn ${annotationsOpen ? "is-active" : ""}`}
            aria-label={annotationsOpen ? "收起批注" : "打开批注"}
            onClick={() => setAnnotationsVisible(!annotationsOpen)}
          >
            <span className="mobile-dock-icon-wrap">
              <MessageSquareText size={17} />
              {(annotationBadgeCount > 0 || Boolean(question.note.trim())) && (
                <span className="mobile-dock-dot" aria-hidden="true" />
              )}
            </span>
            <span>批注</span>
          </button>
          {tab === "answer" && documentView.blocks.length > 0 && (
            <button
              type="button"
              className={`mobile-dock-btn ${hideAll ? "is-active" : ""}`}
              onClick={() => setHideAll(!hideAll)}
            >
              <PencilLine size={17} />
              <span>{hideAll ? "正文" : "默写"}</span>
            </button>
          )}
          <button
            type="button"
            className={`mobile-dock-btn ${aiOpen ? "is-active" : ""}`}
            onClick={() => onToggleAi?.(!aiOpen)}
          >
            <Sparkles size={17} />
            <span>AI</span>
          </button>
          {!question.archived && !!question.answer.trim() ? (
            <Button
              size="sm"
              className="mobile-dock-primary"
              onClick={onSingleReview}
            >
              <PenLine size={15} /> 开始答题
            </Button>
          ) : (
            question.isOwner &&
            !question.archived &&
            !question.answer.trim() && (
              <Button
                size="sm"
                className="mobile-dock-primary"
                onClick={() => onGenerateAnswer(question)}
              >
                <Sparkles size={15} /> AI 写答案
              </Button>
            )
          )}
        </div>
      )}
      {review && !revealed && (
        <div className="mobile-review-reveal-bar" role="toolbar" aria-label="答题控制">
          <div className="segmented-control" aria-label="切换作答方式">
            <button
              type="button"
              aria-pressed={inputMode === "written"}
              onClick={() => {
                setOralRunning(false);
                setInputMode("written");
              }}
            >
              <PenLine size={14} aria-hidden="true" /> 默写
            </button>
            <button
              type="button"
              aria-pressed={inputMode === "oral"}
              onClick={() => setInputMode("oral")}
            >
              <Mic size={14} aria-hidden="true" /> 口述
            </button>
          </div>
          <Button
            className="mobile-dock-primary"
            onClick={() => {
              setOralRunning(false);
              setRevealed(true);
            }}
          >
            <Eye size={16} /> 对照答案
          </Button>
        </div>
      )}
      {lastSelection && (
        <div
          ref={selectionPresence.ref}
          hidden={selectionPresence.isHidden}
          data-closing={selectionPresence.isClosing ? "" : undefined}
          aria-hidden={!selection}
          inert={!selection || selectionPresence.isClosing}
          className={`selection-bubble ${device.isTouchInput ? "is-touch" : ""}`}
          style={{
            left: (selection ?? lastSelection).x,
            top: (selection ?? lastSelection).y,
          }}
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
        >
          <button onClick={() => ask("请解释选中的这句话，说明其中的原因。 ")}>
            <Sparkles size={14} />
            解释
          </button>
          <button onClick={() => ask("请为选中的内容举一个具体的例子。")}>
            举例
          </button>
          <button onClick={() => ask("")}>
            <MessageSquare size={14} />
            追问
          </button>
          {!review && (
            <button
              type="button"
              title={
                (selection ?? lastSelection).text.trim().length <=
                MAX_CONCEPT_TERM_LENGTH
                  ? "添加批注并存入概念库"
                  : "添加侧边批注"
              }
              onClick={() => {
                const quoteText = (selection ?? lastSelection).text
                  .trim()
                  .slice(0, 600);
                if (!quoteText) return;
                setPendingQuote(quoteText);
                setAnnotationsVisible(true);
                setSelection(null);
                window.getSelection()?.removeAllRanges();
              }}
            >
              {(selection ?? lastSelection).text.trim().length <=
              MAX_CONCEPT_TERM_LENGTH ? (
                <>
                  <BookMarked size={14} />
                  批注·概念
                </>
              ) : (
                <>
                  <Highlighter size={14} />
                  加批注
                </>
              )}
            </button>
          )}
          <button aria-label="关闭选区菜单" onClick={() => setSelection(null)}>
            <X size={12} />
          </button>
        </div>
      )}
      {hasOutline && device.isMobileShell && (
        <>
          <button
            ref={mobileOutlineBackdropPresence.ref}
            type="button"
            hidden={mobileOutlineBackdropPresence.isHidden}
            data-closing={
              mobileOutlineBackdropPresence.isClosing ? "" : undefined
            }
            aria-hidden="true"
            tabIndex={-1}
            inert={
              !mobileOutlineOpen || mobileOutlineBackdropPresence.isClosing
            }
            className="reader-outline-backdrop"
            onClick={() => setOutlineOpen(false)}
          />
          <div
            ref={mobileOutlineSheetPresence.ref}
            hidden={mobileOutlineSheetPresence.isHidden}
            data-closing={
              mobileOutlineSheetPresence.isClosing ? "" : undefined
            }
            aria-hidden={!mobileOutlineOpen}
            inert={!mobileOutlineOpen || mobileOutlineSheetPresence.isClosing}
            className="reader-outline-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="阅读目录"
          >
            <div className="sheet-grabber" aria-hidden="true" />
            <div className="reader-outline-head">
              <strong>
                阅读目录（{prevNext?.total ?? readingList?.length ?? 0} 题）
              </strong>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭目录"
                onClick={() => setOutlineOpen(false)}
              >
                <X size={17} />
              </button>
            </div>
            <div className="reader-outline-list">
              {outlineSections.map((sec) => (
                <div className="reader-outline-section" key={sec.key}>
                  {sec.label && (
                    <div className="reader-outline-group-head">
                      <span>{sec.label}</span>
                      <small>{sec.items.length}</small>
                    </div>
                  )}
                  {sec.items.map(({ question: item, globalIndex }) => {
                    const isCurrent = item.id === question.id;
                    return (
                      <button
                        key={item.id}
                        ref={isCurrent ? currentOutlineItemRef : undefined}
                        type="button"
                        className={`reader-outline-item ${isCurrent ? "is-current" : ""}`}
                        aria-current={isCurrent ? "true" : undefined}
                        onClick={() => {
                          setOutlineOpen(false);
                          if (!isCurrent) onJumpQuestion?.(item);
                        }}
                      >
                        <span className="reader-outline-index">
                          {String(globalIndex + 1).padStart(2, "0")}
                        </span>
                        <span className="reader-outline-title">
                          {item.title}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
      {!review && device.isMobileShell && (
        <>
          <button
            ref={mobileAnnotationsBackdropPresence.ref}
            type="button"
            hidden={mobileAnnotationsBackdropPresence.isHidden}
            data-closing={
              mobileAnnotationsBackdropPresence.isClosing ? "" : undefined
            }
            aria-hidden="true"
            tabIndex={-1}
            inert={
              !mobileAnnotationsOpen ||
              mobileAnnotationsBackdropPresence.isClosing
            }
            className="annotations-mobile-backdrop"
            onClick={() => setAnnotationsVisible(false)}
          />
          <div
            ref={mobileAnnotationsSheetPresence.ref}
            hidden={mobileAnnotationsSheetPresence.isHidden}
            data-closing={
              mobileAnnotationsSheetPresence.isClosing ? "" : undefined
            }
            aria-hidden={!mobileAnnotationsOpen}
            inert={
              !mobileAnnotationsOpen ||
              mobileAnnotationsSheetPresence.isClosing
            }
            className="annotations-mobile-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="批注与笔记"
          >
            <div className="sheet-grabber" aria-hidden="true" />
            <QuestionAnnotationsPanel
              open={mobileAnnotationsOpen}
              question={question}
              concepts={concepts}
              conceptFolders={conceptFolders}
              userId={data.user.id}
              mutate={mutate}
              pendingQuote={pendingQuote}
              activeAnnotationId={activeAnnotationId}
              unmatchedIds={unmatchedIds}
              onClearPendingQuote={() => setPendingQuote(null)}
              onSelectAnnotation={handleSelectAnnotation}
              onClose={() => setAnnotationsVisible(false)}
              onEditingChange={setAnnotationEditing}
              onSwitchToNotes={() => {
                setAnnotationsVisible(false);
                switchToNotesTab();
              }}
              onConceptLinked={ensureConceptLinksOn}
              onOpenConcept={
                onOpenConcept
                  ? (conceptId) => {
                      setAnnotationsVisible(false);
                      onOpenConcept(conceptId);
                    }
                  : undefined
              }
            />
          </div>
        </>
      )}
      <ConceptPopover
        concept={activeConcept}
        concepts={concepts}
        conceptFolders={conceptFolders}
        anchorEl={activeConceptAnchor?.el ?? null}
        anchorRect={activeConceptAnchor?.rect ?? null}
        isMobileShell={device.isMobileShell}
        mutate={mutate}
        onClose={() => setActiveConceptAnchor(null)}
        onOpenConcept={onOpenConcept}
        onEditingChange={setConceptPopoverEditing}
      />
      <Dialog
        open={validationOpen}
        onOpenChange={setValidationOpen}
        title="校验记录"
      >
        <ContentValidationPanel review={question.validation} expanded />
      </Dialog>
    </div>
  );
}

export function ReviewComplete({
  count,
  ratings,
  cram,
  cramLabel,
  weakCount = 0,
  onDrillWeak,
  onBack,
  onLibrary,
}: {
  count: number;
  ratings: number[];
  cram?: boolean;
  cramLabel?: string;
  weakCount?: number;
  onDrillWeak?: () => void;
  onBack: () => void;
  onLibrary: () => void;
}) {
  return (
    <div className="page review-complete">
      <div className="completion-art">
        <Check size={42} strokeWidth={1.7} />
      </div>
      <h1>
        {cram
          ? count
            ? "本轮突击完成"
            : "没有可突击的题目"
          : count
            ? "本轮完成"
            : "暂时没有待复习的题"}
      </h1>
      {!count && (
        <p>
          {cram
            ? "当前筛选范围暂无含参考答案的题目，返回资料调整条件即可。"
            : "暂无到期或新增题目，可前往我的资料自由练习或导入新内容。"}
        </p>
      )}
      {count > 0 && (
        <>
          <p>
            {cram
              ? `已完成 ${count} 题专题突击（${cramLabel || "自由练习"}），原有间隔复习排期未受影响。`
              : `本轮已完成 ${count} 题主动回忆，下次复习时间已自动安排。`}
          </p>
          <div className="completion-stats">
            {["忘了", "困难", "记得", "轻松"].map((label, i) => (
              <div key={label}>
                <strong>
                  {ratings.filter((rating) => rating === i + 1).length}
                </strong>
                <span>{label}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="completion-actions">
        {weakCount > 0 && onDrillWeak && (
          <Button variant="secondary" onClick={onDrillWeak}>
            <RotateCcw size={15} /> 重练本轮薄弱题（{weakCount}）
          </Button>
        )}
        <Button variant="outline" onClick={onLibrary}>
          <BookOpen size={15} /> 我的资料
        </Button>
        <Button onClick={onBack}>
          回到今日
          <ArrowRight size={16} />
        </Button>
      </div>
    </div>
  );
}
