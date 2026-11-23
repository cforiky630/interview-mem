import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  decks,
  questions,
  releases,
  subscriptions,
  studyCards,
  reviewEvents,
  credentials,
  preferences,
  user as users,
  type PublishedQuestion,
} from "@/db/schema";
import type { Identity } from "./api";
import type {
  DeckView,
  QuestionView,
  StoredCard,
  Workspace,
} from "@/lib/types";
import { dateKey } from "@/lib/utils";
import { AppError } from "./errors";
import { contentHash } from "./crypto";

export async function ensureWorkspace(userId: string) {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(preferences)
      .values({ userId, onboarded: true })
      .onConflictDoNothing()
      .returning();
    if (inserted.length)
      await tx.insert(decks).values({
        id: crypto.randomUUID(),
        ownerId: userId,
        title: "我的面试题",
        description:
          "收录日常整理的高频面经、技术盲点与复盘思路，按记忆曲线逐步内化为自己的表达。",
        color: "sage",
      });
  });
}

export function publishedQuestion(
  q: Pick<
    typeof questions.$inferSelect,
    | "id"
    | "deckId"
    | "parentId"
    | "title"
    | "answer"
    | "tags"
    | "revision"
    | "majorRevision"
    | "needsEditing"
    | "archived"
    | "createdAt"
    | "updatedAt"
    | "validation"
  >,
): PublishedQuestion {
  return {
    id: q.id,
    deckId: q.deckId,
    parentId: q.parentId,
    title: q.title,
    answer: q.answer,
    tags: q.tags,
    revision: q.revision,
    majorRevision: q.majorRevision,
    needsEditing: q.needsEditing,
    archived: q.archived,
    createdAt: q.createdAt.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
    validation: q.validation
      ? {
          ...q.validation,
          current: q.validation.reviewedHash === contentHash(q.title, q.answer),
        }
      : null,
  };
}

export async function ownedDeck(userId: string, deckId: string) {
  const db = await getDb();
  const [deck] = await db
    .select()
    .from(decks)
    .where(
      and(
        eq(decks.id, deckId),
        eq(decks.ownerId, userId),
        isNull(decks.deletedAt),
      ),
    );
  if (!deck) throw new AppError(404, "题库不存在或没有编辑权限。");
  return deck;
}

export async function accessibleQuestion(
  userId: string,
  questionId: string,
): Promise<PublishedQuestion & { isOwner: boolean }> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(questions)
    .where(eq(questions.id, questionId));
  if (!row) throw new AppError(404, "题目不存在或无权访问。");
  if (row.ownerId === userId) {
    if (row.deletedAt || row.purgedAt)
      throw new AppError(404, "题目已删除或不可访问。");
    return { ...publishedQuestion(row), isOwner: true };
  }
  // A published question keeps its stable identity when the author removes a category or deletes the draft.
  const snapshots = await db
    .select({ release: releases })
    .from(subscriptions)
    .innerJoin(decks, eq(subscriptions.deckId, decks.id))
    .innerJoin(
      releases,
      and(
        eq(releases.deckId, decks.id),
        eq(releases.version, decks.publishedVersion),
      ),
    )
    .where(
      and(
        eq(subscriptions.userId, userId),
        sql`${releases.questions} @> ${JSON.stringify([{ id: questionId }])}::jsonb`,
      ),
    )
    .orderBy(releases.deckId)
    .limit(1);
  const question = snapshots[0]?.release.questions.find(
    (q) => q.id === questionId,
  );
  if (!question) throw new AppError(404, "这道题尚未发布或无权访问。");
  return { ...question, isOwner: false };
}

