import { and, asc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { Database } from "@/db";
import { decks, questions, subscriptions, user as users } from "@/db/schema";
import {
  MAX_FOLDER_DEPTH,
  ROOT_FOLDER_LABEL,
  compareNaturalNames,
  normalizeFolderTitleKey,
  resolveUniqueSiblingTitle,
  validateFolderTitle,
} from "@/lib/folders";
import type { DuplicateHit, FolderConflictItem } from "@/lib/types";
import { contentHash } from "./crypto";
import { AppError } from "./errors";

export type DbTx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type OwnedFolderRow = typeof decks.$inferSelect;
export type FolderConflictStrategy = "abort" | "merge" | "keepBoth";

/**
 * Global transaction lock order invariant across all folder & question mutations:
 *   1. `users` (`lockUserTree`, when serializing a user's folder tree)
 *   2. `decks` (`ORDER BY id ASC FOR NO KEY UPDATE` via `lockOwnedFoldersById`)
 *   3. `imports` (`ORDER BY id ASC FOR UPDATE`, when committing import batches)
 *   4. `questions` (`ORDER BY id ASC FOR NO KEY UPDATE` via `lockOwnedQuestions*`)
 *   5. `study_cards` / `subscriptions`
 *
 * `users`, `decks`, and `questions` rows are never hard-deleted and their primary keys never
 * change, so `FOR NO KEY UPDATE` preserves full write serialization while avoiding PostgreSQL
 * AB-BA deadlocks against automatic `FOR KEY SHARE` foreign-key locks from child-table INSERTs.
 * Never acquire `decks` locks after locking or updating `questions` rows.
 */
export async function lockUserTree(tx: DbTx, userId: string): Promise<void> {
  await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .for("no key update");
}

/** Lock owned folder rows in deterministic `id` order (must precede any `questions` locks/writes). */
export async function lockOwnedFoldersById(
  tx: DbTx,
  userId: string,
  folderIds: readonly (string | null | undefined)[],
): Promise<OwnedFolderRow[]> {
  const uniqueIds = [
    ...new Set(folderIds.filter((id): id is string => Boolean(id))),
  ].sort();
  if (!uniqueIds.length) return [];
  return tx
    .select()
    .from(decks)
    .where(and(eq(decks.ownerId, userId), inArray(decks.id, uniqueIds)))
    .orderBy(asc(decks.id))
    .for("no key update");
}

export type LockedFolderQuestionRow = {
  id: string;
  deckId: string | null;
  contentHash: string;
  deletedAt: Date | null;
  purgedAt: Date | null;
};

/** Lock owned questions inside the given folders in deterministic `id` order (always after locking `decks`). */
export async function lockOwnedQuestionsInFolders(
  tx: DbTx,
  userId: string,
  folderIds: readonly (string | null | undefined)[],
): Promise<LockedFolderQuestionRow[]> {
  const uniqueIds = [
    ...new Set(folderIds.filter((id): id is string => Boolean(id))),
  ].sort();
  if (!uniqueIds.length) return [];
  return tx
    .select({
      id: questions.id,
      deckId: questions.deckId,
      contentHash: questions.contentHash,
      deletedAt: questions.deletedAt,
      purgedAt: questions.purgedAt,
    })
    .from(questions)
    .where(
      and(eq(questions.ownerId, userId), inArray(questions.deckId, uniqueIds)),
    )
    .orderBy(asc(questions.id))
    .for("no key update");
}

/** Lock owned questions matched by explicit IDs and/or folder membership in one deterministic `ORDER BY id` pass. */
async function lockOwnedQuestionsByIdsOrFolders(
  tx: DbTx,
  userId: string,
  input: {
    questionIds?: readonly string[];
    folderIds?: readonly string[];
  },
): Promise<LockedFolderQuestionRow[]> {
  const qIds = [...new Set(input.questionIds ?? [])].sort();
  const fIds = [...new Set(input.folderIds ?? [])].sort();
  if (!qIds.length && !fIds.length) return [];
  const matcher =
    qIds.length && fIds.length
      ? or(inArray(questions.id, qIds), inArray(questions.deckId, fIds))
      : qIds.length
        ? inArray(questions.id, qIds)
        : inArray(questions.deckId, fIds);
  return tx
    .select({
      id: questions.id,
      deckId: questions.deckId,
      contentHash: questions.contentHash,
      deletedAt: questions.deletedAt,
      purgedAt: questions.purgedAt,
    })
    .from(questions)
    .where(and(eq(questions.ownerId, userId), matcher))
    .orderBy(asc(questions.id))
    .for("no key update");
}

export async function loadActiveOwnedFolders(
  tx: Pick<Database, "select">,
  userId: string,
): Promise<OwnedFolderRow[]> {
  return tx
    .select()
    .from(decks)
    .where(and(eq(decks.ownerId, userId), isNull(decks.deletedAt)))
    .orderBy(asc(decks.createdAt), asc(decks.id));
}

export type ServerFolderTree = {
  rows: OwnedFolderRow[];
  byId: Map<string, OwnedFolderRow>;
  children: Map<string | null, OwnedFolderRow[]>;
};

export function buildServerFolderTree(
  rows: readonly OwnedFolderRow[],
): ServerFolderTree {
  const byId = new Map<string, OwnedFolderRow>();
  for (const row of rows) byId.set(row.id, row);
  const children = new Map<string | null, OwnedFolderRow[]>();
  for (const row of rows) {
    const pid =
      row.parentId && byId.has(row.parentId) && row.parentId !== row.id
        ? row.parentId
        : null;
    const list = children.get(pid);
    if (list) list.push(row);
    else children.set(pid, [row]);
  }
  for (const [k, list] of children) {
    list.sort(
      (a, b) =>
        compareNaturalNames(a.title, b.title) || a.id.localeCompare(b.id),
    );
    children.set(k, list);
  }
  return { rows: [...rows], byId, children };
}

export function folderDepth(
  tree: ServerFolderTree,
  folderId: string | null,
): number {
  if (!folderId) return 0;
  let depth = 0;
  const visited = new Set<string>();
  let cursor: string | null = folderId;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const node = tree.byId.get(cursor);
    if (!node) break;
    depth += 1;
    cursor =
      node.parentId && tree.byId.has(node.parentId) ? node.parentId : null;
  }
  return depth;
}

