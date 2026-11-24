import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { getDb, type Database } from "@/db";
import {
  authorSubscriptions,
  decks,
  deckGroups,
  questions,
  releases,
  subscriptions,
  studyCards,
  reviewEvents,
  credentials,
  preferences,
  user as users,
  type PublishedDeckGroup,
  type PublishedQuestion,
} from "@/db/schema";
import type { Identity } from "./api";
import type {
  DeckGroupView,
  DeckView,
  FollowedAuthorView,
  PendingDeckUpdate,
  PublishStatus,
  QuestionView,
  StoredCard,
  UnpublishedDeckDiff,
  Workspace,
} from "@/lib/types";
import {
  computeUnpublishedDiff,
  diffReleaseVersions,
} from "@/lib/subscriptions";
import { dateKey } from "@/lib/utils";
import { AppError } from "./errors";
import { contentHash } from "./crypto";

export async function nextQuestionBaseMs(
  tx: Pick<Database, "select">,
  ownerId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      maxCreatedAt: sql<string | Date | null>`max(${questions.createdAt})`,
    })
    .from(questions)
    .where(eq(questions.ownerId, ownerId));
  const maxMs = row?.maxCreatedAt ? new Date(row.maxCreatedAt).getTime() : 0;
  return Math.max(Date.now(), Number.isFinite(maxMs) ? maxMs + 1 : 0);
}

export async function nextDeckGroupPosition(
  tx: Pick<Database, "select">,
  deckId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      maxPosition: sql<number | null>`max(${deckGroups.position})`,
    })
    .from(deckGroups)
    .where(eq(deckGroups.deckId, deckId));
  return typeof row?.maxPosition === "number" ? row.maxPosition + 1 : 0;
}

export async function nextQuestionPosition(
  tx: Pick<Database, "select">,
  ownerId: string,
  deckId: string | null,
  groupId: string | null,
): Promise<number> {
  const [row] = await tx
    .select({
      maxPosition: sql<number | null>`max(${questions.position})`,
    })
    .from(questions)
    .where(
      and(
        eq(questions.ownerId, ownerId),
        deckId ? eq(questions.deckId, deckId) : isNull(questions.deckId),
        groupId ? eq(questions.groupId, groupId) : isNull(questions.groupId),
        isNull(questions.deletedAt),
      ),
    );
  return typeof row?.maxPosition === "number" ? row.maxPosition + 1 : 0;
}

