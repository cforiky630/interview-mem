import type { DeckGroupView, DeckView, QuestionView } from "./types";
import { isQuestionDue } from "./review-queue";

export const ROOT_FOLDER_LABEL = "我的资料";
export const MAX_FOLDER_DEPTH = 8;
export const MAX_FOLDER_TITLE_LENGTH = 80;

export const folderNameCollator = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});

export type ItemSortKey = "name" | "updated" | "due";

/** Case-insensitive trimmed key matching DB unique index `lower(btrim(title))`. */
export function normalizeFolderTitleKey(title: string): string {
  return title.trim().toLowerCase();
}

/** Validate folder names following Finder / Explorer rules (no blank, `/`, `\`, or control chars). */
export function validateFolderTitle(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return "请输入文件夹名称。";
  if (trimmed.length > MAX_FOLDER_TITLE_LENGTH) {
    return `文件夹名称最多 ${MAX_FOLDER_TITLE_LENGTH} 个字符。`;
  }
  if (/[/\\\p{Cc}]/u.test(trimmed)) {
    return "文件夹名称不能包含 /、\\ 或控制字符。";
  }
  if (trimmed === "." || trimmed === "..") {
    return "文件夹名称不能为 . 或 ..。";
  }
  return null;
}

export function compareNaturalNames(a: string, b: string): number {
  const diff = folderNameCollator.compare(a, b);
  return diff !== 0 ? diff : a.localeCompare(b);
}

export function sortFoldersNatural<
  T extends Pick<DeckView, "id" | "title">,
>(folders: readonly T[]): T[] {
  return [...folders].sort(
    (a, b) => compareNaturalNames(a.title, b.title) || a.id.localeCompare(b.id),
  );
}

export function sortQuestionsList<
  T extends Pick<
    QuestionView,
    "id" | "title" | "updatedAt" | "fsrs" | "majorRevision" | "reviewedRevision"
  >,
>(questions: readonly T[], sortBy: ItemSortKey, now = Date.now()): T[] {
  if (sortBy === "name") {
    return [...questions].sort(
      (a, b) =>
        compareNaturalNames(a.title, b.title) || a.id.localeCompare(b.id),
    );
  }
  if (sortBy === "updated") {
    return [...questions].sort((a, b) => {
      const diff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      if (diff !== 0 && Number.isFinite(diff)) return diff;
      return compareNaturalNames(a.title, b.title) || a.id.localeCompare(b.id);
    });
  }
  // sortBy === "due" (review urgency: due/major first, then new, then scheduled soonest)
  const bucket = (q: T) => (!q.fsrs ? 1 : isQuestionDue(q, now) ? 0 : 2);
  return [...questions].sort((a, b) => {
    const diff = bucket(a) - bucket(b);
    if (diff !== 0) return diff;
    if (a.fsrs && b.fsrs) {
      const dueDiff = Date.parse(a.fsrs.due) - Date.parse(b.fsrs.due);
      if (dueDiff !== 0 && Number.isFinite(dueDiff)) return dueDiff;
    }
    return compareNaturalNames(a.title, b.title) || a.id.localeCompare(b.id);
  });
}

/** Generate a non-colliding sibling title such as "Redis (2)", "Redis (3)". */
export function resolveUniqueSiblingTitle(
  baseTitle: string,
  existingLowerKeys: ReadonlySet<string>,
): string {
  const base = baseTitle.trim() || "未命名文件夹";
  if (!existingLowerKeys.has(normalizeFolderTitleKey(base))) {
    return base.slice(0, MAX_FOLDER_TITLE_LENGTH);
  }
  for (let suffix = 2; suffix < 10_000; suffix++) {
    const tag = ` (${suffix})`;
    const maxBase = Math.max(1, MAX_FOLDER_TITLE_LENGTH - tag.length);
    const candidate = `${base.slice(0, maxBase)}${tag}`;
    if (!existingLowerKeys.has(normalizeFolderTitleKey(candidate))) {
      return candidate;
    }
  }
  return `${base.slice(0, 60)} (${Date.now().toString(36)})`;
}

