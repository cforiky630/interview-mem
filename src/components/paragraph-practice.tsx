"use client";
import { memo, useEffect, useRef, useState } from "react";
import { PencilLine, Eye, RotateCcw, X, Check } from "lucide-react";
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
  const [showReference, setShowReference] = useState(false);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setDraft(readPracticeDraft(draftKey));
  }, [draftKey]);
  useEffect(() => {
    setActive(hideAll);
    setShowReference(false);
  }, [hideAll]);
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
            placeholder="写下你记得的内容…"
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
          {showReference && (
            <div className="paragraph-reference">
              <Markdown>{original}</Markdown>
            </div>
          )}
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
}: {
  followups: Followup[];
  draftPrefix: string;
}) {
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [draft, setDraft] = useState("");
  const current = followups[index];
  const key = `${draftPrefix}:followup:${current?.id}`;
  useEffect(() => {
    setDraft(readPracticeDraft(key));
    setRevealed(false);
  }, [key]);
  if (!current) return <div className="quiet-empty">这道题还没有追问。</div>;
  function select(next: number) {
    setIndex(next);
    setRevealed(false);
    setDraft(
      readPracticeDraft(`${draftPrefix}:followup:${followups[next].id}`),
    );
  }
  function move(step: number) {
    select((index + step + followups.length) % followups.length);
  }
  return (
    <section className="followup-workspace" aria-label="面试追问">
      <div className="carousel-controls">
        <span>面试追问</span>
        <div>
          <span aria-live="polite">
            {index + 1} / {followups.length}
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
        <div className="followup-card" key={current.id}>
          <span className="card-number">
            Q{String(index + 1).padStart(2, "0")}
          </span>
          <div className="followup-question">
            <Markdown>{current.question}</Markdown>
          </div>
          <textarea
            aria-label="追问作答"
            placeholder="试着回答…"
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
            aria-current={i === index ? "true" : undefined}
            onClick={() => select(i)}
          />
        ))}
      </div>
    </section>
  );
}
