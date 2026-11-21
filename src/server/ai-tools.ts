import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { decks, questions, releases, studyCards, subscriptions } from "@/db/schema";
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
  isOwner: boolean;
  title: string;
  answer: string;
  tags: string[];
  needsEditing: boolean;
  due: string | null;
  updatedAt: string;
};

export const WORKSPACE_AI_TOOLS: ProviderTool[] = [
  {
    type: "function",
    function: {
      name: "search_questions",
      description:
        "按关键词、标签或学习状态检索当前范围（当前题库或全部题库）内的相关面试题。",
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

function diceSimilarity(a: string, b: string): number {
  const na = normalizeForSimilarity(a);
  const nb = normalizeForSimilarity(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) {
    return 0.86;
  }
  const ga = charBigrams(na);
  const gb = charBigrams(nb);
  let overlap = 0;
  for (const gram of ga) {
    if (gb.has(gram)) overlap += 1;
  }
  return (2 * overlap) / (ga.size + gb.size);
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
        eq(releases.version, decks.publishedVersion),
      ),
    )
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.deckId, deckId)));
  if (!sub) throw new AppError(404, "题库不存在或无权访问。");
  return { ...sub, isOwner: false };
}

async function loadScopedPool(
  userId: string,
  scope: "deck" | "workspace",
  deckId: string | null,
): Promise<{
  pool: ScopedQuestionItem[];
  deckRows: { id: string | null; title: string; isOwner: boolean }[];
}> {
  const db = await getDb();
  const [ownDecks, subs, studyRows] = await Promise.all([
    db
      .select({ id: decks.id, title: decks.title })
      .from(decks)
      .where(and(eq(decks.ownerId, userId), isNull(decks.deletedAt))),
    db
      .select({
        deckId: decks.id,
        publishedVersion: decks.publishedVersion,
      })
      .from(subscriptions)
      .innerJoin(decks, eq(subscriptions.deckId, decks.id))
      .where(eq(subscriptions.userId, userId)),
    db
      .select({
        questionId: studyCards.questionId,
        fsrs: studyCards.fsrs,
      })
      .from(studyCards)
      .where(eq(studyCards.userId, userId)),
  ]);

  const deckTitleMap = new Map<string, { title: string; isOwner: boolean }>();
  for (const d of ownDecks) deckTitleMap.set(d.id, { title: d.title, isOwner: true });
  const fsrsMap = new Map(studyRows.map((s) => [s.questionId, s.fsrs]));
  const pool: ScopedQuestionItem[] = [];

  if (!deckId || deckTitleMap.has(deckId)) {
    const ownedRows = await db
      .select({
        id: questions.id,
        deckId: questions.deckId,
        title: questions.title,
        answer: questions.answer,
        tags: questions.tags,
        needsEditing: questions.needsEditing,
        archived: questions.archived,
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
      const card = fsrsMap.get(q.id);
      pool.push({
        id: q.id,
        deckId: q.deckId,
        deckTitle: q.deckId
          ? (deckTitleMap.get(q.deckId)?.title ?? "未分类")
          : "未分类",
        isOwner: true,
        title: q.title,
        answer: q.answer,
        tags: q.tags,
        needsEditing: q.needsEditing,
        due: card?.due ? String(card.due) : null,
        updatedAt: q.updatedAt.toISOString(),
      });
    }
  }

  const subIds =
    scope === "deck" && deckId
      ? subs.filter((s) => s.deckId === deckId).map((s) => s.deckId)
      : subs.map((s) => s.deckId);

  if (subIds.length) {
    const published = await db
      .select({ release: releases })
      .from(releases)
      .innerJoin(
        decks,
        and(
          eq(releases.deckId, decks.id),
          eq(releases.version, decks.publishedVersion),
        ),
      )
      .where(inArray(releases.deckId, subIds));
    for (const { release } of published) {
      deckTitleMap.set(release.deckId, { title: release.title, isOwner: false });
      for (const q of release.questions) {
        if (q.archived) continue;
        const card = fsrsMap.get(q.id);
        pool.push({
          id: q.id,
          deckId: release.deckId,
          deckTitle: release.title,
          isOwner: false,
          title: q.title,
          answer: q.answer,
          tags: q.tags,
          needsEditing: q.needsEditing,
          due: card?.due ? String(card.due) : null,
          updatedAt: q.updatedAt,
        });
      }
    }
  }

  const deckRows: { id: string | null; title: string; isOwner: boolean }[] = [
    ...Array.from(deckTitleMap.entries()).map(([id, info]) => ({
      id,
      title: info.title,
      isOwner: info.isOwner,
    })),
    ...(scope === "workspace"
      ? [{ id: null, title: "未分类", isOwner: true }]
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
): Promise<{
  output: unknown;
  label: string;
  refs: ToolQuestionRef[];
}> {
  let args: Record<string, unknown> = {};
  if (rawArgs.trim()) {
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
    } catch {
      args = {};
    }
  }

  if (name === "get_question_detail") {
    const questionId =
      typeof args.questionId === "string" ? args.questionId.trim() : "";
    if (!questionId) {
      return { output: { error: "缺少 questionId 参数。" }, label: "读取题目详情", refs: [] };
    }
    try {
      const q = await accessibleQuestion(userId, questionId);
      if (scope === "deck" && deckId && q.deckId !== deckId) {
        return {
          output: { error: "该题目不属于当前题库范围。" },
          label: "读取题目详情",
          refs: [],
        };
      }
      const db = await getDb();
      const [study] = await db
        .select({ note: studyCards.note })
        .from(studyCards)
        .where(
          and(
            eq(studyCards.userId, userId),
            eq(studyCards.questionId, q.id),
          ),
        );
      return {
        label: `已读取「${q.title.slice(0, 20)}」`,
        refs: [{ id: q.id, title: q.title, deckTitle: q.deckId ?? "" }],
        output: {
          id: q.id,
          title: q.title,
          tags: q.tags,
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

  const { pool, deckRows } = await loadScopedPool(userId, scope, deckId);
  const now = Date.now();

  if (name === "list_workspace_overview") {
    const summary = deckRows.map((d) => {
      const items = pool.filter((q) => q.deckId === d.id);
      return {
        deckId: d.id,
        title: d.title,
        isOwner: d.isOwner,
        total: items.length,
        due: items.filter((q) => q.due && Date.parse(q.due) <= now).length,
        needsEditing: items.filter((q) => q.needsEditing).length,
      };
    });
    return {
      label: `已概览 ${summary.length} 个题库分区（共 ${pool.length} 题）`,
      refs: [],
      output: { totalQuestions: pool.length, decks: summary },
    };
  }

  if (name === "find_duplicate_questions") {
    const limit = Math.min(
      15,
      Math.max(1, Number(args.limit) || 8),
    );
    const capped = [...pool]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 280);
    const pairs: {
      similarity: number;
      a: { id: string; title: string; deckTitle: string; tags: string[] };
      b: { id: string; title: string; deckTitle: string; tags: string[] };
    }[] = [];
    for (let i = 0; i < capped.length; i++) {
      for (let j = i + 1; j < capped.length; j++) {
        const qa = capped[i];
        const qb = capped[j];
        const titleSim = diceSimilarity(qa.title, qb.title);
        const tagBonus =
          qa.tags.length && qb.tags.length
            ? qa.tags.some((t) => qb.tags.includes(t))
              ? 0.06
              : 0
            : 0;
        const score = Math.min(1, Math.round((titleSim + tagBonus) * 100) / 100);
        if (score >= 0.48) {
          pairs.push({
            similarity: score,
            a: { id: qa.id, title: qa.title, deckTitle: qa.deckTitle, tags: qa.tags },
            b: { id: qb.id, title: qb.title, deckTitle: qb.deckTitle, tags: qb.tags },
          });
        }
      }
    }
    pairs.sort((x, y) => y.similarity - x.similarity);
    const topPairs = pairs.slice(0, limit);
    const refsMap = new Map<string, ToolQuestionRef>();
    for (const pair of topPairs) {
      refsMap.set(pair.a.id, { id: pair.a.id, title: pair.a.title, deckTitle: pair.a.deckTitle });
      refsMap.set(pair.b.id, { id: pair.b.id, title: pair.b.title, deckTitle: pair.b.deckTitle });
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

  // Default: search_questions
  const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
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
      if (filter === "due") return !!q.due && Date.parse(q.due) <= now;
      if (filter === "new") return !q.due;
      return true;
    })
    .map((q) => {
      if (!terms.length) return { item: q, score: 1 };
      const titleLower = q.title.toLowerCase();
      const tagsLower = q.tags.join(" ").toLowerCase();
      const deckLower = q.deckTitle.toLowerCase();
      const ansLower = q.answer.slice(0, 1200).toLowerCase();
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
        if (deckLower.includes(term)) {
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
    .filter((entry): entry is { item: ScopedQuestionItem; score: number } => !!entry)
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
    tags: item.tags,
    needsEditing: item.needsEditing,
    due: item.due,
    snippet: item.answer.replace(/\s+/g, " ").trim().slice(0, 160),
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

export async function buildFallbackScopeSummary(
  userId: string,
  scope: "deck" | "workspace",
  deckId: string | null,
) {
  const { pool, deckRows } = await loadScopedPool(userId, scope, deckId);
  const top = [...pool]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 25)
    .map((q) => ({
      id: q.id,
      title: q.title,
      deckTitle: q.deckTitle,
      tags: q.tags,
      needsEditing: q.needsEditing,
    }));
  return JSON.stringify({
    scope,
    totalInScope: pool.length,
    decks: deckRows.map((d) => d.title),
    recentQuestions: top,
  });
}