export function folderSubtreeHeight(
  tree: ServerFolderTree,
  folderId: string,
): number {
  const visited = new Set<string>();
  const dfs = (id: string): number => {
    if (visited.has(id)) return 1;
    visited.add(id);
    let maxChild = 0;
    for (const child of tree.children.get(id) ?? []) {
      maxChild = Math.max(maxChild, dfs(child.id));
    }
    return 1 + maxChild;
  };
  return dfs(folderId);
}

export function collectOwnedSubtreeIds(
  tree: ServerFolderTree,
  folderId: string,
): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const walk = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    result.push(id);
    for (const child of tree.children.get(id) ?? []) {
      walk(child.id);
    }
  };
  walk(folderId);
  return result;
}

export function collectOwnedAncestorIds(
  tree: ServerFolderTree,
  folderId: string,
): string[] {
  const ancestors: string[] = [];
  const visited = new Set<string>([folderId]);
  let cursor = tree.byId.get(folderId)?.parentId ?? null;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const node = tree.byId.get(cursor);
    if (!node) break;
    ancestors.push(node.id);
    cursor =
      node.parentId && tree.byId.has(node.parentId) ? node.parentId : null;
  }
  return ancestors;
}

export function formatOwnedFolderPath(
  byId: ReadonlyMap<string, Pick<OwnedFolderRow, "id" | "parentId" | "title">>,
  folderId: string | null,
): string {
  if (!folderId) return ROOT_FOLDER_LABEL;
  const segments: string[] = [];
  const visited = new Set<string>();
  let cursor: string | null = folderId;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const node = byId.get(cursor);
    if (!node) break;
    segments.push(node.title);
    cursor = node.parentId && byId.has(node.parentId) ? node.parentId : null;
  }
  return segments.length ? segments.reverse().join(" / ") : ROOT_FOLDER_LABEL;
}

export function assertValidFolderName(raw: string): string {
  const err = validateFolderTitle(raw);
  if (err) throw new AppError(400, err, "VALIDATION");
  return raw.trim();
}

/** Sanitize legacy / backup folder titles so they always satisfy Finder/Explorer folder rules. */
export function sanitizeLegacyFolderTitle(raw: string): string {
  const cleaned = raw
    .replace(/[/\\]/g, "／")
    .replace(/\p{Cc}/gu, "")
    .trim()
    .slice(0, 80);
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return "未命名文件夹";
  }
  return cleaned;
}

function findSiblingByLowerTitle(
  tree: ServerFolderTree,
  parentId: string | null,
  lowerTitle: string,
  excludeIds?: ReadonlySet<string>,
): OwnedFolderRow | undefined {
  for (const child of tree.children.get(parentId) ?? []) {
    if (excludeIds?.has(child.id)) continue;
    if (normalizeFolderTitleKey(child.title) === lowerTitle) return child;
  }
  return undefined;
}

function siblingLowerKeys(
  tree: ServerFolderTree,
  parentId: string | null,
  excludeIds?: ReadonlySet<string>,
): Set<string> {
  const keys = new Set<string>();
  for (const child of tree.children.get(parentId) ?? []) {
    if (excludeIds?.has(child.id)) continue;
    keys.add(normalizeFolderTitleKey(child.title));
  }
  return keys;
}

/** Calculate max additional depth below `targetId` after recursively merging `sourceId` into `targetId`. */
function mergedExtraDepth(
  tree: ServerFolderTree,
  sourceId: string,
  targetId: string,
): number {
  let maxExtra = 0;
  for (const srcChild of tree.children.get(sourceId) ?? []) {
    const match = findSiblingByLowerTitle(
      tree,
      targetId,
      normalizeFolderTitleKey(srcChild.title),
    );
    if (match) {
      maxExtra = Math.max(
        maxExtra,
        1 + mergedExtraDepth(tree, srcChild.id, match.id),
      );
    } else {
      maxExtra = Math.max(maxExtra, folderSubtreeHeight(tree, srcChild.id));
    }
  }
  return maxExtra;
}

/**
 * Recursively merge `sourceId` into existing `targetId` inside a user-locked tx.
 * Assumes callers either pre-locked affected `decks` then `questions` (via `options.prelocked`)
 * or lets this entry point acquire locks in canonical `decks ORDER BY id -> questions ORDER BY id` order.
 */