export function publishedDeckGroup(
  g: Pick<
    typeof deckGroups.$inferSelect,
    "id" | "title" | "category" | "description" | "position"
  >,
): PublishedDeckGroup {
  return {
    id: g.id,
    title: g.title,
    category: g.category,
    description: g.description,
    position: g.position,
  };
}

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
    | "groupId"
    | "position"
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
    groupId: q.groupId,
    position: q.position,
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
  // Subscribers stay pinned to their accepted release version (`subscriptions.seenVersion`) until opting into updates.
  const snapshots = await db
    .select({ release: releases })
    .from(subscriptions)
    .innerJoin(decks, eq(subscriptions.deckId, decks.id))
    .innerJoin(
      releases,
      and(
        eq(releases.deckId, decks.id),
        eq(releases.version, subscriptions.seenVersion),
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
  const [own, subscribed, followedRows, states, logs, prefRows, keyRows] =
    await Promise.all([
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
      db
        .select({
          authorId: authorSubscriptions.authorId,
          authorName: users.name,
          autoSubscribeNew: authorSubscriptions.autoSubscribeNew,
          createdAt: authorSubscriptions.createdAt,
        })
        .from(authorSubscriptions)
        .innerJoin(users, eq(authorSubscriptions.authorId, users.id))
        .where(eq(authorSubscriptions.followerId, identity.id))
        .orderBy(desc(authorSubscriptions.createdAt)),
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
  const latestDeckIds = [
    ...new Set([
      ...own.filter((d) => d.publishedVersion > 0).map((d) => d.id),
      ...subscribed
        .filter((s) => s.deck.publishedVersion > s.subscription.seenVersion)
        .map((s) => s.deck.id),
    ]),
  ];
  const followedAuthorIds = followedRows.map((row) => row.authorId);
  const [
    drafts,
    ownGroups,
    activityRows,
    aggregateRows,
    pinnedSubReleases,
    latestReleases,
    followedAuthorDecks,
  ] = await Promise.all([
    db
      .select({
        id: questions.id,
        deckId: questions.deckId,
        groupId: questions.groupId,
        position: questions.position,
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
      .select()
      .from(deckGroups)
      .where(eq(deckGroups.ownerId, identity.id))
      .orderBy(
        asc(deckGroups.position),
        asc(deckGroups.createdAt),
        asc(deckGroups.id),
      ),
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
          .from(subscriptions)
          .innerJoin(
            releases,
            and(
              eq(releases.deckId, subscriptions.deckId),
              eq(releases.version, subscriptions.seenVersion),
            ),
          )
          .where(eq(subscriptions.userId, identity.id))
      : [],
    latestDeckIds.length
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
          .where(inArray(releases.deckId, latestDeckIds))
      : [],
    followedAuthorIds.length
      ? db
          .select({ id: decks.id, ownerId: decks.ownerId })
          .from(decks)
          .where(
            and(
              inArray(decks.ownerId, followedAuthorIds),
              eq(decks.visibility, "public"),
              gt(decks.publishedVersion, 0),
              isNull(decks.deletedAt),
            ),
          )
      : [],
  ]);
  const stateMap = new Map(states.map((s) => [s.questionId, s]));
  const pinnedReleaseMap = new Map(
    pinnedSubReleases.map((p) => [p.release.deckId, p.release]),
  );
  const latestReleaseMap = new Map(
    latestReleases.map((p) => [p.release.deckId, p.release]),
  );
  const subscribedDeckIdSet = new Set(subscribed.map((s) => s.deck.id));
  const followedAuthors: FollowedAuthorView[] = followedRows.map((row) => {
    const publicDecks = followedAuthorDecks.filter(
      (d) => d.ownerId === row.authorId,
    );
    const subscribedDeckCount = publicDecks.filter((d) =>
      subscribedDeckIdSet.has(d.id),
    ).length;
    return {
      authorId: row.authorId,
      authorName: row.authorName,
      autoSubscribeNew: row.autoSubscribeNew,
      createdAt: row.createdAt.toISOString(),
      publicDeckCount: publicDecks.length,
      subscribedDeckCount,
      unsubscribedDeckCount: Math.max(
        0,
        publicDecks.length - subscribedDeckCount,
      ),
    };
  });
  const ownGroupsByDeck = new Map<string, DeckGroupView[]>();
  for (const g of ownGroups) {
    const view: DeckGroupView = {
      id: g.id,
      deckId: g.deckId,
      title: g.title,
      category: g.category,
      description: g.description,
      position: g.position,
      createdAt: g.createdAt.toISOString(),
      updatedAt: g.updatedAt.toISOString(),
    };
    const list = ownGroupsByDeck.get(g.deckId);
    if (list) list.push(view);
    else ownGroupsByDeck.set(g.deckId, [view]);
  }
  const questionViews: QuestionView[] = [];
  const deckViews: DeckView[] = [];
  const now = Date.now();
  function append(
    deck: typeof decks.$inferSelect | null,
    qs: PublishedQuestion[],
    isOwner: boolean,
    ownerName: string,
    seenVersion: number,
    options: {
      releaseSummary?: string;
      groupName?: string;
      groups?: DeckGroupView[];
      pinnedRelease?: typeof releases.$inferSelect;
      dismissedVersion?: number;
      pendingUpdate?: PendingDeckUpdate | null;
      publishStatus?: PublishStatus;
      unpublishedDiff?: UnpublishedDeckDiff | null;
    } = {},
  ) {
    const active = qs.filter((q) => !q.archived);
    const eligible = active.filter((q) => q.answer.trim());
    const due = eligible.filter((q) => {
      const s = stateMap.get(q.id);
      return s?.fsrs && new Date(String(s.fsrs.due)).getTime() <= now;
    }).length;
    const newCount = eligible.filter((q) => !stateMap.get(q.id)?.fsrs).length;
    const release = options.pinnedRelease;
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
        groupName: options.groupName ?? "",
        groups: options.groups ?? [],
        color: deck.color,
        visibility: deck.visibility,
        isOwner,
        ownerId: deck.ownerId,
        ownerName,
        publishedVersion: deck.publishedVersion,
        seenVersion,
        syncedVersion: seenVersion,
        dismissedVersion: options.dismissedVersion ?? 0,
        pendingUpdate: options.pendingUpdate ?? null,
        ...(options.publishStatus !== undefined
          ? { publishStatus: options.publishStatus }
          : {}),
        ...(options.unpublishedDiff !== undefined
          ? { unpublishedDiff: options.unpublishedDiff }
          : {}),
        count: active.length,
        due,
        newCount,
        updatedAt: deck.updatedAt.toISOString(),
        releaseSummary: options.releaseSummary ?? "",
        sourceDeleted: !!deck.deletedAt,
      });
    for (const q of qs) {
      const s = stateMap.get(q.id);
      questionViews.push({
        ...q,
        groupId: q.groupId ?? null,
        position: q.position ?? 0,
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
  for (const deck of own) {
    const deckDrafts = drafts
      .filter((q) => q.deckId === deck.id)
      .map(publishedQuestion);
    const deckGroupViews = ownGroupsByDeck.get(deck.id) ?? [];
    const latestRel =
      deck.publishedVersion > 0 ? latestReleaseMap.get(deck.id) : undefined;
    const { publishStatus, unpublishedDiff } = computeUnpublishedDiff(
      {
        title: deck.title,
        description: deck.description,
        groups: deckGroupViews,
        questions: deckDrafts,
      },
      latestRel,
    );
    append(deck, deckDrafts, true, identity.name, deck.publishedVersion, {
      groupName: deck.groupName,
      groups: deckGroupViews,
      releaseSummary: latestRel?.summary ?? "",
      publishStatus,
      unpublishedDiff,
    });
  }
  append(
    null,
    drafts.filter((q) => !q.deckId).map(publishedQuestion),
    true,
    identity.name,
    0,
  );
  for (const item of subscribed) {
    const pinned = pinnedReleaseMap.get(item.deck.id);
    if (pinned) {
      const releaseTime = pinned.createdAt.toISOString();
      const releaseGroups: DeckGroupView[] = (pinned.groups ?? [])
        .map((g) => ({
          id: g.id,
          deckId: item.deck.id,
          title: g.title,
          category: g.category ?? "",
          description: g.description ?? "",
          position: g.position ?? 0,
          createdAt: releaseTime,
          updatedAt: releaseTime,
        }))
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
      const latest =
        item.deck.publishedVersion > item.subscription.seenVersion
          ? latestReleaseMap.get(item.deck.id)
          : undefined;
      const pendingUpdate =
        latest && latest.version > pinned.version
          ? diffReleaseVersions(pinned, latest)
          : null;
      append(
        item.deck,
        pinned.questions,
        false,
        item.owner,
        item.subscription.seenVersion,
        {
          pinnedRelease: pinned,
          releaseSummary: pinned.summary,
          groupName: item.subscription.groupName,
          groups: releaseGroups,
          dismissedVersion: item.subscription.dismissedVersion,
          pendingUpdate,
        },
      );
    }
  }
  questionViews.sort((a, b) => {
    const diff =
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });
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
    followedAuthors,
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
