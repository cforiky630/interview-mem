import type {
  DeckGroupView,
  PendingDeckUpdate,
  PublishStatus,
  UnpublishedDeckDiff,
} from "./types";
import { compareNaturalNames } from "./folders";

export type ReleaseGroupSnapshot = {
  id: string;
  parentId?: string | null;
  title: string;
  category?: string;
  description?: string;
  position?: number;
};

export type ReleaseQuestionSnapshot = {
  id: string;
  sourceQuestionId?: string;
  groupId?: string | null;
  position?: number;
  title: string;
  answer: string;
  tags: string[];
  revision: number;
  majorRevision: number;
  archived: boolean;
};

export type ReleaseSnapshotLike = {
  version: number;
  title: string;
  description: string;
  summary?: string;
  groups?: readonly ReleaseGroupSnapshot[] | null;
  questions: readonly ReleaseQuestionSnapshot[];
  createdAt?: string | Date;
};

type NormalizedFolderEntry = {
  id: string;
  parentId: string | null;
  title: string;
  description: string;
  canonicalPath: string;
};

function tagsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Normalize either legacy flat/category `ReleaseGroupSnapshot[]` (where `parentId === undefined`)
 * or recursive multi-level `ReleaseGroupSnapshot[]` (where `parentId` is explicitly `string | null`)
 * into a uniform tree of `DeckGroupView[]` for subscriber browsing and diffing.
 */