async function mergeFolderIntoLockedInTx(
  tx: DbTx,
  userId: string,
  tree: ServerFolderTree,
  sourceId: string,
  targetId: string,
  now: Date,
): Promise<void> {
  const srcChildren = [...(tree.children.get(sourceId) ?? [])];

  // Move all owned questions (active + trashed) from source to target.
  await tx
    .update(questions)
    .set({ deckId: targetId, updatedAt: now })
    .where(and(eq(questions.ownerId, userId), eq(questions.deckId, sourceId)));

  // Move all placed subscriptions from source to target.
  await tx
    .update(subscriptions)
    .set({ folderId: targetId })
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.folderId, sourceId),
      ),
    );

  // Recursively merge or re-parent child folders.
  for (const child of srcChildren) {
    const existingTargetChild = findSiblingByLowerTitle(
      tree,
      targetId,
      normalizeFolderTitleKey(child.title),
    );
    if (existingTargetChild) {
      await mergeFolderIntoLockedInTx(
        tx,
        userId,
        tree,
        child.id,
        existingTargetChild.id,
        now,
      );
    } else {
      await tx
        .update(decks)
        .set({ parentId: targetId, updatedAt: now })
        .where(eq(decks.id, child.id));
      // Keep in-memory tree synchronized for subsequent sibling checks.
      const updatedChild = { ...child, parentId: targetId, updatedAt: now };
      tree.byId.set(child.id, updatedChild);
      const tgtList = tree.children.get(targetId) ?? [];
      tgtList.push(updatedChild);
      tree.children.set(targetId, tgtList);
    }
  }
  tree.children.delete(sourceId);

  // Soft-delete source folder and detach its parent so sibling uniqueness slot is freed.
  const srcRow = tree.byId.get(sourceId);
  if (srcRow) {
    const oldParent = srcRow.parentId ?? null;
    tree.children.set(
      oldParent,
      (tree.children.get(oldParent) ?? []).filter((f) => f.id !== sourceId),
    );
    tree.byId.delete(sourceId);
  }
  await tx
    .update(decks)
    .set({ deletedAt: now, parentId: null, updatedAt: now })
    .where(eq(decks.id, sourceId));
  await tx.update(decks).set({ updatedAt: now }).where(eq(decks.id, targetId));
}

async function mergeFolderIntoInTx(
  tx: DbTx,
  userId: string,
  tree: ServerFolderTree,
  sourceId: string,
  targetId: string,
  now: Date,
  options: { prelocked?: boolean } = {},
): Promise<void> {
  if (!options.prelocked) {
    const sourceSubtree = collectOwnedSubtreeIds(tree, sourceId);
    const targetSubtree = collectOwnedSubtreeIds(tree, targetId);
    await lockOwnedFoldersById(tx, userId, [
      ...sourceSubtree,
      ...targetSubtree,
    ]);
    await lockOwnedQuestionsInFolders(tx, userId, sourceSubtree);
  }
  await mergeFolderIntoLockedInTx(tx, userId, tree, sourceId, targetId, now);
}

