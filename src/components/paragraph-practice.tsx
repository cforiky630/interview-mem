"use client";
import { memo, useEffect, useRef, useState } from "react";
import {
  PencilLine,
  Eye,
  RotateCcw,
  X,
  Check,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import { Markdown } from "./markdown";
import { Button } from "./ui/button";
import { CarouselArrows } from "./ui/carousel-arrows";
import {
  readPracticeDraft,
  savePracticeDraft,
  type Followup,
  type StudyBlock,
} from "@/lib/study-document";

export const ParagraphPractice = memo(function ParagraphPractice({
  block,
  draftKey,
  references,
  hideAll,
}: {
  block: StudyBlock;
  draftKey: string;
  references: string;
  hideAll: boolean;
}) {
  const [active, setActive] = useState(hideAll);
  const [prevHideAll, setPrevHideAll] = useState(hideAll);
  const [showReference, setShowReference] = useState(false);
  if (hideAll !== prevHideAll) {
    setPrevHideAll(hideAll);
    setActive(hideAll);
    setShowReference(false);
  }
  const [refMounted, setRefMounted] = useState(false);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setDraft(readPracticeDraft(draftKey));
  }, [draftKey]);
  useEffect(() => {
    if (showReference) setRefMounted(true);
  }, [showReference]);
  useEffect(() => {
    if (active && !hideAll) input.current?.focus({ preventScroll: true });
  }, [active, hideAll]);
  const original = block.markdown + (references ? `\n\n${references}` : "");
  if (!block.practice) return <Markdown>{original}</Markdown>;
  function update(value: string) {
    setDraft(value);
    if (!savePracticeDraft(draftKey, value))
      toast.error("草稿暂时无法保存在浏览器中。");
  }
  return (
    <section
      className={`practice-block ${active ? "is-writing" : ""}`}
      data-block-id={block.id}
      style={{ marginLeft: Math.min(block.depth, 3) * 12 }}
    >
      {active ? (
        <>
          <div className="paragraph-heading">
            <span>
              <PencilLine size={14} /> 第 {block.number} 段
            </span>
            <button
              className="icon-button"
              aria-label={`结束第 ${block.number} 段默写`}
              onClick={() => {
                setActive(false);
                setShowReference(false);
              }}
            >
              <X size={14} />
            </button>
          </div>
          <textarea
            ref={input}
            aria-label={`第 ${block.number} 段默写`}
            placeholder="试着用自己的话把这段要点复述出来（Ctrl/⌘ + Enter 对照原文）…"
            value={draft}
            maxLength={20000}
            rows={Math.min(
              12,
              Math.max(3, Math.ceil(block.markdown.length / 70)),
            )}
            onChange={(event) => update(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (event.ctrlKey || event.metaKey) &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                setShowReference(true);
              }
            }}
          />
          <div className="paragraph-actions">
            {showReference ? (
              <>
                <button
                  className="text-button"
                  onClick={() => setShowReference(false)}
                >
                  <Eye size={13} /> 收起原文
                </button>
                <button
                  className="text-button"
                  onClick={() => {
                    update("");
                    setShowReference(false);
                    input.current?.focus();
                  }}
                >
                  <RotateCcw size={13} /> 重写
                </button>
              </>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowReference(true)}
              >
                <Check size={14} /> 对照原文
              </Button>
            )}
          </div>
          <div
            className="paragraph-reference-collapse"
            data-open={showReference ? "true" : "false"}
            aria-hidden={!showReference}
            inert={!showReference}
          >
            <div className="paragraph-reference-collapse-inner">
              {refMounted && (
                <div className="paragraph-reference">
                  <Markdown>{original}</Markdown>
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        <>
          <Markdown>{original}</Markdown>
          <button
            className="paragraph-start"
            aria-label={`默写第 ${block.number} 段`}
            title="默写这段"
            onClick={() => setActive(true)}
          >
            <PencilLine size={15} />
          </button>
        </>
      )}
    </section>
  );
});

