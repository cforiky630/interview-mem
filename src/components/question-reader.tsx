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
  Mic,
  PenLine,
  Trash2,
  FolderInput,
  Sun,
  Moon,
} from "lucide-react";
import { toast } from "sonner";
import type { QuestionView, Workspace } from "@/lib/types";
import { api } from "@/lib/client";
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
import { QuestionNotePanel } from "./question-note-panel";
import {
  InlineAnswerEditor,
  type InlineQuestionDraft,
} from "./inline-answer-editor";
import type { Mutate } from "./dialogs";
import type { ImportSeed } from "./import-dialog";

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

export function QuestionReader({
  question,
  data,
  onBack,
  backLabel = "返回题库",
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
  activeTheme,
  onToggleTheme,
  aiOpen = false,
  onToggleAi,
  onAskAi,
  onRevealedChange,
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
  activeTheme?: "light" | "dark";
  onToggleTheme?: () => void;
  aiOpen?: boolean;
  onToggleAi?: (open?: boolean) => void;
  onAskAi?: (request: {
    quote: string;
    prompt: string;
    attempt?: string;
  }) => void;
  onRevealedChange?: (revealed: boolean) => void;
}) {
  const [revealed, setRevealed] = useState(!review);
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
  const titleTextareaRef = useRef<HTMLTextAreaElement>(null);
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
  inlineEditingRef.current = editingTitle || editingAnswer || editingNote;
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
    if (review || !prevNext || prevNext.total <= 1) return;
    function stepKeys(event: KeyboardEvent) {
      if (
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
  }, [review, prevNext, aiOpen]);
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
          Math.min(window.innerWidth - 290, rect.left + rect.width / 2 - 130),
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
        onGrade?.(Number(event.key), inputMode === "written" ? answer : "");
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
  }) {
    if (!canInlineEdit || editBusy) return;
    const trimmedTitle = editDraft.title.trim();
    if (!trimmedTitle) {
      setEditError("请输入面试题目。");
      return;
    }
    if (trimmedTitle.length > 200) {
      setEditError("题目最多 200 字。");
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
    if (question.revision !== editDraft.baseRevision && !options?.merged) {
      setEditError("题目已在其他页面更新，请先在编辑区确认合并。");
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
        toast.success("修改已保存。");
      } else {
        setEditError("没有保存成功，当前草稿已保留。");
      }
    } finally {
      setEditBusy(false);
    }
  }
  const switchToNotesTab = useCallback(() => setTab("notes"), []);
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
  return (
    <div className="reader-layout notebook-reader">
      <div className="reader-body">
        <div className="reader-toolbar">
          <button className="back-link" onClick={onBack}>
            <ArrowLeft size={16} />
            {review ? (cram ? "结束突击" : "结束答题") : backLabel}
          </button>
          {!review && prevNext && prevNext.total > 1 && (
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
              <span>
                {prevNext.index + 1} / {prevNext.total}
              </span>
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
            <button
              className={`icon-button reader-desktop-tool ${question.favorite ? "is-favorite" : ""}`}
              aria-label={question.favorite ? "取消收藏" : "收藏题目"}
              onClick={onFavorite}
            >
              <Star
                size={17}
                fill={question.favorite ? "currentColor" : "none"}
              />
            </button>
            {(!review || revealed) && (
              <Button
                className="reader-desktop-tool"
                variant={aiOpen ? "secondary" : "outline"}
                size="sm"
                onClick={() => onToggleAi?.(!aiOpen)}
              >
                <Sparkles size={15} /> AI 助手
              </Button>
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
            {onToggleTheme && (
              <button
                type="button"
                className="icon-button reader-mobile-theme-btn"
                aria-label={
                  activeTheme === "dark" ? "切换浅色模式" : "切换深色模式"
                }
                onClick={onToggleTheme}
              >
                {activeTheme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
              </button>
            )}
            {(question.isOwner || !!question.validation || !review) && (
              <ActionMenu label="更多题目操作">
                {question.isOwner && !review && (
                  <button onClick={onMove}>
                    <FolderInput size={15} />
                    移动到题库
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
                              ? "已恢复到题库。"
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
                        if (result)
                          toast.success(
                            `已另存副本到「${target?.title ?? "未分类"}」。`,
                          );
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
        <article className="question-article">
          <header className="question-card-heading">
            <div className="question-breadcrumb">
              <span>{question.deckTitle}</span>
              <ChevronRight size={12} />
              <span>{review ? (cram ? "突击练习" : "答题") : "学习卡"}</span>
              {review && cram && (
                <span className="cram-badge">
                  {cramLabel || "专题突击"} · 不影响记忆曲线
                </span>
              )}
            </div>
            {canInlineEdit && editingTitle ? (
              <form
                className="inline-title-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveInlineQuestion({ closeTitle: true });
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
                      void saveInlineQuestion({ closeTitle: true });
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
                  <span>
                    {editDraft.title.length} / 200 · Enter 保存 · Esc 取消
                  </span>
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
                      disabled={editBusy || !editDraft.title.trim()}
                    >
                      {editBusy ? (
                        <Loader2 size={13} className="spin" />
                      ) : (
                        <Check size={13} />
                      )}
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
                  title="点击原地编辑题目"
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
                已恢复上次未保存的草稿。
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
          {review && (
            <section className="answer-draft">
              <div className="answer-draft-heading">
                <strong>你的作答</strong>
                <div className="segmented-control" aria-label="作答方式">
                  <button
                    aria-pressed={inputMode === "written"}
                    disabled={revealed}
                    onClick={() => {
                      setOralRunning(false);
                      setInputMode("written");
                    }}
                  >
                    <PenLine size={14} /> 默写
                  </button>
                  <button
                    aria-pressed={inputMode === "oral"}
                    disabled={revealed}
                    onClick={() => setInputMode("oral")}
                  >
                    <Mic size={14} /> 口述
                  </button>
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
                    <Clock size={14} />
                    <span>{formatTimer(oralSeconds)} / 02:00</span>
                    <button
                      type="button"
                      className="text-button"
                      disabled={revealed}
                      onClick={() => setOralRunning((r) => !r)}
                    >
                      {oralRunning ? <Pause size={13} /> : <Play size={13} />}
                      {oralRunning
                        ? "暂停"
                        : oralSeconds > 0
                          ? "继续"
                          : "开始计时"}
                    </button>
                    {oralSeconds > 0 && !revealed && (
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          setOralRunning(false);
                          setOralSeconds(0);
                        }}
                      >
                        重置
                      </button>
                    )}
                  </div>
                </div>
              )}
              <div
                className={`answer-submit-row ${!revealed ? "is-pre-reveal" : ""}`}
              >
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
                    {inputMode === "written" && answer.trim() && (
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
          )}
          {revealed && (
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
                      <div className="answer-actions">
                        {canInlineEdit && (
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => {
                              setHideAll(false);
                              setEditingAnswer(true);
                            }}
                          >
                            <PencilLine size={14} /> 编辑答案
                          </button>
                        )}
                        <button
                          className={`text-button ${hideAll ? "active" : ""}`}
                          onClick={() => setHideAll(!hideAll)}
                        >
                          <PenLine size={14} />
                          {hideAll ? "显示正文" : "逐段默写"}
                        </button>
                        <button
                          className="icon-button"
                          title="问 AI"
                          aria-label="围绕本题问 AI"
                          onClick={() =>
                            ask("请解释这道题，并举一个具体的例子。", "")
                          }
                        >
                          <MessageSquare size={16} />
                        </button>
                      </div>
                      <div className="answer-content">
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
                                  <Button
                                    onClick={() => onGenerateAnswer(question)}
                                  >
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
                      根据每次自评结果结合 FSRS
                      算法估算遗忘曲线，只在快忘掉前提醒巩固。
                    </p>
                  </section>
                )}
              </div>
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
                    onClick={() =>
                      onGrade?.(
                        item.rating,
                        inputMode === "written" ? answer : "",
                      )
                    }
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
              <PenLine size={14} /> 默写
            </button>
            <button
              type="button"
              aria-pressed={inputMode === "oral"}
              onClick={() => setInputMode("oral")}
            >
              <Mic size={14} /> 口述
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
      {selection && (
        <div
          className="selection-bubble"
          style={{ left: selection.x, top: selection.y }}
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
          <button aria-label="关闭选区菜单" onClick={() => setSelection(null)}>
            <X size={12} />
          </button>
        </div>
      )}
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
            ? "当前筛选范围暂无含参考答案的题目，返回题库调整条件即可。"
            : "暂无到期或新增题目，可前往题库自由练习或导入新题。"}
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
          <BookOpen size={15} /> 我的题库
        </Button>
        <Button onClick={onBack}>
          回到今日
          <ArrowRight size={16} />
        </Button>
      </div>
    </div>
  );
}
