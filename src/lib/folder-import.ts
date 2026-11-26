import {
  MAX_FOLDER_DEPTH,
  ROOT_FOLDER_LABEL,
  compareNaturalNames,
  normalizeFolderTitleKey,
  validateFolderTitle,
} from "./folders";
import type { DeckView } from "./types";

export type FolderImportStructureMode = "preserve" | "flatten";

export type VirtualFolderNode = {
  pathKey: string;
  segments: string[];
  title: string;
  status: "reuse" | "create";
  existingFolderId: string | null;
  depth: number;
  directFileCount: number;
  directQuestionCount: number;
  children: VirtualFolderNode[];
};

export type BatchFolderPlacement = {
  batchId: string;
  sourceName: string;
  relativeSegments: string[];
  displayPath: string;
  depthExceeded: boolean;
  invalidSegmentError: string | null;
};

export type FolderImportPlan = {
  commonOuterFolder: string | null;
  outerMatchesBase: boolean;
  tree: VirtualFolderNode[];
  placements: Map<string, BatchFolderPlacement>;
  foldersToCreate: number;
  foldersToReuse: number;
  depthErrors: string[];
  nameErrors: string[];
};

/**
 * Extract the parent directory segments of an imported file path.
 * Split questions stay in the file's parent folder — never auto-creating a folder named after the file.
 */
export function extractRelativeFolderSegments(sourceName: string): string[] {
  const parts = sourceName
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== "..");
  if (parts.length <= 1) return [];
  return parts.slice(0, -1);
}

/** Detect if every provided file shares the exact same non-empty top-level directory segment. */
export function detectCommonOuterFolder(
  sourceNames: readonly string[],
): string | null {
  if (!sourceNames.length) return null;
  let common: string | null = null;
  let commonKey: string | null = null;
  for (const name of sourceNames) {
    const segs = extractRelativeFolderSegments(name);
    if (!segs.length) return null;
    const key = normalizeFolderTitleKey(segs[0]);
    if (commonKey === null) {
      common = segs[0];
      commonKey = key;
    } else if (key !== commonKey) {
      return null;
    }
  }
  return common;
}