export function FollowupCards({
  followups,
  draftPrefix,
  onEditFollowups,
}: {
  followups: Followup[];
  draftPrefix: string;
  onEditFollowups?: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [draft, setDraft] = useState("");
  const [dragX, setDragX] = useState(0);
  const cardTouch = useRef<{
    x: number;
    y: number;
    locked: "h" | "v" | null;
  } | null>(null);
  const safeIndex = followups.length ? Math.min(index, followups.length - 1) : 0;
  const current = followups[safeIndex];
  const key = `${draftPrefix}:followup:${current?.id}`;
  useEffect(() => {
    setDraft(readPracticeDraft(key));
    setRevealed(false);
  }, [key]);
  if (!current)
    return (
      <div className="quiet-empty followup-empty-state">
        <p>
          这道题还没有拆出面试追问。可在正文中用「## 追问」与 Q：/ A：
          编写追问，这里会自动生成独立抽认卡。
        </p>
        {onEditFollowups && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onEditFollowups}
          >
            <PencilLine size={14} /> 原地补充追问
          </Button>
        )}
      </div>
    );
  function select(next: number) {
    setIndex(next);
    setRevealed(false);
    setDraft(
      readPracticeDraft(`${draftPrefix}:followup:${followups[next].id}`),
    );
  }
  function move(step: number) {
    select((safeIndex + step + followups.length) % followups.length);
  }
  return (
    <section className="followup-workspace" aria-label="面试追问">
      <div className="carousel-controls">
        <span>面试追问</span>
        <div>
          {followups.length > 1 && (
            <div className="followup-inline-arrows">
              <button
                type="button"
                className="carousel-step-btn"
                aria-label="上一道追问"
                onClick={() => move(-1)}
              >
                <ChevronLeft size={15} />
              </button>
              <button
                type="button"
                className="carousel-step-btn"
                aria-label="下一道追问"
                onClick={() => move(1)}
              >
                <ChevronRight size={15} />
              </button>
            </div>
          )}
          <span aria-live="polite">
            {safeIndex + 1} / {followups.length}
          </span>
        </div>
      </div>
      <div className="followup-card-frame">
        <CarouselArrows
          count={followups.length}
          previousLabel="上一道追问"
          nextLabel="下一道追问"
          onPrevious={() => move(-1)}
          onNext={() => move(1)}
        />
        <div
          className="followup-card"
          key={current.id}
          style={
            dragX !== 0
              ? {
                  transform: `translateX(${dragX * 0.42}px) rotate(${dragX * 0.01}deg)`,
                  transition: "none",
                  touchAction: followups.length > 1 ? "pan-y" : undefined,
                }
              : followups.length > 1
                ? { touchAction: "pan-y" }
                : undefined
          }
          onTouchStart={(event) => {
            if (followups.length <= 1 || event.touches.length !== 1) return;
            const touch = event.touches[0];
            cardTouch.current = {
              x: touch.clientX,
              y: touch.clientY,
              locked: null,
            };
          }}
          onTouchMove={(event) => {
            const state = cardTouch.current;
            if (!state || event.touches.length !== 1) return;
            const touch = event.touches[0];
            const dx = touch.clientX - state.x;
            const dy = touch.clientY - state.y;
            if (!state.locked) {
              if (Math.hypot(dx, dy) < 10) return;
              state.locked =
                Math.abs(dx) > Math.abs(dy) * 1.25 ? "h" : "v";
            }
            if (state.locked === "h") {
              setDragX(dx);
            }
          }}
          onTouchEnd={(event) => {
            const state = cardTouch.current;
            cardTouch.current = null;
            if (state?.locked === "h") {
              const dx =
                (event.changedTouches[0]?.clientX ?? state.x) - state.x;
              if (dx < -48) move(1);
              else if (dx > 48) move(-1);
            }
            setDragX(0);
          }}
          onTouchCancel={() => {
            cardTouch.current = null;
            setDragX(0);
          }}
        >
          <span className="card-number">
            Q{String(safeIndex + 1).padStart(2, "0")}
          </span>
          <div className="followup-question">
            <Markdown>{current.question}</Markdown>
          </div>
          <textarea
            aria-label="追问作答"
            placeholder="针对这道追问，写出你第一时间能想到的思路或关键踩坑…"
            rows={4}
            maxLength={20000}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              if (!savePracticeDraft(key, event.target.value))
                toast.error("草稿暂时无法保存在浏览器中。");
            }}
          />
          <Button variant="secondary" onClick={() => setRevealed(!revealed)}>
            <Eye size={15} />
            {revealed ? "收起答案" : "查看答案"}
          </Button>
          {revealed && (
            <div className="followup-answer">
              <Markdown>{current.answer}</Markdown>
            </div>
          )}
        </div>
      </div>
      <div className="carousel-dots" aria-label="选择追问">
        {followups.map((item, i) => (
          <button
            key={item.id}
            aria-label={`第 ${i + 1} 道追问`}
            aria-current={i === safeIndex ? "true" : undefined}
            onClick={() => select(i)}
          />
        ))}
      </div>
    </section>
  );
}