/** Canonical text key matching server `contentHash(title, answer)` input verbatim. */
export function normalizedContentKey(title: string, answer: string): string {
  return `${title.trim().replace(/\s+/g, " ")}\n${answer.trim().replace(/\r\n/g, "\n")}`;
}

export type FolderBreadcrumbNode = {
  id: string | null;
  subGroupId?: string | null;
  title: string;
  isSubscription?: boolean;
};

export type FolderIndex = {
  byId: Map<string, DeckView>;
  ownedById: Map<string, DeckView>;
  ownedChildren: Map<string | null, DeckView[]>;
  subChildren: Map<string | null, DeckView[]>;
  subscriptionsByFolder: Map<string | null, DeckView[]>;
  allChildren: Map<string | null, DeckView[]>;
  depthOf: (folderId: string | null) => number;
  subtreeHeightOf: (folderId: string) => number;
  subtreeHeight: (folderId: string) => number;
  ancestorsOf: (folderId: string | null) => DeckView[];
  breadcrumbsOf: (folderId: string | null) => DeckView[];
  ancestorIds: (folderId: string | null) => string[];
  ownedDescendantIds: (folderId: string) => Set<string>;
  subtreeOwnedIds: (folderId: string) => Set<string>;
  subtreeDeckIds: (
    folderId: string | null,
    options?: { includeSubscriptions?: boolean },
  ) => Set<string | null>;
  breadcrumbsFor: (
    folderId: string | null,
    subGroupId?: string | null,
  ) => FolderBreadcrumbNode[];
  pathSegmentsOf: (
    folderId: string | null,
    subGroupId?: string | null,
  ) => string[];
  formatPath: (folderId: string | null, subGroupId?: string | null) => string;
  pathOf: (folderId: string | null, subGroupId?: string | null) => string;
  formatRelativePath: (
    baseFolderId: string | null,
    targetFolderId: string | null,
    subGroupId?: string | null,
  ) => string;
  relativePathOf: (
    targetFolderId: string | null,
    baseFolderId: string | null,
    subGroupId?: string | null,
  ) => string;
  subGroupChildrenOf: (
    deck: DeckView,
    parentGroupId: string | null,
  ) => DeckGroupView[];
  subGroupDescendantIds: (deck: DeckView, groupId: string | null) => Set<string>;
  publishedAncestorsOf: (folderId: string) => DeckView[];
  publishedAncestors: (folderId: string) => DeckView[];
  publishedDescendantsOf: (folderId: string) => DeckView[];
  publishedDescendants: (folderId: string) => DeckView[];
  flatOwnedList: () => { deck: DeckView; depth: number; fullPath: string }[];
  flatOwned: { folder: DeckView; depth: number; path: string }[];
};

