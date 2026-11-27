import type { ChatMessage, QuestionView } from "./types";
import {
  noteDraftKey,
  pendingNoteDrafts,
  readNoteDrafts,
  selectedNoteDraft,
} from "./drafts";

export type AiScope = "question" | "deck" | "workspace";

export type ParsedSseEvent = {
  event: string;
  payload: Record<string, unknown>;
};

export function clampAiDockWidth(
  width: number,
  viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1440,
): number {
  const maxWidth = Math.min(620, Math.max(380, Math.floor(viewportWidth * 0.45)));
  return Math.min(maxWidth, Math.max(360, Math.round(width)));
}

export function parseSseBlocks(
  rawPending: string,
  flushAll: boolean,
): { events: ParsedSseEvent[]; rest: string } {
  const normalized = rawPending.replace(/\r\n?/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = flushAll ? "" : (parts.pop() ?? "");
  const events: ParsedSseEvent[] = [];

  for (const block of parts) {
    if (!block.trim()) continue;
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (!dataLines.length) continue;
    const rawJson = dataLines.join("\n").trim();
    if (!rawJson || rawJson === "[DONE]") continue;
    try {
      const payload = JSON.parse(rawJson);
      if (payload && typeof payload === "object") {
        events.push({ event, payload: payload as Record<string, unknown> });
      }
    } catch {
      /* Ignore malformed JSON chunk from upstream. */
    }
  }

  return { events, rest };
}

export function buildScopeKey(
  scope: AiScope,
  userId: string,
  questionId?: string,
  deckId?: string,
) {
  if (scope === "question" && questionId) return `q:${questionId}`;
  if (scope === "deck" && deckId) return `d:${deckId}`;
  return `w:${userId}`;
}

export function buildChatUrl(
  scope: AiScope,
  questionId?: string,
  deckId?: string,
) {
  if (scope === "question" && questionId) {
    return `/api/chat?scope=question&questionId=${encodeURIComponent(questionId)}`;
  }
  if (scope === "deck" && deckId) {
    return `/api/chat?scope=deck&deckId=${encodeURIComponent(deckId)}`;
  }
  return "/api/chat?scope=workspace";
}

export function formatNoteAppendSection(
  baseNote: string,
  content: string,
  heading = "AI 补充",
): string {
  const cleanHeading = heading.trim() || "AI 补充";
  const block = `### ${cleanHeading}\n${content.trim()}`;
  const existing = baseNote.trimEnd();
  return existing ? `${existing}\n\n${block}` : block;
}

export function appendToStoredNote(
  userId: string,
  question: Pick<QuestionView, "id" | "note" | "noteVersion">,
  content: string,
  heading = "AI 补充",
) {
  const key = noteDraftKey(userId, question.id);
  const drafts = readNoteDrafts(key);
  const selected = selectedNoteDraft(key, drafts);
  const pending = pendingNoteDrafts(drafts).filter(
    (draft) => draft.content !== question.note,
  );
  const draft = selected && selected.content !== question.note
    ? selected
    : selected === undefined && pending.length === 1 ? pending[0] : undefined;
  if (pending.length && !draft) return null;
  return {
    nextNote: formatNoteAppendSection(
      draft?.content ?? question.note,
      content,
      heading,
    ),
    expectedVersion: draft?.version ?? question.noteVersion,
    draft,
  };
}

export function suggestCardTitle(
  questionTitle: string,
  messages: ChatMessage[],
  targetMessage: ChatMessage,
): string {
  const idx = messages.findIndex((m) => m.id === targetMessage.id);
  const rawPrev =
    (idx >= 0 ? messages.slice(0, idx) : [...messages])
      .reverse()
      .find((m) => m.role === "user")?.content ?? "";
  const normalized = rawPrev.replace(/\s+/g, " ").trim();
  const topicSuffix =
    !normalized || normalized.includes("点评我的本次作答")
      ? "作答点评要点"
      : normalized;
  return `${questionTitle} · ${topicSuffix}`.slice(0, 200);
}
