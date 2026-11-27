import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { getDb, type Database } from "@/db";
import {
  authorSubscriptions,
  conceptFolders,
  concepts,
  decks,
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
  ConceptFolderView,
  ConceptView,
  DeckGroupView,
  DeckView,
  FollowedAuthorView,
  PendingDeckUpdate,
  QuestionView,
  StoredCard,
  Workspace,
} from "@/lib/types";
import {
  CONCEPT_ROOT_LABEL,
  recomputeConceptFolderState,
} from "@/lib/concepts";
import {
  computeUnpublishedDiff,
  diffReleaseVersions,
  normalizeReleaseGroups,
} from "@/lib/subscriptions";
import { ROOT_FOLDER_LABEL } from "@/lib/folders";
import { isQuestionDue } from "@/lib/review-queue";
import { dateKey } from "@/lib/utils";
import { AppError } from "./errors";
import { contentHash } from "./crypto";
import {
  buildServerFolderTree,
  collectOwnedSubtreeIds,
  formatOwnedFolderPath,
  type OwnedFolderRow,
  type ServerFolderTree,
} from "./folders";

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

export async function nextQuestionPosition(
  tx: Pick<Database, "select">,
  ownerId: string,
  deckId: string | null,
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
        isNull(questions.deletedAt),
      ),
    );
  return typeof row?.maxPosition === "number" ? row.maxPosition + 1 : 0;
}

export async function bumpWorkspaceVersion(
  executor: Pick<Database, "update">,
  userId: string,
) {
  await executor
    .update(preferences)
    .set({ workspaceVersion: sql`${preferences.workspaceVersion} + 1` })
    .where(eq(preferences.userId, userId));
}