export async function createFolderInTx(
  tx: DbTx,
  userId: string,
  input: {
    title: string;
    parentId?: string | null;
    description?: string;
    color?: string;
  },
): Promise<OwnedFolderRow> {
  await lockUserTree(tx, userId);
  const title = assertValidFolderName(input.title);
  const parentId = input.parentId ?? null;
  const tree = buildServerFolderTree(await loadActiveOwnedFolders(tx, userId));

  if (parentId) {
    if (!tree.byId.has(parentId)) {
      throw new AppError(404, "目标父文件夹不存在或已删除。");
    }
    const parentDepth = folderDepth(tree, parentId);
    if (parentDepth + 1 > MAX_FOLDER_DEPTH) {
      throw new AppError(400, `文件夹最多支持 ${MAX_FOLDER_DEPTH} 层嵌套。`);
    }
  }

  const dup = findSiblingByLowerTitle(
    tree,
    parentId,
    normalizeFolderTitleKey(title),
  );
  if (dup) {
    throw new AppError(
      409,
      `当前位置已存在同名文件夹「${dup.title}」。`,
      "FOLDER_NAME_CONFLICT",
      {
        conflicts: [
          {
            sourceId: "",
            existingId: dup.id,
            title: dup.title,
            targetParentId: parentId,
          } satisfies FolderConflictItem,
        ],
      },
    );
  }

  if (parentId) {
    await lockOwnedFoldersById(tx, userId, [parentId]);
  }
  const now = new Date();
  const [created] = await tx
    .insert(decks)
    .values({
      id: crypto.randomUUID(),
      ownerId: userId,
      parentId,
      title,
      description: input.description ?? "",
      color: input.color ?? "sage",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return created;
}

export async function editFolderInTx(
  tx: DbTx,
  userId: string,
  input: {
    deckId: string;
    title: string;
    description: string;
    color?: string;
    expected: {
      title: string;
      description: string;
      color?: string;
    };
  },
): Promise<void> {
  await lockUserTree(tx, userId);
  const title = assertValidFolderName(input.title);
  const tree = buildServerFolderTree(await loadActiveOwnedFolders(tx, userId));
  const current = tree.byId.get(input.deckId);
  if (!current) {
    throw new AppError(404, "文件夹不存在或没有编辑权限。");
  }
  if (
    current.title !== input.expected.title ||
    current.description !== input.expected.description ||
    (input.expected.color !== undefined &&
      current.color !== input.expected.color)
  ) {
    throw new AppError(
      409,
      "文件夹信息已在其他页面更新，请刷新后重试。",
      "CONFLICT",
    );
  }

  const parentId =
    current.parentId && tree.byId.has(current.parentId)
      ? current.parentId
      : null;
  const dup = findSiblingByLowerTitle(
    tree,
    parentId,
    normalizeFolderTitleKey(title),
    new Set([current.id]),
  );
  if (dup) {
    throw new AppError(
      409,
      `同一目录下已存在同名文件夹「${dup.title}」。`,
      "FOLDER_NAME_CONFLICT",
      {
        conflicts: [
          {
            sourceId: current.id,
            existingId: dup.id,
            title: dup.title,
            targetParentId: parentId,
          } satisfies FolderConflictItem,
        ],
      },
    );
  }

  await lockOwnedFoldersById(tx, userId, [current.id]);
  await tx
    .update(decks)
    .set({
      title,
      description: input.description,
      ...(input.color ? { color: input.color } : {}),
      updatedAt: new Date(),
    })
    .where(eq(decks.id, current.id));
}

export async function moveFolderInTx(
  tx: DbTx,
  userId: string,
  input: {
    folderId: string;
    targetParentId: string | null;
    conflictStrategy?: FolderConflictStrategy;
  },
): Promise<{
  ok: true;
  folderId: string;
  mergedIntoId?: string;
  renamedTitle?: string;
}> {
  await lockUserTree(tx, userId);
  const strategy = input.conflictStrategy ?? "abort";
  const tree = buildServerFolderTree(await loadActiveOwnedFolders(tx, userId));
  const folder = tree.byId.get(input.folderId);
  if (!folder) {
    throw new AppError(404, "文件夹不存在或没有管理权限。");
  }
  const targetParentId = input.targetParentId ?? null;
  if (targetParentId) {
    if (!tree.byId.has(targetParentId)) {
      throw new AppError(404, "目标文件夹不存在或已删除。");
    }
    const subtreeSet = new Set(collectOwnedSubtreeIds(tree, folder.id));
    if (subtreeSet.has(targetParentId)) {
      throw new AppError(400, "不能将文件夹移动到自身或其子文件夹中。");
    }
  }

  const currentParentId =
    folder.parentId && tree.byId.has(folder.parentId) ? folder.parentId : null;
  if (currentParentId === targetParentId) {
    return { ok: true, folderId: folder.id };
  }

  const targetDepth = folderDepth(tree, targetParentId);
  const dup = findSiblingByLowerTitle(
    tree,
    targetParentId,
    normalizeFolderTitleKey(folder.title),
    new Set([folder.id]),
  );

  const now = new Date();

  if (dup) {
    if (strategy === "abort") {
      throw new AppError(
        409,
        `目标位置已存在同名文件夹「${dup.title}」。`,
        "FOLDER_NAME_CONFLICT",
        {
          conflicts: [
            {
              sourceId: folder.id,
              existingId: dup.id,
              title: dup.title,
              targetParentId,
            } satisfies FolderConflictItem,
          ],
        },
      );
    }
    if (strategy === "merge") {
      const mergedDepth =
        folderDepth(tree, dup.id) + mergedExtraDepth(tree, folder.id, dup.id);
      if (mergedDepth > MAX_FOLDER_DEPTH) {
        throw new AppError(
          400,
          `合并后文件夹层级将超过 ${MAX_FOLDER_DEPTH} 层上限。`,
        );
      }
      await mergeFolderIntoInTx(tx, userId, tree, folder.id, dup.id, now);
      return { ok: true, folderId: dup.id, mergedIntoId: dup.id };
    }
    // strategy === "keepBoth"
    const height = folderSubtreeHeight(tree, folder.id);
    if (targetDepth + height > MAX_FOLDER_DEPTH) {
      throw new AppError(
        400,
        `移动后文件夹层级将超过 ${MAX_FOLDER_DEPTH} 层上限。`,
      );
    }
    const nextTitle = resolveUniqueSiblingTitle(
      folder.title,
      siblingLowerKeys(tree, targetParentId, new Set([folder.id])),
    );
    await lockOwnedFoldersById(tx, userId, [folder.id, targetParentId]);
    await tx
      .update(decks)
      .set({ parentId: targetParentId, title: nextTitle, updatedAt: now })
      .where(eq(decks.id, folder.id));
    return { ok: true, folderId: folder.id, renamedTitle: nextTitle };
  }

  const height = folderSubtreeHeight(tree, folder.id);
  if (targetDepth + height > MAX_FOLDER_DEPTH) {
    throw new AppError(
      400,
      `移动后文件夹层级将超过 ${MAX_FOLDER_DEPTH} 层上限。`,
    );
  }

  await lockOwnedFoldersById(tx, userId, [folder.id, targetParentId]);
  await tx
    .update(decks)
    .set({ parentId: targetParentId, updatedAt: now })
    .where(eq(decks.id, folder.id));
  return { ok: true, folderId: folder.id };
}

export async function dissolveFolderInTx(
  tx: DbTx,
  userId: string,
  input: {
    folderId: string;
    conflictStrategy?: FolderConflictStrategy;
  },
): Promise<{
  ok: true;
  detached: number;
  liftedFolders: number;
  liftedSubscriptions: number;
  mergedFolders: number;
  duplicateWarnings: number;
}> {
  await lockUserTree(tx, userId);
  const strategy = input.conflictStrategy ?? "abort";
  const tree = buildServerFolderTree(await loadActiveOwnedFolders(tx, userId));
  const folder = tree.byId.get(input.folderId);
  if (!folder) {
    throw new AppError(404, "文件夹不存在或没有管理权限。");
  }

  const parentId =
    folder.parentId && tree.byId.has(folder.parentId) ? folder.parentId : null;
  const directChildren = [...(tree.children.get(folder.id) ?? [])];
  const excludeSelf = new Set([folder.id]);

  // Detect any child-folder name collisions in parentId (excluding folder itself since it's being dissolved).
  const conflicts: FolderConflictItem[] = [];
  for (const child of directChildren) {
    const match = findSiblingByLowerTitle(
      tree,
      parentId,
      normalizeFolderTitleKey(child.title),
      excludeSelf,
    );
    if (match) {
      conflicts.push({
        sourceId: child.id,
        existingId: match.id,
        title: match.title,
        targetParentId: parentId,
      });
    }
  }

  if (conflicts.length > 0 && strategy === "abort") {
    throw new AppError(
      409,
      `上级目录中已有 ${conflicts.length} 个同名文件夹（如「${conflicts[0].title}」）。`,
      "FOLDER_NAME_CONFLICT",
      { conflicts },
    );
  }

  if (conflicts.length > 0 && strategy === "merge") {
    for (const conflict of conflicts) {
      const mergedDepth =
        folderDepth(tree, conflict.existingId) +
        mergedExtraDepth(tree, conflict.sourceId, conflict.existingId);
      if (mergedDepth > MAX_FOLDER_DEPTH) {
        throw new AppError(
          400,
          `合并「${conflict.title}」后层级将超过 ${MAX_FOLDER_DEPTH} 层上限。`,
        );
      }
    }
  }

  const now = new Date();

  // Enforce global lock order: users (lockUserTree) -> decks (ORDER BY id) -> questions (ORDER BY id).
  const deckIdsToLock: (string | null)[] = [
    folder.id,
    parentId,
    ...directChildren.map((c) => c.id),
  ];
  const questionFolderIdsToLock: string[] = [folder.id];
  if (conflicts.length > 0 && strategy === "merge") {
    for (const conflict of conflicts) {
      const srcSubtree = collectOwnedSubtreeIds(tree, conflict.sourceId);
      const tgtSubtree = collectOwnedSubtreeIds(tree, conflict.existingId);
      deckIdsToLock.push(...srcSubtree, ...tgtSubtree);
      questionFolderIdsToLock.push(...srcSubtree);
    }
  }
  await lockOwnedFoldersById(tx, userId, deckIdsToLock);
  const lockedQuestions = await lockOwnedQuestionsInFolders(
    tx,
    userId,
    questionFolderIdsToLock,
  );

  // Check potential non-empty-answer duplicate warnings before lifting questions (never blocks/skips).
  const folderQuestions = lockedQuestions.filter((q) => q.deckId === folder.id);

  let duplicateWarnings = 0;
  const activeToLift = folderQuestions.filter((q) => !q.deletedAt);
  if (activeToLift.length) {
    const parentHashes = new Set(
      (
        await tx
          .select({ contentHash: questions.contentHash })
          .from(questions)
          .where(
            and(
              eq(questions.ownerId, userId),
              parentId
                ? eq(questions.deckId, parentId)
                : isNull(questions.deckId),
              isNull(questions.deletedAt),
            ),
          )
      ).map((r) => r.contentHash),
    );
    for (const q of activeToLift) {
      if (parentHashes.has(q.contentHash)) duplicateWarnings += 1;
      else parentHashes.add(q.contentHash);
    }
  }

  // 1. Soft-delete the dissolved folder FIRST (detaching parentId) so any child sharing the dissolved folder's own name can cleanly move up without hitting deck_sibling_title_uniq!
  await tx
    .update(decks)
    .set({ deletedAt: now, parentId: null, updatedAt: now })
    .where(eq(decks.id, folder.id));
  tree.byId.delete(folder.id);
  tree.children.set(
    parentId,
    (tree.children.get(parentId) ?? []).filter((f) => f.id !== folder.id),
  );

  // 2. Lift all questions (active + trashed) up one level to parentId.
  if (folderQuestions.length) {
    await tx
      .update(questions)
      .set({ deckId: parentId, updatedAt: now })
      .where(
        inArray(
          questions.id,
          folderQuestions.map((q) => q.id),
        ),
      );
  }

  // 3. Lift all placed subscriptions up one level to parentId.
  const liftedSubs = await tx
    .update(subscriptions)
    .set({ folderId: parentId })
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.folderId, folder.id),
      ),
    )
    .returning({ deckId: subscriptions.deckId });

  // 4. Lift direct child folders up one level to parentId with conflict handling.
  let mergedFolders = 0;
  let liftedFolders = 0;
  const conflictSourceIds = new Set(conflicts.map((c) => c.sourceId));
  const usedParentKeys = siblingLowerKeys(tree, parentId);
  // Reserve non-conflicting lifted sibling keys upfront so renaming a conflicting child
  // (e.g. "A" -> "A (2)") can never collide with another lifted child already named "A (2)".
  for (const child of directChildren) {
    if (!conflictSourceIds.has(child.id)) {
      usedParentKeys.add(normalizeFolderTitleKey(child.title));
    }
  }
  const parentChildrenList = [...(tree.children.get(parentId) ?? [])];
  tree.children.set(parentId, parentChildrenList);

  for (const child of directChildren) {
    const match = findSiblingByLowerTitle(
      tree,
      parentId,
      normalizeFolderTitleKey(child.title),
    );
    if (match && strategy === "merge") {
      await mergeFolderIntoInTx(tx, userId, tree, child.id, match.id, now, {
        prelocked: true,
      });
      mergedFolders += 1;
    } else if (match && strategy === "keepBoth") {
      const nextTitle = resolveUniqueSiblingTitle(child.title, usedParentKeys);
      usedParentKeys.add(normalizeFolderTitleKey(nextTitle));
      await tx
        .update(decks)
        .set({ parentId, title: nextTitle, updatedAt: now })
        .where(eq(decks.id, child.id));
      const updatedChild = {
        ...child,
        parentId,
        title: nextTitle,
        updatedAt: now,
      };
      tree.byId.set(child.id, updatedChild);
      tree.children.get(parentId)!.push(updatedChild);
      liftedFolders += 1;
    } else {
      usedParentKeys.add(normalizeFolderTitleKey(child.title));
      await tx
        .update(decks)
        .set({ parentId, updatedAt: now })
        .where(eq(decks.id, child.id));
      const updatedChild = { ...child, parentId, updatedAt: now };
      tree.byId.set(child.id, updatedChild);
      tree.children.get(parentId)!.push(updatedChild);
      liftedFolders += 1;
    }
  }

  return {
    ok: true,
    detached: folderQuestions.length,
    liftedFolders,
    liftedSubscriptions: liftedSubs.length,
    mergedFolders,
    duplicateWarnings,
  };
}