export function buildFolderIndex(decks: readonly DeckView[]): FolderIndex {
  const byId = new Map<string, DeckView>();
  const ownedById = new Map<string, DeckView>();
  for (const d of decks) {
    byId.set(d.id, d);
    if (d.isOwner) ownedById.set(d.id, d);
  }

  const ownedChildren = new Map<string | null, DeckView[]>();
  const subChildren = new Map<string | null, DeckView[]>();
  const allChildren = new Map<string | null, DeckView[]>();

  const pushChild = (
    map: Map<string | null, DeckView[]>,
    parentId: string | null,
    item: DeckView,
  ) => {
    const list = map.get(parentId);
    if (list) list.push(item);
    else map.set(parentId, [item]);
  };

  for (const d of decks) {
    const validParent =
      d.parentId && ownedById.has(d.parentId) && d.parentId !== d.id
        ? d.parentId
        : null;
    if (d.isOwner) pushChild(ownedChildren, validParent, d);
    else pushChild(subChildren, validParent, d);
    pushChild(allChildren, validParent, d);
  }

  for (const [key, list] of ownedChildren) {
    ownedChildren.set(key, sortFoldersNatural(list));
  }
  for (const [key, list] of subChildren) {
    subChildren.set(key, sortFoldersNatural(list));
  }
  for (const [key, list] of allChildren) {
    // Owned folders first, then subscriptions, each naturally sorted.
    allChildren.set(key, [
      ...sortFoldersNatural(list.filter((d) => d.isOwner)),
      ...sortFoldersNatural(list.filter((d) => !d.isOwner)),
    ]);
  }

  function ancestorsOf(folderId: string | null): DeckView[] {
    if (!folderId) return [];
    const chain: DeckView[] = [];
    const visited = new Set<string>();
    let cursor: string | null = folderId;
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const node = byId.get(cursor);
      if (!node) break;
      chain.push(node);
      cursor =
        node.parentId && ownedById.has(node.parentId) ? node.parentId : null;
    }
    return chain.reverse();
  }

  function depthOf(folderId: string | null): number {
    if (!folderId) return 0;
    return ancestorsOf(folderId).length;
  }

  function subtreeHeightOf(folderId: string): number {
    const visited = new Set<string>();
    const dfs = (id: string): number => {
      if (visited.has(id)) return 1;
      visited.add(id);
      const kids = ownedChildren.get(id) ?? [];
      let maxChild = 0;
      for (const kid of kids) {
        maxChild = Math.max(maxChild, dfs(kid.id));
      }
      return 1 + maxChild;
    };
    return dfs(folderId);
  }

  function ownedDescendantIds(folderId: string): Set<string> {
    const result = new Set<string>();
    const stack = [folderId];
    while (stack.length) {
      const current = stack.pop()!;
      if (result.has(current)) continue;
      result.add(current);
      for (const child of ownedChildren.get(current) ?? []) {
        stack.push(child.id);
      }
    }
    return result;
  }

  function subtreeDeckIds(
    folderId: string | null,
    options: { includeSubscriptions?: boolean } = {},
  ): Set<string | null> {
    const includeSubs = options.includeSubscriptions ?? true;
    if (folderId === null) {
      const all = new Set<string | null>([null]);
      for (const d of decks) {
        if (d.isOwner || includeSubs) all.add(d.id);
      }
      return all;
    }
    const target = byId.get(folderId);
    if (!target) return new Set();
    if (!target.isOwner) return new Set([target.id]);
    const result = new Set<string | null>();
    const stack = [target.id];
    while (stack.length) {
      const current = stack.pop()!;
      if (result.has(current)) continue;
      result.add(current);
      for (const child of ownedChildren.get(current) ?? []) {
        stack.push(child.id);
      }
      if (includeSubs) {
        for (const sub of subChildren.get(current) ?? []) {
          result.add(sub.id);
        }
      }
    }
    return result;
  }

  function subGroupChain(deck: DeckView, subGroupId: string | null): DeckGroupView[] {
    if (!subGroupId || !deck.groups.length) return [];
    const map = new Map(deck.groups.map((g) => [g.id, g]));
    const chain: DeckGroupView[] = [];
    const visited = new Set<string>();
    let cursor: string | null = subGroupId;
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const grp = map.get(cursor);
      if (!grp) break;
      chain.push(grp);
      cursor = grp.parentId && map.has(grp.parentId) ? grp.parentId : null;
    }
    return chain.reverse();
  }

  function breadcrumbsFor(
    folderId: string | null,
    subGroupId?: string | null,
  ): FolderBreadcrumbNode[] {
    const nodes: FolderBreadcrumbNode[] = [{ id: null, title: ROOT_FOLDER_LABEL }];
    if (!folderId) return nodes;
    const chain = ancestorsOf(folderId);
    for (const d of chain) {
      nodes.push({
        id: d.id,
        title: d.title,
        isSubscription: !d.isOwner,
      });
    }
    const leaf = chain.at(-1);
    if (leaf && !leaf.isOwner && subGroupId) {
      for (const grp of subGroupChain(leaf, subGroupId)) {
        nodes.push({
          id: leaf.id,
          subGroupId: grp.id,
          title: grp.title,
          isSubscription: true,
        });
      }
    }
    return nodes;
  }

  function pathSegmentsOf(
    folderId: string | null,
    subGroupId?: string | null,
  ): string[] {
    return breadcrumbsFor(folderId, subGroupId)
      .slice(1)
      .map((n) => n.title);
  }

  function formatPath(
    folderId: string | null,
    subGroupId?: string | null,
  ): string {
    const segments = pathSegmentsOf(folderId, subGroupId);
    return segments.length ? segments.join(" / ") : ROOT_FOLDER_LABEL;
  }

  function formatRelativePath(
    baseFolderId: string | null,
    targetFolderId: string | null,
    subGroupId?: string | null,
  ): string {
    if (baseFolderId === targetFolderId && !subGroupId) return "";
    if (!baseFolderId) return formatPath(targetFolderId, subGroupId);
    const baseSegs = pathSegmentsOf(baseFolderId);
    const targetSegs = pathSegmentsOf(targetFolderId, subGroupId);
    if (
      targetSegs.length >= baseSegs.length &&
      baseSegs.every((seg, idx) => targetSegs[idx] === seg)
    ) {
      const rest = targetSegs.slice(baseSegs.length);
      return rest.length ? rest.join(" / ") : "";
    }
    return targetSegs.join(" / ") || ROOT_FOLDER_LABEL;
  }

  function subGroupChildrenOf(
    deck: DeckView,
    parentGroupId: string | null,
  ): DeckGroupView[] {
    const validIds = new Set(deck.groups.map((g) => g.id));
    const kids = deck.groups.filter((g) => {
      const pid = g.parentId && validIds.has(g.parentId) ? g.parentId : null;
      return pid === parentGroupId;
    });
    return sortFoldersNatural(kids);
  }

  function subGroupDescendantIds(
    deck: DeckView,
    groupId: string | null,
  ): Set<string> {
    if (!groupId) return new Set(deck.groups.map((g) => g.id));
    const result = new Set<string>();
    const stack = [groupId];
    while (stack.length) {
      const cur = stack.pop()!;
      if (result.has(cur)) continue;
      result.add(cur);
      for (const child of subGroupChildrenOf(deck, cur)) {
        stack.push(child.id);
      }
    }
    return result;
  }

  function publishedAncestorsOf(folderId: string): DeckView[] {
    const chain = ancestorsOf(folderId);
    return chain
      .slice(0, -1)
      .filter((d) => d.isOwner && d.publishedVersion > 0 && d.visibility !== "private");
  }

  function publishedDescendantsOf(folderId: string): DeckView[] {
    const ids = ownedDescendantIds(folderId);
    ids.delete(folderId);
    const found: DeckView[] = [];
    for (const id of ids) {
      const d = ownedById.get(id);
      if (d && d.publishedVersion > 0 && d.visibility !== "private") {
        found.push(d);
      }
    }
    return sortFoldersNatural(found);
  }

  function flatOwnedList(): { deck: DeckView; depth: number; fullPath: string }[] {
    const result: { deck: DeckView; depth: number; fullPath: string }[] = [];
    const visited = new Set<string>();
    const walk = (parentId: string | null, depth: number, prefix: string[]) => {
      for (const child of ownedChildren.get(parentId) ?? []) {
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        const nextPrefix = [...prefix, child.title];
        result.push({
          deck: child,
          depth,
          fullPath: nextPrefix.join(" / "),
        });
        walk(child.id, depth + 1, nextPrefix);
      }
    };
    walk(null, 1, []);
    return result;
  }

  const flatOwned = flatOwnedList().map((item) => ({
    folder: item.deck,
    depth: item.depth,
    path: item.fullPath,
  }));

  function ancestorIds(folderId: string | null): string[] {
    return ancestorsOf(folderId)
      .slice(0, -1)
      .map((d) => d.id);
  }

  function relativePathOf(
    targetFolderId: string | null,
    baseFolderId: string | null,
    subGroupId?: string | null,
  ): string {
    return formatRelativePath(baseFolderId, targetFolderId, subGroupId);
  }

  return {
    byId,
    ownedById,
    ownedChildren,
    subChildren,
    subscriptionsByFolder: subChildren,
    allChildren,
    depthOf,
    subtreeHeightOf,
    subtreeHeight: subtreeHeightOf,
    ancestorsOf,
    breadcrumbsOf: ancestorsOf,
    ancestorIds,
    ownedDescendantIds,
    subtreeOwnedIds: ownedDescendantIds,
    subtreeDeckIds,
    breadcrumbsFor,
    pathSegmentsOf,
    formatPath,
    pathOf: formatPath,
    formatRelativePath,
    relativePathOf,
    subGroupChildrenOf,
    subGroupDescendantIds,
    publishedAncestorsOf,
    publishedAncestors: publishedAncestorsOf,
    publishedDescendantsOf,
    publishedDescendants: publishedDescendantsOf,
    flatOwnedList,
    flatOwned,
  };
}

