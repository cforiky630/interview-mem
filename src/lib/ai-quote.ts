import type { Conversation, ConversationScope } from "./types";

function normalizeBreaks(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

/**
 * Detect whether a quote string is actually a full-answer dump (e.g. from legacy
 * whole-question "问 AI" triggers that sent `question.answer.slice(0, 5000)`).
 */
export function isFullAnswerQuote(
  quote: string,
  answerText?: string | null,
): boolean {
  const q = normalizeBreaks(quote);
  const a = normalizeBreaks(answerText ?? "");
  if (!q || !a || q.length < 80) return false;
  if (q === a) return true;
  return a.startsWith(q) && (q.length >= a.length * 0.85 || q.length >= 4800);
}

/**
 * Collapse multiline/whitespace-heavy text into a compact single-line preview.
 */
export function formatQuotePreview(quote: string, maxLen = 48): string {
  const collapsed = quote.replace(/\s+/g, " ").trim();
  if (!collapsed || collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, maxLen).trimEnd()}…`;
}

/**
 * Build a readable history dropdown label without mislabeling full-answer quotes as highlights.
 */
export function formatThreadLabel(
  thread: Pick<
    Conversation,
    "attempt" | "quote" | "answerSnapshot" | "questionRevision" | "messages"
  >,
  scope: ConversationScope,
  fallbackAnswer?: string,
): string {
  const firstUser =
    thread.messages.find((m) => m.role === "user")?.content ?? "";
  if (scope === "question") {
    if (thread.attempt.trim()) {
      return `[作答点评] ${formatQuotePreview(firstUser || "默写点评", 24)}`;
    }
    if (
      thread.quote.trim() &&
      !isFullAnswerQuote(thread.quote, thread.answerSnapshot || fallbackAnswer)
    ) {
      return `划选：${formatQuotePreview(thread.quote, 24)}`;
    }
    return formatQuotePreview(firstUser, 28) || "题目问答";
  }
  return (
    formatQuotePreview(firstUser, 32) ||
    (scope === "deck" ? "文件夹整理" : "全局资料问答")
  );
}
