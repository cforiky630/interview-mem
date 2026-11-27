import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { conceptFolders, concepts, studyCards } from "@/db/schema";
import {
  CONCEPT_ROOT_LABEL,
  MAX_CONCEPTS,
  MAX_CONCEPT_DEFINITION_LENGTH,
  MAX_CONCEPT_TERM_LENGTH,
  findMatchingConcept,
  normalizeConceptAliases,
  normalizeConceptKey,
  recomputeConceptFolderState,
  sortConceptsNatural,
} from "@/lib/concepts";
import {
  MAX_FOLDER_DEPTH,
  compareNaturalNames,
  normalizeFolderTitleKey,
  resolveUniqueSiblingTitle,
} from "@/lib/folders";
import type {
  ConceptFolderView,
  ConceptView,
  FolderConflictItem,
  FolderConflictStrategy,
  QuestionAnnotation,
  QuestionAnnotationColor,
} from "@/lib/types";
import { AppError } from "./errors";
import {
  assertValidFolderName,
  lockUserTree,
  sanitizeLegacyFolderTitle,
  type DbTx,
} from "./folders";
import { accessibleQuestion } from "./workspace";

export type ConceptRow = typeof concepts.$inferSelect;
export type ConceptFolderRow = typeof conceptFolders.$inferSelect;

type ServerConceptFolderTree = {
  rows: ConceptFolderRow[];
  byId: Map<string, ConceptFolderRow>;
  children: Map<string | null, ConceptFolderRow[]>;
};

function nextMonotonicTimestamp(prev?: Date | null): Date {
  const now = Date.now();
  const prevMs = prev ? prev.getTime() : 0;
  return new Date(Math.max(now, prevMs + 1));
}

