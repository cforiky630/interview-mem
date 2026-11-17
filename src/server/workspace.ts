import { and, desc, eq, inArray, sql } from "drizzle-orm";
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
        description: "把值得记住的知识，变成自己的表达。",
        color: "sage",
      });
  });
}

export function publishedQuestion(
  q: typeof questions.$inferSelect,
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
    .where(and(eq(decks.id, deckId), eq(decks.ownerId, userId)));
  if (!deck) throw new AppError(404, "题库不存在或没有编辑权限。");
  return deck;
}

export async function accessibleQuestion(
  userId: string,
  questionId: string,
): Promise<PublishedQuestion & { isOwner: boolean }> {
  const db = await getDb();
  const [row] = await db
    .select({ question: questions, deck: decks })
    .from(questions)
    .innerJoin(decks, eq(questions.deckId, decks.id))
    .where(eq(questions.id, questionId));
  if (!row) throw new AppError(404, "题目不存在或无权访问。");
  if (row.deck.ownerId === userId)
    return { ...publishedQuestion(row.question), isOwner: true };
  const [subscription] = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.deckId, row.deck.id),
      ),
    );
  if (!subscription) throw new AppError(404, "请先订阅题库再学习。");
  const [release] = await db
    .select()
    .from(releases)
    .where(
      and(
        eq(releases.deckId, row.deck.id),
        eq(releases.version, row.deck.publishedVersion),
      ),
    );
  const question = release?.questions.find((q) => q.id === questionId);
  if (!question) throw new AppError(404, "这道题尚未发布。");
  return { ...question, isOwner: false };
}

export async function getWorkspace(identity: Identity): Promise<Workspace> {
  await ensureWorkspace(identity.id);
  const db = await getDb();
  const [own, subscribed, states, logs, prefRows, keyRows] = await Promise.all([
    db
      .select()
      .from(decks)
      .where(eq(decks.ownerId, identity.id))
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
  const dayExpression = sql<string>`to_char(${reviewEvents.createdAt} at time zone ${timeZone}, 'YYYY-MM-DD')`;
  const recentCutoff = new Date(Date.now() - 30 * 86400_000);
  const [drafts, activityRows, aggregateRows, published] = await Promise.all([
    own.length
      ? db
          .select()
          .from(questions)
          .where(
            inArray(
              questions.deckId,
              own.map((d) => d.id),
            ),
          )
      : [],
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
    deck: typeof decks.$inferSelect,
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
    const release = releaseMap.get(deck.id);
    const title = isOwner ? deck.title : (release?.title ?? deck.title);
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
  const today = dateKey(new Date(), timeZone);
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
      due: deckViews.reduce((n, d) => n + d.due, 0),
      new: deckViews.reduce((n, d) => n + d.newCount, 0),
      reviewedToday: counts.get(today) ?? 0,
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
      model: keyRows[0]?.model ?? "deepseek-flash",
      dailyGoal: pref?.dailyGoal ?? 20,
      theme: pref?.theme ?? "light",
      timeZone,
    },
  };
}