export function normalizeReleaseGroups(
  rawGroups: readonly ReleaseGroupSnapshot[] | null | undefined,
  deckId = "",
  timestamp = "",
): DeckGroupView[] {
  const list = rawGroups ?? [];
  if (!list.length) return [];

  const usesExplicitTree = list.some((g) => g.parentId !== undefined);
  if (usesExplicitTree) {
    const validIds = new Set(list.map((g) => g.id));
    return list
      .map((g) => ({
        id: g.id,
        deckId,
        parentId:
          g.parentId && validIds.has(g.parentId) && g.parentId !== g.id
            ? g.parentId
            : null,
        title: g.title,
        category: g.category ?? "",
        description: g.description ?? "",
        position: g.position ?? 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      }))
      .sort(
        (a, b) =>
          compareNaturalNames(a.title, b.title) || a.id.localeCompare(b.id),
      );
  }

  // Legacy flat / category-based snapshot: synthesize deterministic parent nodes for non-empty `category`.
  const categoryNodeByKey = new Map<string, DeckGroupView>();
  const result: DeckGroupView[] = [];
  for (const g of list) {
    const cat = (g.category ?? "").trim();
    let parentId: string | null = null;
    if (cat) {
      const catKey = cat.toLowerCase();
      let catNode = categoryNodeByKey.get(catKey);
      if (!catNode) {
        catNode = {
          id: `legacy-cat:${catKey}`,
          deckId,
          parentId: null,
          title: cat,
          category: "",
          description: "",
          position: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        categoryNodeByKey.set(catKey, catNode);
        result.push(catNode);
      }
      parentId = catNode.id;
    }
    result.push({
      id: g.id,
      deckId,
      parentId,
      title: g.title,
      category: cat,
      description: g.description ?? "",
      position: g.position ?? 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
  return result.sort(
    (a, b) => compareNaturalNames(a.title, b.title) || a.id.localeCompare(b.id),
  );
}

function buildNormalizedFolderMap(
  rawGroups: readonly ReleaseGroupSnapshot[] | null | undefined,
): Map<string, NormalizedFolderEntry> {
  const normalized = normalizeReleaseGroups(rawGroups, "__rel__", "");
  const byId = new Map(normalized.map((g) => [g.id, g]));
  const result = new Map<string, NormalizedFolderEntry>();

  const pathFor = (id: string): string => {
    const segments: string[] = [];
    const visited = new Set<string>();
    let cur: string | null = id;
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      const node = byId.get(cur);
      if (!node) break;
      segments.push(node.title.trim().toLowerCase());
      cur = node.parentId;
    }
    return segments.reverse().join("\0");
  };

  for (const g of normalized) {
    result.set(g.id, {
      id: g.id,
      parentId: g.parentId,
      title: g.title.trim(),
      description: (g.description ?? "").trim(),
      canonicalPath: pathFor(g.id),
    });
  }
  return result;
}

function groupsChangedBetween(
  mapA: Map<string, NormalizedFolderEntry>,
  mapB: Map<string, NormalizedFolderEntry>,
): boolean {
  const sigs = (map: Map<string, NormalizedFolderEntry>) =>
    Array.from(map.values())
      .map((entry) => `${entry.canonicalPath}\u0001${entry.title}\u0001${entry.description}`)
      .sort();
  const a = sigs(mapA);
  const b = sigs(mapB);
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return true;
  }
  return false;
}

function questionDiffers(
  a: ReleaseQuestionSnapshot,
  b: ReleaseQuestionSnapshot,
  folderPathA: string,
  folderPathB: string,
): boolean {
  return (
    a.revision !== b.revision ||
    a.majorRevision !== b.majorRevision ||
    a.title !== b.title ||
    a.answer !== b.answer ||
    folderPathA !== folderPathB ||
    !tagsEqual(a.tags, b.tags)
  );
}

/**
 * Compute an exact subscriber-facing diff summary between the subscriber's
 * pinned release and the author's latest published release.
 */
export function diffReleaseVersions(
  pinned: ReleaseSnapshotLike,
  latest: ReleaseSnapshotLike,
): PendingDeckUpdate {
  const pinnedFolders = buildNormalizedFolderMap(pinned.groups);
  const latestFolders = buildNormalizedFolderMap(latest.groups);

  const pinnedActive = new Map<string, ReleaseQuestionSnapshot>();
  for (const q of pinned.questions) {
    if (!q.archived) pinnedActive.set(q.id, q);
  }
  const latestActive = new Map<string, ReleaseQuestionSnapshot>();
  for (const q of latest.questions) {
    if (!q.archived) latestActive.set(q.id, q);
  }

  let added = 0;
  let updated = 0;
  let removed = 0;

  for (const [id, nextQ] of latestActive) {
    const prevQ = pinnedActive.get(id);
    if (!prevQ) {
      added += 1;
    } else {
      const pathA = prevQ.groupId
        ? (pinnedFolders.get(prevQ.groupId)?.canonicalPath ?? "")
        : "";
      const pathB = nextQ.groupId
        ? (latestFolders.get(nextQ.groupId)?.canonicalPath ?? "")
        : "";
      if (questionDiffers(prevQ, nextQ, pathA, pathB)) {
        updated += 1;
      }
    }
  }
  for (const id of pinnedActive.keys()) {
    if (!latestActive.has(id)) removed += 1;
  }

  const groupsChanged = groupsChangedBetween(pinnedFolders, latestFolders);
  const titleChanged =
    pinned.title !== latest.title || pinned.description !== latest.description;
  const publishedAt =
    latest.createdAt instanceof Date
      ? latest.createdAt.toISOString()
      : (latest.createdAt ?? new Date(0).toISOString());

  return {
    fromVersion: pinned.version,
    toVersion: latest.version,
    added,
    updated,
    removed,
    groupsChanged,
    titleChanged,
    summary: latest.summary ?? "",
    publishedAt,
  };
}

/**
 * Compare an author's live folder subtree against its latest published release
 * snapshot (both legacy category snapshots and recursive parentId snapshots)
 * so migrated synced folders show zero spurious changes.
 */
export function computeUnpublishedDiff(
  live: {
    title: string;
    description: string;
    groups: readonly ReleaseGroupSnapshot[];
    questions: readonly ReleaseQuestionSnapshot[];
  },
  latestRelease: ReleaseSnapshotLike | null | undefined,
): {
  publishStatus: PublishStatus;
  unpublishedDiff: UnpublishedDeckDiff | null;
} {
  if (!latestRelease) {
    return { publishStatus: "unpublished", unpublishedDiff: null };
  }

  const liveFolders = buildNormalizedFolderMap(live.groups);
  const relFolders = buildNormalizedFolderMap(latestRelease.groups);

  // Match release questions via canonical sourceQuestionId (for moved/nested-published aliases).
  const publishedActive = new Map<string, ReleaseQuestionSnapshot>();
  for (const q of latestRelease.questions) {
    if (!q.archived) publishedActive.set(q.sourceQuestionId ?? q.id, q);
  }
  const liveActive = new Map<string, ReleaseQuestionSnapshot>();
  for (const q of live.questions) {
    if (!q.archived) liveActive.set(q.id, q);
  }

  let added = 0;
  let updated = 0;
  let removed = 0;

  for (const [id, liveQ] of liveActive) {
    const relQ = publishedActive.get(id);
    if (!relQ) {
      added += 1;
    } else {
      const relPath = relQ.groupId
        ? (relFolders.get(relQ.groupId)?.canonicalPath ?? "")
        : "";
      const livePath = liveQ.groupId
        ? (liveFolders.get(liveQ.groupId)?.canonicalPath ?? "")
        : "";
      if (questionDiffers(relQ, liveQ, relPath, livePath)) {
        updated += 1;
      }
    }
  }
  for (const id of publishedActive.keys()) {
    if (!liveActive.has(id)) removed += 1;
  }

  const metaChanged =
    live.title !== latestRelease.title ||
    live.description !== latestRelease.description;
  const groupsChanged = groupsChangedBetween(liveFolders, relFolders);

  if (!added && !updated && !removed && !metaChanged && !groupsChanged) {
    return { publishStatus: "synced", unpublishedDiff: null };
  }

  return {
    publishStatus: "changes",
    unpublishedDiff: {
      added,
      updated,
      removed,
      metaChanged,
      groupsChanged,
    },
  };
}

/** Format a compact Chinese diff string such as "+3 新增 · ~2 修改 · -1 移除". */
export function formatDiffSummary(diff: {
  added: number;
  updated: number;
  removed: number;
  groupsChanged?: boolean;
  titleChanged?: boolean;
  metaChanged?: boolean;
}): string {
  const parts: string[] = [];
  if (diff.added > 0) parts.push(`+${diff.added} 新增`);
  if (diff.updated > 0) parts.push(`~${diff.updated} 修改`);
  if (diff.removed > 0) parts.push(`-${diff.removed} 移除`);
  if (!parts.length) {
    if (diff.groupsChanged) parts.push("目录结构已调整");
    if (diff.titleChanged || diff.metaChanged) parts.push("文件夹信息已更新");
  }
  return parts.join(" · ") || "内容已更新";
}
