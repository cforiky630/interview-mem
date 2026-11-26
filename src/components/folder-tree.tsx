"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Clock,
  CopyCheck,
  Edit3,
  Folder,
  FolderOpen,
  Globe,
  Home,
  Link2,
  Rss,
  Star,
  Trash2,
} from "lucide-react";
import type { DeckView } from "@/lib/types";
import type { LibraryQuickView } from "@/lib/navigation";
import {
  ROOT_FOLDER_LABEL,
  buildFolderIndex,
  readExpandedFolderIds,
  writeExpandedFolderIds,
} from "@/lib/folders";

export type DragMovePayload =
  | { kind: "folder"; ids: string[] }
  | { kind: "question"; ids: string[] }
  | { kind: "subscription"; ids: string[] }
  | {
      kind: "mixed";
      folderIds: string[];
      questionIds: string[];
      subscriptionDeckIds: string[];
    };

export const DRAG_MIME = "application/x-shiyi-move";

export function parseDragPayload(
  dt: DataTransfer | null,
): DragMovePayload | null {
  if (!dt) return null;
  const raw = dt.getData(DRAG_MIME) || dt.getData("text/plain");
  if (!raw || !raw.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(raw) as DragMovePayload;
    if (parsed && typeof parsed === "object" && "kind" in parsed) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

export function FolderTree({
  userId,
  decks,
  activeFolderId,
  activeQuickView,
  counts,
  onSelectRoot,
  onSelectFolder,
  onSelectQuickView,
  onDropMove,
}: {
  userId: string;
  decks: readonly DeckView[];
  activeFolderId: string | null;
  activeQuickView: LibraryQuickView | null;
  counts: {
    all: number;
    recent: number;
    favorites: number;
    inbox: number;
    duplicates: number;
    archived: number;
  };
  onSelectRoot: () => void;
  onSelectFolder: (folderId: string) => void;
  onSelectQuickView: (quick: LibraryQuickView) => void;
  onDropMove: (targetFolderId: string | null, payload: DragMovePayload) => void;
}) {
  const index = useMemo(() => buildFolderIndex(decks), [decks]);
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    readExpandedFolderIds(userId),
  );
  const [dragOverId, setDragOverId] = useState<string | "ROOT" | null>(null);

  useEffect(() => {
    setExpanded(readExpandedFolderIds(userId));
  }, [userId]);

  // Auto-expand ancestor chain whenever activeFolderId changes.
  useEffect(() => {
    if (!activeFolderId) return;
    const ancestors = index.ancestorIds(activeFolderId);
    const activeDeck = index.byId.get(activeFolderId);
    const parentToExpand =
      activeDeck && !activeDeck.isOwner && activeDeck.parentId
        ? [...index.ancestorIds(activeDeck.parentId), activeDeck.parentId]
        : ancestors;
    if (!parentToExpand.length) return;
    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of parentToExpand) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      if (changed) writeExpandedFolderIds(userId, next);
      return changed ? next : prev;
    });
  }, [activeFolderId, index, userId]);

  function toggleExpand(folderId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      writeExpandedFolderIds(userId, next);
      return next;
    });
  }

  function handleDragOver(
    e: React.DragEvent,
    targetKey: string | "ROOT",
  ) {
    if (
      e.dataTransfer.types.includes(DRAG_MIME) ||
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
    const payload = parseDragPayload(e.dataTransfer);
    if (!payload) return;
    onDropMove(targetFolderId, payload);
  }

  const rootOwned = index.ownedChildren.get(null) ?? [];
  const rootSubs = index.subscriptionsByFolder.get(null) ?? [];
  const isRootActive = !activeQuickView && activeFolderId === null;

  function renderOwnedNode(folder: DeckView, depth: number) {
    const childFolders = index.ownedChildren.get(folder.id) ?? [];
    const placedSubs = index.subscriptionsByFolder.get(folder.id) ?? [];
    const hasChildren = childFolders.length > 0 || placedSubs.length > 0;
    const isOpen = expanded.has(folder.id);
    const isActive = !activeQuickView && activeFolderId === folder.id;
    const isDragTarget = dragOverId === folder.id;
    const isPublished =
      folder.publishedVersion > 0 && folder.visibility !== "private";

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
              aria-label={isOpen ? `收起 ${folder.title}` : `展开 ${folder.title}`}
              aria-expanded={isOpen}
              onClick={(e) => {
                e.stopPropagation();
                toggleExpand(folder.id);
              }}
            >
              {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
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
            {isPublished && (
              <span
                className="folder-tree-pub-mark"
                title={
                  folder.visibility === "public"
                    ? `已公开 v${folder.publishedVersion}`
                    : `链接分享 v${folder.publishedVersion}`
                }
              >
                {folder.visibility === "public" ? (
                  <Globe size={11} />
                ) : (
                  <Link2 size={11} />
                )}
              </span>
            )}
            <span className="folder-tree-count">{folder.count}</span>
          </button>
        </div>
        {hasChildren && isOpen && (
          <ul className="folder-tree-list">
            {childFolders.map((child) => renderOwnedNode(child, depth + 1))}
            {placedSubs.map((sub) => renderSubNode(sub, depth + 1))}
          </ul>
        )}
      </li>
    );
  }

  function renderSubNode(sub: DeckView, depth: number) {
    const isActive = !activeQuickView && activeFolderId === sub.id;
    return (
      <li key={sub.id} className="folder-tree-li">
        <div
          className={`folder-tree-row is-subscription color-${sub.color} ${isActive ? "is-active" : ""}`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          <span className="folder-tree-spacer" aria-hidden="true" />
          <button
            type="button"
            className="folder-tree-btn"
            aria-current={isActive ? "page" : undefined}
            title={`订阅资料 · ${sub.ownerName}`}
            onClick={() => onSelectFolder(sub.id)}
          >
            <Rss size={14} className="folder-tree-sub-icon" />
            <span className="folder-tree-label">{sub.title}</span>
            {Boolean(sub.pendingUpdate) && (
              <span className="folder-tree-dot" title="有新版本可更新" />
            )}
            <span className="folder-tree-count">{sub.count}</span>
          </button>
        </div>
      </li>
    );
  }

  const quickItems: {
    id: LibraryQuickView;
    label: string;
    icon: React.ReactNode;
    count?: number;
    accent?: boolean;
  }[] = [
    {
      id: "recent",
      label: "最近打开",
      icon: <Clock size={15} />,
      count: counts.recent,
    },
    {
      id: "favorites",
      label: "收藏",
      icon: <Star size={15} />,
      count: counts.favorites,
    },
    {
      id: "inbox",
      label: "待补答案",
      icon: <Edit3 size={15} />,
      count: counts.inbox,
      accent: counts.inbox > 0,
    },
    {
      id: "duplicates",
      label: "重复内容",
      icon: <CopyCheck size={15} />,
      count: counts.duplicates,
      accent: counts.duplicates > 0,
    },
    {
      id: "archived",
      label: "已归档",
      icon: <Archive size={15} />,
      count: counts.archived,
    },
    {
      id: "trash",
      label: "回收站",
      icon: <Trash2 size={15} />,
    },
  ];

  return (
    <aside className="library-tree-pane" aria-label="资料目录导航">
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
            onClick={onSelectRoot}
          >
            <Home size={15} className="folder-tree-icon" />
            <span className="folder-tree-label">{ROOT_FOLDER_LABEL}</span>
            <span className="folder-tree-count">{counts.all}</span>
          </button>
        </div>

        <ul className="folder-tree-list folder-tree-folders">
          {rootOwned.map((f) => renderOwnedNode(f, 0))}
          {rootSubs.map((sub) => renderSubNode(sub, 0))}
          {rootOwned.length === 0 && rootSubs.length === 0 && (
            <li className="folder-tree-empty">暂无文件夹</li>
          )}
        </ul>
      </div>

      <div className="folder-tree-divider" />

      <div className="folder-tree-section">
        <div className="folder-tree-heading">快捷视图</div>
        <ul className="folder-tree-list">
          {quickItems.map((item) => {
            const active = activeQuickView === item.id;
            return (
              <li key={item.id} className="folder-tree-li">
                <div className={`folder-tree-row ${active ? "is-active" : ""}`}>
                  <button
                    type="button"
                    className="folder-tree-btn"
                    aria-current={active ? "page" : undefined}
                    onClick={() => onSelectQuickView(item.id)}
                  >
                    <span className="folder-tree-quick-icon">{item.icon}</span>
                    <span className="folder-tree-label">{item.label}</span>
                    {typeof item.count === "number" && item.count > 0 && (
                      <span
                        className={`folder-tree-count ${item.accent ? "is-accent" : ""}`}
                      >
                        {item.count}
                      </span>
                    )}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
