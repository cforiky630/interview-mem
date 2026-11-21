"use client";
import { Loader2 } from "lucide-react";
import type { ChatEdit, DeckView, QuestionView } from "@/lib/types";
import { Markdown } from "./markdown";
import { Button } from "./ui/button";

export function chatEditState(
  edit: ChatEdit,
  question: QuestionView,
  deck?: DeckView,
) {
  if (!question.isOwner) return "unavailable";
  if (edit.target === "deck") {
    if (!deck?.isOwner || deck.id !== edit.id) return "unavailable";
    const { title, description } = edit.fields;
    if (
      (title === undefined || title === deck.title) &&
      (description === undefined || description === deck.description)
    )
      return "matched";
    return deck.title === edit.expected.title &&
      deck.description === edit.expected.description
      ? "ready"
      : "stale";
  }
  if (edit.target === "note") {
    if (question.id !== edit.id) return "unavailable";
    if (edit.fields.note === question.note) return "matched";
    return question.noteVersion === edit.expectedVersion ? "ready" : "stale";
  }
  if (question.id !== edit.id) return "unavailable";
  const { title, answer, tags } = edit.fields;
  if (
    (title === undefined || title === question.title) &&
    (answer === undefined || answer === question.answer) &&
    (tags === undefined ||
      JSON.stringify(tags) === JSON.stringify(question.tags))
  )
    return "matched";
  return question.revision === edit.revision ? "ready" : "stale";
}

export function ChatEditCard({
  edit,
  question,
  deck,
  busy,
  applying,
  onApply,
}: {
  edit: ChatEdit;
  question: QuestionView;
  deck?: DeckView;
  busy: boolean;
  applying: boolean;
  onApply: () => void;
}) {
  const state = chatEditState(edit, question, deck);
  const target =
    edit.target === "deck"
      ? "题库"
      : edit.target === "note"
        ? "个人笔记"
        : "题目";
  const applyTarget = edit.target === "note" ? "笔记" : target;
  const rows =
    edit.target === "deck"
      ? [
          ["名称", edit.fields.title],
          ["简介", edit.fields.description],
        ]
      : edit.target === "question"
        ? [
            ["标题", edit.fields.title],
            ["标签", edit.fields.tags?.join("、")],
          ]
        : [];
  const detailContent =
    edit.target === "question"
      ? edit.fields.answer
      : edit.target === "note"
        ? edit.fields.note
        : undefined;
  const detailSummary =
    edit.target === "note" ? "查看建议笔记" : "查看建议答案";
  const detailEmpty = edit.target === "note" ? "清空个人笔记" : "清空答案";
  return (
    <div className="chat-edit-card">
      <strong>{target}修改建议</strong>
      {rows.map(
        ([label, value]) =>
          value !== undefined && (
            <p key={label}>
              <span>{label}</span>
              {value || "清空"}
            </p>
          ),
      )}
      {detailContent !== undefined && (
        <details className="chat-edit-answer">
          <summary>{detailSummary}</summary>
          {detailContent.trim() ? (
            <Markdown>{detailContent}</Markdown>
          ) : (
            <p>{detailEmpty}</p>
          )}
        </details>
      )}
      {state === "ready" ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={onApply}>
          {applying && <Loader2 size={14} className="spin" />}
          应用到{applyTarget}
        </Button>
      ) : (
        <small className="muted" role="status">
          {state === "matched"
            ? "当前内容已符合建议"
            : state === "stale"
              ? "内容已更新，请重新生成建议"
              : "当前无法编辑这项内容"}
        </small>
      )}
    </div>
  );
}
