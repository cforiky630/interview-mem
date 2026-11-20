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
  const target = edit.target === "deck" ? "题库" : "题目";
  const rows =
    edit.target === "deck"
      ? [
          ["名称", edit.fields.title],
          ["简介", edit.fields.description],
        ]
      : [
          ["标题", edit.fields.title],
          ["标签", edit.fields.tags?.join("、")],
        ];
  const answer = edit.target === "question" ? edit.fields.answer : undefined;
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
      {answer !== undefined && (
        <details className="chat-edit-answer">
          <summary>查看建议答案</summary>
          {answer.trim() ? <Markdown>{answer}</Markdown> : <p>清空答案</p>}
        </details>
      )}
      {state === "ready" ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={onApply}>
          {applying && <Loader2 size={14} className="spin" />}
          应用到{target}
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
