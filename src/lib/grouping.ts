import type { DeckGroupView, DeckView, QuestionView } from "./types";

export const UNGROUPED_LABEL = "未分组";
export const OTHER_DECKS_LABEL = "其他题库";

export type CategoryGroupCluster = {
  category: string;
  groups: DeckGroupView[];
};

export type QuestionGroupSection = {
  group: DeckGroupView | null;
  questions: QuestionView[];
};

export type QuestionCategoryBucket = {
  category: string;
  sections: QuestionGroupSection[];
  questionCount: number;
};

export type DeckBucket<T extends Pick<DeckView, "groupName">> = {
  groupName: string;
  decks: T[];
};

export type ReaderGroupContext = {
  currentGroup: DeckGroupView | null;
  groupIndex: number;
  groupTotal: number;
  prevGroup: DeckGroupView | null;
  nextGroup: DeckGroupView | null;
  prevCrossesGroup: boolean;
  nextCrossesGroup: boolean;
};

/** Sort intra-deck groups deterministically by explicit position, then createdAt, then id. */
export function sortDeckGroups<
  T extends Pick<DeckGroupView, "id" | "position" | "createdAt">,
>(groups: readonly T[]): T[] {
  return [...groups].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    const diff = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (diff !== 0 && Number.isFinite(diff)) return diff;
    return a.id.localeCompare(b.id);
  });
}

/** Sort questions within a single group or ungrouped bucket by position, then createdAt, then id. */
export function sortQuestionsWithinGroup<
  T extends Pick<QuestionView, "id" | "position" | "createdAt">,
>(questions: readonly T[]): T[] {
  return [...questions].sort((a, b) => {
    const posDiff = (a.position ?? 0) - (b.position ?? 0);
    if (posDiff !== 0) return posDiff;
    const timeDiff = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (timeDiff !== 0 && Number.isFinite(timeDiff)) return timeDiff;
    return a.id.localeCompare(b.id);
  });
}

/** List distinct non-empty category labels in first-appearance order across sorted deck groups. */
export function listDeckCategories(
  groups: readonly Pick<
    DeckGroupView,
    "id" | "category" | "position" | "createdAt"
  >[],
): string[] {
  const ordered = sortDeckGroups(groups);
  const seen = new Set<string>();
  const categories: string[] = [];
  for (const g of ordered) {
    const cat = g.category.trim();
    if (!cat || seen.has(cat)) continue;
    seen.add(cat);
    categories.push(cat);
  }
  return categories;
}

/**
 * Cluster intra-deck groups by their optional `category` (e.g. company name) while preserving
 * first-appearance order of categories and `position` order within each category.
 * Uncategorized groups (`category === ""`) trail in their `position` order.
 */
export function clusterDeckGroupsByCategory(groups: readonly DeckGroupView[]): {
  hasCategories: boolean;
  categories: CategoryGroupCluster[];
  orderedGroups: DeckGroupView[];
} {
  const sorted = sortDeckGroups(groups);
  const byCategory = new Map<string, DeckGroupView[]>();
  const uncategorized: DeckGroupView[] = [];
  for (const group of sorted) {
    const cat = group.category.trim();
    if (!cat) {
      uncategorized.push(group);
      continue;
    }
    const list = byCategory.get(cat);
    if (list) list.push(group);
    else byCategory.set(cat, [group]);
  }
  const hasCategories = byCategory.size > 0;
  if (!hasCategories) {
    return {
      hasCategories: false,
      categories: sorted.length ? [{ category: "", groups: sorted }] : [],
      orderedGroups: sorted,
    };
  }
  const categories: CategoryGroupCluster[] = Array.from(
    byCategory.entries(),
    ([category, list]) => ({ category, groups: list }),
  );
  if (uncategorized.length) {
    categories.push({ category: "", groups: uncategorized });
  }
  return {
    hasCategories: true,
    categories,
    orderedGroups: categories.flatMap((bucket) => bucket.groups),
  };
}

/**
 * Compute the canonical reading order of questions in a deck:
 * category appearance order -> group position -> question position -> createdAt -> id,
 * with ungrouped (`groupId === null` or unknown group) trailing last.
 */
