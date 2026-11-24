import type {
  PendingDeckUpdate,
  PublishStatus,
  UnpublishedDeckDiff,
} from "./types";

export type ReleaseGroupSnapshot = {
  id: string;
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

function tagsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function groupsChangedBetween(
  a: readonly ReleaseGroupSnapshot[] | null | undefined,
  b: readonly ReleaseGroupSnapshot[] | null | undefined,
): boolean {
  const listA = [...(a ?? [])].sort(
    (x, y) => (x.position ?? 0) - (y.position ?? 0) || x.id.localeCompare(y.id),
  );
  const listB = [...(b ?? [])].sort(
    (x, y) => (x.position ?? 0) - (y.position ?? 0) || x.id.localeCompare(y.id),
  );
  if (listA.length !== listB.length) return true;
  for (let i = 0; i < listA.length; i++) {
    const ga = listA[i];
    const gb = listB[i];
    if (
      ga.id !== gb.id ||
      ga.title !== gb.title ||
      (ga.category ?? "") !== (gb.category ?? "") ||
      (ga.description ?? "") !== (gb.description ?? "") ||
      (ga.position ?? 0) !== (gb.position ?? 0)
    ) {
      return true;
    }
  }
  return false;
}

function questionDiffers(
  a: ReleaseQuestionSnapshot,
  b: ReleaseQuestionSnapshot,
): boolean {
  return (
    a.revision !== b.revision ||
    a.majorRevision !== b.majorRevision ||
    a.title !== b.title ||
    a.answer !== b.answer ||
    (a.groupId ?? null) !== (b.groupId ?? null) ||
    (a.position ?? 0) !== (b.position ?? 0) ||
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
    } else if (questionDiffers(prevQ, nextQ)) {
      updated += 1;
    }
  }
  for (const id of pinnedActive.keys()) {
    if (!latestActive.has(id)) removed += 1;
  }

  const groupsChanged = groupsChangedBetween(pinned.groups, latest.groups);
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
 * Compare an author's live deck (metadata + groups + questions) against its
 * latest published release snapshot to detect unpublished changes accurately.
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

  // Match release questions via canonical sourceQuestionId (for moved-question aliases).
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
    } else if (questionDiffers(relQ, liveQ)) {
      updated += 1;
    }
  }
  for (const id of publishedActive.keys()) {
    if (!liveActive.has(id)) removed += 1;
  }

  const metaChanged =
    live.title !== latestRelease.title ||
    live.description !== latestRelease.description;
  const groupsChanged = groupsChangedBetween(live.groups, latestRelease.groups);

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
    if (diff.groupsChanged) parts.push("分组已调整");
    if (diff.titleChanged || diff.metaChanged) parts.push("题库信息已更新");
  }
  return parts.join(" · ") || "内容已更新";
}
