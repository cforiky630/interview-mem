"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Folder, FolderOpen, Home } from "lucide-react";
import type { ConceptFolderView } from "@/lib/types";
import { CONCEPT_ROOT_LABEL, buildConceptFolderIndex } from "@/lib/concepts";

export type ConceptDragPayload =
  | { kind: "folder"; ids: string[] }
  | { kind: "concept"; ids: string[] }
  | { kind: "mixed"; folderIds: string[]; conceptIds: string[] };

export const CONCEPT_DRAG_MIME = "application/x-shiyi-concept-move";

export function parseConceptDragPayload(
  dt: DataTransfer | null,
): ConceptDragPayload | null {
  if (!dt) return null;
  const raw = dt.getData(CONCEPT_DRAG_MIME) || dt.getData("text/plain");
  if (!raw || !raw.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(raw) as ConceptDragPayload;
    if (parsed && typeof parsed === "object" && "kind" in parsed) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function expandedStorageKey(userId: string): string {
  return `shiyi:concept-tree-expanded:${userId}`;
}

function readExpandedConceptFolders(userId: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(expandedStorageKey(userId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((v): v is string => typeof v === "string"));
    }
  } catch {
    /* Ignore storage access errors. */
  }
  return new Set();
}

function writeExpandedConceptFolders(
  userId: string,
  ids: ReadonlySet<string>,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      expandedStorageKey(userId),
      JSON.stringify([...ids]),
    );
  } catch {
    /* Ignore storage access errors. */
  }
}

export function ConceptFolderTree({
  userId,
  folders,
  totalConcepts,
  activeFolderId,
  onSelectFolder,
  onDropMove,
}: {
  userId: string;
  folders: readonly ConceptFolderView[];
  totalConcepts: number;
  activeFolderId: string | null;
  onSelectFolder: (folderId: string | null) => void;
  onDropMove: (
    targetFolderId: string | null,
    payload: ConceptDragPayload,
  ) => void;
}) {
  const index = useMemo(() => buildConceptFolderIndex(folders), [folders]);
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    readExpandedConceptFolders(userId),
  );
  const [mountedIds, setMountedIds] = useState<Set<string>>(
    () => new Set(expanded),
  );
  const [dragOverId, setDragOverId] = useState<string | "ROOT" | null>(null);

  useEffect(() => {
    setExpanded(readExpandedConceptFolders(userId));
  }, [userId]);

  useEffect(() => {
    setMountedIds((prev) => {
      let changed = false;
      for (const id of expanded) {
        if (!prev.has(id)) {
          changed = true;
          break;
        }
      }
      if (!changed) return prev;
      const next = new Set(prev);
      expanded.forEach((id) => next.add(id));
      return next;
    });
  }, [expanded]);

  // Auto-expand ancestor chain whenever activeFolderId changes.
  useEffect(() => {
    if (!activeFolderId) return;
    const ancestors = index.ancestorIds(activeFolderId);
    if (!ancestors.length) return;
    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of ancestors) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      if (changed) writeExpandedConceptFolders(userId, next);
      return changed ? next : prev;
    });
  }, [activeFolderId, index, userId]);

  function toggleExpand(folderId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      writeExpandedConceptFolders(userId, next);
      return next;
    });
  }

  function handleDragOver(
    e: React.DragEvent,
    targetKey: string | "ROOT",
  ) {
    if (
      e.dataTransfer.types.includes(CONCEPT_DRAG_MIME) ||
      e.dataTransfer.types.includes("text/plain")
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dragOverId !== targetKey) setDragOverId(targetKey);
    }
  }

  function handleDrop(
    e: React.DragEvent,
    targetFolderId: string | null,
  ) {
    e.preventDefault();
    setDragOverId(null);
    const payload = parseConceptDragPayload(e.dataTransfer);
    if (!payload) return;
    onDropMove(targetFolderId, payload);
  }

  const rootFolders = index.children.get(null) ?? [];
  const isRootActive = activeFolderId === null;

  function renderNode(folder: ConceptFolderView, depth: number) {
    const childFolders = index.children.get(folder.id) ?? [];
    const hasChildren = childFolders.length > 0;
    const isOpen = expanded.has(folder.id);
    const isActive = activeFolderId === folder.id;
    const isDragTarget = dragOverId === folder.id;

    return (
      <li key={folder.id} className="folder-tree-li">
        <div
          className={`folder-tree-row color-${folder.color} ${isActive ? "is-active" : ""} ${isDragTarget ? "is-drag-over" : ""}`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          onDragOver={(e) => handleDragOver(e, folder.id)}
          onDragLeave={() => {
            if (dragOverId === folder.id) setDragOverId(null);
          }}
          onDrop={(e) => handleDrop(e, folder.id)}
        >
          {hasChildren ? (
            <button
              type="button"
              className="folder-tree-toggle"
              data-open={isOpen ? "true" : "false"}
              aria-label={
                isOpen ? `收起 ${folder.title}` : `展开 ${folder.title}`
              }
              aria-expanded={isOpen}
              onClick={(e) => {
                e.stopPropagation();
                toggleExpand(folder.id);
              }}
            >
              <ChevronRight size={13} className="folder-tree-chevron" />
            </button>
          ) : (
            <span className="folder-tree-spacer" aria-hidden="true" />
          )}
          <button
            type="button"
            className="folder-tree-btn"
            aria-current={isActive ? "page" : undefined}
            title={index.pathOf(folder.id)}
            onClick={() => onSelectFolder(folder.id)}
          >
            {isActive || isOpen ? (
              <FolderOpen size={15} className="folder-tree-icon" />
            ) : (
              <Folder size={15} className="folder-tree-icon" />
            )}
            <span className="folder-tree-label">{folder.title}</span>
            <span className="folder-tree-count">{folder.count}</span>
          </button>
        </div>
        {hasChildren && (isOpen || mountedIds.has(folder.id)) && (
          <div
            className="folder-tree-children"
            data-open={isOpen ? "true" : "false"}
            aria-hidden={!isOpen}
            inert={!isOpen}
          >
            <div className="folder-tree-children-inner">
              <ul className="folder-tree-list" role="group">
                {childFolders.map((child) => renderNode(child, depth + 1))}
              </ul>
            </div>
          </div>
        )}
      </li>
    );
  }

  return (
    <aside className="library-tree-pane" aria-label="概念目录导航">
      <div className="folder-tree-section">
        <div
          className={`folder-tree-row folder-tree-root ${isRootActive ? "is-active" : ""} ${dragOverId === "ROOT" ? "is-drag-over" : ""}`}
          onDragOver={(e) => handleDragOver(e, "ROOT")}
          onDragLeave={() => {
            if (dragOverId === "ROOT") setDragOverId(null);
          }}
          onDrop={(e) => handleDrop(e, null)}
        >
          <button
            type="button"
            className="folder-tree-btn"
            aria-current={isRootActive ? "page" : undefined}
            onClick={() => onSelectFolder(null)}
          >
            <Home size={15} className="folder-tree-icon" />
            <span className="folder-tree-label">{CONCEPT_ROOT_LABEL}</span>
            <span className="folder-tree-count">{totalConcepts}</span>
          </button>
        </div>

        <ul className="folder-tree-list folder-tree-folders">
          {rootFolders.map((f) => renderNode(f, 0))}
          {rootFolders.length === 0 && (
            <li className="folder-tree-empty">暂无文件夹</li>
          )}
        </ul>
      </div>
    </aside>
  );
}