export function computeDeckReadingOrder(
  questions: readonly QuestionView[],
  groups: readonly DeckGroupView[],
): QuestionView[] {
  if (!groups.length) return sortQuestionsWithinGroup(questions);
  const { orderedGroups } = clusterDeckGroupsByCategory(groups);
  const byGroupId = new Map<string, QuestionView[]>();
  const ungrouped: QuestionView[] = [];
  const validGroupIds = new Set(orderedGroups.map((g) => g.id));
  for (const q of questions) {
    if (q.groupId && validGroupIds.has(q.groupId)) {
      const list = byGroupId.get(q.groupId);
      if (list) list.push(q);
      else byGroupId.set(q.groupId, [q]);
    } else {
      ungrouped.push(q);
    }
  }
  const result: QuestionView[] = [];
  for (const g of orderedGroups) {
    const items = byGroupId.get(g.id);
    if (items?.length) result.push(...sortQuestionsWithinGroup(items));
  }
  if (ungrouped.length) {
    result.push(...sortQuestionsWithinGroup(ungrouped));
  }
  return result;
}

/**
 * Bucket a deck's questions into category -> group sections plus the matching flat canonical order.
 * Useful for Library grouped view, category filtering, and QuestionReader outline.
 */
export function bucketQuestionsByGroup(
  questions: readonly QuestionView[],
  groups: readonly DeckGroupView[],
  options: { includeEmptyGroups?: boolean } = {},
): {
  hasGroups: boolean;
  hasCategories: boolean;
  categoryBuckets: QuestionCategoryBucket[];
  flatOrdered: QuestionView[];
} {
  const includeEmpty = options.includeEmptyGroups ?? true;
  if (!groups.length) {
    const flatOrdered = sortQuestionsWithinGroup(questions);
    return {
      hasGroups: false,
      hasCategories: false,
      categoryBuckets: flatOrdered.length
        ? [
            {
              category: "",
              sections: [{ group: null, questions: flatOrdered }],
              questionCount: flatOrdered.length,
            },
          ]
        : [],
      flatOrdered,
    };
  }

  const { hasCategories, categories, orderedGroups } =
    clusterDeckGroupsByCategory(groups);
  const validGroupIds = new Set(orderedGroups.map((g) => g.id));
  const byGroupId = new Map<string, QuestionView[]>();
  const ungrouped: QuestionView[] = [];

  for (const q of questions) {
    if (q.groupId && validGroupIds.has(q.groupId)) {
      const list = byGroupId.get(q.groupId);
      if (list) list.push(q);
      else byGroupId.set(q.groupId, [q]);
    } else {
      ungrouped.push(q);
    }
  }

  const categoryBuckets: QuestionCategoryBucket[] = [];
  const flatOrdered: QuestionView[] = [];

  for (const cluster of categories) {
    const sections: QuestionGroupSection[] = [];
    let questionCount = 0;
    for (const group of cluster.groups) {
      const items = sortQuestionsWithinGroup(byGroupId.get(group.id) ?? []);
      if (!includeEmpty && items.length === 0) continue;
      sections.push({ group, questions: items });
      questionCount += items.length;
      flatOrdered.push(...items);
    }
    if (sections.length) {
      categoryBuckets.push({
        category: cluster.category,
        sections,
        questionCount,
      });
    }
  }

  const sortedUngrouped = sortQuestionsWithinGroup(ungrouped);
  if (sortedUngrouped.length) {
    flatOrdered.push(...sortedUngrouped);
    const trailingUncategorized = categoryBuckets.find(
      (b) => b.category === "",
    );
    if (trailingUncategorized && !hasCategories) {
      trailingUncategorized.sections.push({
        group: null,
        questions: sortedUngrouped,
      });
      trailingUncategorized.questionCount += sortedUngrouped.length;
    } else {
      categoryBuckets.push({
        category: "",
        sections: [{ group: null, questions: sortedUngrouped }],
        questionCount: sortedUngrouped.length,
      });
    }
  }

  return {
    hasGroups: true,
    hasCategories,
    categoryBuckets,
    flatOrdered,
  };
}

/** Resolve a question's intra-deck group metadata from workspace decks. */
export function resolveQuestionGroup(
  decks: readonly DeckView[],
  question: Pick<QuestionView, "deckId" | "groupId">,
): DeckGroupView | null {
  if (!question.deckId || !question.groupId) return null;
  const deck = decks.find((d) => d.id === question.deckId);
  if (!deck?.groups.length) return null;
  return deck.groups.find((g) => g.id === question.groupId) ?? null;
}

/** Format a group's human-readable label ("字节跳动 · 抖音一面" or "事务与 MVCC"). */
export function formatGroupLabel(
  group: Pick<DeckGroupView, "category" | "title"> | null | undefined,
  separator = " · ",
): string {
  if (!group) return "";
  const category = group.category.trim();
  const title = group.title.trim();
  if (!category) return title;
  if (!title) return category;
  return `${category}${separator}${title}`;
}

/**
 * Compute reader group context (current group slice position & prev/next group boundary cues)
 * for QuestionReader prev/next navigation.
 */
