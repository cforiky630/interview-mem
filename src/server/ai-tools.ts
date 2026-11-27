import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  decks,
  questions,
  releases,
  studyCards,
  subscriptions,
  type PublishedDeckGroup,
} from "@/db/schema";
import { markdownDocument, mergeQuestionTags } from "@/lib/markdown-source";
import {
  isQuestionDue,
  isQuestionMajorRevisionDue,
} from "@/lib/review-queue";
import { ROOT_FOLDER_LABEL } from "@/lib/folders";
import {
  buildConceptSources,
  findConceptMatchesInText,
  normalizeConceptKey,
} from "@/lib/concepts";
import { normalizeReleaseGroups } from "@/lib/subscriptions";
import type { StoredCard } from "@/lib/types";
import type { ProviderTool } from "./ai";
import { AppError } from "./errors";
import { linkedConceptAnnotationFilter, listConcepts } from "./concepts";
import { accessibleQuestion } from "./workspace";
import {
  buildServerFolderTree,
  collectOwnedSubtreeIds,
  formatOwnedFolderPath,
  loadActiveOwnedFolders,
} from "./folders";

export type AiChatScope = "question" | "deck" | "workspace";
export type ToolQuestionRef = {
  id: string;
  title: string;
  deckTitle: string;
};

type ScopedQuestionItem = {
  id: string;
  deckId: string | null;
  deckTitle: string;
  folderPath: string;
  groupId: string | null;
  isOwner: boolean;
  title: string;
  answerSnippet: string;
  hasAnswer: boolean;
  noteSnippet: string;
  tags: string[];
  needsEditing: boolean;
  fsrs: StoredCard | null;
  majorRevision: number;
  reviewedRevision: number;
  due: string | null;
  updatedAt: string;
};

export type ScopedPool = {
  pool: ScopedQuestionItem[];
  deckRows: {
    id: string | null;
    title: string;
    path: string;
    isOwner: boolean;
    groups: { id: string; title: string; path: string }[];
  }[];
};

function formatReleaseGroupPath(
  rootTitle: string,
  releaseGroups: readonly PublishedDeckGroup[] | null | undefined,
  groupId: string | null | undefined,
): string {
  if (!groupId || !releaseGroups?.length) return rootTitle;
  const normalized = normalizeReleaseGroups(releaseGroups);
  const byId = new Map(normalized.map((g) => [g.id, g]));
  const parts: string[] = [];
  const visited = new Set<string>();
  let cursor: string | null = groupId;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const node = byId.get(cursor);
    if (!node) break;
    parts.push(node.title);
    cursor = node.parentId;
  }
  return parts.length ? `${rootTitle} / ${parts.reverse().join(" / ")}` : rootTitle;
}

