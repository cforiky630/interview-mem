import {
  DefaultScheduler,
  type DefaultSchedulerCardInput,
  type Grade,
} from "ts-fsrs";
import type { StoredCard } from "@/lib/types";
import { readableInterval } from "@/lib/utils";

const schedulerPromise = DefaultScheduler({
  version: "FSRS-7",
  desiredRetention: 0.9,
  enableFuzz: false,
});
function unpack(
  stored: StoredCard | null,
  now: Date,
  scheduler: Awaited<typeof schedulerPromise>,
): DefaultSchedulerCardInput {
  if (!stored) return scheduler.newCard({ now });
  if (stored.engine !== "FSRS-7") throw new Error("未知调度模型，需要迁移。");
  return {
    ...stored.raw,
    dueAt: new Date(String(stored.raw.dueAt)),
    lastReviewAt: stored.raw.lastReviewAt
      ? new Date(String(stored.raw.lastReviewAt))
      : null,
  } as DefaultSchedulerCardInput;
}
export async function schedule(
  stored: StoredCard | null,
  rating: number,
  now = new Date(),
): Promise<StoredCard> {
  const scheduler = await schedulerPromise;
  const result = scheduler.review({
    card: unpack(stored, now, scheduler),
    grade: rating as Grade,
    now,
  });
  const raw = JSON.parse(JSON.stringify(result.card)) as Record<
    string,
    unknown
  >;
  return {
    engine: "FSRS-7",
    raw,
    due: result.card.dueAt.toISOString(),
    stability: result.card.stability,
    difficulty: result.card.difficulty,
    elapsed_days: stored?.last_review
      ? Math.max(
          0,
          (now.getTime() - new Date(stored.last_review).getTime()) / 86400_000,
        )
      : 0,
    scheduled_days: (result.card.dueAt.getTime() - now.getTime()) / 86400_000,
    reps: (stored?.reps ?? 0) + 1,
    lapses: (stored?.lapses ?? 0) + (rating === 1 && stored ? 1 : 0),
    state: Number(result.card.state ?? (rating === 1 ? 1 : 2)),
    last_review: now.toISOString(),
  };
}
export async function reviewInsight(
  stored: StoredCard | null,
  now = new Date(),
) {
  const scheduler = await schedulerPromise;
  const card = unpack(stored, now, scheduler);
  const previews = Array.from(scheduler.preview({ card, now })).map((item) => ({
    rating: item.grade,
    due: item.card.dueAt.toISOString(),
    interval: readableInterval(item.card.dueAt, now),
  }));
  const curve = stored
    ? [0, 1, 2, 3, 5, 7, 10, 14, 21, 30].map((day) => ({
        day,
        retention:
          Math.round(
            scheduler.model.forgettingCurve(
              card as Parameters<typeof scheduler.model.forgettingCurve>[0],
              day,
            ) * 1000,
          ) / 10,
      }))
    : [];
  return { previews, curve };
}