function buildServerConceptFolderTree(
  rows: readonly ConceptFolderRow[],
): ServerConceptFolderTree {
  const byId = new Map<string, ConceptFolderRow>();
  for (const row of rows) byId.set(row.id, row);
  const children = new Map<string | null, ConceptFolderRow[]>();
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

function conceptFolderDepth(
  tree: ServerConceptFolderTree,
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

function conceptFolderSubtreeHeight(
  tree: ServerConceptFolderTree,
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

function collectConceptSubtreeIds(
  tree: ServerConceptFolderTree,
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

function findConceptSiblingByLowerTitle(
  tree: ServerConceptFolderTree,
  parentId: string | null,
  lowerTitle: string,
  excludeIds?: ReadonlySet<string>,
): ConceptFolderRow | undefined {
  for (const child of tree.children.get(parentId) ?? []) {
    if (excludeIds?.has(child.id)) continue;
    if (normalizeFolderTitleKey(child.title) === lowerTitle) return child;
  }
  return undefined;
}

function conceptSiblingLowerKeys(
  tree: ServerConceptFolderTree,
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

function conceptMergedExtraDepth(
  tree: ServerConceptFolderTree,
  sourceId: string,
  targetId: string,
): number {
  let maxExtra = 0;
  for (const srcChild of tree.children.get(sourceId) ?? []) {
    const match = findConceptSiblingByLowerTitle(
      tree,
      targetId,
      normalizeFolderTitleKey(srcChild.title),
    );
    if (match) {
      maxExtra = Math.max(
        maxExtra,
        1 + conceptMergedExtraDepth(tree, srcChild.id, match.id),
      );
    } else {
      maxExtra = Math.max(
        maxExtra,
        conceptFolderSubtreeHeight(tree, srcChild.id),
      );
    }
  }
  return maxExtra;
}

export function formatServerConceptFolderPath(
  byId: ReadonlyMap<
    string,
    Pick<ConceptFolderRow, "id" | "parentId" | "title">
  >,
  folderId: string | null | undefined,
): string {
  if (!folderId) return CONCEPT_ROOT_LABEL;
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
  return segments.length ? segments.reverse().join(" / ") : CONCEPT_ROOT_LABEL;
}

export function toConceptView(
  row: ConceptRow,
  folderById?: ReadonlyMap<
    string,
    Pick<ConceptFolderRow, "id" | "parentId" | "title">
  >,
): ConceptView {
  const validFolderId =
    row.folderId && (!folderById || folderById.has(row.folderId))
      ? row.folderId
      : null;
  const folder = validFolderId ? folderById?.get(validFolderId) : undefined;
  const folderPath = validFolderId && folderById
    ? formatServerConceptFolderPath(folderById, validFolderId)
    : CONCEPT_ROOT_LABEL;
  return {
    id: row.id,
    term: row.term,
    aliases: Array.isArray(row.aliases) ? row.aliases : [],
    normalizedKey: row.normalizedKey,
    definition: row.definition,
    folderId: validFolderId,
    folderPath,
    groupName: folder ? folder.title : validFolderId ? row.groupName : "",
    color: row.color,
    sourceQuestionId: row.sourceQuestionId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRawConceptFolderView(row: ConceptFolderRow): ConceptFolderView {
  return {
    id: row.id,
    parentId: row.parentId ?? null,
    title: row.title,
    color: row.color,
    count: 0,
    directCount: 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function loadUserConceptSnapshotInTx(
  tx: DbTx,
  userId: string,
): Promise<{ conceptFolders: ConceptFolderView[]; concepts: ConceptView[] }> {
  const [folderRows, conceptRows] = await Promise.all([
    tx
      .select()
      .from(conceptFolders)
      .where(eq(conceptFolders.userId, userId)),
    tx.select().from(concepts).where(eq(concepts.userId, userId)),
  ]);
  const folderById = new Map(folderRows.map((f) => [f.id, f]));
  const rawFolders = folderRows.map(toRawConceptFolderView);
  const rawConcepts = conceptRows.map((c) => toConceptView(c, folderById));
  return recomputeConceptFolderState(rawFolders, rawConcepts);
}

export async function listConcepts(userId: string): Promise<ConceptView[]> {
  const db = await getDb();
  const [folderRows, conceptRows] = await Promise.all([
    db
      .select()
      .from(conceptFolders)
      .where(eq(conceptFolders.userId, userId)),
    db.select().from(concepts).where(eq(concepts.userId, userId)),
  ]);
  const folderById = new Map(folderRows.map((f) => [f.id, f]));
  return sortConceptsNatural(
    conceptRows.map((row) => toConceptView(row, folderById)),
  );
}

async function resolveFolderTargetInTx(
  tx: DbTx,
  userId: string,
  tree: ServerConceptFolderTree,
  input: { folderId?: string | null; groupName?: string },
): Promise<{
  folderId: string | null;
  groupName: string;
  createdFolder: ConceptFolderRow | null;
}> {
  if (input.folderId !== undefined) {
    if (input.folderId === null) {
      return { folderId: null, groupName: "", createdFolder: null };
    }
    const target = tree.byId.get(input.folderId);
    if (!target) {
      throw new AppError(404, "目标概念文件夹不存在或已删除。");
    }
    return {
      folderId: target.id,
      groupName: target.title,
      createdFolder: null,
    };
  }

  const rawGroup = (input.groupName ?? "").trim();
  if (!rawGroup) {
    return { folderId: null, groupName: "", createdFolder: null };
  }

  const sanitized = sanitizeLegacyFolderTitle(rawGroup);
  const key = normalizeFolderTitleKey(sanitized);
  const existing = findConceptSiblingByLowerTitle(tree, null, key);
  if (existing) {
    return {
      folderId: existing.id,
      groupName: existing.title,
      createdFolder: null,
    };
  }

  const now = new Date();
  const [created] = await tx
    .insert(conceptFolders)
    .values({
      id: crypto.randomUUID(),
      userId,
      parentId: null,
      title: sanitized,
      color: "sage",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  tree.byId.set(created.id, created);
  const rootList = tree.children.get(null) ?? [];
  rootList.push(created);
  tree.children.set(null, rootList);
  tree.children.set(created.id, []);
  return {
    folderId: created.id,
    groupName: created.title,
    createdFolder: created,
  };
}

/**
 * Sync linked `study_cards.annotations` entries for one or more concepts inside an active
 * transaction that ALREADY holds `lockUserTree(tx, userId)`.
 */
export async function syncLinkedAnnotationsInTx(
  tx: DbTx,
  userId: string,
  conceptIds: string | readonly string[],
  patch: {
    comment?: string;
    color?: QuestionAnnotationColor;
    unlink?: boolean;
  },
  excludeQuestionId?: string,
): Promise<void> {
  const idSet = new Set(
    typeof conceptIds === "string" ? [conceptIds] : conceptIds,
  );
  if (!idSet.size) return;

  const conceptFilter =
    idSet.size <= 20
      ? or(
          ...[...idSet].map(
            (cid) =>
              sql`${studyCards.annotations} @> ${JSON.stringify([{ conceptId: cid }])}::jsonb`,
          ),
        )
      : sql`jsonb_array_length(${studyCards.annotations}) > 0`;

  const cards = await tx
    .select({
      questionId: studyCards.questionId,
      annotations: studyCards.annotations,
    })
    .from(studyCards)
    .where(and(eq(studyCards.userId, userId), conceptFilter))
    .orderBy(asc(studyCards.questionId))
    .for("update");

  const now = new Date();
  const nowIso = now.toISOString();
  const nextComment =
    patch.comment !== undefined ? patch.comment.slice(0, 2000) : undefined;

  for (const card of cards) {
    if (excludeQuestionId && card.questionId === excludeQuestionId) continue;
    const list: QuestionAnnotation[] = Array.isArray(card.annotations)
      ? card.annotations
      : [];
    let changed = false;
    const nextList = list.map((item) => {
      if (!item.conceptId || !idSet.has(item.conceptId)) return item;
      changed = true;
      if (patch.unlink) {
        return {
          ...item,
          conceptId: null,
          updatedAt: nowIso,
        };
      }
      return {
        ...item,
        ...(nextComment !== undefined ? { comment: nextComment } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        updatedAt: nowIso,
      };
    });
    if (!changed) continue;
    await tx
      .update(studyCards)
      .set({
        annotations: nextList,
        annotationsVersion: sql`${studyCards.annotationsVersion} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(studyCards.userId, userId),
          eq(studyCards.questionId, card.questionId),
        ),
      );
  }
}

export async function createConcept(
  userId: string,
  input: {
    term: string;
    definition: string;
    aliases?: string[];
    folderId?: string | null;
    groupName?: string;
    color?: QuestionAnnotationColor;
    sourceQuestionId?: string | null;
  },
): Promise<{ concept: ConceptView; folder: ConceptFolderView | null }> {
  const term = input.term.trim();
  const normalizedKey = normalizeConceptKey(term);
  if (!term || !normalizedKey) {
    throw new AppError(400, "概念名称不能为空或仅包含分隔符号。");
  }
  const definition = input.definition.trim();
  if (!definition) {
    throw new AppError(400, "请输入概念释义。");
  }
  const color: QuestionAnnotationColor = input.color ?? "accent";
  const aliases = normalizeConceptAliases(input.aliases ?? [], term);
  const sourceQuestionId = input.sourceQuestionId ?? null;

  if (sourceQuestionId) {
    await accessibleQuestion(userId, sourceQuestionId);
  }

  const db = await getDb();
  return db.transaction(async (tx) => {
    await lockUserTree(tx, userId);

    const [folderRows, existingRows] = await Promise.all([
      tx
        .select()
        .from(conceptFolders)
        .where(eq(conceptFolders.userId, userId)),
      tx.select().from(concepts).where(eq(concepts.userId, userId)),
    ]);
    const tree = buildServerConceptFolderTree(folderRows);

    const duplicate = existingRows.find(
      (row) => row.normalizedKey === normalizedKey,
    );
    if (duplicate) {
      throw new AppError(
        409,
        `概念「${duplicate.term}」已存在。`,
        "CONCEPT_EXISTS",
        { existing: toConceptView(duplicate, tree.byId) },
      );
    }

    if (existingRows.length >= MAX_CONCEPTS) {
      throw new AppError(400, `概念库最多保存 ${MAX_CONCEPTS} 条概念。`);
    }

    const target = await resolveFolderTargetInTx(tx, userId, tree, {
      folderId: input.folderId,
      groupName: input.groupName,
    });

    const now = new Date();
    const [inserted] = await tx
      .insert(concepts)
      .values({
        id: crypto.randomUUID(),
        userId,
        folderId: target.folderId,
        term,
        aliases,
        normalizedKey,
        definition,
        groupName: target.groupName,
        color,
        sourceQuestionId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return {
      concept: toConceptView(inserted, tree.byId),
      folder: target.createdFolder
        ? {
            ...toRawConceptFolderView(target.createdFolder),
            count: 1,
            directCount: 1,
          }
        : null,
    };
  });
}

export async function editConcept(
  userId: string,
  input: {
    id: string;
    term?: string;
    definition?: string;
    aliases?: string[];
    folderId?: string | null;
    groupName?: string;
    color?: QuestionAnnotationColor;
  },
): Promise<{ concept: ConceptView; folder: ConceptFolderView | null }> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    await lockUserTree(tx, userId);

    const [folderRows, existingRows] = await Promise.all([
      tx
        .select()
        .from(conceptFolders)
        .where(eq(conceptFolders.userId, userId)),
      tx.select().from(concepts).where(eq(concepts.userId, userId)),
    ]);
    const tree = buildServerConceptFolderTree(folderRows);

    const current = existingRows.find((row) => row.id === input.id);
    if (!current) {
      throw new AppError(404, "概念不存在或已删除。");
    }

    const nextTerm =
      input.term !== undefined ? input.term.trim() : current.term;
    const nextNormalizedKey = normalizeConceptKey(nextTerm);
    if (!nextTerm || !nextNormalizedKey) {
      throw new AppError(400, "概念名称不能为空或仅包含分隔符号。");
    }

    if (nextNormalizedKey !== current.normalizedKey) {
      const duplicate = existingRows.find(
        (row) => row.id !== current.id && row.normalizedKey === nextNormalizedKey,
      );
      if (duplicate) {
        throw new AppError(
          409,
          `概念「${duplicate.term}」已存在。`,
          "CONCEPT_EXISTS",
          { existing: toConceptView(duplicate, tree.byId) },
        );
      }
    }

    const nextDefinition =
      input.definition !== undefined
        ? input.definition.trim()
        : current.definition;
    if (!nextDefinition) {
      throw new AppError(400, "请输入概念释义。");
    }

    let nextFolderId = current.folderId ?? null;
    let nextGroupName =
      nextFolderId && tree.byId.has(nextFolderId)
        ? tree.byId.get(nextFolderId)!.title
        : "";
    let createdFolder: ConceptFolderRow | null = null;

    if (input.folderId !== undefined || input.groupName !== undefined) {
      const resolved = await resolveFolderTargetInTx(tx, userId, tree, {
        folderId: input.folderId,
        groupName: input.groupName,
      });
      nextFolderId = resolved.folderId;
      nextGroupName = resolved.groupName;
      createdFolder = resolved.createdFolder;
    }

    const nextColor: QuestionAnnotationColor = input.color ?? current.color;
    const nextAliases =
      input.aliases !== undefined
        ? normalizeConceptAliases(input.aliases, nextTerm)
        : normalizeConceptAliases(current.aliases, nextTerm);
    const updatedAt = nextMonotonicTimestamp(current.updatedAt);

    const [updated] = await tx
      .update(concepts)
      .set({
        folderId: nextFolderId,
        term: nextTerm,
        aliases: nextAliases,
        normalizedKey: nextNormalizedKey,
        definition: nextDefinition,
        groupName: nextGroupName,
        color: nextColor,
        updatedAt,
      })
      .where(and(eq(concepts.id, current.id), eq(concepts.userId, userId)))
      .returning();

    if (
      nextDefinition !== current.definition ||
      nextColor !== current.color
    ) {
      await syncLinkedAnnotationsInTx(tx, userId, current.id, {
        comment: nextDefinition,
        color: nextColor,
      });
    }

    return {
      concept: toConceptView(updated, tree.byId),
      folder: createdFolder
        ? { ...toRawConceptFolderView(createdFolder), count: 1, directCount: 1 }
        : null,
    };
  });
}

export async function deleteConcept(
  userId: string,
  id: string,
): Promise<{ ok: true; id: string }> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    await lockUserTree(tx, userId);

    const deleted = await tx
      .delete(concepts)
      .where(and(eq(concepts.id, id), eq(concepts.userId, userId)))
      .returning({ id: concepts.id });

    if (!deleted.length) {
      throw new AppError(404, "概念不存在或已删除。");
    }

    await syncLinkedAnnotationsInTx(tx, userId, id, { unlink: true });

    return { ok: true, id };
  });
}

export async function moveConceptsToFolder(
  userId: string,
  ids: string[],
  folderId: string | null,
): Promise<{
  ok: true;
  updated: number;
  folderId: string | null;
  folderPath: string;
  groupName: string;
}> {
  const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (!uniqueIds.length) {
    return {
      ok: true,
      updated: 0,
      folderId: null,
      folderPath: CONCEPT_ROOT_LABEL,
      groupName: "",
    };
  }

  const db = await getDb();
  return db.transaction(async (tx) => {
    await lockUserTree(tx, userId);

    const folderRows = await tx
      .select()
      .from(conceptFolders)
      .where(eq(conceptFolders.userId, userId));
    const tree = buildServerConceptFolderTree(folderRows);

    let groupName = "";
    if (folderId !== null) {
      const target = tree.byId.get(folderId);
      if (!target) {
        throw new AppError(404, "目标概念文件夹不存在或已删除。");
      }
      groupName = target.title;
    }

    const existing = await tx
      .select({ id: concepts.id, updatedAt: concepts.updatedAt })
      .from(concepts)
      .where(and(eq(concepts.userId, userId), inArray(concepts.id, uniqueIds)));
    if (!existing.length) {
      return {
        ok: true,
        updated: 0,
        folderId,
        folderPath: formatServerConceptFolderPath(tree.byId, folderId),
        groupName,
      };
    }

    const maxPrev = existing.reduce<Date | null>(
      (acc, r) => (!acc || r.updatedAt > acc ? r.updatedAt : acc),
      null,
    );
    const updatedAt = nextMonotonicTimestamp(maxPrev);
    const updated = await tx
      .update(concepts)
      .set({ folderId, groupName, updatedAt })
      .where(and(eq(concepts.userId, userId), inArray(concepts.id, uniqueIds)))
      .returning({ id: concepts.id });

    return {
      ok: true,
      updated: updated.length,
      folderId,
      folderPath: formatServerConceptFolderPath(tree.byId, folderId),
      groupName,
    };
  });
}

async function mergeConceptFolderIntoInTx(
  tx: DbTx,
  userId: string,
  tree: ServerConceptFolderTree,
  sourceId: string,
  targetId: string,
  now: Date,
): Promise<void> {
  const targetRow = tree.byId.get(targetId);
  const targetTitle = targetRow?.title ?? "";
  const srcChildren = [...(tree.children.get(sourceId) ?? [])];

  // Move all direct concepts from sourceId into targetId.
  await tx
    .update(concepts)
    .set({ folderId: targetId, groupName: targetTitle, updatedAt: now })
    .where(and(eq(concepts.userId, userId), eq(concepts.folderId, sourceId)));

  // Recursively merge or re-parent child folders.
  for (const child of srcChildren) {
    const existingTargetChild = findConceptSiblingByLowerTitle(
      tree,
      targetId,
      normalizeFolderTitleKey(child.title),
    );
    if (existingTargetChild) {
      await mergeConceptFolderIntoInTx(
        tx,
        userId,
        tree,
        child.id,
        existingTargetChild.id,
        now,
      );
    } else {
      await tx
        .update(conceptFolders)
        .set({ parentId: targetId, updatedAt: now })
        .where(eq(conceptFolders.id, child.id));
      const updatedChild = { ...child, parentId: targetId, updatedAt: now };
      tree.byId.set(child.id, updatedChild);
      const tgtList = tree.children.get(targetId) ?? [];
      tgtList.push(updatedChild);
      tree.children.set(targetId, tgtList);
    }
  }
  tree.children.delete(sourceId);

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
    .delete(conceptFolders)
    .where(
      and(eq(conceptFolders.id, sourceId), eq(conceptFolders.userId, userId)),
    );
  await tx
    .update(conceptFolders)
    .set({ updatedAt: now })
    .where(eq(conceptFolders.id, targetId));
}

export async function createConceptFolder(
  userId: string,
  input: {
    parentId?: string | null;
    title: string;
    color?: string;
  },
): Promise<{ ok: true; folder: ConceptFolderView }> {
  const title = assertValidFolderName(input.title);
  const parentId = input.parentId ?? null;
  const color = input.color ?? "sage";

  const db = await getDb();
  return db.transaction(async (tx) => {
    await lockUserTree(tx, userId);

    const rows = await tx
      .select()
      .from(conceptFolders)
      .where(eq(conceptFolders.userId, userId));
    const tree = buildServerConceptFolderTree(rows);

    if (parentId) {
      if (!tree.byId.has(parentId)) {
        throw new AppError(404, "目标父文件夹不存在或已删除。");
      }
      if (conceptFolderDepth(tree, parentId) + 1 > MAX_FOLDER_DEPTH) {
        throw new AppError(400, `文件夹最多支持 ${MAX_FOLDER_DEPTH} 层嵌套。`);
      }
    }

    const dup = findConceptSiblingByLowerTitle(
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

    const now = new Date();
    const [created] = await tx
      .insert(conceptFolders)
      .values({
        id: crypto.randomUUID(),
        userId,
        parentId,
        title,
        color,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return { ok: true, folder: toRawConceptFolderView(created) };
  });
}

export async function editConceptFolder(
  userId: string,
  input: {
    id: string;
    title: string;
    color?: string;
  },
): Promise<{ ok: true; folder: ConceptFolderView }> {
  const title = assertValidFolderName(input.title);

  const db = await getDb();
  return db.transaction(async (tx) => {
    await lockUserTree(tx, userId);

    const rows = await tx
      .select()
      .from(conceptFolders)
      .where(eq(conceptFolders.userId, userId));
    const tree = buildServerConceptFolderTree(rows);

    const current = tree.byId.get(input.id);
    if (!current) {
      throw new AppError(404, "文件夹不存在或没有编辑权限。");
    }

    const parentId =
      current.parentId && tree.byId.has(current.parentId)
        ? current.parentId
        : null;
    const dup = findConceptSiblingByLowerTitle(
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

    const updatedAt = nextMonotonicTimestamp(current.updatedAt);
    await tx
      .update(conceptFolders)
      .set({
        title,
        ...(input.color ? { color: input.color } : {}),
        updatedAt,
      })
      .where(
        and(eq(conceptFolders.id, current.id), eq(conceptFolders.userId, userId)),
      );

    if (title !== current.title) {
      await tx
        .update(concepts)
        .set({ groupName: title, updatedAt })
        .where(
          and(eq(concepts.userId, userId), eq(concepts.folderId, current.id)),
        );
    }

    const snapshot = await loadUserConceptSnapshotInTx(tx, userId);
    const folder = snapshot.conceptFolders.find((f) => f.id === current.id)!;
    return { ok: true, folder };
  });
}

export async function moveConceptFolder(
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
  conceptFolders: ConceptFolderView[];
  concepts: ConceptView[];
}> {
  const strategy = input.conflictStrategy ?? "abort";
  const targetParentId = input.targetParentId ?? null;

  const db = await getDb();
  return db.transaction(async (tx) => {
    await lockUserTree(tx, userId);

    const rows = await tx
      .select()
      .from(conceptFolders)
      .where(eq(conceptFolders.userId, userId));
    const tree = buildServerConceptFolderTree(rows);

    const folder = tree.byId.get(input.folderId);
    if (!folder) {
      throw new AppError(404, "文件夹不存在或没有管理权限。");
    }

    if (targetParentId) {
      if (!tree.byId.has(targetParentId)) {
        throw new AppError(404, "目标文件夹不存在或已删除。");
      }
      const subtreeSet = new Set(collectConceptSubtreeIds(tree, folder.id));
      if (subtreeSet.has(targetParentId)) {
        throw new AppError(400, "不能将文件夹移动到自身或其子文件夹中。");
      }
    }

    const currentParentId =
      folder.parentId && tree.byId.has(folder.parentId)
        ? folder.parentId
        : null;
    if (currentParentId === targetParentId) {
      const snapshot = await loadUserConceptSnapshotInTx(tx, userId);
      return {
        ok: true,
        folderId: folder.id,
        conceptFolders: snapshot.conceptFolders,
        concepts: snapshot.concepts,
      };
    }

    const targetDepth = conceptFolderDepth(tree, targetParentId);
    const dup = findConceptSiblingByLowerTitle(
      tree,
      targetParentId,
      normalizeFolderTitleKey(folder.title),
      new Set([folder.id]),
    );
    const now = nextMonotonicTimestamp(folder.updatedAt);

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
          conceptFolderDepth(tree, dup.id) +
          conceptMergedExtraDepth(tree, folder.id, dup.id);
        if (mergedDepth > MAX_FOLDER_DEPTH) {
          throw new AppError(
            400,
            `合并后文件夹层级将超过 ${MAX_FOLDER_DEPTH} 层上限。`,
          );
        }
        await mergeConceptFolderIntoInTx(tx, userId, tree, folder.id, dup.id, now);
        const snapshot = await loadUserConceptSnapshotInTx(tx, userId);
        return {
          ok: true,
          folderId: dup.id,
          mergedIntoId: dup.id,
          conceptFolders: snapshot.conceptFolders,
          concepts: snapshot.concepts,
        };
      }

      // keepBoth
      const height = conceptFolderSubtreeHeight(tree, folder.id);
      if (targetDepth + height > MAX_FOLDER_DEPTH) {
        throw new AppError(
          400,
          `移动后文件夹层级将超过 ${MAX_FOLDER_DEPTH} 层上限。`,
        );
      }
      const nextTitle = resolveUniqueSiblingTitle(
        folder.title,
        conceptSiblingLowerKeys(tree, targetParentId, new Set([folder.id])),
      );
      await tx
        .update(conceptFolders)
        .set({ parentId: targetParentId, title: nextTitle, updatedAt: now })
        .where(eq(conceptFolders.id, folder.id));
      await tx
        .update(concepts)
        .set({ groupName: nextTitle, updatedAt: now })
        .where(and(eq(concepts.userId, userId), eq(concepts.folderId, folder.id)));
      const snapshot = await loadUserConceptSnapshotInTx(tx, userId);
      return {
        ok: true,
        folderId: folder.id,
        renamedTitle: nextTitle,
        conceptFolders: snapshot.conceptFolders,
        concepts: snapshot.concepts,
      };
    }

    const height = conceptFolderSubtreeHeight(tree, folder.id);
    if (targetDepth + height > MAX_FOLDER_DEPTH) {
      throw new AppError(
        400,
        `移动后文件夹层级将超过 ${MAX_FOLDER_DEPTH} 层上限。`,
      );
    }

    await tx
      .update(conceptFolders)
      .set({ parentId: targetParentId, updatedAt: now })
      .where(eq(conceptFolders.id, folder.id));
    const snapshot = await loadUserConceptSnapshotInTx(tx, userId);
    return {
      ok: true,
      folderId: folder.id,
      conceptFolders: snapshot.conceptFolders,
      concepts: snapshot.concepts,
    };
  });
}

export async function groupIntoNewConceptFolder(
  userId: string,
  input: {
    parentId?: string | null;
    title: string;
    color?: string;
    folderIds?: string[];
    conceptIds?: string[];
    conflictStrategy?: FolderConflictStrategy;
  },
): Promise<{
  ok: true;
  folder: ConceptFolderView;
  movedFolders: number;
  movedConcepts: number;
  conceptFolders: ConceptFolderView[];
  concepts: ConceptView[];
}> {
  const title = assertValidFolderName(input.title);
  const parentId = input.parentId ?? null;
  const strategy = input.conflictStrategy ?? "abort";
  const color = input.color ?? "sage";

  const db = await getDb();
  return db.transaction(async (tx) => {
    await lockUserTree(tx, userId);

    const rows = await tx
      .select()
      .from(conceptFolders)
      .where(eq(conceptFolders.userId, userId));
    const tree = buildServerConceptFolderTree(rows);

    if (parentId && !tree.byId.has(parentId)) {
      throw new AppError(404, "目标父文件夹不存在或已删除。");
    }

    const newDepth = conceptFolderDepth(tree, parentId) + 1;
    if (newDepth > MAX_FOLDER_DEPTH) {
      throw new AppError(400, `文件夹最多支持 ${MAX_FOLDER_DEPTH} 层嵌套。`);
    }

    const existingSibling = findConceptSiblingByLowerTitle(
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
    const uniqueConceptIds = [...new Set(input.conceptIds ?? [])];
    const selectedFolderSet = new Set(uniqueFolderIds);

    const folderRowsToMove: ConceptFolderRow[] = [];
    for (const fid of uniqueFolderIds) {
      const f = tree.byId.get(fid);
      if (!f) throw new AppError(404, "部分所选文件夹不存在或没有管理权限。");
      const subtreeIds = collectConceptSubtreeIds(tree, f.id);
      if (parentId && subtreeIds.includes(parentId)) {
        throw new AppError(400, "不能将父文件夹归入其子目录中。");
      }
      if (subtreeIds.some((id) => id !== f.id && selectedFolderSet.has(id))) {
        throw new AppError(400, "不能同时选择父文件夹及其子文件夹。");
      }
      const height = conceptFolderSubtreeHeight(tree, f.id);
      if (newDepth + height > MAX_FOLDER_DEPTH) {
        throw new AppError(
          400,
          `「${f.title}」归入新文件夹后将超过 ${MAX_FOLDER_DEPTH} 层上限。`,
        );
      }
      folderRowsToMove.push(f);
    }

    if (uniqueConceptIds.length) {
      const existingConcepts = await tx
        .select({ id: concepts.id })
        .from(concepts)
        .where(
          and(
            eq(concepts.userId, userId),
            inArray(concepts.id, uniqueConceptIds),
          ),
        );
      if (existingConcepts.length !== uniqueConceptIds.length) {
        throw new AppError(404, "部分所选概念不存在或已删除。");
      }
    }

    const now = new Date();
    const [created] = await tx
      .insert(conceptFolders)
      .values({
        id: crypto.randomUUID(),
        userId,
        parentId,
        title,
        color,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    tree.byId.set(created.id, created);
    tree.children.set(created.id, []);
    const parentList = tree.children.get(parentId) ?? [];
    parentList.push(created);
    tree.children.set(parentId, parentList);

    const detachFromOldParent = (folderRow: ConceptFolderRow) => {
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

    const usedInNew = new Set<string>();
    for (const f of folderRowsToMove) {
      const key = normalizeFolderTitleKey(f.title);
      if (usedInNew.has(key)) {
        const existing = findConceptSiblingByLowerTitle(tree, created.id, key);
        if (existing && strategy === "merge") {
          const mergedDepth =
            conceptFolderDepth(tree, existing.id) +
            conceptMergedExtraDepth(tree, f.id, existing.id);
          if (mergedDepth > MAX_FOLDER_DEPTH) {
            throw new AppError(
              400,
              `合并「${f.title}」后层级将超过 ${MAX_FOLDER_DEPTH} 层上限。`,
            );
          }
          await mergeConceptFolderIntoInTx(
            tx,
            userId,
            tree,
            f.id,
            existing.id,
            now,
          );
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
          .update(conceptFolders)
          .set({ parentId: created.id, title: nextTitle, updatedAt: now })
          .where(eq(conceptFolders.id, f.id));
        await tx
          .update(concepts)
          .set({ groupName: nextTitle, updatedAt: now })
          .where(and(eq(concepts.userId, userId), eq(concepts.folderId, f.id)));
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
          .update(conceptFolders)
          .set({ parentId: created.id, updatedAt: now })
          .where(eq(conceptFolders.id, f.id));
        detachFromOldParent(f);
        const updated = { ...f, parentId: created.id, updatedAt: now };
        tree.byId.set(f.id, updated);
        tree.children.get(created.id)!.push(updated);
      }
    }

    if (uniqueConceptIds.length) {
      await tx
        .update(concepts)
        .set({ folderId: created.id, groupName: created.title, updatedAt: now })
        .where(
          and(
            eq(concepts.userId, userId),
            inArray(concepts.id, uniqueConceptIds),
          ),
        );
    }

    const snapshot = await loadUserConceptSnapshotInTx(tx, userId);
    const createdView = snapshot.conceptFolders.find(
      (f) => f.id === created.id,
    )!;
    return {
      ok: true,
      folder: createdView,
      movedFolders: folderRowsToMove.length,
      movedConcepts: uniqueConceptIds.length,
      conceptFolders: snapshot.conceptFolders,
      concepts: snapshot.concepts,
    };
  });
}

export async function dissolveConceptFolder(
  userId: string,
  input: {
    folderId: string;
    conflictStrategy?: FolderConflictStrategy;
  },
): Promise<{
  ok: true;
  liftedConcepts: number;
  liftedFolders: number;
  mergedFolders: number;
  conceptFolders: ConceptFolderView[];
  concepts: ConceptView[];
}> {
  const strategy = input.conflictStrategy ?? "abort";

  const db = await getDb();
  return db.transaction(async (tx) => {
    await lockUserTree(tx, userId);

    const rows = await tx
      .select()
      .from(conceptFolders)
      .where(eq(conceptFolders.userId, userId));
    const tree = buildServerConceptFolderTree(rows);

    const folder = tree.byId.get(input.folderId);
    if (!folder) {
      throw new AppError(404, "文件夹不存在或没有管理权限。");
    }

    const parentId =
      folder.parentId && tree.byId.has(folder.parentId)
        ? folder.parentId
        : null;
    const parentTitle = parentId ? (tree.byId.get(parentId)?.title ?? "") : "";
    const directChildren = [...(tree.children.get(folder.id) ?? [])];
    const excludeSelf = new Set([folder.id]);

    const conflicts: FolderConflictItem[] = [];
    for (const child of directChildren) {
      const match = findConceptSiblingByLowerTitle(
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
          conceptFolderDepth(tree, conflict.existingId) +
          conceptMergedExtraDepth(tree, conflict.sourceId, conflict.existingId);
        if (mergedDepth > MAX_FOLDER_DEPTH) {
          throw new AppError(
            400,
            `合并「${conflict.title}」后层级将超过 ${MAX_FOLDER_DEPTH} 层上限。`,
          );
        }
      }
    }

    const now = nextMonotonicTimestamp(folder.updatedAt);

    // 1. Free the dissolved folder's unique title slot in `parentId` before lifting children.
    await tx
      .update(conceptFolders)
      .set({ title: `\u0001dissolving:${folder.id}`, updatedAt: now })
      .where(eq(conceptFolders.id, folder.id));
    tree.byId.delete(folder.id);
    tree.children.set(
      parentId,
      (tree.children.get(parentId) ?? []).filter((f) => f.id !== folder.id),
    );

    // 2. Lift all direct concepts up one level to parentId.
    const liftedConceptRows = await tx
      .update(concepts)
      .set({ folderId: parentId, groupName: parentTitle, updatedAt: now })
      .where(and(eq(concepts.userId, userId), eq(concepts.folderId, folder.id)))
      .returning({ id: concepts.id });

    // 3. Lift direct child folders up one level with conflict handling.
    let mergedFolders = 0;
    let liftedFolders = 0;
    const conflictSourceIds = new Set(conflicts.map((c) => c.sourceId));
    const usedParentKeys = conceptSiblingLowerKeys(tree, parentId);
    for (const child of directChildren) {
      if (!conflictSourceIds.has(child.id)) {
        usedParentKeys.add(normalizeFolderTitleKey(child.title));
      }
    }
    const parentChildrenList = [...(tree.children.get(parentId) ?? [])];
    tree.children.set(parentId, parentChildrenList);

    for (const child of directChildren) {
      const match = findConceptSiblingByLowerTitle(
        tree,
        parentId,
        normalizeFolderTitleKey(child.title),
      );
      if (match && strategy === "merge") {
        await mergeConceptFolderIntoInTx(
          tx,
          userId,
          tree,
          child.id,
          match.id,
          now,
        );
        mergedFolders += 1;
      } else if (match && strategy === "keepBoth") {
        const nextTitle = resolveUniqueSiblingTitle(child.title, usedParentKeys);
        usedParentKeys.add(normalizeFolderTitleKey(nextTitle));
        await tx
          .update(conceptFolders)
          .set({ parentId, title: nextTitle, updatedAt: now })
          .where(eq(conceptFolders.id, child.id));
        await tx
          .update(concepts)
          .set({ groupName: nextTitle, updatedAt: now })
          .where(
            and(eq(concepts.userId, userId), eq(concepts.folderId, child.id)),
          );
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
          .update(conceptFolders)
          .set({ parentId, updatedAt: now })
          .where(eq(conceptFolders.id, child.id));
        const updatedChild = { ...child, parentId, updatedAt: now };
        tree.byId.set(child.id, updatedChild);
        tree.children.get(parentId)!.push(updatedChild);
        liftedFolders += 1;
      }
    }

    // 4. Delete the dissolved folder row cleanly.
    await tx
      .delete(conceptFolders)
      .where(
        and(eq(conceptFolders.id, folder.id), eq(conceptFolders.userId, userId)),
      );

    const snapshot = await loadUserConceptSnapshotInTx(tx, userId);
    return {
      ok: true,
      liftedConcepts: liftedConceptRows.length,
      liftedFolders,
      mergedFolders,
      conceptFolders: snapshot.conceptFolders,
      concepts: snapshot.concepts,
    };
  });
}

export async function deleteConceptFolder(
  userId: string,
  folderId: string,
): Promise<{
  ok: true;
  deletedFolders: number;
  deletedConcepts: number;
  deletedConceptIds: string[];
  conceptFolders: ConceptFolderView[];
  concepts: ConceptView[];
}> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    await lockUserTree(tx, userId);

    const rows = await tx
      .select()
      .from(conceptFolders)
      .where(eq(conceptFolders.userId, userId));
    const tree = buildServerConceptFolderTree(rows);

    const folder = tree.byId.get(folderId);
    if (!folder) {
      throw new AppError(404, "文件夹不存在或没有管理权限。");
    }

    const subtreeIds = collectConceptSubtreeIds(tree, folder.id);

    const deletedConceptRows = await tx
      .delete(concepts)
      .where(
        and(
          eq(concepts.userId, userId),
          inArray(concepts.folderId, subtreeIds),
        ),
      )
      .returning({ id: concepts.id });
    const deletedConceptIds = deletedConceptRows.map((r) => r.id);

    if (deletedConceptIds.length) {
      await syncLinkedAnnotationsInTx(tx, userId, deletedConceptIds, {
        unlink: true,
      });
    }

    await tx
      .delete(conceptFolders)
      .where(
        and(
          eq(conceptFolders.userId, userId),
          inArray(conceptFolders.id, subtreeIds),
        ),
      );

    const snapshot = await loadUserConceptSnapshotInTx(tx, userId);
    return {
      ok: true,
      deletedFolders: subtreeIds.length,
      deletedConcepts: deletedConceptIds.length,
      deletedConceptIds,
      conceptFolders: snapshot.conceptFolders,
      concepts: snapshot.concepts,
    };
  });
}

/**
 * Legacy compatibility wrapper for `renameGroup` -> renames or dissolves a top-level concept folder.
 */
export async function renameConceptGroup(
  userId: string,
  fromGroup: string,
  toGroup: string,
): Promise<{
  ok: true;
  updated: number;
  fromGroup: string;
  toGroup: string;
  conceptFolders: ConceptFolderView[];
  concepts: ConceptView[];
}> {
  const from = fromGroup.trim();
  const to = toGroup.trim();
  if (!from) {
    throw new AppError(400, "请指定要重命名的分组。");
  }

  const db = await getDb();
  return db.transaction(async (tx) => {
    await lockUserTree(tx, userId);
    if (from === to) {
      const snapshot = await loadUserConceptSnapshotInTx(tx, userId);
      return {
        ok: true,
        updated: 0,
        fromGroup: from,
        toGroup: to,
        conceptFolders: snapshot.conceptFolders,
        concepts: snapshot.concepts,
      };
    }

    const folderRows = await tx
      .select()
      .from(conceptFolders)
      .where(eq(conceptFolders.userId, userId));
    const tree = buildServerConceptFolderTree(folderRows);

    const fromKey = normalizeFolderTitleKey(sanitizeLegacyFolderTitle(from));
    const sourceFolder = findConceptSiblingByLowerTitle(tree, null, fromKey);
    const now = nextMonotonicTimestamp(sourceFolder?.updatedAt);
    let updatedCount = 0;

    if (sourceFolder) {
      const directConcepts = await tx
        .select({ id: concepts.id })
        .from(concepts)
        .where(
          and(eq(concepts.userId, userId), eq(concepts.folderId, sourceFolder.id)),
        );
      updatedCount = directConcepts.length;

      if (!to) {
        // Dissolve into root.
        await tx
          .update(concepts)
          .set({ folderId: null, groupName: "", updatedAt: now })
          .where(
            and(
              eq(concepts.userId, userId),
              eq(concepts.folderId, sourceFolder.id),
            ),
          );
        await tx
          .delete(conceptFolders)
          .where(eq(conceptFolders.id, sourceFolder.id));
      } else {
        const nextTitle = sanitizeLegacyFolderTitle(to);
        const toKey = normalizeFolderTitleKey(nextTitle);
        const existingTarget = findConceptSiblingByLowerTitle(
          tree,
          null,
          toKey,
          new Set([sourceFolder.id]),
        );
        if (existingTarget) {
          await mergeConceptFolderIntoInTx(
            tx,
            userId,
            tree,
            sourceFolder.id,
            existingTarget.id,
            now,
          );
        } else {
          await tx
            .update(conceptFolders)
            .set({ title: nextTitle, updatedAt: now })
            .where(eq(conceptFolders.id, sourceFolder.id));
          await tx
            .update(concepts)
            .set({ groupName: nextTitle, updatedAt: now })
            .where(
              and(
                eq(concepts.userId, userId),
                eq(concepts.folderId, sourceFolder.id),
              ),
            );
        }
      }
    } else {
      // Fallback for any stray concepts without a matching folder row.
      const res = await tx
        .update(concepts)
        .set({ groupName: to, updatedAt: now })
        .where(and(eq(concepts.userId, userId), eq(concepts.groupName, from)))
        .returning({ id: concepts.id });
      updatedCount = res.length;
    }

    const snapshot = await loadUserConceptSnapshotInTx(tx, userId);
    return {
      ok: true,
      updated: updatedCount,
      fromGroup: from,
      toGroup: to,
      conceptFolders: snapshot.conceptFolders,
      concepts: snapshot.concepts,
    };
  });
}

/**
 * Legacy compatibility wrapper for `moveGroup` -> resolves/creates top-level folder and moves concepts.
 */
export async function moveConceptsToGroup(
  userId: string,
  ids: string[],
  groupName: string,
): Promise<{
  ok: true;
  updated: number;
  groupName: string;
  folderId: string | null;
  conceptFolders: ConceptFolderView[];
  concepts: ConceptView[];
}> {
  const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  const targetGroup = groupName.trim();

  const db = await getDb();
  return db.transaction(async (tx) => {
    await lockUserTree(tx, userId);

    const folderRows = await tx
      .select()
      .from(conceptFolders)
      .where(eq(conceptFolders.userId, userId));
    const tree = buildServerConceptFolderTree(folderRows);

    if (!uniqueIds.length) {
      const snapshot = await loadUserConceptSnapshotInTx(tx, userId);
      return {
        ok: true,
        updated: 0,
        groupName: targetGroup,
        folderId: null,
        conceptFolders: snapshot.conceptFolders,
        concepts: snapshot.concepts,
      };
    }

    const existing = await tx
      .select({ id: concepts.id, updatedAt: concepts.updatedAt })
      .from(concepts)
      .where(and(eq(concepts.userId, userId), inArray(concepts.id, uniqueIds)));
    if (!existing.length) {
      const snapshot = await loadUserConceptSnapshotInTx(tx, userId);
      return {
        ok: true,
        updated: 0,
        groupName: targetGroup,
        folderId: null,
        conceptFolders: snapshot.conceptFolders,
        concepts: snapshot.concepts,
      };
    }

    const resolved = await resolveFolderTargetInTx(tx, userId, tree, {
      groupName: targetGroup,
    });
    const maxPrev = existing.reduce<Date | null>(
      (acc, r) => (!acc || r.updatedAt > acc ? r.updatedAt : acc),
      null,
    );
    const updatedAt = nextMonotonicTimestamp(maxPrev);
    const updated = await tx
      .update(concepts)
      .set({
        folderId: resolved.folderId,
        groupName: resolved.groupName,
        updatedAt,
      })
      .where(and(eq(concepts.userId, userId), inArray(concepts.id, uniqueIds)))
      .returning({ id: concepts.id });

    const snapshot = await loadUserConceptSnapshotInTx(tx, userId);
    return {
      ok: true,
      updated: updated.length,
      groupName: resolved.groupName,
      folderId: resolved.folderId,
      conceptFolders: snapshot.conceptFolders,
      concepts: snapshot.concepts,
    };
  });
}

export async function importConceptsFromAnnotations(
  userId: string,
  input: {
    items?: { questionId: string; annotationId: string }[];
    folderId?: string | null;
    groupName?: string;
  } = {},
): Promise<{
  ok: true;
  created: number;
  linked: number;
  concepts: ConceptView[];
  conceptFolders: ConceptFolderView[];
  allConcepts: ConceptView[];
  updatedCards: {
    questionId: string;
    annotations: QuestionAnnotation[];
    version: number;
  }[];
}> {
  const explicitItems =
    input.items && input.items.length > 0 ? input.items : null;
  const itemKeySet = explicitItems
    ? new Set(explicitItems.map((it) => `${it.questionId}\0${it.annotationId}`))
    : null;
  const targetQuestionIds = explicitItems
    ? [...new Set(explicitItems.map((it) => it.questionId))]
    : null;

  const db = await getDb();
  return db.transaction(async (tx) => {
    await lockUserTree(tx, userId);

    const [folderRows, existingRows] = await Promise.all([
      tx
        .select()
        .from(conceptFolders)
        .where(eq(conceptFolders.userId, userId)),
      tx.select().from(concepts).where(eq(concepts.userId, userId)),
    ]);
    const tree = buildServerConceptFolderTree(folderRows);
    const conceptPool: ConceptView[] = existingRows.map((row) =>
      toConceptView(row, tree.byId),
    );
    const validConceptIds = new Set(conceptPool.map((c) => c.id));

    // Only validate/create target folder lazily when at least one concept is actually created,
    // or upfront if an explicit folderId was supplied.
    let resolvedTarget: {
      folderId: string | null;
      groupName: string;
    } | null = null;
    if (input.folderId !== undefined) {
      const res = await resolveFolderTargetInTx(tx, userId, tree, {
        folderId: input.folderId,
      });
      resolvedTarget = { folderId: res.folderId, groupName: res.groupName };
    }

    const ensureTarget = async () => {
      if (resolvedTarget) return resolvedTarget;
      const res = await resolveFolderTargetInTx(tx, userId, tree, {
        groupName: input.groupName,
      });
      resolvedTarget = { folderId: res.folderId, groupName: res.groupName };
      return resolvedTarget;
    };

    const cards = await tx
      .select({
        questionId: studyCards.questionId,
        annotations: studyCards.annotations,
      })
      .from(studyCards)
      .where(
        targetQuestionIds
          ? and(
              eq(studyCards.userId, userId),
              inArray(studyCards.questionId, targetQuestionIds),
            )
          : and(
              eq(studyCards.userId, userId),
              sql`jsonb_array_length(${studyCards.annotations}) > 0`,
            ),
      )
      .orderBy(asc(studyCards.questionId))
      .for("update");

    let created = 0;
    let linked = 0;
    const createdConcepts: ConceptView[] = [];
    const updatedCards: {
      questionId: string;
      annotations: QuestionAnnotation[];
      version: number;
    }[] = [];
    const now = new Date();
    const nowIso = now.toISOString();

    for (const card of cards) {
      const list: QuestionAnnotation[] = Array.isArray(card.annotations)
        ? card.annotations
        : [];
      if (!list.length) continue;

      let cardChanged = false;
      const nextList: QuestionAnnotation[] = [];

      for (const ann of list) {
        if (itemKeySet && !itemKeySet.has(`${card.questionId}\0${ann.id}`)) {
          nextList.push(ann);
          continue;
        }
        if (ann.conceptId && validConceptIds.has(ann.conceptId)) {
          nextList.push(ann);
          continue;
        }
        const trimmedQuote = ann.quote.trim();
        const normKey = normalizeConceptKey(trimmedQuote);
        if (
          !trimmedQuote ||
          trimmedQuote.length > MAX_CONCEPT_TERM_LENGTH ||
          !normKey
        ) {
          if (explicitItems && explicitItems.length === 1) {
            throw new AppError(
              400,
              `批注摘录需为 1–${MAX_CONCEPT_TERM_LENGTH} 字的有效概念词条才能存入概念库。`,
            );
          }
          nextList.push(ann);
          continue;
        }

        const existing = findMatchingConcept(conceptPool, trimmedQuote);
        if (existing) {
          nextList.push({
            ...ann,
            conceptId: existing.id,
            updatedAt: nowIso,
          });
          cardChanged = true;
          linked += 1;
          continue;
        }

        if (conceptPool.length >= MAX_CONCEPTS) {
          if (explicitItems) {
            throw new AppError(400, `概念库最多保存 ${MAX_CONCEPTS} 条概念。`);
          }
          nextList.push(ann);
          continue;
        }

        const definition = ann.comment
          .trim()
          .slice(0, MAX_CONCEPT_DEFINITION_LENGTH);
        if (!definition) {
          nextList.push(ann);
          continue;
        }

        const target = await ensureTarget();
        const [inserted] = await tx
          .insert(concepts)
          .values({
            id: crypto.randomUUID(),
            userId,
            folderId: target.folderId,
            term: trimmedQuote,
            aliases: [],
            normalizedKey: normKey,
            definition,
            groupName: target.groupName,
            color: ann.color,
            sourceQuestionId: card.questionId,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        const view = toConceptView(inserted, tree.byId);
        conceptPool.push(view);
        validConceptIds.add(view.id);
        createdConcepts.push(view);
        created += 1;
        linked += 1;
        cardChanged = true;
        nextList.push({
          ...ann,
          conceptId: view.id,
          updatedAt: nowIso,
        });
      }

      if (cardChanged) {
        const [updatedCard] = await tx
          .update(studyCards)
          .set({
            annotations: nextList,
            annotationsVersion: sql`${studyCards.annotationsVersion} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(studyCards.userId, userId),
              eq(studyCards.questionId, card.questionId),
            ),
          )
          .returning({ annotationsVersion: studyCards.annotationsVersion });
        updatedCards.push({
          questionId: card.questionId,
          annotations: nextList,
          version: updatedCard.annotationsVersion,
        });
      }
    }

    const snapshot = await loadUserConceptSnapshotInTx(tx, userId);
    return {
      ok: true,
      created,
      linked,
      concepts: createdConcepts,
      conceptFolders: snapshot.conceptFolders,
      allConcepts: snapshot.concepts,
      updatedCards,
    };
  });
}

/**
 * Create or reuse/update a concept when adding a question annotation with `saveAsConcept: true`.
 * Caller MUST already hold `lockUserTree(tx, userId)`.
 */
export async function upsertConceptFromAnnotationInTx(
  tx: DbTx,
  userId: string,
  input: {
    questionId: string;
    quote: string;
    comment: string;
    color: QuestionAnnotationColor;
    conceptFolderId?: string | null;
    conceptGroup?: string;
    aliases?: string[];
    updateExistingConcept?: boolean;
  },
): Promise<{
  concept: ConceptView | null;
  folder: ConceptFolderView | null;
}> {
  const term = input.quote.trim();
  if (!term || term.length > MAX_CONCEPT_TERM_LENGTH) {
    return { concept: null, folder: null };
  }
  const normalizedKey = normalizeConceptKey(term);
  if (!normalizedKey) return { concept: null, folder: null };

  const [folderRows, existingRows] = await Promise.all([
    tx
      .select()
      .from(conceptFolders)
      .where(eq(conceptFolders.userId, userId)),
    tx.select().from(concepts).where(eq(concepts.userId, userId)),
  ]);
  const tree = buildServerConceptFolderTree(folderRows);
  const views = existingRows.map((row) => toConceptView(row, tree.byId));
  const matched = findMatchingConcept(views, term);

  if (matched) {
    if (!input.updateExistingConcept) {
      return { concept: matched, folder: null };
    }
    const matchedRow = existingRows.find((r) => r.id === matched.id)!;
    let nextFolderId = matchedRow.folderId ?? null;
    let nextGroupName =
      nextFolderId && tree.byId.has(nextFolderId)
        ? tree.byId.get(nextFolderId)!.title
        : "";
    let createdFolder: ConceptFolderRow | null = null;

    if (
      input.conceptFolderId !== undefined ||
      input.conceptGroup !== undefined
    ) {
      const resolved = await resolveFolderTargetInTx(tx, userId, tree, {
        folderId: input.conceptFolderId,
        groupName: input.conceptGroup,
      });
      nextFolderId = resolved.folderId;
      nextGroupName = resolved.groupName;
      createdFolder = resolved.createdFolder;
    }

    const nextAliases =
      input.aliases && input.aliases.length > 0
        ? normalizeConceptAliases(
            [...matchedRow.aliases, ...input.aliases],
            matchedRow.term,
          )
        : matchedRow.aliases;
    const nextDefinition = input.comment
      .trim()
      .slice(0, MAX_CONCEPT_DEFINITION_LENGTH);
    const updatedAt = nextMonotonicTimestamp(matchedRow.updatedAt);

    const [updated] = await tx
      .update(concepts)
      .set({
        folderId: nextFolderId,
        definition: nextDefinition,
        color: input.color,
        groupName: nextGroupName,
        aliases: nextAliases,
        updatedAt,
      })
      .where(and(eq(concepts.id, matchedRow.id), eq(concepts.userId, userId)))
      .returning();

    await syncLinkedAnnotationsInTx(
      tx,
      userId,
      matchedRow.id,
      { comment: nextDefinition, color: input.color },
      input.questionId,
    );

    return {
      concept: toConceptView(updated, tree.byId),
      folder: createdFolder
        ? { ...toRawConceptFolderView(createdFolder), count: 1, directCount: 1 }
        : null,
    };
  }

  if (existingRows.length >= MAX_CONCEPTS) {
    throw new AppError(400, `概念库最多保存 ${MAX_CONCEPTS} 条概念。`);
  }

  const target = await resolveFolderTargetInTx(tx, userId, tree, {
    folderId: input.conceptFolderId,
    groupName: input.conceptGroup,
  });

  const now = new Date();
  const [inserted] = await tx
    .insert(concepts)
    .values({
      id: crypto.randomUUID(),
      userId,
      folderId: target.folderId,
      term,
      aliases: normalizeConceptAliases(input.aliases ?? [], term),
      normalizedKey,
      definition: input.comment.trim().slice(0, MAX_CONCEPT_DEFINITION_LENGTH),
      groupName: target.groupName,
      color: input.color,
      sourceQuestionId: input.questionId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return {
    concept: toConceptView(inserted, tree.byId),
    folder: target.createdFolder
      ? {
          ...toRawConceptFolderView(target.createdFolder),
          count: 1,
          directCount: 1,
        }
      : null,
  };
}

/**
 * Sync a linked concept when an annotation is edited with `syncConcept !== false`.
 * Caller MUST already hold `lockUserTree(tx, userId)`.
 */
export async function syncConceptFromAnnotationEditInTx(
  tx: DbTx,
  userId: string,
  input: {
    questionId: string;
    conceptId: string;
    comment: string;
    color?: QuestionAnnotationColor;
  },
): Promise<ConceptView | null> {
  const [folderRows, existingRows] = await Promise.all([
    tx
      .select()
      .from(conceptFolders)
      .where(eq(conceptFolders.userId, userId)),
    tx
      .select()
      .from(concepts)
      .where(and(eq(concepts.id, input.conceptId), eq(concepts.userId, userId))),
  ]);
  const existing = existingRows[0];
  if (!existing) return null;

  const folderById = new Map(folderRows.map((f) => [f.id, f]));
  const nextDefinition = input.comment
    .trim()
    .slice(0, MAX_CONCEPT_DEFINITION_LENGTH);
  const nextColor = input.color ?? existing.color;
  const updatedAt = nextMonotonicTimestamp(existing.updatedAt);

  const [updated] = await tx
    .update(concepts)
    .set({
      definition: nextDefinition,
      color: nextColor,
      updatedAt,
    })
    .where(and(eq(concepts.id, existing.id), eq(concepts.userId, userId)))
    .returning();

  await syncLinkedAnnotationsInTx(
    tx,
    userId,
    existing.id,
    { comment: nextDefinition, color: nextColor },
    input.questionId,
  );

  return toConceptView(updated, folderById);
}