/** Delete folder subtree permanently (soft-deleting folder records, moving all subtree owned items to 30-day trash, lifting subscriptions safely). */
export async function deleteFolderToTrashInTx(
  tx: DbTx,
  userId: string,
  folderId: string,
): Promise<{
  ok: true;
  deletedFolders: number;
  trashedQuestions: number;
  liftedSubscriptions: number;
}> {
  await lockUserTree(tx, userId);
  const tree = buildServerFolderTree(await loadActiveOwnedFolders(tx, userId));
  const folder = tree.byId.get(folderId);
  if (!folder) {
    throw new AppError(404, "文件夹不存在或没有管理权限。");
  }
  const parentId =
    folder.parentId && tree.byId.has(folder.parentId) ? folder.parentId : null;
  const subtreeIds = collectOwnedSubtreeIds(tree, folder.id);
  const now = new Date();

  // Enforce global lock order: users (lockUserTree) -> decks (ORDER BY id) -> questions (ORDER BY id).
  await lockOwnedFoldersById(tx, userId, [...subtreeIds, parentId]);
  await lockOwnedQuestionsInFolders(tx, userId, subtreeIds);

  // Move any placed subscriptions inside the deleted subtree up to parentId (never lose user subscriptions).
  const liftedSubs = await tx
    .update(subscriptions)
    .set({ folderId: parentId })
    .where(
      and(
        eq(subscriptions.userId, userId),
        inArray(subscriptions.folderId, subtreeIds),
      ),
    )
    .returning({ deckId: subscriptions.deckId });

  // Move active owned questions in the subtree to 30-day trash (and point deckId to surviving parentId for clean restore).
  const trashed = await tx
    .update(questions)
    .set({ deletedAt: now, deckId: parentId, updatedAt: now })
    .where(
      and(
        eq(questions.ownerId, userId),
        inArray(questions.deckId, subtreeIds),
        isNull(questions.deletedAt),
        isNull(questions.purgedAt),
      ),
    )
    .returning({ id: questions.id });

  // Preserve original deletedAt on already-trashed items while detaching them from deleted folders.
  await tx
    .update(questions)
    .set({ deckId: parentId, updatedAt: now })
    .where(
      and(
        eq(questions.ownerId, userId),
        inArray(questions.deckId, subtreeIds),
        isNull(questions.purgedAt),
      ),
    );

  // Soft-delete all folders in the subtree (retaining publication identity for historical releases/subscribers).
  await tx
    .update(decks)
    .set({ deletedAt: now, parentId: null, updatedAt: now })
    .where(and(eq(decks.ownerId, userId), inArray(decks.id, subtreeIds)));

  return {
    ok: true,
    deletedFolders: subtreeIds.length,
    trashedQuestions: trashed.length,
    liftedSubscriptions: liftedSubs.length,
  };
}