export async function withWorkspaceEtag(
  userId: string,
  response: Response,
  executor?: Pick<Database, "update">,
): Promise<Response> {
  const db = executor ?? (await getDb());
  await bumpWorkspaceVersion(db, userId);
  const etag = await getWorkspaceEtag(userId);
  response.headers.set("X-Workspace-ETag", etag);
  return response;
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
        parentId: null,
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
  override?: { deckId?: string | null; groupId?: string | null },
): PublishedQuestion {
  return {
    id: q.id,
    deckId: override?.deckId !== undefined ? override.deckId : q.deckId,
    groupId: override?.groupId !== undefined ? override.groupId : null,
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

/**
 * Collect the recursive owned subfolder tree and owned questions for publishing or diffing a folder.
 * Subscriptions placed inside this folder are structurally excluded (they are not owned `decks` rows).
 */
export function buildOwnedPublishSubtree<
  Q extends Pick<
    typeof questions.$inferSelect,
    | "id"
    | "deckId"
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
>(
  tree: ServerFolderTree,
  rootFolder: OwnedFolderRow,
  allOwnedQuestions: readonly Q[],
): {
  subtreeFolderIds: string[];
  groups: PublishedDeckGroup[];
  questions: PublishedQuestion[];
  rawQuestions: Q[];
} {
  const subtreeFolderIds = collectOwnedSubtreeIds(tree, rootFolder.id);
  const subtreeSet = new Set(subtreeFolderIds);
  const groups: PublishedDeckGroup[] = [];
  for (const id of subtreeFolderIds) {
    if (id === rootFolder.id) continue;
    const node = tree.byId.get(id);
    if (!node) continue;
    groups.push({
      id: node.id,
      parentId: node.parentId === rootFolder.id ? null : (node.parentId ?? null),
      title: node.title,
      category: "",
      description: node.description,
      position: 0,
    });
  }
  const rawQuestions = allOwnedQuestions.filter(
    (q) => q.deckId !== null && subtreeSet.has(q.deckId),
  );
  const serialized = rawQuestions.map((q) =>
    publishedQuestion(q, {
      deckId: rootFolder.id,
      groupId: q.deckId === rootFolder.id ? null : q.deckId,
    }),
  );
  return { subtreeFolderIds, groups, questions: serialized, rawQuestions };
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
  if (!deck) throw new AppError(404, "文件夹不存在或没有编辑权限。");
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
  // A published question keeps its stable identity when the author removes a folder or deletes the draft.
  // Subscribers stay pinned to their accepted release version (`subscriptions.seenVersion`) until opting into updates.
  const snapshots = await db
    .select({
      question: sql<PublishedQuestion | null>`jsonb_path_query_first(${releases.questions}, '$[*] ? (@.id == $qid)', jsonb_build_object('qid', ${questionId}::text))`,
    })
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
  const question = snapshots[0]?.question;
  if (!question) throw new AppError(404, "这道题尚未发布或无权访问。");
  return { ...question, isOwner: false };
}

export async function getWorkspaceEtag(userId: string): Promise<string> {
  const db = await getDb();
  const [[prefRow], [credRow], [subAgg], [followAgg], [dueRow]] =
    await Promise.all([
      db
        .select({
          workspaceVersion: preferences.workspaceVersion,
          dailyGoal: preferences.dailyGoal,
          dailyNewLimit: preferences.dailyNewLimit,
          theme: preferences.theme,
          timeZone: preferences.timeZone,
          onboarded: preferences.onboarded,
        })
        .from(preferences)
        .where(eq(preferences.userId, userId)),
      db
        .select({
          updatedAt: credentials.updatedAt,
          model: credentials.model,
          baseUrl: credentials.baseUrl,
        })
        .from(credentials)
        .where(eq(credentials.userId, userId)),
      db
        .select({
          count: sql<number>`count(*)::int`,
          sumSeen: sql<string>`coalesce(sum(${subscriptions.seenVersion})::bigint, 0)::text`,
          sumDismissed: sql<string>`coalesce(sum(${subscriptions.dismissedVersion})::bigint, 0)::text`,
          sumPublished: sql<string>`coalesce(sum(${decks.publishedVersion})::bigint, 0)::text`,
          maxDeckUpdated: sql<string>`coalesce(max(${decks.updatedAt})::text, '')`,
          deletedCount: sql<number>`(count(*) filter (where ${decks.deletedAt} is not null))::int`,
          visSig: sql<string>`coalesce(string_agg(${subscriptions.deckId} || ':' || ${decks.visibility}, ',' order by ${subscriptions.deckId}), '')`,
        })
        .from(subscriptions)
        .innerJoin(decks, eq(subscriptions.deckId, decks.id))
        .where(eq(subscriptions.userId, userId)),
      db
        .select({
          count: sql<number>`count(*)::int`,
          autoCount: sql<number>`(count(*) filter (where ${authorSubscriptions.autoSubscribeNew}))::int`,
          maxAuthorUpdated: sql<string>`coalesce(max(${users.updatedAt})::text, '')`,
        })
        .from(authorSubscriptions)
        .innerJoin(users, eq(authorSubscriptions.authorId, users.id))
        .where(eq(authorSubscriptions.followerId, userId)),
      db
        .select({
          dueCount: sql<number>`(count(*) filter (where ${studyCards.fsrs} is not null and case when (${studyCards.fsrs}->>'due') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' then (${studyCards.fsrs}->>'due')::timestamptz <= now() else false end))::int`,
        })
        .from(studyCards)
        .where(eq(studyCards.userId, userId)),
    ]);

  let followedPublicSig = "";
  if ((followAgg?.count ?? 0) > 0) {
    const [pubAgg] = await db
      .select({
        count: sql<number>`count(*)::int`,
        maxUpdated: sql<string>`coalesce(max(${decks.updatedAt})::text, '')`,
        sumPublished: sql<string>`coalesce(sum(${decks.publishedVersion})::bigint, 0)::text`,
      })
      .from(decks)
      .innerJoin(
        authorSubscriptions,
        eq(decks.ownerId, authorSubscriptions.authorId),
      )
      .where(
        and(
          eq(authorSubscriptions.followerId, userId),
          eq(decks.visibility, "public"),
          gt(decks.publishedVersion, 0),
          isNull(decks.deletedAt),
        ),
      );
    followedPublicSig = JSON.stringify(pubAgg ?? {});
  }

  const timeZone = prefRow?.timeZone ?? "Asia/Shanghai";
  const today = dateKey(new Date(), timeZone);
  const fingerprint = JSON.stringify([
    today,
    prefRow ?? null,
    credRow ?? null,
    subAgg ?? null,
    followAgg ?? null,
    followedPublicSig,
    dueRow ?? null,
  ]);
  const hash = createHash("sha256").update(fingerprint).digest("hex").slice(0, 24);
  return `W/"${hash}"`;
}

function formatSubGroupPath(
  rootTitle: string,
  releaseGroups: readonly DeckGroupView[],
  groupId: string | null | undefined,
): string {
  if (!groupId || !releaseGroups.length) return rootTitle;
  const map = new Map(releaseGroups.map((g) => [g.id, g]));
  const segs: string[] = [];
  const visited = new Set<string>();
  let cursor: string | null = groupId;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const node = map.get(cursor);
    if (!node) break;
    segs.push(node.title);
    cursor = node.parentId && map.has(node.parentId) ? node.parentId : null;
  }
  return segs.length ? `${rootTitle} / ${segs.reverse().join(" / ")}` : rootTitle;
}

export async function getWorkspace(identity: Identity): Promise<Workspace> {
  const db = await getDb();
  let [
    own,
    subscribed,
    followedRows,
    states,
    logs,
    prefRows,
    keyRows,
    conceptRows,
    conceptFolderRows,
  ] = await Promise.all([
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
    db.select().from(concepts).where(eq(concepts.userId, identity.id)),
    db
      .select()
      .from(conceptFolders)
      .where(eq(conceptFolders.userId, identity.id)),
  ]);

  // Only execute the write transaction on brand-new user first boot (when preferences row is absent).
  if (prefRows.length === 0) {
    await ensureWorkspace(identity.id);
    [own, prefRows] = await Promise.all([
      db
        .select()
        .from(decks)
        .where(and(eq(decks.ownerId, identity.id), isNull(decks.deletedAt)))
        .orderBy(decks.createdAt),
      db.select().from(preferences).where(eq(preferences.userId, identity.id)),
    ]);
  }
  const timeZone = prefRows[0]?.timeZone ?? "Asia/Shanghai";
  const today = dateKey(new Date(), timeZone);
  const dayExpression = sql<string>`to_char(${reviewEvents.createdAt} at time zone ${timeZone}, 'YYYY-MM-DD')`;
  const recentCutoff = new Date(Date.now() - 30 * 86400_000);
  const latestDeckIds = [
    ...new Set([
      ...own.filter((d) => d.publishedVersion > 0).map((d) => d.id),
      ...subscribed
        .filter(
          (s) =>
            !s.deck.deletedAt &&
            s.deck.visibility !== "private" &&
            s.deck.publishedVersion > s.subscription.seenVersion,
        )
        .map((s) => s.deck.id),
    ]),
  ];
  const followedAuthorIds = followedRows.map((row) => row.authorId);
  const [
    drafts,
    reviewDailyRows,
    pinnedSubReleases,
    latestReleases,
    followedAuthorDecks,
  ] = await Promise.all([
    db
      .select({
        id: questions.id,
        deckId: questions.deckId,
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
      .select({
        date: dayExpression,
        count: sql<number>`count(*)::int`,
        recent: sql<number>`(count(*) filter (where ${reviewEvents.createdAt} >= ${recentCutoff}))::int`,
        remembered: sql<number>`(count(*) filter (where ${reviewEvents.createdAt} >= ${recentCutoff} and ${reviewEvents.rating} > 1))::int`,
        todayDistinct: sql<number>`count(distinct ${reviewEvents.questionId})::int`,
        newTodayDistinct: sql<number>`count(distinct case when ${reviewEvents.before} is null then ${reviewEvents.questionId} end)::int`,
      })
      .from(reviewEvents)
      .where(eq(reviewEvents.userId, identity.id))
      .groupBy(sql`1`),
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

  const ownedTree = buildServerFolderTree(own);
  const questionViews: QuestionView[] = [];
  const deckViews: DeckView[] = [];
  const now = Date.now();

  const countMetrics = (qs: readonly PublishedQuestion[]) => {
    const active = qs.filter((q) => !q.archived);
    const eligible = active.filter((q) => q.answer.trim());
    const due = eligible.filter((q) => {
      const s = stateMap.get(q.id);
      return isQuestionDue(
        {
          fsrs: (s?.fsrs as StoredCard | null) ?? null,
          majorRevision: q.majorRevision,
          reviewedRevision: s?.reviewedRevision ?? 0,
        },
        now,
      );
    }).length;
    const newCount = eligible.filter((q) => !stateMap.get(q.id)?.fsrs).length;
    return { count: active.length, due, newCount };
  };

  // Single O(Q) pass: pre-serialize owned questions, bucket by deckId, and compute direct metrics.
  const serializedDraftsByDeck = new Map<string | null, PublishedQuestion[]>();
  const directMetricsByDeck = new Map<
    string,
    { count: number; due: number; newCount: number }
  >();
  const serializedDraftList: PublishedQuestion[] = [];

  for (const rawQ of drafts) {
    const q = publishedQuestion(rawQ);
    serializedDraftList.push(q);
    const bucket = serializedDraftsByDeck.get(q.deckId);
    if (bucket) bucket.push(q);
    else serializedDraftsByDeck.set(q.deckId, [q]);

    if (q.deckId && !q.archived) {
      let m = directMetricsByDeck.get(q.deckId);
      if (!m) {
        m = { count: 0, due: 0, newCount: 0 };
        directMetricsByDeck.set(q.deckId, m);
      }
      m.count += 1;
      if (q.answer.trim()) {
        const s = stateMap.get(q.id);
        if (
          isQuestionDue(
            {
              fsrs: (s?.fsrs as StoredCard | null) ?? null,
              majorRevision: q.majorRevision,
              reviewedRevision: s?.reviewedRevision ?? 0,
            },
            now,
          )
        ) {
          m.due += 1;
        } else if (!s?.fsrs) {
          m.newCount += 1;
        }
      }
    }
  }

  // O(F) memoized bottom-up subtree metrics over owned folder tree.
  const subtreeMetricsMemo = new Map<
    string,
    { count: number; due: number; newCount: number }
  >();
  const computeOwnedSubtreeMetrics = (
    folderId: string,
    visiting: Set<string>,
  ): { count: number; due: number; newCount: number } => {
    const cached = subtreeMetricsMemo.get(folderId);
    if (cached) return cached;
    if (visiting.has(folderId)) return { count: 0, due: 0, newCount: 0 };
    visiting.add(folderId);
    const direct = directMetricsByDeck.get(folderId) ?? {
      count: 0,
      due: 0,
      newCount: 0,
    };
    let count = direct.count;
    let due = direct.due;
    let newCount = direct.newCount;
    for (const child of ownedTree.children.get(folderId) ?? []) {
      const childMetrics = computeOwnedSubtreeMetrics(child.id, visiting);
      count += childMetrics.count;
      due += childMetrics.due;
      newCount += childMetrics.newCount;
    }
    const result = { count, due, newCount };
    subtreeMetricsMemo.set(folderId, result);
    return result;
  };

  // Emit owned folders with O(F + Q) subtree metrics and on-demand publish diffs.
  for (const deck of own) {
    const directActiveCount = directMetricsByDeck.get(deck.id)?.count ?? 0;
    const metrics = computeOwnedSubtreeMetrics(deck.id, new Set());
    const latestRel =
      deck.publishedVersion > 0 ? latestReleaseMap.get(deck.id) : undefined;

    let publishStatus: DeckView["publishStatus"] = "unpublished";
    let unpublishedDiff: DeckView["unpublishedDiff"] = null;
    if (deck.publishedVersion > 0 && latestRel) {
      const subtreeFolderIds = collectOwnedSubtreeIds(ownedTree, deck.id);
      const subtreeGroups: PublishedDeckGroup[] = [];
      const subtreeQuestions: PublishedQuestion[] = [];
      for (const fid of subtreeFolderIds) {
        if (fid !== deck.id) {
          const node = ownedTree.byId.get(fid);
          if (node) {
            subtreeGroups.push({
              id: node.id,
              parentId:
                node.parentId === deck.id ? null : (node.parentId ?? null),
              title: node.title,
              category: "",
              description: node.description,
              position: 0,
            });
          }
        }
        const bucket = serializedDraftsByDeck.get(fid);
        if (bucket) {
          for (const q of bucket) {
            subtreeQuestions.push({
              ...q,
              deckId: deck.id,
              groupId: fid === deck.id ? null : fid,
            });
          }
        }
      }
      const diffRes = computeUnpublishedDiff(
        {
          title: deck.title,
          description: deck.description,
          groups: subtreeGroups,
          questions: subtreeQuestions,
        },
        latestRel,
      );
      publishStatus = diffRes.publishStatus;
      unpublishedDiff = diffRes.unpublishedDiff;
    }

    const validParentId =
      deck.parentId && ownedTree.byId.has(deck.parentId) && deck.parentId !== deck.id
        ? deck.parentId
        : null;
    deckViews.push({
      id: deck.id,
      parentId: validParentId,
      title: deck.title,
      description: deck.description,
      groups: [],
      color: deck.color,
      visibility: deck.visibility,
      isOwner: true,
      ownerId: deck.ownerId,
      ownerName: identity.name,
      publishedVersion: deck.publishedVersion,
      seenVersion: deck.publishedVersion,
      syncedVersion: deck.publishedVersion,
      dismissedVersion: 0,
      pendingUpdate: null,
      publishStatus,
      unpublishedDiff,
      directCount: directActiveCount,
      count: metrics.count,
      due: metrics.due,
      newCount: metrics.newCount,
      updatedAt: deck.updatedAt.toISOString(),
      releaseSummary: latestRel?.summary ?? "",
      sourceDeleted: false,
    });
  }

  // Emit all owned questions once with their real folder title and full path.
  const ownedPathCache = new Map<string | null, string>();
  const getOwnedFolderPath = (deckId: string | null) => {
    const cached = ownedPathCache.get(deckId);
    if (cached !== undefined) return cached;
    const p = formatOwnedFolderPath(ownedTree.byId, deckId);
    ownedPathCache.set(deckId, p);
    return p;
  };
  for (const q of serializedDraftList) {
    const s = stateMap.get(q.id);
    const folder = q.deckId ? ownedTree.byId.get(q.deckId) : undefined;
    const deckTitle = folder ? folder.title : ROOT_FOLDER_LABEL;
    const folderPath = getOwnedFolderPath(q.deckId);
    questionViews.push({
      ...q,
      groupId: null,
      position: q.position ?? 0,
      isOwner: true,
      deckTitle,
      folderPath,
      note: s?.note ?? "",
      noteVersion: s?.noteVersion ?? 0,
      annotations: Array.isArray(s?.annotations) ? s.annotations : [],
      annotationsVersion: s?.annotationsVersion ?? 0,
      favorite: s?.favorite ?? false,
      fsrs: (s?.fsrs as StoredCard | null) ?? null,
      studyVersion: s?.version ?? 0,
      reviewedRevision: s?.reviewedRevision ?? 0,
    });
  }

  // Emit subscribed decks (placed inside user's personal folder via subscriptions.folderId) and their pinned release questions.
  for (const item of subscribed) {
    const pinned = pinnedReleaseMap.get(item.deck.id);
    if (!pinned) continue;
    const releaseTime = pinned.createdAt.toISOString();
    const releaseGroups = normalizeReleaseGroups(
      pinned.groups,
      item.deck.id,
      releaseTime,
    );
    const validGroupIds = new Set(releaseGroups.map((g) => g.id));
    const latest =
      !item.deck.deletedAt &&
      item.deck.visibility !== "private" &&
      item.deck.publishedVersion > item.subscription.seenVersion
        ? latestReleaseMap.get(item.deck.id)
        : undefined;
    const pendingUpdate: PendingDeckUpdate | null =
      latest && latest.version > pinned.version
        ? diffReleaseVersions(pinned, latest)
        : null;
    const metrics = countMetrics(pinned.questions);
    const placedFolderId =
      item.subscription.folderId && ownedTree.byId.has(item.subscription.folderId)
        ? item.subscription.folderId
        : null;
    const placedPrefix = placedFolderId
      ? `${formatOwnedFolderPath(ownedTree.byId, placedFolderId)} / `
      : "";
    const directCount = pinned.questions.filter(
      (q) => !q.archived && (!q.groupId || !validGroupIds.has(q.groupId)),
    ).length;

    deckViews.push({
      id: item.deck.id,
      parentId: placedFolderId,
      title: pinned.title,
      description: pinned.description,
      groups: releaseGroups,
      color: item.deck.color,
      visibility: item.deck.visibility,
      isOwner: false,
      ownerId: item.deck.ownerId,
      ownerName: item.owner,
      publishedVersion: item.deck.publishedVersion,
      seenVersion: item.subscription.seenVersion,
      syncedVersion: item.subscription.seenVersion,
      dismissedVersion: item.subscription.dismissedVersion,
      pendingUpdate,
      directCount,
      count: metrics.count,
      due: metrics.due,
      newCount: metrics.newCount,
      updatedAt: item.deck.updatedAt.toISOString(),
      releaseSummary: pinned.summary,
      sourceDeleted: !!item.deck.deletedAt,
    });

    for (const q of pinned.questions) {
      const s = stateMap.get(q.id);
      const validGroupId =
        q.groupId && validGroupIds.has(q.groupId) ? q.groupId : null;
      const relPath = formatSubGroupPath(
        pinned.title,
        releaseGroups,
        validGroupId,
      );
      questionViews.push({
        ...q,
        deckId: item.deck.id,
        groupId: validGroupId,
        position: q.position ?? 0,
        isOwner: false,
        deckTitle: pinned.title,
        folderPath: `${placedPrefix}${relPath}`,
        note: s?.note ?? "",
        noteVersion: s?.noteVersion ?? 0,
        annotations: Array.isArray(s?.annotations) ? s.annotations : [],
        annotationsVersion: s?.annotationsVersion ?? 0,
        favorite: s?.favorite ?? false,
        fsrs: (s?.fsrs as StoredCard | null) ?? null,
        studyVersion: s?.version ?? 0,
        reviewedRevision: s?.reviewedRevision ?? 0,
      });
    }
  }

  questionViews.sort((a, b) => {
    const diff =
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });

  const pref = prefRows[0];
  const counts = new Map<string, number>();
  const aggregate = {
    total: 0,
    recent: 0,
    remembered: 0,
    today: 0,
    newToday: 0,
  };
  for (const row of reviewDailyRows) {
    counts.set(row.date, row.count);
    aggregate.total += row.count;
    aggregate.recent += row.recent;
    aggregate.remembered += row.remembered;
    if (row.date === today) {
      aggregate.today = row.todayDistinct;
      aggregate.newToday = row.newTodayDistinct;
    }
  }
  let streak = 0;
  const cursor = new Date(`${today}T12:00:00Z`);
  if (!counts.has(today)) cursor.setUTCDate(cursor.getUTCDate() - 1);
  while (counts.has(cursor.toISOString().slice(0, 10))) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  const rawConceptFolders: ConceptFolderView[] = conceptFolderRows.map(
    (row) => ({
      id: row.id,
      parentId: row.parentId ?? null,
      title: row.title,
      color: row.color,
      count: 0,
      directCount: 0,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }),
  );
  const rawConcepts: ConceptView[] = conceptRows.map((row) => ({
    id: row.id,
    term: row.term,
    aliases: Array.isArray(row.aliases) ? row.aliases : [],
    normalizedKey: row.normalizedKey,
    definition: row.definition,
    folderId: row.folderId ?? null,
    folderPath: CONCEPT_ROOT_LABEL,
    groupName: row.groupName,
    color: row.color,
    sourceQuestionId: row.sourceQuestionId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
  const { conceptFolders: conceptFolderViews, concepts: conceptViews } =
    recomputeConceptFolderState(rawConceptFolders, rawConcepts);

  const active = questionViews.filter((q) => !q.archived);
  const titles = new Map(questionViews.map((q) => [q.id, q.title]));
  return {
    user: identity,
    decks: deckViews,
    questions: questionViews,
    concepts: conceptViews,
    conceptFolders: conceptFolderViews,
    followedAuthors,
    stats: {
      due: active.filter((q) => q.answer.trim() && isQuestionDue(q, now)).length,
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
      title: r.questionTitle ?? titles.get(r.questionId) ?? "已归档题目",
      questionAnswer: r.questionAnswer ?? null,
      questionRevision: r.questionRevision,
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