export function computeReaderGroupContext(
  readingList: readonly QuestionView[],
  currentIndex: number,
  groups: readonly DeckGroupView[],
): ReaderGroupContext | null {
  const current = readingList[currentIndex];
  if (!current || !groups.length) return null;

  const groupMap = new Map(groups.map((g) => [g.id, g]));
  const groupFor = (q: QuestionView | undefined): DeckGroupView | null =>
    q?.groupId ? (groupMap.get(q.groupId) ?? null) : null;

  const currentGroup = groupFor(current);
  const currentKey = currentGroup?.id ?? "";
  let groupIndex = 0;
  let groupTotal = 0;
  for (let i = 0; i < readingList.length; i++) {
    const key = groupFor(readingList[i])?.id ?? "";
    if (key === currentKey) {
      if (i === currentIndex) groupIndex = groupTotal;
      groupTotal += 1;
    }
  }

  const prevItem = currentIndex > 0 ? readingList[currentIndex - 1] : undefined;
  const nextItem =
    currentIndex < readingList.length - 1
      ? readingList[currentIndex + 1]
      : undefined;
  const prevGroup = groupFor(prevItem);
  const nextGroup = groupFor(nextItem);
  const prevKey = prevGroup?.id ?? "";
  const nextKey = nextGroup?.id ?? "";

  return {
    currentGroup,
    groupIndex,
    groupTotal,
    prevGroup,
    nextGroup,
    prevCrossesGroup: Boolean(prevItem) && prevKey !== currentKey,
    nextCrossesGroup: Boolean(nextItem) && nextKey !== currentKey,
  };
}

/** List distinct non-empty deck-level group names in first-appearance order. */
export function listDeckGroupNames(
  decks: readonly Pick<DeckView, "groupName">[],
): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const d of decks) {
    const name = d.groupName.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** Bucket decks by their `groupName`, preserving order with ungrouped decks trailing last. */
export function groupDecksByName<T extends Pick<DeckView, "groupName">>(
  decks: readonly T[],
): { hasGroups: boolean; buckets: DeckBucket<T>[] } {
  const map = new Map<string, T[]>();
  const ungrouped: T[] = [];
  for (const deck of decks) {
    const name = deck.groupName.trim();
    if (!name) {
      ungrouped.push(deck);
      continue;
    }
    const list = map.get(name);
    if (list) list.push(deck);
    else map.set(name, [deck]);
  }
  if (map.size === 0) {
    return {
      hasGroups: false,
      buckets: decks.length ? [{ groupName: "", decks: [...decks] }] : [],
    };
  }
  const buckets: DeckBucket<T>[] = Array.from(
    map.entries(),
    ([groupName, list]) => ({ groupName, decks: list }),
  );
  if (ungrouped.length) {
    buckets.push({ groupName: "", decks: ungrouped });
  }
  return { hasGroups: true, buckets };
}

/**
 * Infer an intra-deck `{ category, title }` from an imported file's relative path or filename.
 * Examples:
 *   "字节跳动/抖音一面.md"       -> { category: "字节跳动", title: "抖音一面" }
 *   "面经/字节跳动/抖音一面.md"   -> { category: "字节跳动", title: "抖音一面" }
 *   "美团一面.md"                -> { category: "", title: "美团一面" }
 */
export function inferGroupFromSourceName(sourceName: string): {
  category: string;
  title: string;
} {
  const normalized = sourceName
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..");
  if (!normalized.length) return { category: "", title: "" };

  const fileName = normalized[normalized.length - 1];
  const baseName = fileName.replace(/\.(?:md|txt)$/i, "").trim() || fileName;
  const parentDir =
    normalized.length >= 2 ? normalized[normalized.length - 2] : "";

  return {
    category: parentDir.slice(0, 40),
    title: baseName.slice(0, 80),
  };
}

function collapsedStorageKey(userId: string, deckId: string): string {
  return `shiyi:deck-groups:${userId}:${deckId}`;
}

/** Read persisted collapsed group IDs for a given `(userId, deckId)` from localStorage. */
export function readCollapsedGroupIds(
  userId: string,
  deckId: string,
): Set<string> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(collapsedStorageKey(userId, deckId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return new Set(
      parsed.filter((item): item is string => typeof item === "string"),
    );
  } catch {
    return null;
  }
}

/** Persist collapsed group IDs for a given `(userId, deckId)` to localStorage. */
export function writeCollapsedGroupIds(
  userId: string,
  deckId: string,
  ids: Iterable<string>,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      collapsedStorageKey(userId, deckId),
      JSON.stringify([...new Set(ids)]),
    );
  } catch {
    /* Ignore storage access restrictions. */
  }
}