export async function groupIntoNewFolderInTx(
  tx: DbTx,
  userId: string,
  input: {
    parentId: string | null;
    title: string;
    description?: string;
    color?: string;
    folderIds?: string[];
    questionIds?: string[];
    subscriptionDeckIds?: string[];
    conflictStrategy?: FolderConflictStrategy;
  },
): Promise<{
  ok: true;
  folder: OwnedFolderRow;
  movedFolders: number;
  movedQuestions: number;
  movedSubscriptions: number;
}> {
  await lockUserTree(tx, userId);
  const title = assertValidFolderName(input.title);
  const parentId = input.parentId ?? null;
  const strategy = input.conflictStrategy ?? "abort";
  const tree = buildServerFolderTree(await loadActiveOwnedFolders(tx, userId));

  if (parentId && !tree.byId.has(parentId)) {
    throw new AppError(404, "目标父文件夹不存在或已删除。");
  }

  const newDepth = folderDepth(tree, parentId) + 1;
  if (newDepth > MAX_FOLDER_DEPTH) {
    throw new AppError(400, `文件夹最多支持 ${MAX_FOLDER_DEPTH} 层嵌套。`);
  }

  const existingSibling = findSiblingByLowerTitle(
    tree,
    parentId,
    normalizeFolderTitleKey(title),
  );
  if (existingSibling) {
    throw new AppError(
      409,
      `当前位置已存在同名文件夹「${existingSibling.title}」。`,
      "FOLDER_NAME_CONFLICT",
      {
        conflictKind: "targetParent",
        conflicts: [
          {
            sourceId: "",
            existingId: existingSibling.id,
            title: existingSibling.title,
            targetParentId: parentId,
          } satisfies FolderConflictItem,
        ],
      },
    );
  }

  const uniqueFolderIds = [...new Set(input.folderIds ?? [])];
  const uniqueQuestionIds = [...new Set(input.questionIds ?? [])];
  const uniqueSubIds = [...new Set(input.subscriptionDeckIds ?? [])];
  const selectedFolderSet = new Set(uniqueFolderIds);

  // Validate all folders to move before creating anything.
  const folderRowsToMove: OwnedFolderRow[] = [];
  for (const fid of uniqueFolderIds) {
    const f = tree.byId.get(fid);
    if (!f) throw new AppError(404, "部分所选文件夹不存在或没有管理权限。");
    const subtreeIds = collectOwnedSubtreeIds(tree, f.id);
    if (parentId && subtreeIds.includes(parentId)) {
      throw new AppError(400, "不能将父文件夹归入其子目录中。");
    }
    if (subtreeIds.some((id) => id !== f.id && selectedFolderSet.has(id))) {
      throw new AppError(400, "不能同时选择父文件夹及其子文件夹。");
    }
    const height = folderSubtreeHeight(tree, f.id);
    if (newDepth + height > MAX_FOLDER_DEPTH) {
      throw new AppError(
        400,
        `「${f.title}」归入新文件夹后将超过 ${MAX_FOLDER_DEPTH} 层上限。`,
      );
    }
    folderRowsToMove.push(f);
  }

  // Enforce global lock order: users (lockUserTree) -> decks (ORDER BY id) -> questions (ORDER BY id).
  const decksToLock: (string | null)[] = [
    parentId,
    ...folderRowsToMove.flatMap((f) => collectOwnedSubtreeIds(tree, f.id)),
  ];
  await lockOwnedFoldersById(tx, userId, decksToLock);

  const mergeSourceFolderIds: string[] = [];
  if (strategy === "merge") {
    const seenKeys = new Set<string>();
    for (const f of folderRowsToMove) {
      const key = normalizeFolderTitleKey(f.title);
      if (seenKeys.has(key)) {
        mergeSourceFolderIds.push(...collectOwnedSubtreeIds(tree, f.id));
      } else {
        seenKeys.add(key);
      }
    }
  }

  // Lock & validate all selected questions (plus any merged-folder questions) in one deterministic pass.
  if (uniqueQuestionIds.length || mergeSourceFolderIds.length) {
    const lockedQs = await lockOwnedQuestionsByIdsOrFolders(tx, userId, {
      questionIds: uniqueQuestionIds,
      folderIds: mergeSourceFolderIds,
    });
    if (uniqueQuestionIds.length) {
      const activeIdSet = new Set(
        lockedQs.filter((q) => !q.deletedAt && !q.purgedAt).map((q) => q.id),
      );
      if (uniqueQuestionIds.some((id) => !activeIdSet.has(id))) {
        throw new AppError(404, "部分所选题目不存在或已删除。");
      }
    }
  }

  // Validate all selected subscriptions belong to user.
  if (uniqueSubIds.length) {
    const subRows = await tx
      .select({ deckId: subscriptions.deckId })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, userId),
          inArray(subscriptions.deckId, uniqueSubIds),
        ),
      );
    if (subRows.length !== uniqueSubIds.length) {
      throw new AppError(404, "部分所选订阅不存在。");
    }
  }

  // Create the new folder (parentId was already locked above before questions).
  const now = new Date();
  const [created] = await tx
    .insert(decks)
    .values({
      id: crypto.randomUUID(),
      ownerId: userId,
      parentId,
      title,
      description: input.description ?? "",
      color: input.color ?? "sage",
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  tree.byId.set(created.id, created);
  tree.children.set(created.id, []);
  const parentList = tree.children.get(parentId) ?? [];
  parentList.push(created);
  tree.children.set(parentId, parentList);

  const detachFromOldParent = (folderRow: OwnedFolderRow) => {
    const oldPid =
      folderRow.parentId && tree.byId.has(folderRow.parentId)
        ? folderRow.parentId
        : null;
    tree.children.set(
      oldPid,
      (tree.children.get(oldPid) ?? []).filter(
        (item) => item.id !== folderRow.id,
      ),
    );
  };

  // Move selected folders into the new folder (handling rare case where two selected folders from different parents share the same name).
  const usedInNew = new Set<string>();
  for (const f of folderRowsToMove) {
    const key = normalizeFolderTitleKey(f.title);
    if (usedInNew.has(key)) {
      const existing = findSiblingByLowerTitle(tree, created.id, key);
      if (existing && strategy === "merge") {
        const mergedDepth =
          folderDepth(tree, existing.id) +
          mergedExtraDepth(tree, f.id, existing.id);
        if (mergedDepth > MAX_FOLDER_DEPTH) {
          throw new AppError(
            400,
            `合并「${f.title}」后层级将超过 ${MAX_FOLDER_DEPTH} 层上限。`,
          );
        }
        await mergeFolderIntoInTx(tx, userId, tree, f.id, existing.id, now, {
          prelocked: true,
        });
        continue;
      }
      if (strategy === "abort") {
        throw new AppError(
          409,
          `所选文件夹中包含同名文件夹「${f.title}」。`,
          "FOLDER_NAME_CONFLICT",
          {
            conflictKind: "selectionDuplicate",
            conflicts: existing
              ? [
                  {
                    sourceId: f.id,
                    existingId: existing.id,
                    title: existing.title,
                    targetParentId: created.id,
                  } satisfies FolderConflictItem,
                ]
              : [],
          },
        );
      }
      const nextTitle = resolveUniqueSiblingTitle(f.title, usedInNew);
      usedInNew.add(normalizeFolderTitleKey(nextTitle));
      await tx
        .update(decks)
        .set({ parentId: created.id, title: nextTitle, updatedAt: now })
        .where(eq(decks.id, f.id));
      detachFromOldParent(f);
      const updated = {
        ...f,
        parentId: created.id,
        title: nextTitle,
        updatedAt: now,
      };
      tree.byId.set(f.id, updated);
      tree.children.get(created.id)!.push(updated);
    } else {
      usedInNew.add(key);
      await tx
        .update(decks)
        .set({ parentId: created.id, updatedAt: now })
        .where(eq(decks.id, f.id));
      detachFromOldParent(f);
      const updated = { ...f, parentId: created.id, updatedAt: now };
      tree.byId.set(f.id, updated);
      tree.children.get(created.id)!.push(updated);
    }
  }

  if (uniqueQuestionIds.length) {
    await tx
      .update(questions)
      .set({ deckId: created.id, updatedAt: now })
      .where(
        and(
          eq(questions.ownerId, userId),
          inArray(questions.id, uniqueQuestionIds),
        ),
      );
  }

  if (uniqueSubIds.length) {
    await tx
      .update(subscriptions)
      .set({ folderId: created.id })
      .where(
        and(
          eq(subscriptions.userId, userId),
          inArray(subscriptions.deckId, uniqueSubIds),
        ),
      );
  }

  return {
    ok: true,
    folder: created,
    movedFolders: folderRowsToMove.length,
    movedQuestions: uniqueQuestionIds.length,
    movedSubscriptions: uniqueSubIds.length,
  };
}

export async function placeSubscriptionInTx(
  tx: DbTx,
  userId: string,
  deckId: string,
  folderId: string | null,
): Promise<void> {
  if (folderId) {
    const [folder] = await lockOwnedFoldersById(tx, userId, [folderId]);
    if (!folder || folder.deletedAt) {
      throw new AppError(404, "目标文件夹不存在或没有访问权限。");
    }
  }
  const [updated] = await tx
    .update(subscriptions)
    .set({ folderId })
    .where(
      and(eq(subscriptions.userId, userId), eq(subscriptions.deckId, deckId)),
    )
    .returning({ deckId: subscriptions.deckId });
  if (!updated) throw new AppError(404, "未订阅该题库。");
}

/**
 * Find exact duplicate active owned questions for Global Soft Dedup notices.
 * - Non-empty answer: searches across entire account via `question_owner_hash_idx`.
 * - Empty answer: searches only within `deckId` (same folder).
 */
export async function findDuplicateHitsInTx(
  tx: Pick<Database, "select">,
  params: {
    userId: string;
    deckId: string | null;
    title: string;
    answer: string;
    excludeQuestionId?: string;
  },
): Promise<DuplicateHit[]> {
  const hash = contentHash(params.title, params.answer);
  const isBlank = !params.answer.trim();
  const rows = await tx
    .select({
      id: questions.id,
      title: questions.title,
      deckId: questions.deckId,
    })
    .from(questions)
    .where(
      and(
        eq(questions.ownerId, params.userId),
        eq(questions.contentHash, hash),
        isNull(questions.deletedAt),
        isNull(questions.purgedAt),
        params.excludeQuestionId
          ? ne(questions.id, params.excludeQuestionId)
          : undefined,
        isBlank
          ? params.deckId
            ? eq(questions.deckId, params.deckId)
            : isNull(questions.deckId)
          : undefined,
      ),
    )
    .limit(10);

  if (!rows.length) return [];
  const folders = await loadActiveOwnedFolders(tx, params.userId);
  const byId = new Map(folders.map((f) => [f.id, f]));
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    deckId: row.deckId,
    path: formatOwnedFolderPath(byId, row.deckId),
    scope: row.deckId === params.deckId ? "sameFolder" : "global",
  }));
}