export const WORKSPACE_AI_TOOLS: ProviderTool[] = [
  {
    type: "function",
    function: {
      name: "search_concepts",
      description:
        "按名称或别名检索用户的概念、释义和来源题。文件夹范围只返回与该文件夹题目有关联的概念。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "概念名称、别名或包含多个概念名称的问题。",
          },
          limit: { type: "integer", minimum: 1, maximum: 8 },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_questions",
      description:
        "按关键词、标签、笔记、路径或学习状态检索当前范围（当前文件夹及全部子文件夹，或全部资料库）内的相关面试题。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "检索关键词（空格分隔多关键词）；留空则按最近更新排序。",
          },
          filter: {
            type: "string",
            enum: ["all", "due", "needsEditing", "new"],
            description: "按复习状态筛选：all / due / needsEditing / new。",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            description: "最多返回条数，默认 10，最大 20。",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_duplicate_questions",
      description:
        "扫描当前范围内的疑似重复、标题相近或内容高度重叠的题目候选对。",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 15,
            description: "最多返回相似对数量，默认 8。",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_question_detail",
      description:
        "读取指定题目的完整题干、所在路径、标签、参考答案正文与当前用户的个人笔记摘要。",
      parameters: {
        type: "object",
        properties: {
          questionId: {
            type: "string",
            description: "要查看的题目 UUID。",
          },
        },
        required: ["questionId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_workspace_overview",
      description:
        "查看当前范围内各文件夹及订阅资料的题目总数、待复习数与待完善题数概览。",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];

function normalizeForSimilarity(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

function charBigrams(text: string): Set<string> {
  const grams = new Set<string>();
  if (text.length <= 2) {
    if (text) grams.add(text);
    return grams;
  }
  for (let i = 0; i < text.length - 1; i++) {
    grams.add(text.slice(i, i + 2));
  }
  return grams;
}

function precomputedDiceSimilarity(
  a: { norm: string; grams: Set<string> },
  b: { norm: string; grams: Set<string> },
): number {
  if (!a.norm || !b.norm) return 0;
  if (a.norm === b.norm) return 1;
  if (
    a.norm.length >= 4 &&
    b.norm.length >= 4 &&
    (a.norm.includes(b.norm) || b.norm.includes(a.norm))
  ) {
    return 0.86;
  }
  let overlap = 0;
  for (const gram of a.grams) {
    if (b.grams.has(gram)) overlap += 1;
  }
  return (2 * overlap) / (a.grams.size + b.grams.size);
}

export async function assertDeckChatAccess(userId: string, deckId: string) {
  const db = await getDb();
  const [own] = await db
    .select({ id: decks.id, title: decks.title, description: decks.description })
    .from(decks)
    .where(
      and(
        eq(decks.id, deckId),
        eq(decks.ownerId, userId),
        isNull(decks.deletedAt),
      ),
    );
  if (own) return { ...own, isOwner: true };

  const [sub] = await db
    .select({
      id: decks.id,
      title: releases.title,
      description: releases.description,
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
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.deckId, deckId)));
  if (!sub) throw new AppError(404, "文件夹不存在或无权访问。");
  return { ...sub, isOwner: false };
}

async function resolveQuestionLocation(
  userId: string,
  q: {
    deckId: string | null;
    groupId?: string | null;
    isOwner: boolean;
  },
): Promise<{ deckTitle: string; folderPath: string }> {
  if (!q.deckId) {
    return { deckTitle: ROOT_FOLDER_LABEL, folderPath: ROOT_FOLDER_LABEL };
  }
  const db = await getDb();
  if (q.isOwner) {
    const folders = await loadActiveOwnedFolders(db, userId);
    const byId = new Map(folders.map((f) => [f.id, f]));
    const own = byId.get(q.deckId);
    return {
      deckTitle: own?.title ?? ROOT_FOLDER_LABEL,
      folderPath: formatOwnedFolderPath(byId, own ? q.deckId : null),
    };
  }
  const [[rel], ownedFolders] = await Promise.all([
    db
      .select({
        title: releases.title,
        groups: releases.groups,
        folderId: subscriptions.folderId,
      })
      .from(subscriptions)
      .innerJoin(
        releases,
        and(
          eq(releases.deckId, subscriptions.deckId),
          eq(releases.version, subscriptions.seenVersion),
        ),
      )
      .where(
        and(eq(subscriptions.userId, userId), eq(subscriptions.deckId, q.deckId)),
      ),
    loadActiveOwnedFolders(db, userId),
  ]);
  const title = rel?.title ?? "订阅资料";
  const ownedById = new Map(ownedFolders.map((f) => [f.id, f]));
  const placementPrefix =
    rel?.folderId && ownedById.has(rel.folderId)
      ? `${formatOwnedFolderPath(ownedById, rel.folderId)} / `
      : "";
  return {
    deckTitle: title,
    folderPath: `${placementPrefix}${formatReleaseGroupPath(title, rel?.groups, q.groupId)}`,
  };
}

export async function loadScopedPool(
  userId: string,
  scope: "deck" | "workspace",
  deckId: string | null,
): Promise<ScopedPool> {
  const db = await getDb();
  const [allOwnedFolders, allSubs, studyRows] = await Promise.all([
    loadActiveOwnedFolders(db, userId),
    db
      .select({
        deckId: subscriptions.deckId,
        folderId: subscriptions.folderId,
        seenVersion: subscriptions.seenVersion,
      })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId)),
    db
      .select({
        questionId: studyCards.questionId,
        fsrs: studyCards.fsrs,
        reviewedRevision: studyCards.reviewedRevision,
        noteSnippet: sql<string>`left(${studyCards.note}, 1000)`,
      })
      .from(studyCards)
      .where(eq(studyCards.userId, userId)),
  ]);

  const ownedTree = buildServerFolderTree(allOwnedFolders);
  const isOwnedScope = Boolean(
    scope === "deck" && deckId && ownedTree.byId.has(deckId),
  );
  const ownedSubtreeIds = isOwnedScope
    ? new Set<string>(collectOwnedSubtreeIds(ownedTree, deckId!))
    : scope === "workspace"
      ? new Set(ownedTree.byId.keys())
      : new Set<string>();

  // Subscriptions in scope:
  // - workspace: all user subscriptions
  // - owned folder scope: subscriptions placed inside the folder's recursive subtree
  // - subscribed deck scope: that specific subscription only
  const scopedSubs =
    scope === "workspace"
      ? allSubs
      : isOwnedScope
        ? allSubs.filter(
            (s) => s.folderId !== null && ownedSubtreeIds.has(s.folderId),
          )
        : allSubs.filter((s) => s.deckId === deckId);

  const deckInfoMap = new Map<
    string,
    {
      title: string;
      path: string;
      isOwner: boolean;
      groups: { id: string; title: string; path: string }[];
    }
  >();

  for (const folderId of ownedSubtreeIds) {
    const f = ownedTree.byId.get(folderId);
    if (!f) continue;
    deckInfoMap.set(f.id, {
      title: f.title,
      path: formatOwnedFolderPath(ownedTree.byId, f.id),
      isOwner: true,
      groups: [],
    });
  }

  const studyMap = new Map(studyRows.map((s) => [s.questionId, s]));
  const pool: ScopedQuestionItem[] = [];

  if (scope === "workspace" || isOwnedScope) {
    const ownedRows = await db
      .select({
        id: questions.id,
        deckId: questions.deckId,
        title: questions.title,
        answerSnippet: sql<string>`left(${questions.answer}, 2000)`,
        hasAnswer: sql<boolean>`btrim(${questions.answer}) <> ''`,
        tags: questions.tags,
        needsEditing: questions.needsEditing,
        majorRevision: questions.majorRevision,
        updatedAt: questions.updatedAt,
      })
      .from(questions)
      .where(
        and(
          eq(questions.ownerId, userId),
          isNull(questions.deletedAt),
          isNull(questions.purgedAt),
          eq(questions.archived, false),
          isOwnedScope
            ? inArray(questions.deckId, [...ownedSubtreeIds])
            : undefined,
        ),
      );
    for (const q of ownedRows) {
      const study = studyMap.get(q.id);
      const mergedTags = mergeQuestionTags(
        q.tags,
        markdownDocument(q.answerSnippet).tags,
      );
      const fsrs = (study?.fsrs as StoredCard | null) ?? null;
      const folder = q.deckId ? ownedTree.byId.get(q.deckId) : undefined;
      const folderPath = formatOwnedFolderPath(
        ownedTree.byId,
        folder ? q.deckId : null,
      );
      pool.push({
        id: q.id,
        deckId: folder ? q.deckId : null,
        deckTitle: folder?.title ?? ROOT_FOLDER_LABEL,
        folderPath,
        groupId: null,
        isOwner: true,
        title: q.title,
        answerSnippet: q.answerSnippet,
        hasAnswer: Boolean(q.hasAnswer),
        noteSnippet: study?.noteSnippet ?? "",
        tags: mergedTags,
        needsEditing: q.needsEditing,
        fsrs,
        majorRevision: q.majorRevision,
        reviewedRevision: study?.reviewedRevision ?? 0,
        due: fsrs?.due ? String(fsrs.due) : null,
        updatedAt: q.updatedAt.toISOString(),
      });
    }
  }

  const subIds = scopedSubs.map((s) => s.deckId);
  if (subIds.length) {
    const published = await db
      .select({ release: releases, folderId: subscriptions.folderId })
      .from(subscriptions)
      .innerJoin(
        releases,
        and(
          eq(releases.deckId, subscriptions.deckId),
          eq(releases.version, subscriptions.seenVersion),
        ),
      )
      .where(
        and(
          eq(subscriptions.userId, userId),
          inArray(subscriptions.deckId, subIds),
        ),
      );
    for (const { release, folderId } of published) {
      const placementPrefix =
        folderId && ownedTree.byId.has(folderId)
          ? `${formatOwnedFolderPath(ownedTree.byId, folderId)} / `
          : "";
      const rootPath = `${placementPrefix}${release.title}`;
      const normalizedGroups = normalizeReleaseGroups(release.groups ?? []);
      const releaseGroupEntries = normalizedGroups.map((g) => ({
        id: g.id,
        title: g.title,
        path: `${placementPrefix}${formatReleaseGroupPath(release.title, release.groups, g.id)}`,
      }));
      const groupPathMap = new Map(releaseGroupEntries.map((g) => [g.id, g.path]));
      deckInfoMap.set(release.deckId, {
        title: release.title,
        path: rootPath,
        isOwner: false,
        groups: releaseGroupEntries,
      });
      for (const q of release.questions) {
        if (q.archived) continue;
        const study = studyMap.get(q.id);
        const snippet = q.answer.slice(0, 2000);
        const mergedTags = mergeQuestionTags(
          q.tags,
          markdownDocument(snippet).tags,
        );
        const fsrs = (study?.fsrs as StoredCard | null) ?? null;
        const groupId = q.groupId && groupPathMap.has(q.groupId) ? q.groupId : null;
        pool.push({
          id: q.id,
          deckId: release.deckId,
          deckTitle: release.title,
          folderPath: groupId ? groupPathMap.get(groupId)! : rootPath,
          groupId,
          isOwner: false,
          title: q.title,
          answerSnippet: snippet,
          hasAnswer: Boolean(q.answer.trim()),
          noteSnippet: study?.noteSnippet ?? "",
          tags: mergedTags,
          needsEditing: q.needsEditing,
          fsrs,
          majorRevision: q.majorRevision,
          reviewedRevision: study?.reviewedRevision ?? 0,
          due: fsrs?.due ? String(fsrs.due) : null,
          updatedAt: q.updatedAt,
        });
      }
    }
  }

  const deckRows = [
    ...Array.from(deckInfoMap.entries()).map(([id, info]) => ({
      id,
      title: info.title,
      path: info.path,
      isOwner: info.isOwner,
      groups: info.groups,
    })),
    ...(scope === "workspace"
      ? [
          {
            id: null,
            title: ROOT_FOLDER_LABEL,
            path: ROOT_FOLDER_LABEL,
            isOwner: true,
            groups: [],
          },
        ]
      : []),
  ];

  return { pool, deckRows };
}

async function searchScopedConcepts(
  userId: string,
  scope: "deck" | "workspace",
  query: string,
  limit: number,
  pool: ScopedPool["pool"],
) {
  const key = normalizeConceptKey(query);
  if (!key) return { matches: [], refs: [] };

  const concepts = await listConcepts(userId);
  const mentioned = new Set(
    findConceptMatchesInText(query.normalize("NFKC"), concepts).map(
      ({ concept }) => concept.id,
    ),
  );
  const candidates = concepts.filter(
    (concept) =>
      mentioned.has(concept.id) ||
      [concept.term, ...concept.aliases].some((name) =>
        normalizeConceptKey(name).includes(key),
      ),
  );
  if (!candidates.length) return { matches: [], refs: [] };

  const db = await getDb();
  const annotations = await db
    .select({
      questionId: studyCards.questionId,
      annotations: studyCards.annotations,
    })
    .from(studyCards)
    .where(
      and(
        eq(studyCards.userId, userId),
        linkedConceptAnnotationFilter(candidates.map((concept) => concept.id)),
      ),
    );
  const sources = buildConceptSources(candidates, pool, annotations);
  const matches = candidates
    .filter((concept) => scope === "workspace" || sources.get(concept.id)?.size)
    .sort((a, b) => Number(mentioned.has(b.id)) - Number(mentioned.has(a.id)))
    .slice(0, limit)
    .map((concept) => ({
      id: concept.id,
      term: concept.term,
      aliases: concept.aliases,
      definition: concept.definition.slice(0, 1200),
      sources: Array.from(sources.get(concept.id)?.values() ?? [])
        .slice(0, 3)
        .map((question): ToolQuestionRef => ({
          id: question.id,
          title: question.title,
          deckTitle: question.folderPath,
        })),
    }));
  const refs = new Map(
    matches.flatMap((match) => match.sources.map((ref) => [ref.id, ref] as const)),
  );
  return { matches, refs: [...refs.values()].slice(0, 8) };
}

export async function executeWorkspaceTool(
  userId: string,
  scope: "deck" | "workspace",
  deckId: string | null,
  name: string,
  rawArgs: string,
  cachedPool?: Promise<ScopedPool>,
): Promise<{
  output: unknown;
  label: string;
  refs: ToolQuestionRef[];
}> {
  let args: Record<string, unknown> = {};
  if (rawArgs.trim()) {
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object") {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      args = {};
    }
  }

  if (name === "get_question_detail") {
    const questionId =
      typeof args.questionId === "string" ? args.questionId.trim() : "";
    if (!questionId) {
      return {
        output: { error: "缺少 questionId 参数。" },
        label: "读取题目详情",
        refs: [],
      };
    }
    try {
      const q = await accessibleQuestion(userId, questionId);
      if (q.archived) {
        return {
          output: { error: "该题目已归档。" },
          label: "题目已归档",
          refs: [],
        };
      }
      const db = await getDb();
      if (scope === "deck" && deckId) {
        let inScope = false;
        if (q.isOwner) {
          const folders = await loadActiveOwnedFolders(db, userId);
          const tree = buildServerFolderTree(folders);
          const subtreeIds = tree.byId.has(deckId)
            ? new Set<string>(collectOwnedSubtreeIds(tree, deckId))
            : new Set<string>();
          inScope = Boolean(q.deckId && subtreeIds.has(q.deckId));
        } else if (q.deckId === deckId) {
          inScope = true;
        } else if (q.deckId) {
          const [folders, [sub]] = await Promise.all([
            loadActiveOwnedFolders(db, userId),
            db
              .select({ folderId: subscriptions.folderId })
              .from(subscriptions)
              .where(
                and(
                  eq(subscriptions.userId, userId),
                  eq(subscriptions.deckId, q.deckId),
                ),
              ),
          ]);
          const tree = buildServerFolderTree(folders);
          const subtreeIds = tree.byId.has(deckId)
            ? new Set<string>(collectOwnedSubtreeIds(tree, deckId))
            : new Set<string>();
          inScope = Boolean(sub?.folderId && subtreeIds.has(sub.folderId));
        }
        if (!inScope) {
          return {
            output: { error: "该题目不属于当前文件夹范围。" },
            label: "读取题目详情",
            refs: [],
          };
        }
      }
      const [[study], location] = await Promise.all([
        db
          .select({ note: studyCards.note })
          .from(studyCards)
          .where(
            and(
              eq(studyCards.userId, userId),
              eq(studyCards.questionId, q.id),
            ),
          ),
        resolveQuestionLocation(userId, q),
      ]);
      const tags = mergeQuestionTags(q.tags, markdownDocument(q.answer).tags);
      return {
        label: `已读取「${q.title.slice(0, 20)}」`,
        refs: [{ id: q.id, title: q.title, deckTitle: location.folderPath }],
        output: {
          id: q.id,
          deckTitle: location.deckTitle,
          folderPath: location.folderPath,
          isOwner: q.isOwner,
          title: q.title,
          tags,
          revision: q.revision,
          needsEditing: q.needsEditing,
          answer: q.answer.slice(0, 6000),
          note: (study?.note ?? "").slice(0, 2000),
        },
      };
    } catch {
      return {
        output: { error: "题目不存在或无权访问。" },
        label: "读取题目详情",
        refs: [],
      };
    }
  }

  const getPool = () => cachedPool ?? loadScopedPool(userId, scope, deckId);

  if (name === "search_concepts") {
    const query =
      typeof args.query === "string" ? args.query.trim().slice(0, 4000) : "";
    if (!query) {
      return { output: { matches: [] }, label: "请输入概念关键词", refs: [] };
    }
    const limit =
      typeof args.limit === "number" && Number.isInteger(args.limit)
        ? Math.max(1, Math.min(8, args.limit))
        : 5;
    const { pool } = await getPool();
    const { matches, refs } = await searchScopedConcepts(
      userId,
      scope,
      query,
      limit,
      pool,
    );
    return {
      output: { matches },
      label: matches.length ? `已检索到 ${matches.length} 条概念` : "未检索到匹配概念",
      refs,
    };
  }

  if (name === "list_workspace_overview") {
    const { pool, deckRows } = await getPool();
    const now = Date.now();
    const summary = deckRows.map((d) => {
      const items = pool.filter((q) => q.deckId === d.id);
      const groupSummary = d.groups.length
        ? d.groups.map((g) => {
            const groupItems = items.filter((q) => q.groupId === g.id);
            return {
              title: g.title,
              path: g.path,
              total: groupItems.length,
              due: groupItems.filter(
                (q) => q.hasAnswer && isQuestionDue(q, now),
              ).length,
              needsEditing: groupItems.filter((q) => q.needsEditing).length,
            };
          })
        : undefined;
      return {
        deckId: d.id,
        title: d.title,
        path: d.path,
        isOwner: d.isOwner,
        total: items.length,
        due: items.filter((q) => q.hasAnswer && isQuestionDue(q, now)).length,
        needsEditing: items.filter((q) => q.needsEditing).length,
        ...(groupSummary ? { groups: groupSummary } : {}),
      };
    });
    return {
      label: `已概览 ${summary.length} 个文件夹位置（共 ${pool.length} 题）`,
      refs: [],
      output: { totalQuestions: pool.length, decks: summary },
    };
  }

  if (name === "find_duplicate_questions") {
    const { pool } = await getPool();
    const limit = Math.min(15, Math.max(1, Number(args.limit) || 8));
    const capped = [...pool]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 280);
    const prepared = capped.map((item) => {
      const norm = normalizeForSimilarity(item.title);
      return { item, norm, grams: charBigrams(norm) };
    });

    const pairs: {
      similarity: number;
      a: {
        id: string;
        title: string;
        deckTitle: string;
        folderPath: string;
        tags: string[];
        isOwner: boolean;
      };
      b: {
        id: string;
        title: string;
        deckTitle: string;
        folderPath: string;
        tags: string[];
        isOwner: boolean;
      };
    }[] = [];

    for (let i = 0; i < prepared.length; i++) {
      for (let j = i + 1; j < prepared.length; j++) {
        const pa = prepared[i];
        const pb = prepared[j];
        const titleSim = precomputedDiceSimilarity(pa, pb);
        const tagBonus =
          pa.item.tags.length &&
          pb.item.tags.length &&
          pa.item.tags.some((t) => pb.item.tags.includes(t))
            ? 0.06
            : 0;
        const score = Math.min(1, Math.round((titleSim + tagBonus) * 100) / 100);
        if (score >= 0.48) {
          pairs.push({
            similarity: score,
            a: {
              id: pa.item.id,
              title: pa.item.title,
              deckTitle: pa.item.deckTitle,
              folderPath: pa.item.folderPath,
              tags: pa.item.tags,
              isOwner: pa.item.isOwner,
            },
            b: {
              id: pb.item.id,
              title: pb.item.title,
              deckTitle: pb.item.deckTitle,
              folderPath: pb.item.folderPath,
              tags: pb.item.tags,
              isOwner: pb.item.isOwner,
            },
          });
        }
      }
    }
    pairs.sort((x, y) => y.similarity - x.similarity);
    const topPairs = pairs.slice(0, limit);
    const refsMap = new Map<string, ToolQuestionRef>();
    for (const pair of topPairs) {
      refsMap.set(pair.a.id, {
        id: pair.a.id,
        title: pair.a.title,
        deckTitle: pair.a.folderPath,
      });
      refsMap.set(pair.b.id, {
        id: pair.b.id,
        title: pair.b.title,
        deckTitle: pair.b.folderPath,
      });
    }
    return {
      label: topPairs.length
        ? `已发现 ${topPairs.length} 组相似题目`
        : "未发现高相似度重复题目",
      refs: [...refsMap.values()].slice(0, 8),
      output: {
        scanned: capped.length,
        candidates: topPairs,
      },
    };
  }

  if (name === "search_questions") {
    const { pool } = await getPool();
    const now = Date.now();
    const query =
      typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
    const filter =
      args.filter === "due" ||
      args.filter === "needsEditing" ||
      args.filter === "new"
        ? args.filter
        : "all";
    const limit = Math.min(20, Math.max(1, Number(args.limit) || 10));
    const terms = query.split(/\s+/).filter(Boolean);

    const ranked = pool
      .filter((q) => {
        if (filter === "needsEditing") return q.needsEditing;
        if (filter === "due") return q.hasAnswer && isQuestionDue(q, now);
        if (filter === "new") return q.hasAnswer && !q.fsrs;
        return true;
      })
      .map((q) => {
        if (!terms.length) return { item: q, score: 1 };
        const titleLower = q.title.toLowerCase();
        const tagsLower = q.tags.join(" ").toLowerCase();
        const pathLower = q.folderPath.toLowerCase();
        const ansLower = q.answerSnippet.slice(0, 1200).toLowerCase();
        const noteLower = q.noteSnippet.toLowerCase();
        let score = 0;
        for (const term of terms) {
          let hit = false;
          if (titleLower.includes(term)) {
            score += 5;
            hit = true;
          }
          if (tagsLower.includes(term)) {
            score += 3;
            hit = true;
          }
          if (pathLower.includes(term)) {
            score += 3;
            hit = true;
          }
          if (noteLower.includes(term)) {
            score += 2;
            hit = true;
          }
          if (ansLower.includes(term)) {
            score += 1;
            hit = true;
          }
          if (!hit) return null;
        }
        return { item: q, score };
      })
      .filter(
        (entry): entry is { item: ScopedQuestionItem; score: number } =>
          !!entry,
      )
      .sort((a, b) => {
        if (filter === "due" && !terms.length) {
          const majorDiff =
            Number(isQuestionMajorRevisionDue(b.item)) -
            Number(isQuestionMajorRevisionDue(a.item));
          if (majorDiff !== 0) return majorDiff;
        }
        return (
          b.score - a.score ||
          Date.parse(b.item.updatedAt) - Date.parse(a.item.updatedAt)
        );
      })
      .slice(0, limit);

    const items = ranked.map(({ item }) => ({
      id: item.id,
      title: item.title,
      deckTitle: item.deckTitle,
      folderPath: item.folderPath,
      isOwner: item.isOwner,
      tags: item.tags,
      needsEditing: item.needsEditing,
      ...(isQuestionMajorRevisionDue(item) ? { needsRelearn: true } : {}),
      due: item.due,
      snippet: item.answerSnippet.replace(/\s+/g, " ").trim().slice(0, 160),
    }));

    return {
      label: items.length
        ? `已检索到 ${items.length} 道相关题目`
        : "未检索到匹配题目",
      refs: items.slice(0, 8).map((q) => ({
        id: q.id,
        title: q.title,
        deckTitle: q.folderPath,
      })),
      output: { totalInScope: pool.length, matches: items },
    };
  }

  return {
    label: `未知工具：${name}`,
    refs: [],
    output: { error: `Unknown tool: ${name}` },
  };
}

export async function buildFallbackScopeSummary(
  userId: string,
  scope: "deck" | "workspace",
  deckId: string | null,
  cachedPool?: Promise<ScopedPool>,
  query = "",
) {
  const { pool, deckRows } = await (cachedPool ??
    loadScopedPool(userId, scope, deckId));
  const top = [...pool]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 25)
    .map((q) => ({
      id: q.id,
      title: q.title,
      deckTitle: q.deckTitle,
      folderPath: q.folderPath,
      tags: q.tags,
      needsEditing: q.needsEditing,
    }));
  const { matches, refs } = await searchScopedConcepts(
    userId,
    scope,
    query,
    4,
    pool,
  );
  const summary = JSON.stringify({
    scope,
    totalInScope: pool.length,
    ...(matches.length ? { relatedConcepts: matches } : {}),
    folders: deckRows.map((d) => ({
      title: d.title,
      path: d.path,
      ...(d.groups.length
        ? { subfolders: d.groups.map((g) => g.path) }
        : {}),
    })),
    recentQuestions: top,
  });
  return { summary, refs };
}