export type DuplicateCluster = {
  key: string;
  isBlankAnswer: boolean;
  questions: QuestionView[];
  suggestedPrimaryId: string;
};

/**
 * Group exact duplicate owned active questions:
 * - Non-empty answer: exact `(normalized title, normalized answer)` match across entire workspace.
 * - Blank answer: exact normalized title match within the same folder.
 */
export function findExactDuplicateClusters(
  questions: readonly QuestionView[],
): DuplicateCluster[] {
  const buckets = new Map<string, { isBlank: boolean; items: QuestionView[] }>();
  for (const q of questions) {
    if (!q.isOwner || q.archived) continue;
    const isBlank = !q.answer.trim();
    const contentKey = normalizedContentKey(q.title, q.answer);
    const bucketKey = isBlank
      ? `blank::${q.deckId ?? ""}::${contentKey}`
      : `full::${contentKey}`;
    const bucket = buckets.get(bucketKey);
    if (bucket) bucket.items.push(q);
    else buckets.set(bucketKey, { isBlank, items: [q] });
  }

  const scorePrimary = (q: QuestionView) => {
    const reps = q.fsrs?.reps ?? 0;
    const stability = q.fsrs?.stability ?? 0;
    const noteBonus = q.note.trim().length > 0 ? 100 : 0;
    const annBonus = q.annotations.length * 20;
    const favBonus = q.favorite ? 50 : 0;
    return reps * 1000 + stability * 10 + noteBonus + annBonus + favBonus;
  };

  const clusters: DuplicateCluster[] = [];
  for (const [key, { isBlank, items }] of buckets) {
    if (items.length < 2) continue;
    const ordered = [...items].sort((a, b) => {
      const scoreDiff = scorePrimary(b) - scorePrimary(a);
      if (scoreDiff !== 0) return scoreDiff;
      return Date.parse(a.createdAt) - Date.parse(b.createdAt);
    });
    clusters.push({
      key,
      isBlankAnswer: isBlank,
      questions: ordered,
      suggestedPrimaryId: ordered[0].id,
    });
  }
  return clusters.sort(
    (a, b) =>
      Number(a.isBlankAnswer) - Number(b.isBlankAnswer) ||
      b.questions.length - a.questions.length ||
      compareNaturalNames(a.questions[0].title, b.questions[0].title),
  );
}

const RECENT_MAX_ITEMS = 30;
function recentStorageKey(userId: string): string {
  return `shiyi:recent-questions:${userId}`;
}

export function readRecentQuestionIds(userId: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(recentStorageKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string" && item.length > 0)
      .slice(0, RECENT_MAX_ITEMS);
  } catch {
    return [];
  }
}

export function recordRecentQuestionId(userId: string, questionId: string): string[] {
  const prev = readRecentQuestionIds(userId);
  const next = [questionId, ...prev.filter((id) => id !== questionId)].slice(
    0,
    RECENT_MAX_ITEMS,
  );
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(recentStorageKey(userId), JSON.stringify(next));
    } catch {
      /* Ignore storage access restrictions. */
    }
  }
  return next;
}

function expandedTreeStorageKey(userId: string): string {
  return `shiyi:folder-tree-expanded:${userId}`;
}

export function readExpandedFolderIds(userId: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(expandedTreeStorageKey(userId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

export function writeExpandedFolderIds(
  userId: string,
  ids: Iterable<string>,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      expandedTreeStorageKey(userId),
      JSON.stringify([...new Set(ids)]),
    );
  } catch {
    /* Ignore storage access restrictions. */
  }
}