/**
 * Ensure a relative folder chain exists under `baseFolderId` inside a user-locked transaction.
 * Reuses existing case-insensitive matching folders and creates missing ones atomically.
 */
export async function ensureRelativeFolderPathInTx(
  tx: DbTx,
  userId: string,
  tree: ServerFolderTree,
  baseFolderId: string | null,
  segments: readonly string[],
  defaultColor = "sage",
): Promise<{
  folderId: string | null;
  createdCount: number;
  reusedCount: number;
}> {
  if (!segments.length) {
    return { folderId: baseFolderId, createdCount: 0, reusedCount: 0 };
  }
  const baseDepth = folderDepth(tree, baseFolderId);
  if (baseDepth + segments.length > MAX_FOLDER_DEPTH) {
    throw new AppError(
      400,
      `目录「${segments.join("/")}」导入后超过 ${MAX_FOLDER_DEPTH} 层嵌套上限。`,
    );
  }
  let cursor = baseFolderId;
  let createdCount = 0;
  let reusedCount = 0;
  const now = new Date();

  for (const rawSeg of segments) {
    const seg = assertValidFolderName(rawSeg);
    const existing = findSiblingByLowerTitle(
      tree,
      cursor,
      normalizeFolderTitleKey(seg),
    );
    if (existing) {
      cursor = existing.id;
      reusedCount += 1;
      continue;
    }
    const [inserted] = await tx
      .insert(decks)
      .values({
        id: crypto.randomUUID(),
        ownerId: userId,
        parentId: cursor,
        title: seg,
        description: "",
        color: defaultColor,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    tree.byId.set(inserted.id, inserted);
    const list = tree.children.get(cursor) ?? [];
    list.push(inserted);
    tree.children.set(cursor, list);
    tree.children.set(inserted.id, []);
    cursor = inserted.id;
    createdCount += 1;
  }
  return { folderId: cursor, createdCount, reusedCount };
}
