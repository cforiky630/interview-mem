import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  deckGroups,
  decks,
  questions,
  releases,
  studyCards,
  subscriptions,
} from "@/db/schema";
import { markdownDocument, mergeQuestionTags } from "@/lib/markdown-source";
import type { ProviderTool } from "./ai";
import { AppError } from "./errors";
import { accessibleQuestion } from "./workspace";

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
  groupId: string | null;
  groupTitle: string;
  groupCategory: string;
  isOwner: boolean;
  title: string;
  answerSnippet: string;
  hasAnswer: boolean;
  noteSnippet: string;
  tags: string[];
  needsEditing: boolean;
  due: string | null;
  updatedAt: string;
};

export type ScopedPool = {
  pool: ScopedQuestionItem[];
  deckRows: {
    id: string | null;
    title: string;
    groupName: string;
    isOwner: boolean;
    groups: { id: string; title: string; category: string }[];
  }[];
};

export const WORKSPACE_AI_TOOLS: ProviderTool[] = [
  {
    type: "function",
    function: {
      name: "search_questions",
      description:
        "按关键词、标签、笔记或学习状态检索当前范围（当前题库或全部题库）内的相关面试题。",
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
        "读取指定题目的完整题干、标签、参考答案正文与当前用户的个人笔记摘要。",
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
        "查看当前范围内各题库（含未分类）的题目总数、待复习数与待完善题数概览。",
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
  if (!sub) throw new AppError(404, "题库不存在或无权访问。");
  return { ...sub, isOwner: false };
}

async function resolveDeckTitle(
  userId: string,
  deckId: string | null,
  isOwner: boolean,
): Promise<string> {
  if (!deckId) return "未分类";
  const db = await getDb();
  if (isOwner) {
    const [own] = await db
      .select({ title: decks.title })
      .from(decks)
      .where(
        and(
          eq(decks.id, deckId),
          eq(decks.ownerId, userId),
          isNull(decks.deletedAt),
        ),
      );
    return own?.title ?? "未分类";
  }
  const [rel] = await db
    .select({ title: releases.title })
    .from(subscriptions)
    .innerJoin(
      releases,
      and(
        eq(releases.deckId, subscriptions.deckId),
        eq(releases.version, subscriptions.seenVersion),
      ),
    )
    .where(
      and(eq(subscriptions.userId, userId), eq(subscriptions.deckId, deckId)),
    );
  return rel?.title ?? "订阅题库";
}

export async function loadScopedPool(
  userId: string,
  scope: "deck" | "workspace",
  deckId: string | null,
): Promise<ScopedPool> {
  const db = await getDb();
  const [ownDecks, ownGroups, subs, studyRows] = await Promise.all([
    db
      .select({
        id: decks.id,
        title: decks.title,
        groupName: decks.groupName,
      })
      .from(decks)
      .where(
        and(
          eq(decks.ownerId, userId),
          isNull(decks.deletedAt),
          scope === "deck" && deckId ? eq(decks.id, deckId) : undefined,
        ),
      ),
    db
      .select({
        id: deckGroups.id,
        deckId: deckGroups.deckId,
        title: deckGroups.title,
        category: deckGroups.category,
      })
      .from(deckGroups)
      .where(
        and(
          eq(deckGroups.ownerId, userId),
          scope === "deck" && deckId ? eq(deckGroups.deckId, deckId) : undefined,
        ),
      )
      .orderBy(
        asc(deckGroups.position),
        asc(deckGroups.createdAt),
        asc(deckGroups.id),
      ),
    db
      .select({
        deckId: decks.id,
        publishedVersion: decks.publishedVersion,
        groupName: subscriptions.groupName,
      })
      .from(subscriptions)
      .innerJoin(decks, eq(subscriptions.deckId, decks.id))
      .where(
        and(
          eq(subscriptions.userId, userId),
          scope === "deck" && deckId
            ? eq(subscriptions.deckId, deckId)
            : undefined,
        ),
      ),
    db
      .select({
        questionId: studyCards.questionId,
        fsrs: studyCards.fsrs,
        noteSnippet: sql<string>`left(${studyCards.note}, 1000)`,
      })
      .from(studyCards)
      .where(eq(studyCards.userId, userId)),
  ]);

  const deckInfoMap = new Map<
    string,
    {
      title: string;
      groupName: string;
      isOwner: boolean;
      groups: { id: string; title: string; category: string }[];
    }
  >();
  const groupInfoMap = new Map<
    string,
    { title: string; category: string }
  >();
  for (const d of ownDecks) {
    deckInfoMap.set(d.id, {
      title: d.title,
      groupName: d.groupName,
      isOwner: true,
      groups: [],
    });
  }
  for (const g of ownGroups) {
    groupInfoMap.set(g.id, { title: g.title, category: g.category });
    deckInfoMap.get(g.deckId)?.groups.push({
      id: g.id,
      title: g.title,
      category: g.category,
    });
  }
  const subGroupNameMap = new Map(subs.map((s) => [s.deckId, s.groupName]));
  const studyMap = new Map(studyRows.map((s) => [s.questionId, s]));
  const pool: ScopedQuestionItem[] = [];

  if (!deckId || deckInfoMap.has(deckId)) {
    const ownedRows = await db
      .select({
        id: questions.id,
        deckId: questions.deckId,
        groupId: questions.groupId,
        title: questions.title,
        answerSnippet: sql<string>`left(${questions.answer}, 2000)`,
        hasAnswer: sql<boolean>`btrim(${questions.answer}) <> ''`,
        tags: questions.tags,
        needsEditing: questions.needsEditing,
        updatedAt: questions.updatedAt,
      })
      .from(questions)
      .where(
        and(
          eq(questions.ownerId, userId),
          isNull(questions.deletedAt),
          isNull(questions.purgedAt),
          eq(questions.archived, false),
          scope === "deck" && deckId ? eq(questions.deckId, deckId) : undefined,
        ),
      );
    for (const q of ownedRows) {
      const study = studyMap.get(q.id);
      const grp = q.groupId ? groupInfoMap.get(q.groupId) : undefined;
      const mergedTags = mergeQuestionTags(
        q.tags,
        markdownDocument(q.answerSnippet).tags,
      );
      pool.push({
        id: q.id,
        deckId: q.deckId,
        deckTitle: q.deckId
          ? (deckInfoMap.get(q.deckId)?.title ?? "未分类")
          : "未分类",
        groupId: q.groupId,
        groupTitle: grp?.title ?? "",
        groupCategory: grp?.category ?? "",
        isOwner: true,
        title: q.title,
        answerSnippet: q.answerSnippet,
        hasAnswer: Boolean(q.hasAnswer),
        noteSnippet: study?.noteSnippet ?? "",
        tags: mergedTags,
        needsEditing: q.needsEditing,
        due: study?.fsrs?.due ? String(study.fsrs.due) : null,
        updatedAt: q.updatedAt.toISOString(),
      });
    }
  }

  const subIds = subs.map((s) => s.deckId);

  if (subIds.length) {
    const published = await db
      .select({ release: releases })
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
    for (const { release } of published) {
      const releaseGroups = (release.groups ?? []).map((g) => ({
        id: g.id,
        title: g.title,
        category: g.category ?? "",
      }));
      const releaseGroupMap = new Map(releaseGroups.map((g) => [g.id, g]));
      deckInfoMap.set(release.deckId, {
        title: release.title,
        groupName: subGroupNameMap.get(release.deckId) ?? "",
        isOwner: false,
        groups: releaseGroups,
      });
      for (const q of release.questions) {
        if (q.archived) continue;
        const study = studyMap.get(q.id);
        const grp = q.groupId ? releaseGroupMap.get(q.groupId) : undefined;
        const snippet = q.answer.slice(0, 2000);
        const mergedTags = mergeQuestionTags(
          q.tags,
          markdownDocument(snippet).tags,
        );
        pool.push({
          id: q.id,
          deckId: release.deckId,
          deckTitle: release.title,
          groupId: q.groupId ?? null,
          groupTitle: grp?.title ?? "",
          groupCategory: grp?.category ?? "",
          isOwner: false,
          title: q.title,
          answerSnippet: snippet,
          hasAnswer: Boolean(q.answer.trim()),
          noteSnippet: study?.noteSnippet ?? "",
          tags: mergedTags,
          needsEditing: q.needsEditing,
          due: study?.fsrs?.due ? String(study.fsrs.due) : null,
          updatedAt: q.updatedAt,
        });
      }
    }
  }

  const deckRows = [
    ...Array.from(deckInfoMap.entries()).map(([id, info]) => ({
      id,
      title: info.title,
      groupName: info.groupName,
      isOwner: info.isOwner,
      groups: info.groups,
    })),
    ...(scope === "workspace"
      ? [
          {
            id: null,
            title: "未分类",
            groupName: "",
            isOwner: true,
            groups: [],
          },
        ]
      : []),
  ];

  return { pool, deckRows };
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
      if (scope === "deck" && deckId && q.deckId !== deckId) {
        return {
          output: { error: "该题目不属于当前题库范围。" },
          label: "读取题目详情",
          refs: [],
        };
      }
      const db = await getDb();
      const [[study], deckTitle, groupInfo] = await Promise.all([
        db
          .select({ note: studyCards.note })
          .from(studyCards)
          .where(
            and(
              eq(studyCards.userId, userId),
              eq(studyCards.questionId, q.id),
            ),
          ),
        resolveDeckTitle(userId, q.deckId, q.isOwner),
        q.groupId && q.deckId
          ? q.isOwner
            ? db
                .select({
                  title: deckGroups.title,
                  category: deckGroups.category,
                })
                .from(deckGroups)
                .where(
                  and(
                    eq(deckGroups.id, q.groupId),
                    eq(deckGroups.ownerId, userId),
                  ),
                )
                .then((rows) => rows[0] ?? null)
            : db
                .select({ groups: releases.groups })
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
                    eq(subscriptions.deckId, q.deckId),
                  ),
                )
                .then(
                  (rows) =>
                    rows[0]?.groups?.find((g) => g.id === q.groupId) ?? null,
                )
          : Promise.resolve(null),
      ]);
      const tags = mergeQuestionTags(q.tags, markdownDocument(q.answer).tags);
      return {
        label: `已读取「${q.title.slice(0, 20)}」`,
        refs: [{ id: q.id, title: q.title, deckTitle }],
        output: {
          id: q.id,
          deckTitle,
          ...(groupInfo
            ? {
                groupCategory: groupInfo.category,
                groupTitle: groupInfo.title,
              }
            : {}),
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

  if (name === "list_workspace_overview") {
    const { pool, deckRows } = await getPool();
    const now = Date.now();
    const summary = deckRows.map((d) => {
      const items = pool.filter((q) => q.deckId === d.id);
      const groupSummary = d.groups.length
        ? d.groups.map((g) => {
            const groupItems = items.filter((q) => q.groupId === g.id);
            return {
              category: g.category,
              title: g.title,
              total: groupItems.length,
              due: groupItems.filter(
                (q) => q.hasAnswer && q.due && Date.parse(q.due) <= now,
              ).length,
              needsEditing: groupItems.filter((q) => q.needsEditing).length,
            };
          })
        : undefined;
      return {
        deckId: d.id,
        title: d.title,
        ...(d.groupName ? { groupName: d.groupName } : {}),
        isOwner: d.isOwner,
        total: items.length,
        due: items.filter(
          (q) => q.hasAnswer && q.due && Date.parse(q.due) <= now,
        ).length,
        needsEditing: items.filter((q) => q.needsEditing).length,
        ...(groupSummary ? { groups: groupSummary } : {}),
      };
    });
    return {
      label: `已概览 ${summary.length} 个题库分区（共 ${pool.length} 题）`,
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
        groupCategory?: string;
        groupTitle?: string;
        tags: string[];
        isOwner: boolean;
      };
      b: {
        id: string;
        title: string;
        deckTitle: string;
        groupCategory?: string;
        groupTitle?: string;
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
              ...(pa.item.groupCategory
                ? { groupCategory: pa.item.groupCategory }
                : {}),
              ...(pa.item.groupTitle ? { groupTitle: pa.item.groupTitle } : {}),
              tags: pa.item.tags,
              isOwner: pa.item.isOwner,
            },
            b: {
              id: pb.item.id,
              title: pb.item.title,
              deckTitle: pb.item.deckTitle,
              ...(pb.item.groupCategory
                ? { groupCategory: pb.item.groupCategory }
                : {}),
              ...(pb.item.groupTitle ? { groupTitle: pb.item.groupTitle } : {}),
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
        deckTitle: pair.a.deckTitle,
      });
      refsMap.set(pair.b.id, {
        id: pair.b.id,
        title: pair.b.title,
        deckTitle: pair.b.deckTitle,
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
        if (filter === "due")
          return q.hasAnswer && !!q.due && Date.parse(q.due) <= now;
        if (filter === "new") return q.hasAnswer && !q.due;
        return true;
      })
      .map((q) => {
        if (!terms.length) return { item: q, score: 1 };
        const titleLower = q.title.toLowerCase();
        const tagsLower = q.tags.join(" ").toLowerCase();
        const groupLower = `${q.groupCategory} ${q.groupTitle}`.toLowerCase();
        const deckLower = q.deckTitle.toLowerCase();
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
          if (groupLower.includes(term)) {
            score += 3;
            hit = true;
          }
          if (deckLower.includes(term)) {
            score += 2;
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
      .sort(
        (a, b) =>
          b.score - a.score ||
          Date.parse(b.item.updatedAt) - Date.parse(a.item.updatedAt),
      )
      .slice(0, limit);

    const items = ranked.map(({ item }) => ({
      id: item.id,
      title: item.title,
      deckTitle: item.deckTitle,
      ...(item.groupCategory ? { groupCategory: item.groupCategory } : {}),
      ...(item.groupTitle ? { groupTitle: item.groupTitle } : {}),
      isOwner: item.isOwner,
      tags: item.tags,
      needsEditing: item.needsEditing,
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
        deckTitle: q.deckTitle,
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
      ...(q.groupCategory ? { groupCategory: q.groupCategory } : {}),
      ...(q.groupTitle ? { groupTitle: q.groupTitle } : {}),
      tags: q.tags,
      needsEditing: q.needsEditing,
    }));
  return JSON.stringify({
    scope,
    totalInScope: pool.length,
    decks: deckRows.map((d) => ({
      title: d.title,
      ...(d.groupName ? { groupName: d.groupName } : {}),
      ...(d.groups.length
        ? {
            groups: d.groups.map((g) =>
              g.category ? `${g.category} · ${g.title}` : g.title,
            ),
          }
        : {}),
    })),
    recentQuestions: top,
  });
}