export function planFolderImport(params: {
  existingFolders: readonly Pick<DeckView, "id" | "parentId" | "title" | "isOwner">[];
  baseFolderId: string | null;
  sources: readonly {
    batchId: string;
    sourceName: string;
    questionCount: number;
  }[];
  structureMode: FolderImportStructureMode;
  stripOuterFolder: boolean;
}): FolderImportPlan {
  const owned = params.existingFolders.filter((d) => d.isOwner);
  const ownedById = new Map(owned.map((d) => [d.id, d]));

  // Compute base depth and base title chain.
  const baseChain: string[] = [];
  let cursor = params.baseFolderId;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const node = ownedById.get(cursor);
    if (!node) break;
    baseChain.unshift(node.title);
    cursor = node.parentId && ownedById.has(node.parentId) ? node.parentId : null;
  }
  const baseDepth = baseChain.length;
  const baseTitle = params.baseFolderId
    ? (ownedById.get(params.baseFolderId)?.title ?? null)
    : null;
  const baseDisplay = baseChain.length ? baseChain.join(" / ") : ROOT_FOLDER_LABEL;

  // Lookup existing child folders by (parentId, lowerTitle).
  const existingChildLookup = new Map<string, string>();
  for (const d of owned) {
    const pid = d.parentId && ownedById.has(d.parentId) ? d.parentId : null;
    existingChildLookup.set(
      `${pid ?? ""}::${normalizeFolderTitleKey(d.title)}`,
      d.id,
    );
  }

  const activeSources = params.sources.filter((s) => s.questionCount > 0);
  const commonOuterFolder = detectCommonOuterFolder(
    activeSources.map((s) => s.sourceName),
  );
  const outerMatchesBase = Boolean(
    commonOuterFolder &&
      baseTitle &&
      normalizeFolderTitleKey(commonOuterFolder) ===
        normalizeFolderTitleKey(baseTitle),
  );

  const placements = new Map<string, BatchFolderPlacement>();
  const nodeMap = new Map<string, VirtualFolderNode>();
  const rootNodes: VirtualFolderNode[] = [];
  const depthErrors: string[] = [];
  const nameErrors: string[] = [];

  for (const source of params.sources) {
    let segs =
      params.structureMode === "preserve"
        ? extractRelativeFolderSegments(source.sourceName)
        : [];
    if (
      params.structureMode === "preserve" &&
      params.stripOuterFolder &&
      commonOuterFolder &&
      segs.length > 0 &&
      normalizeFolderTitleKey(segs[0]) ===
        normalizeFolderTitleKey(commonOuterFolder)
    ) {
      segs = segs.slice(1);
    }

    let invalidSegmentError: string | null = null;
    for (const seg of segs) {
      const err = validateFolderTitle(seg);
      if (err) {
        invalidSegmentError = `目录「${seg}」无效：${err}`;
        break;
      }
    }
    const depthExceeded = baseDepth + segs.length > MAX_FOLDER_DEPTH;
    const displayPath = segs.length
      ? baseChain.length
        ? `${baseDisplay} / ${segs.join(" / ")}`
        : segs.join(" / ")
      : baseDisplay;

    placements.set(source.batchId, {
      batchId: source.batchId,
      sourceName: source.sourceName,
      relativeSegments: segs,
      displayPath,
      depthExceeded,
      invalidSegmentError,
    });

    if (source.questionCount <= 0) continue;
    if (invalidSegmentError) {
      nameErrors.push(invalidSegmentError);
      continue;
    }
    if (depthExceeded) {
      depthErrors.push(
        `「${source.sourceName}」导入后层级为 ${baseDepth + segs.length} 层，超过 ${MAX_FOLDER_DEPTH} 层上限。`,
      );
      continue;
    }

    let parentVirtual: VirtualFolderNode | null = null;
    let parentExistingId: string | null = params.baseFolderId;
    const accKeys: string[] = [];
    const accTitles: string[] = [];

    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const lowerKey = normalizeFolderTitleKey(seg);
      accKeys.push(lowerKey);
      accTitles.push(seg);
      const pathKey = accKeys.join("\0");

      let node = nodeMap.get(pathKey);
      if (!node) {
        const matchedExistingId: string | null =
          parentExistingId !== undefined &&
          (parentVirtual === null || parentVirtual.existingFolderId !== null)
            ? (existingChildLookup.get(
                `${parentExistingId ?? ""}::${lowerKey}`,
              ) ?? null)
            : null;
        node = {
          pathKey,
          segments: [...accTitles],
          title: seg,
          status: matchedExistingId ? "reuse" : "create",
          existingFolderId: matchedExistingId,
          depth: baseDepth + i + 1,
          directFileCount: 0,
          directQuestionCount: 0,
          children: [],
        };
        nodeMap.set(pathKey, node);
        if (parentVirtual) {
          parentVirtual.children.push(node);
        } else {
          rootNodes.push(node);
        }
      }
      parentVirtual = node;
      parentExistingId = node.existingFolderId;
    }

    if (parentVirtual) {
      parentVirtual.directFileCount += 1;
      parentVirtual.directQuestionCount += source.questionCount;
    }
  }

  const sortTree = (nodes: VirtualFolderNode[]) => {
    nodes.sort((a, b) => compareNaturalNames(a.title, b.title));
    for (const n of nodes) sortTree(n.children);
  };
  sortTree(rootNodes);

  let foldersToCreate = 0;
  let foldersToReuse = 0;
  for (const node of nodeMap.values()) {
    if (node.status === "create") foldersToCreate += 1;
    else foldersToReuse += 1;
  }

  return {
    commonOuterFolder,
    outerMatchesBase,
    tree: rootNodes,
    placements,
    foldersToCreate,
    foldersToReuse,
    depthErrors,
    nameErrors,
  };
}