export async function getWorkspace(identity: Identity): Promise<Workspace> {
  await ensureWorkspace(identity.id);
  const db = await getDb();
  const [own, subscribed, states, logs, prefRows, keyRows] = await Promise.all([
    db
      .select()
      .from(decks)
      .where(and(eq(decks.ownerId, identity.id), isNull(decks.deletedAt)))
      .orderBy(decks.createdAt),
    db
      .select({ deck: decks, subscription: subscriptions, owner: users.name })
      .from(subscriptions)
      .innerJoin(decks, eq(subscriptions.deckId, decks.id))
      .innerJoin(users, eq(decks.ownerId, users.id))
      .where(eq(subscriptions.userId, identity.id)),
    db.select().from(studyCards).where(eq(studyCards.userId, identity.id)),
    db
      .select()
      .from(reviewEvents)
      .where(eq(reviewEvents.userId, identity.id))
      .orderBy(desc(reviewEvents.createdAt))
      .limit(30),
    db.select().from(preferences).where(eq(preferences.userId, identity.id)),
    db
      .select({
        keyHint: credentials.keyHint,
        provider: credentials.provider,
        baseUrl: credentials.baseUrl,
        model: credentials.model,
      })
      .from(credentials)
      .where(eq(credentials.userId, identity.id)),
  ]);
  const timeZone = prefRows[0]?.timeZone ?? "Asia/Shanghai";
  const today = dateKey(new Date(), timeZone);
  const dayExpression = sql<string>`to_char(${reviewEvents.createdAt} at time zone ${timeZone}, 'YYYY-MM-DD')`;
  const recentCutoff = new Date(Date.now() - 30 * 86400_000);
  const [drafts, activityRows, aggregateRows, published] = await Promise.all([
    db
      .select({
        id: questions.id,
        deckId: questions.deckId,
        parentId: questions.parentId,
        title: questions.title,
        answer: questions.answer,
        tags: questions.tags,
        revision: questions.revision,
        majorRevision: questions.majorRevision,
        needsEditing: questions.needsEditing,
        archived: questions.archived,
        createdAt: questions.createdAt,
        updatedAt: questions.updatedAt,
        validation: questions.validation,
      })
      .from(questions)
      .where(
        and(
          eq(questions.ownerId, identity.id),
          isNull(questions.deletedAt),
          isNull(questions.purgedAt),
        ),
      )
      .orderBy(asc(questions.createdAt), asc(questions.id)),
    db
      .select({ date: dayExpression, count: sql<number>`count(*)::int` })
      .from(reviewEvents)
      .where(eq(reviewEvents.userId, identity.id))
      .groupBy(sql`1`),
    db
      .select({
        total: sql<number>`count(*)::int`,
        recent: sql<number>`(count(*) filter (where ${reviewEvents.createdAt} >= ${recentCutoff}))::int`,
        remembered: sql<number>`(count(*) filter (where ${reviewEvents.createdAt} >= ${recentCutoff} and ${reviewEvents.rating} > 1))::int`,
        today: sql<number>`count(distinct case when ${dayExpression} = ${today} then ${reviewEvents.questionId} end)::int`,
        newToday: sql<number>`count(distinct case when ${dayExpression} = ${today} and ${reviewEvents.before} is null then ${reviewEvents.questionId} end)::int`,
      })
      .from(reviewEvents)
      .where(eq(reviewEvents.userId, identity.id)),
    subscribed.length
      ? db
          .select({ release: releases })
          .from(releases)
          .innerJoin(
            decks,
            and(
              eq(releases.deckId, decks.id),
              eq(releases.version, decks.publishedVersion),
            ),
          )
          .where(
            inArray(
              releases.deckId,
              subscribed.map((s) => s.deck.id),
            ),
          )
      : [],
  ]);
  const stateMap = new Map(states.map((s) => [s.questionId, s]));
  const releaseMap = new Map(
    published.map((p) => [p.release.deckId, p.release]),
  );
  const questionViews: QuestionView[] = [];
  const deckViews: DeckView[] = [];
  const now = Date.now();
  function append(
    deck: typeof decks.$inferSelect | null,
    qs: PublishedQuestion[],
    isOwner: boolean,
    ownerName: string,
    seenVersion: number,
    releaseSummary = "",
  ) {
    const active = qs.filter((q) => !q.archived);
    const eligible = active.filter((q) => q.answer.trim());
    const due = eligible.filter((q) => {
      const s = stateMap.get(q.id);
      return s?.fsrs && new Date(String(s.fsrs.due)).getTime() <= now;
    }).length;
    const newCount = eligible.filter((q) => !stateMap.get(q.id)?.fsrs).length;
    const release = deck ? releaseMap.get(deck.id) : undefined;
    const title = deck
      ? isOwner
        ? deck.title
        : (release?.title ?? deck.title)
      : "未分类";
    if (deck)
      deckViews.push({
        id: deck.id,
        title,
        description: isOwner
          ? deck.description
          : (release?.description ?? deck.description),
        color: deck.color,
        visibility: deck.visibility,
        isOwner,
        ownerName,
        publishedVersion: deck.publishedVersion,
        seenVersion,
        count: active.length,
        due,
        newCount,
        updatedAt: deck.updatedAt.toISOString(),
        releaseSummary,
        sourceDeleted: !!deck.deletedAt,
      });
    for (const q of qs) {
      const s = stateMap.get(q.id);
      questionViews.push({
        ...q,
        isOwner,
        deckTitle: title,
        note: s?.note ?? "",
        noteVersion: s?.noteVersion ?? 0,
        favorite: s?.favorite ?? false,
        fsrs: (s?.fsrs as StoredCard | null) ?? null,
        studyVersion: s?.version ?? 0,
        reviewedRevision: s?.reviewedRevision ?? 0,
      });
    }
  }
  for (const deck of own)
    append(
      deck,
      drafts.filter((q) => q.deckId === deck.id).map(publishedQuestion),
      true,
      identity.name,
      deck.publishedVersion,
    );
  append(
    null,
    drafts.filter((q) => !q.deckId).map(publishedQuestion),
    true,
    identity.name,
    0,
  );
  for (const item of subscribed) {
    const release = releaseMap.get(item.deck.id);
    if (release)
      append(
        item.deck,
        release.questions,
        false,
        item.owner,
        item.subscription.seenVersion,
        release.summary,
      );
  }
  const pref = prefRows[0];
  const counts = new Map(activityRows.map((row) => [row.date, row.count]));
  let streak = 0;
  const cursor = new Date(`${today}T12:00:00Z`);
  if (!counts.has(today)) cursor.setUTCDate(cursor.getUTCDate() - 1);
  while (counts.has(cursor.toISOString().slice(0, 10))) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  const active = questionViews.filter((q) => !q.archived);
  const aggregate = aggregateRows[0];
  const titles = new Map(questionViews.map((q) => [q.id, q.title]));
  return {
    user: identity,
    decks: deckViews,
    questions: questionViews,
    stats: {
      due: active.filter(
        (q) =>
          q.answer.trim() && q.fsrs && new Date(q.fsrs.due).getTime() <= now,
      ).length,
      new: active.filter((q) => q.answer.trim() && !q.fsrs).length,
      reviewedToday: aggregate.today,
      newLearnedToday: aggregate.newToday,
      totalReviews: aggregate.total,
      streak,
      total: active.length,
      retention: aggregate.recent
        ? Math.round((aggregate.remembered / aggregate.recent) * 100)
        : null,
    },
    activity: Array.from(counts, ([date, count]) => ({ date, count })),
    recentReviews: logs.slice(0, 30).map((r) => ({
      id: r.id,
      questionId: r.questionId,
      title: titles.get(r.questionId) ?? "已归档题目",
      rating: r.rating,
      answer: r.answer,
      createdAt: r.createdAt.toISOString(),
      due: String(r.after.due),
    })),
    settings: {
      hasKey: !!keyRows[0],
      keyHint: keyRows[0]?.keyHint ?? "",
      provider: "openai-compatible",
      baseUrl: keyRows[0]?.baseUrl ?? "https://api.deepseek.com",
      model: keyRows[0]?.model ?? "",
      dailyGoal: pref?.dailyGoal ?? 5,
      dailyNewLimit: pref?.dailyNewLimit ?? 3,
      theme: pref?.theme ?? "light",
      timeZone,
    },
  };
}
