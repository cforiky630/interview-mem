"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Folder,
  FolderInput,
  FolderPlus,
  Home,
  Loader2,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import type {
  DeckView,
  FolderConflictItem,
  FolderConflictStrategy,
} from "@/lib/types";
import {
  RequestError,
  batchMoveQuestionsToFolder,
  createFolder,
  moveFolder,
  moveQuestionToFolder,
  placeSubscriptionInFolder,
  type DuplicateMoveStrategy,
  type WorkspaceMutate,
} from "@/lib/client";
import {
  MAX_FOLDER_DEPTH,
  ROOT_FOLDER_LABEL,
  buildFolderIndex,
  validateFolderTitle,
} from "@/lib/folders";
import { isImeComposing } from "./folder-dialogs";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

export type DuplicateConflictDetail = {
  sourceId: string;
  existingId: string;
  title: string;
  targetDeckId: string | null;
  targetPath: string;
};

export type MoveSelection = {
  folderIds?: string[];
  questionIds?: string[];
  subscriptionDeckIds?: string[];
  label?: string;
  initialTargetId?: string | null;
  initialFolderConflicts?: FolderConflictItem[];
  initialDupConflicts?: DuplicateConflictDetail[];
};

export function FolderMoveDialog({
  selection,
  decks,
  mutate,
  onClose,
  onDone,
}: {
  selection: MoveSelection | null;
  decks: readonly DeckView[];
  mutate: WorkspaceMutate;
  onClose: () => void;
  onDone?: (targetFolderId: string | null) => void;
}) {
  const index = useMemo(() => buildFolderIndex(decks), [decks]);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [creatingInline, setCreatingInline] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [busy, setBusy] = useState(false);
  const [folderConflicts, setFolderConflicts] = useState<
    FolderConflictItem[] | null
  >(null);
  const [dupConflicts, setDupConflicts] = useState<
    DuplicateConflictDetail[] | null
  >(null);
  const [completedFolders, setCompletedFolders] = useState<Set<string>>(
    () => new Set(),
  );
  const [completedQuestions, setCompletedQuestions] = useState(false);
  const [completedSubs, setCompletedSubs] = useState<Set<string>>(
    () => new Set(),
  );

  const folderIds = selection?.folderIds ?? [];
  const questionIds = selection?.questionIds ?? [];
  const subIds = selection?.subscriptionDeckIds ?? [];

  const remainingFolderIds = useMemo(
    () => folderIds.filter((id) => !completedFolders.has(id)),
    [folderIds, completedFolders],
  );
  const remainingQuestionIds = useMemo(
    () => (completedQuestions ? [] : questionIds),
    [questionIds, completedQuestions],
  );
  const remainingSubIds = useMemo(
    () => subIds.filter((id) => !completedSubs.has(id)),
    [subIds, completedSubs],
  );
  const hasPartialProgress =
    completedFolders.size > 0 || completedQuestions || completedSubs.size > 0;

  useEffect(() => {
    if (!selection) return;
    setTargetId(selection.initialTargetId ?? null);
    setSearch("");
    setCreatingInline(false);
    setNewFolderName("");
    setFolderConflicts(
      selection.initialFolderConflicts?.length
        ? selection.initialFolderConflicts
        : null,
    );
    setDupConflicts(
      selection.initialDupConflicts?.length
        ? selection.initialDupConflicts
        : null,
    );
    setCompletedFolders(new Set());
    setCompletedQuestions(false);
    setCompletedSubs(new Set());
  }, [selection]);

  // Compute disabled target IDs (cycle prevention + depth <= 8 for remaining moving folders).
  const disabledReasons = useMemo(() => {
    const map = new Map<string, string>();
    if (!remainingFolderIds.length) return map;
    const movingSubtreeMaxHeight = Math.max(
      ...remainingFolderIds.map((fid) => index.subtreeHeight(fid)),
    );
    for (const fid of remainingFolderIds) {
      for (const desc of index.subtreeOwnedIds(fid)) {
        map.set(desc, "不能移入自身或子文件夹");
      }
    }
    for (const item of index.flatOwned) {
      if (map.has(item.folder.id)) continue;
      if (item.depth + movingSubtreeMaxHeight > MAX_FOLDER_DEPTH) {
        map.set(item.folder.id, `超过 ${MAX_FOLDER_DEPTH} 层上限`);
      }
    }
    return map;
  }, [remainingFolderIds, index]);

  const titleCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of index.flatOwned) {
      const key = item.folder.title.trim().toLowerCase();
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [index]);

  const filteredFolders = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return index.flatOwned;
    return index.flatOwned.filter(
      (item) =>
        item.folder.title.toLowerCase().includes(q) ||
        item.path.toLowerCase().includes(q),
    );
  }, [index, search]);

  const inlineNameError = newFolderName.trim()
    ? validateFolderTitle(newFolderName)
    : null;
  const canCreateInline =
    !busy &&
    !!newFolderName.trim() &&
    !inlineNameError &&
    (targetId === null || index.depthOf(targetId) < MAX_FOLDER_DEPTH);

  if (!selection) return null;

  const totalItems =
    remainingFolderIds.length +
    remainingQuestionIds.length +
    remainingSubIds.length;
  const targetPath = targetId ? index.pathOf(targetId) : ROOT_FOLDER_LABEL;

  function handleClose() {
    if (hasPartialProgress) onDone?.(targetId);
    onClose();
  }

  async function handleInlineCreate() {
    if (!canCreateInline) return;
    setBusy(true);
    try {
      const res = await createFolder(mutate, {
        title: newFolderName.trim(),
        parentId: targetId,
      });
      if (res) {
        const createdId =
          (res.deck as { id?: string } | undefined)?.id ??
          (typeof res.id === "string" ? res.id : "");
        if (createdId) setTargetId(createdId);
        setNewFolderName("");
        setCreatingInline(false);
        toast.success("已新建文件夹并选中。");
      }
    } finally {
      setBusy(false);
    }
  }

  async function executeMove(
    folderStrategy: FolderConflictStrategy = "abort",
    dupStrategy: DuplicateMoveStrategy = "check",
  ) {
    if (busy) return;
    if (targetId && disabledReasons.has(targetId)) return;
    setBusy(true);
    setFolderConflicts(null);
    setDupConflicts(null);
    try {
      // 1. Move remaining selected owned folders.
      for (const fid of remainingFolderIds) {
        const res = await moveFolder(
          mutate,
          {
            folderId: fid,
            targetParentId: targetId,
            conflictStrategy: folderStrategy,
          },
          { throwOnCodes: ["FOLDER_NAME_CONFLICT"] },
        );
        if (!res) return;
        setCompletedFolders((prev) => {
          const next = new Set(prev);
          next.add(fid);
          return next;
        });
      }

      // 2. Move selected owned questions (skipped on retry if already completed).
      if (remainingQuestionIds.length === 1) {
        const res = await moveQuestionToFolder(
          mutate,
          remainingQuestionIds[0],
          targetId,
          dupStrategy,
          { throwOnCodes: ["DUPLICATE_IN_TARGET"] },
        );
        if (!res) return;
        setCompletedQuestions(true);
      } else if (remainingQuestionIds.length > 1) {
        const res = await batchMoveQuestionsToFolder(
          mutate,
          remainingQuestionIds,
          targetId,
          dupStrategy,
          { throwOnCodes: ["DUPLICATE_IN_TARGET"] },
        );
        if (!res) return;
        setCompletedQuestions(true);
      }

      // 3. Place remaining selected subscriptions into target folder.
      for (const subId of remainingSubIds) {
        const res = await placeSubscriptionInFolder(mutate, subId, targetId);
        if (!res) return;
        setCompletedSubs((prev) => {
          const next = new Set(prev);
          next.add(subId);
          return next;
        });
      }

      toast.success(`已移动到「${targetPath}」。`);
      onClose();
      onDone?.(targetId);
    } catch (e) {
      if (e instanceof RequestError && e.code === "FOLDER_NAME_CONFLICT") {
        const list = Array.isArray(e.details?.conflicts)
          ? (e.details!.conflicts as FolderConflictItem[])
          : [];
        setFolderConflicts(list);
      } else if (
        e instanceof RequestError &&
        e.code === "DUPLICATE_IN_TARGET"
      ) {
        const list = Array.isArray(e.details?.conflicts)
          ? (e.details!.conflicts as DuplicateConflictDetail[])
          : [];
        setDupConflicts(list);
      } else {
        toast.error(e instanceof Error ? e.message : "移动失败，请重试。");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !busy) handleClose();
      }}
      title="移动到文件夹"
      description={
        selection.label && !hasPartialProgress
          ? `移动「${selection.label}」· 保留所有学习进度与个人笔记`
          : `移动已选的 ${totalItems} 项内容 · 保留所有学习进度与个人笔记`
      }
      className="folder-move-dialog"
    >
      <div className="dialog-form">
        <div className="folder-move-search">
          <Search size={15} />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索目标文件夹名称或路径…"
            aria-label="搜索目标文件夹"
            disabled={busy}
            autoFocus
          />
        </div>

        <div
          className="folder-move-list"
          role="listbox"
          aria-label="选择目标位置"
        >
          {!search.trim() && (
            <button
              type="button"
              role="option"
              aria-selected={targetId === null}
              className={`folder-move-item ${targetId === null ? "is-selected" : ""}`}
              disabled={busy}
              onClick={() => {
                setTargetId(null);
                setFolderConflicts(null);
                setDupConflicts(null);
              }}
            >
              <Home size={15} />
              <span className="folder-move-title">{ROOT_FOLDER_LABEL}</span>
              <span className="folder-move-hint">根目录</span>
              {targetId === null && (
                <Check size={15} className="folder-move-check" />
              )}
            </button>
          )}
          {filteredFolders.map((item) => {
            const disabledReason = disabledReasons.get(item.folder.id);
            const selected = targetId === item.folder.id;
            const hasDuplicateName =
              (titleCounts.get(item.folder.title.trim().toLowerCase()) ?? 0) >
              1;
            const showFullPath = Boolean(search.trim()) || hasDuplicateName;
            return (
              <button
                key={item.folder.id}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={busy || Boolean(disabledReason)}
                className={`folder-move-item color-${item.folder.color} ${selected ? "is-selected" : ""} ${disabledReason ? "is-disabled" : ""}`}
                style={{
                  paddingLeft: search.trim()
                    ? "12px"
                    : `${12 + (item.depth - 1) * 16}px`,
                }}
                onClick={() => {
                  setTargetId(item.folder.id);
                  setFolderConflicts(null);
                  setDupConflicts(null);
                }}
              >
                <Folder size={15} className="folder-tree-icon" />
                <span className="folder-move-text">
                  <span className="folder-move-title">{item.folder.title}</span>
                  {showFullPath && (
                    <span className="folder-move-path">{item.path}</span>
                  )}
                </span>
                {disabledReason ? (
                  <span className="folder-move-hint">{disabledReason}</span>
                ) : selected ? (
                  <Check size={15} className="folder-move-check" />
                ) : null}
              </button>
            );
          })}
          {filteredFolders.length === 0 && (
            <p className="muted small" style={{ padding: "12px" }}>
              没有匹配的文件夹。
            </p>
          )}
        </div>

        {!creatingInline ? (
          <div className="folder-move-inline-trigger">
            <button
              type="button"
              className="text-button"
              disabled={
                busy ||
                (targetId !== null &&
                  index.depthOf(targetId) >= MAX_FOLDER_DEPTH)
              }
              onClick={() => setCreatingInline(true)}
            >
              <FolderPlus size={14} /> 在「{targetPath}」下新建文件夹
            </button>
          </div>
        ) : (
          <div className="folder-move-inline-form">
            <input
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !isImeComposing(e) &&
                  canCreateInline
                ) {
                  e.preventDefault();
                  void handleInlineCreate();
                }
              }}
              placeholder={`在「${targetPath}」下输入新文件夹名称…`}
              maxLength={80}
              disabled={busy}
              autoFocus
            />
            <Button
              type="button"
              size="sm"
              disabled={!canCreateInline}
              onClick={() => void handleInlineCreate()}
            >
              新建
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setCreatingInline(false);
                setNewFolderName("");
              }}
            >
              取消
            </Button>
            {inlineNameError && (
              <small className="danger-text" style={{ width: "100%" }}>
                {inlineNameError}
              </small>
            )}
          </div>
        )}

        {folderConflicts && (
          <div className="conflict-box" role="alert">
            <div className="conflict-box-head">
              <AlertTriangle size={15} />
              <strong>目标位置已有同名文件夹</strong>
            </div>
            <p className="muted small">
              「{targetPath}」中已存在
              {folderConflicts.map((c) => `「${c.title}」`).join("、")}
              ，请选择处理方式：
            </p>
            <div className="conflict-box-actions">
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => void executeMove("merge", "check")}
              >
                合并内容
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void executeMove("keepBoth", "check")}
              >
                保留两者（自动编号）
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setFolderConflicts(null)}
              >
                取消
              </Button>
            </div>
          </div>
        )}

        {dupConflicts && (
          <div className="conflict-box" role="alert">
            <div className="conflict-box-head">
              <AlertTriangle size={15} />
              <strong>
                目标文件夹已有 {dupConflicts.length} 条内容完全相同的资料
              </strong>
            </div>
            <p className="muted small">
              {dupConflicts
                .slice(0, 3)
                .map((c) => `「${c.title}」`)
                .join("、")}
              {dupConflicts.length > 3 ? "等" : ""}
              。系统不会自动覆盖或合并复习记录，请选择：
            </p>
            <div className="conflict-box-actions">
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => void executeMove("abort", "keepBoth")}
              >
                保留两份并移动
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void executeMove("abort", "skip")}
              >
                跳过重复项（留在原处）
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setDupConflicts(null)}
              >
                取消
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="dialog-footer">
        <span className="muted small" style={{ marginRight: "auto" }}>
          目标：{targetPath}
        </span>
        <Button variant="ghost" disabled={busy} onClick={handleClose}>
          取消
        </Button>
        {!folderConflicts && !dupConflicts && (
          <Button
            disabled={
              busy || Boolean(targetId && disabledReasons.has(targetId))
            }
            onClick={() => void executeMove("abort", "check")}
          >
            {busy ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <FolderInput size={15} />
            )}{" "}
            移动到此处
          </Button>
        )}
      </div>
    </Dialog>
  );
}
