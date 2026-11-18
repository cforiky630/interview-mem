"use client";
import { useEffect, useMemo, useRef, useState } from "react";
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
  ChevronRight,
  BookOpen,
  Mic,
  PenLine,
  Trash2,
  FolderInput,
} from "lucide-react";
import { toast } from "sonner";
import type { QuestionView, Workspace } from "@/lib/types";
import { api } from "@/lib/client";
import { relativeDue } from "@/lib/utils";
import { markdownDocument } from "@/lib/markdown-source";
import {
  practiceDraftKey,
  readPracticeDraft,
  savePracticeDraft,
  studyDocument,
} from "@/lib/study-document";
import { Button } from "./ui/button";
import { ActionMenu } from "./ui/action-menu";
import { Dialog } from "./ui/dialog";
import { Markdown, ObsidianProperties } from "./markdown";
import { ParagraphPractice, FollowupCards } from "./paragraph-practice";
import { ContentValidationPanel } from "./content-validation";
import { AiPanel, type AiTrigger } from "./ai-panel";
import type { Mutate } from "./dialogs";

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
  onEdit,
  onDelete,
  onMove,
  onSettings,
  onGenerateAnswer,
  onFavorite,
  mutate,
  review,
  onGrade,
  busy,
  progress,
  onSingleReview,
}: {
  question: QuestionView;
  data: Workspace;
  onBack: () => void;
  backLabel?: string;
  onEdit: () => void;
  onDelete: () => void;
  onMove: () => void;
  onSettings: () => void;
  onGenerateAnswer: (q: QuestionView) => void;
  onFavorite: () => void;
  mutate: Mutate;
  review?: boolean;
  onGrade?: (rating: number, answer: string) => void;
  busy?: boolean;
  progress?: { current: number; total: number };
  onSingleReview?: () => void;
}) {
  const [revealed, setRevealed] = useState(!review);
  const noteMeta = useMemo(
    () => markdownDocument(question.answer),
    [question.answer],
  );
  const mergedTags = useMemo(
    () => Array.from(new Set([...question.tags, ...noteMeta.tags])),
    [question.tags, noteMeta.tags],
  );
  const documentView = useMemo(
    () => studyDocument(revealed ? question.answer : "", question.title),
    [question.answer, question.title, revealed],
  );
  const [tab, setTab] = useState<ReaderTab>("answer");
  const [inputMode, setInputMode] = useState<"written" | "oral">("written");
  const [answer, setAnswer] = useState("");
  const [hideAll, setHideAll] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [validationOpen, setValidationOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [trigger, setTrigger] = useState<AiTrigger | null>(null);
  const [selection, setSelection] = useState<{
    text: string;
    x: number;
    y: number;
  } | null>(null);
  const [note, setNote] = useState(question.note);
  const [noteBase, setNoteBase] = useState(question.noteVersion);
  const [noteDirty, setNoteDirty] = useState(false);
  const [noteBusy, setNoteBusy] = useState(false);
  const [insight, setInsight] = useState<Insight | null>(null);
  const insightVersion = useRef("");
  const answerRef = useRef<HTMLDivElement>(null);
  const draftKey = `shiyi:note:${data.user.id}:${question.id}`;
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
  useEffect(() => {
    setAnswer(readPracticeDraft(answerKey));
  }, [answerKey]);
  useEffect(() => {
    const draft = localStorage.getItem(draftKey);
    if (draft === null) return;
    try {
      const saved = JSON.parse(draft);
      if (typeof saved.content !== "string" || !Number.isInteger(saved.version))
        throw new Error();
      setNote(saved.content);
      setNoteBase(saved.version);
    } catch {
      setNote(draft);
      setNoteBase(0);
    }
    setNoteDirty(true);
  }, [draftKey]);
  useEffect(() => {
    if (!noteDirty && !localStorage.getItem(draftKey)) {
      setNote(question.note);
      setNoteBase(question.noteVersion);
    }
  }, [question.note, question.noteVersion, noteDirty, draftKey]);
  useEffect(() => {
    // 普通阅读不抢发曲线请求；答题或打开“记忆”时才读取，同版本复用结果。
    if (!review && tab !== "memory") return;
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
  }, [question.id, question.studyVersion, review, tab]);
  useEffect(() => {
    function detect() {
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
      if (!anchor?.closest(".prose-content")) {
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
        event.target.closest(".ai-panel, .table-scroll, pre")
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
          "input,textarea,select,[contenteditable='true'],[role='dialog'],button",
        ) ||
        globalThis.document.querySelector("[role='dialog']") ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        chatOpen ||
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
  }, [review, revealed, busy, chatOpen, onGrade, answer, inputMode]);
  function ask(prompt: string, quote = selection?.text ?? "") {
    setChatOpen(true);
    setTrigger({ quote, prompt, nonce: Date.now() });
    setSelection(null);
    window.getSelection()?.removeAllRanges();
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
        localStorage.removeItem(draftKey);
        setNoteBase(Number(result.version));
        setNoteDirty(false);
      }
    } finally {
      setNoteBusy(false);
    }
  }
  async function appendNote(content: string) {
    const value = note + content;
    setNote(value);
    setNoteDirty(true);
    localStorage.setItem(
      draftKey,
      JSON.stringify({ content: value, version: noteBase }),
    );
    await saveNote(value);
    setTab("notes");
  }
  const ratings = [
    { rating: 1, label: "忘了", className: "again" },
    { rating: 2, label: "困难", className: "hard" },
    { rating: 3, label: "记得", className: "good" },
    { rating: 4, label: "轻松", className: "easy" },
  ];
  const tabs: { id: ReaderTab; label: string }[] = [
    { id: "answer", label: "正文" },
    { id: "followups", label: "追问" },
    { id: "notes", label: "笔记" },
    { id: "memory", label: "记忆" },
  ];
  return (
    <div
      className={`reader-layout notebook-reader ${chatOpen ? "with-chat" : ""}`}
    >
      <div className="reader-body">
        <div className="reader-toolbar">
          <button className="back-link" onClick={onBack}>
            <ArrowLeft size={16} />
            {review ? "结束答题" : backLabel}
          </button>
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
              className={`icon-button ${question.favorite ? "is-favorite" : ""}`}
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
                variant={chatOpen ? "secondary" : "outline"}
                size="sm"
                onClick={() => setChatOpen(!chatOpen)}
              >
                <Sparkles size={15} /> AI
              </Button>
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
                  <button onClick={onEdit}>
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
              <span>{review ? "答题" : "学习卡"}</span>
            </div>
            <h1>{question.title}</h1>
            <div className="question-card-foot">
              <div className="question-tags">
                {mergedTags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
              {!review && !question.archived && !!question.answer.trim() && (
                <Button size="sm" onClick={onSingleReview}>
                  <PenLine size={15} /> 开始答题
                </Button>
              )}
            </div>
          </header>
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
                    onClick={() => setInputMode("written")}
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
                </div>
              )}
              <div className="answer-submit-row">
                {!revealed ? (
                  <Button onClick={() => setRevealed(true)}>
                    <Eye size={15} /> 对照答案
                  </Button>
                ) : (
                  <button
                    className="text-button"
                    onClick={() => {
                      setRevealed(false);
                      setChatOpen(false);
                      setTab("answer");
                    }}
                  >
                    <RotateCcw size={14} /> 再想一遍
                  </button>
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
                {tab === "answer" && (
                  <>
                    {noteMeta.properties.length > 0 && (
                      <ObsidianProperties
                        source={question.answer}
                        extraTags={question.tags}
                        defaultExpanded
                      />
                    )}
                    <div className="answer-actions">
                      <button
                        className={`text-button ${hideAll ? "active" : ""}`}
                        onClick={() => setHideAll(!hideAll)}
                      >
                        <PencilLine size={14} />
                        {hideAll ? "显示正文" : "逐段默写"}
                      </button>
                      <button
                        className="icon-button"
                        title="问 AI"
                        aria-label="引用本题提问"
                        onClick={() =>
                          ask(
                            "请解释这道题，并举一个具体的例子。",
                            question.answer.slice(0, 5000),
                          )
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
                                <Button variant="ghost" onClick={onEdit}>
                                  自己补充
                                </Button>
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
                )}
                {tab === "followups" && (
                  <FollowupCards
                    followups={documentView.followups}
                    draftPrefix={answerKey}
                  />
                )}
                {tab === "notes" && (
                  <section className="personal-notes">
                    <div className="section-heading">
                      <h2>我的笔记</h2>
                    </div>
                    {noteDirty && noteBase !== question.noteVersion && (
                      <div className="note-conflict">
                        <strong>云端笔记已有更新</strong>
                        <details>
                          <summary>查看云端版本，再合并到下方草稿</summary>
                          <Markdown>
                            {question.note || "云端笔记为空。"}
                          </Markdown>
                        </details>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={noteBusy}
                          onClick={() =>
                            void saveNote(note, question.noteVersion)
                          }
                        >
                          已合并，保存到最新版本
                        </Button>
                      </div>
                    )}
                    <textarea
                      aria-label="个人笔记"
                      placeholder="记下你的第一反应、容易混淆的边界条件，或结合过往项目经历梳理出的回答话术…"
                      value={note}
                      maxLength={50000}
                      rows={8}
                      onChange={(event) => {
                        setNote(event.target.value);
                        setNoteDirty(true);
                        localStorage.setItem(
                          draftKey,
                          JSON.stringify({
                            content: event.target.value,
                            version: noteBase,
                          }),
                        );
                      }}
                    />
                    <div className="notes-footer">
                      <span>{note !== question.note ? "草稿" : "已保存"}</span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={noteBusy || note === question.note}
                        onClick={() => void saveNote()}
                      >
                        {noteBusy ? (
                          <Loader2 size={13} className="spin" />
                        ) : (
                          <Check size={13} />
                        )}{" "}
                        保存笔记
                      </Button>
                    </div>
                  </section>
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
                      根据每次自评结果结合 FSRS 算法估算遗忘曲线，只在快忘掉前提醒巩固。
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
                      {insight?.previews.find(
                        (preview) => preview.rating === item.rating,
                      )?.interval ?? "…"}
                    </small>
                  </button>
                ))}
              </div>
            </section>
          )}
        </article>
      </div>
      {chatOpen && (
        <AiPanel
          question={question}
          data={data}
          trigger={trigger}
          onClose={() => setChatOpen(false)}
          onSettings={onSettings}
          onAppendNote={appendNote}
          mutate={mutate}
        />
      )}
      {selection && (
        <div
          className="selection-bubble"
          style={{ left: selection.x, top: selection.y }}
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
  onBack,
  onLibrary,
}: {
  count: number;
  ratings: number[];
  onBack: () => void;
  onLibrary: () => void;
}) {
  return (
    <div className="page review-complete">
      <div className="completion-art">
        <Check size={42} strokeWidth={1.7} />
      </div>
      <h1>{count ? "本轮完成" : "暂时没有待复习的题"}</h1>
      {!count && (
        <p>
          暂无到期或新增题目，可前往题库自由练习或导入新题。
        </p>
      )}
      {count > 0 && (
        <>
          <p>
            本轮已完成 {count} 题主动回忆，下次复习时间已自动安排。
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
