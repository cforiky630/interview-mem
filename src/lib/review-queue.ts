import type { QuestionView } from "./types";

export function isQuestionReviewable(
  q: Pick<QuestionView, "archived" | "answer">,
): boolean {
  return !q.archived && q.answer.trim().length > 0;
}

export function isQuestionMajorRevisionDue(
  q: Pick<QuestionView, "fsrs" | "majorRevision" | "reviewedRevision">,
): boolean {
  return Boolean(q.fsrs && q.majorRevision > q.reviewedRevision);
}

export function isQuestionDue(
  q: Pick<QuestionView, "fsrs" | "majorRevision" | "reviewedRevision">,
  now = Date.now(),
): boolean {
  if (!q.fsrs) return false;
  if (q.majorRevision > q.reviewedRevision) return true;
  return new Date(q.fsrs.due).getTime() <= now;
}

export function buildReviewQueue(
  questions: QuestionView[],
  opts: {
    dailyNewLimit: number;
    newLearnedToday: number;
    now?: number;
    deckId?: string | null;
    deckIds?: ReadonlySet<string | null>;
  },
) {
  const now = opts.now ?? Date.now();
  const active = questions.filter((q) => {
    if (!isQuestionReviewable(q)) return false;
    if (opts.deckIds) return opts.deckIds.has(q.deckId);
    if (opts.deckId !== undefined && opts.deckId !== null)
      return q.deckId === opts.deckId;
    return true;
  });
  const majorReview = active
    .filter((q) => isQuestionMajorRevisionDue(q))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const majorIds = new Set(majorReview.map((q) => q.id));
  const dueReview = active
    .filter(
      (q) =>
        !majorIds.has(q.id) &&
        q.fsrs &&
        new Date(q.fsrs.due).getTime() <= now,
    )
    .sort(
      (a, b) =>
        new Date(a.fsrs!.due).getTime() - new Date(b.fsrs!.due).getTime(),
    );
  const remainingNew = Math.max(0, opts.dailyNewLimit - opts.newLearnedToday);
  const fresh = active.filter((q) => !q.fsrs).slice(0, remainingNew);
  return {
    active,
    majorReview,
    dueReview,
    dueCount: majorReview.length + dueReview.length,
    fresh,
    queue: [...majorReview, ...dueReview, ...fresh],
    remainingNew,
  };
}
