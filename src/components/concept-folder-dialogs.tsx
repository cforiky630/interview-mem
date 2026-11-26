"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Folder,
  FolderInput,
  FolderMinus,
  FolderPlus,
  Home,
  Loader2,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type {
  ConceptFolderView,
  FolderConflictItem,
  FolderConflictStrategy,
} from "@/lib/types";
import {
  RequestError,
  createConceptFolder,
  deleteConceptFolder,
  dissolveConceptFolder,
  editConceptFolder,
  groupIntoNewConceptFolder,
  moveConceptFolder,
  moveConceptsToFolder,
  type WorkspaceMutate,
} from "@/lib/client";
import { CONCEPT_ROOT_LABEL, buildConceptFolderIndex } from "@/lib/concepts";
import { MAX_FOLDER_DEPTH, validateFolderTitle } from "@/lib/folders";
import { FolderColorSwatches, isImeComposing } from "./folder-dialogs";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

export type ConceptMoveSelection = {
  folderIds?: string[];
  conceptIds?: string[];
  label?: string;
  initialTargetId?: string | null;
  initialFolderConflicts?: FolderConflictItem[];
};

export function CreateConceptFolderDialog({
  open,
  parentId,
  folders,
  mutate,
  onClose,
  onCreated,
}: {
  open: boolean;
  parentId: string | null;
  folders: readonly ConceptFolderView[];
  mutate: WorkspaceMutate;
  onClose: () => void;
  onCreated?: (id: string) => void;
}) {
  const index = useMemo(() => buildConceptFolderIndex(folders), [folders]);
  const [title, setTitle] = useState("");
  const [color, setColor] = useState("sage");
  const [busy, setBusy] = useState(false);
  const [nameConflict, setNameConflict] = useState<string | null>(null);

  const parentPath = parentId ? index.pathOf(parentId) : CONCEPT_ROOT_LABEL;
  const validationError = title.trim() ? validateFolderTitle(title) : null;
  const canSubmit = !busy && !!title.trim() && !validationError;

  useEffect(() => {
    if (open) {
      setTitle("");
      setNameConflict(null);
      const parent = parentId ? index.byId.get(parentId) : undefined;
      setColor(parent?.color || "sage");
    }
  }, [open, parentId, index]);

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setNameConflict(null);
    try {
      const result = await createConceptFolder(
        mutate,
        {
          title: title.trim(),
          parentId,
          color,
        },
        { throwOnCodes: ["FOLDER_NAME_CONFLICT"] },
      );
      if (result) {
        const folder = result.folder as ConceptFolderView | undefined;
        const id = folder?.id ?? String(result.id ?? "");
        toast.success("文件夹已创建。");
        onClose();
        if (id) onCreated?.(id);
      }
    } catch (err) {
      if (err instanceof RequestError && err.code === "FOLDER_NAME_CONFLICT") {
        setNameConflict(
          err.message || `当前位置已存在同名文件夹「${title.trim()}」。`,
        );
      } else {
        toast.error(err instanceof Error ? err.message : "创建文件夹失败。");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
      title="新建文件夹"
      description={`将在「${parentPath}」下创建`}
    >
      <form onSubmit={(e) => void handleSubmit(e)}>
        <div className="dialog-form">
          <label className="field">
            文件夹名称
            <input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                if (nameConflict) setNameConflict(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isImeComposing(e) && canSubmit) {
                  e.preventDefault();
                  void handleSubmit();
                }
              }}
              maxLength={80}
              disabled={busy}
              placeholder="例如：技术、RAG、系统设计"
              autoFocus
            />
            {(validationError || nameConflict) && (
              <small className="danger-text" role="alert">
                {validationError || nameConflict}
              </small>
            )}
          </label>
          <div className="field">
            标识颜色
            <FolderColorSwatches value={color} onChange={setColor} />
          </div>
        </div>
        <div className="dialog-footer">
          <Button variant="ghost" type="button" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {busy ? (
              <Loader2 size={16} className="spin" />
            ) : (
              <FolderPlus size={16} />
            )}{" "}
            创建文件夹
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function EditConceptFolderDialog({
  folder,
  mutate,
  onClose,
}: {
  folder: ConceptFolderView | null;
  mutate: WorkspaceMutate;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [color, setColor] = useState("sage");
  const [busy, setBusy] = useState(false);
  const [nameConflict, setNameConflict] = useState<string | null>(null);

  useEffect(() => {
    if (folder) {
      setTitle(folder.title);
      setColor(folder.color || "sage");
      setNameConflict(null);
    }
  }, [folder]);

  const titleChanged = Boolean(folder && title.trim() !== folder.title);
  const validationError =
    titleChanged && title.trim() ? validateFolderTitle(title) : null;
  const dirty =
    Boolean(folder) &&
    (title.trim() !== folder!.title || color !== (folder!.color || "sage"));
  const canSubmit = !busy && !!title.trim() && dirty && !validationError;

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!folder || !canSubmit) return;
    setBusy(true);
    setNameConflict(null);
    try {
      const result = await editConceptFolder(
        mutate,
        {
          id: folder.id,
          title: title.trim(),
          color,
        },
        { throwOnCodes: ["FOLDER_NAME_CONFLICT"] },
      );
      if (result) {
        toast.success("文件夹信息已更新。");
        onClose();
      }
    } catch (err) {
      if (err instanceof RequestError && err.code === "FOLDER_NAME_CONFLICT") {
        setNameConflict(
          err.message || `同级目录已存在同名文件夹「${title.trim()}」。`,
        );
      } else {
        toast.error(err instanceof Error ? err.message : "更新文件夹失败。");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={Boolean(folder)}
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
      title="编辑文件夹"
    >
      <form onSubmit={(e) => void handleSubmit(e)}>
        <div className="dialog-form">
          <label className="field">
            文件夹名称
            <input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                if (nameConflict) setNameConflict(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isImeComposing(e) && canSubmit) {
                  e.preventDefault();
                  void handleSubmit();
                }
              }}
              maxLength={80}
              disabled={busy}
              placeholder="输入文件夹名称"
              autoFocus
            />
            {(validationError || nameConflict) && (
              <small className="danger-text" role="alert">
                {validationError || nameConflict}
              </small>
            )}
          </label>
          <div className="field">
            标识颜色
            <FolderColorSwatches value={color} onChange={setColor} />
          </div>
        </div>
        <div className="dialog-footer">
          <Button variant="ghost" type="button" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />}{" "}
            保存修改
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function ConceptFolderMoveDialog({
  selection,
  folders,
  mutate,
  onClose,
  onDone,
}: {
  selection: ConceptMoveSelection | null;
  folders: readonly ConceptFolderView[];
  mutate: WorkspaceMutate;
  onClose: () => void;
  onDone?: (targetFolderId: string | null) => void;
}) {
  const index = useMemo(() => buildConceptFolderIndex(folders), [folders]);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [folderConflicts, setFolderConflicts] = useState<
    FolderConflictItem[] | null
  >(null);
  const [completedFolders, setCompletedFolders] = useState<Set<string>>(
    () => new Set(),
  );
  const [completedConcepts, setCompletedConcepts] = useState(false);

  const folderIds = selection?.folderIds ?? [];
  const conceptIds = selection?.conceptIds ?? [];

  const remainingFolderIds = useMemo(
    () => folderIds.filter((id) => !completedFolders.has(id)),
    [folderIds, completedFolders],
  );
  const remainingConceptIds = useMemo(
    () => (completedConcepts ? [] : conceptIds),
    [conceptIds, completedConcepts],
  );
  const hasPartialProgress = completedFolders.size > 0 || completedConcepts;

  useEffect(() => {
    if (!selection) return;
    setTargetId(selection.initialTargetId ?? null);
    setSearch("");
    setFolderConflicts(
      selection.initialFolderConflicts?.length
        ? selection.initialFolderConflicts
        : null,
    );
    setCompletedFolders(new Set());
    setCompletedConcepts(false);
  }, [selection]);

  const disabledReasons = useMemo(() => {
    const map = new Map<string, string>();
    if (!remainingFolderIds.length) return map;
    const movingSubtreeMaxHeight = Math.max(
      ...remainingFolderIds.map((fid) => index.subtreeHeight(fid)),
    );
    for (const fid of remainingFolderIds) {
      for (const desc of index.descendantIds(fid)) {
        map.set(desc, "不能移入自身或子文件夹");
      }
    }
    for (const item of index.flatList) {
      if (map.has(item.folder.id)) continue;
      if (item.depth + movingSubtreeMaxHeight > MAX_FOLDER_DEPTH) {
        map.set(item.folder.id, `超过 ${MAX_FOLDER_DEPTH} 层上限`);
      }
    }
    return map;
  }, [remainingFolderIds, index]);

  const titleCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of index.flatList) {
      const key = item.folder.title.trim().toLowerCase();
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [index]);

  const filteredFolders = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return index.flatList;
    return index.flatList.filter(
      (item) =>
        item.folder.title.toLowerCase().includes(q) ||
        item.path.toLowerCase().includes(q),
    );
  }, [index, search]);

  if (!selection) return null;

  const totalItems = remainingFolderIds.length + remainingConceptIds.length;
  const targetPath = targetId ? index.pathOf(targetId) : CONCEPT_ROOT_LABEL;

  function handleClose() {
    if (hasPartialProgress) onDone?.(targetId);
    onClose();
  }

  async function executeMove(strategy: FolderConflictStrategy = "abort") {
    if (busy) return;
    if (targetId && disabledReasons.has(targetId)) return;
    setBusy(true);
    setFolderConflicts(null);
    try {
      for (const fid of remainingFolderIds) {
        const res = await moveConceptFolder(
          mutate,
          {
            folderId: fid,
            targetParentId: targetId,
            conflictStrategy: strategy,
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

      if (remainingConceptIds.length > 0) {
        const res = await moveConceptsToFolder(
          mutate,
          remainingConceptIds,
          targetId,
        );
        if (!res) return;
        setCompletedConcepts(true);
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
          ? `移动「${selection.label}」`
          : `移动已选的 ${totalItems} 项内容`
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
              }}
            >
              <Home size={15} />
              <span className="folder-move-title">{CONCEPT_ROOT_LABEL}</span>
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
                onClick={() => void executeMove("merge")}
              >
                合并内容
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void executeMove("keepBoth")}
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
      </div>

      <div className="dialog-footer">
        <span className="muted small" style={{ marginRight: "auto" }}>
          目标：{targetPath}
        </span>
        <Button variant="ghost" disabled={busy} onClick={handleClose}>
          取消
        </Button>
        {!folderConflicts && (
          <Button
            disabled={
              busy || Boolean(targetId && disabledReasons.has(targetId))
            }
            onClick={() => void executeMove("abort")}
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

export function GroupIntoNewConceptFolderDialog({
  open,
  parentId,
  folders,
  folderIds,
  conceptIds,
  mutate,
  onClose,
  onDone,
}: {
  open: boolean;
  parentId: string | null;
  folders: readonly ConceptFolderView[];
  folderIds: string[];
  conceptIds: string[];
  mutate: WorkspaceMutate;
  onClose: () => void;
  onDone?: (createdId: string) => void;
}) {
  const index = useMemo(() => buildConceptFolderIndex(folders), [folders]);
  const [title, setTitle] = useState("");
  const [color, setColor] = useState("sage");
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState<FolderConflictItem[] | null>(null);
  const [parentNameConflict, setParentNameConflict] = useState<string | null>(
    null,
  );

  const totalCount = folderIds.length + conceptIds.length;
  const parentPath = parentId ? index.pathOf(parentId) : CONCEPT_ROOT_LABEL;
  const validationError = title.trim() ? validateFolderTitle(title) : null;
  const canSubmit = !busy && !!title.trim() && !validationError && totalCount > 0;

  useEffect(() => {
    if (open) {
      setTitle("");
      setConflicts(null);
      setParentNameConflict(null);
      const parent = parentId ? index.byId.get(parentId) : undefined;
      setColor(parent?.color || "sage");
    }
  }, [open, parentId, index]);

  async function runGroup(strategy: FolderConflictStrategy = "abort") {
    if (!canSubmit) return;
    setBusy(true);
    setParentNameConflict(null);
    try {
      const res = await groupIntoNewConceptFolder(
        mutate,
        {
          parentId,
          title: title.trim(),
          color,
          folderIds,
          conceptIds,
          conflictStrategy: strategy,
        },
        { throwOnCodes: ["FOLDER_NAME_CONFLICT"] },
      );
      if (res) {
        const folder = res.folder as ConceptFolderView | undefined;
        toast.success(`已归入新文件夹「${title.trim()}」。`);
        onClose();
        if (folder?.id) onDone?.(folder.id);
      }
    } catch (e) {
      if (e instanceof RequestError && e.code === "FOLDER_NAME_CONFLICT") {
        const list = Array.isArray(e.details?.conflicts)
          ? (e.details!.conflicts as FolderConflictItem[])
          : [];
        const isParentCollision =
          e.details?.conflictKind === "targetParent" ||
          list.some((item) => !item.sourceId);
        if (isParentCollision) {
          setConflicts(null);
          setParentNameConflict(
            e.message || `当前位置已存在同名文件夹「${title.trim()}」，请换一个名称。`,
          );
        } else {
          setConflicts(list);
        }
      } else {
        toast.error(e instanceof Error ? e.message : "归入失败，请重试。");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
      title="归入新文件夹"
      description={`将在「${parentPath}」新建文件夹，并移入已选的 ${totalCount} 项内容。`}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void runGroup("abort");
        }}
      >
        <div className="dialog-form">
          <label className="field">
            新文件夹名称
            <input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setConflicts(null);
                setParentNameConflict(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isImeComposing(e) && canSubmit) {
                  e.preventDefault();
                  void runGroup("abort");
                }
              }}
              maxLength={80}
              disabled={busy}
              placeholder="例如：检索增强、底层原理"
              autoFocus
            />
            {(validationError || parentNameConflict) && (
              <small className="danger-text" role="alert">
                {validationError || parentNameConflict}
              </small>
            )}
          </label>
          <div className="field">
            标识颜色
            <FolderColorSwatches value={color} onChange={setColor} />
          </div>
          {conflicts && (
            <div className="conflict-box" role="alert">
              <div className="conflict-box-head">
                <AlertTriangle size={15} />
                <strong>所选文件夹包含同名项</strong>
              </div>
              <p className="muted small">
                {conflicts.map((c) => `「${c.title}」`).join("、")}
                在新文件夹内存在同名冲突，请选择处理方式：
              </p>
              <div className="conflict-box-actions">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => void runGroup("merge")}
                >
                  合并同名文件夹
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void runGroup("keepBoth")}
                >
                  保留两者（自动编号）
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setConflicts(null)}
                >
                  取消
                </Button>
              </div>
            </div>
          )}
        </div>
        <div className="dialog-footer">
          <Button variant="ghost" type="button" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {busy ? (
              <Loader2 size={16} className="spin" />
            ) : (
              <FolderPlus size={16} />
            )}{" "}
            创建并归入
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function DissolveConceptFolderDialog({
  folder,
  folders,
  mutate,
  onClose,
  onDone,
}: {
  folder: ConceptFolderView | null;
  folders: readonly ConceptFolderView[];
  mutate: WorkspaceMutate;
  onClose: () => void;
  onDone?: (parentId: string | null) => void;
}) {
  const index = useMemo(() => buildConceptFolderIndex(folders), [folders]);
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState<FolderConflictItem[] | null>(null);

  useEffect(() => {
    setConflicts(null);
  }, [folder?.id]);

  if (!folder) return null;

  const parentId =
    folder.parentId && index.byId.has(folder.parentId) ? folder.parentId : null;
  const parentLabel = parentId ? index.pathOf(parentId) : CONCEPT_ROOT_LABEL;
  const childCount = (index.children.get(folder.id) ?? []).length;
  const directItems = folder.directCount ?? 0;

  async function runDissolve(strategy: FolderConflictStrategy = "abort") {
    if (!folder || busy) return;
    setBusy(true);
    try {
      const res = await dissolveConceptFolder(mutate, folder.id, strategy, {
        throwOnCodes: ["FOLDER_NAME_CONFLICT"],
      });
      if (res) {
        toast.success(`已解散「${folder.title}」，内容已上移到「${parentLabel}」。`);
        onClose();
        onDone?.(parentId);
      }
    } catch (e) {
      if (e instanceof RequestError && e.code === "FOLDER_NAME_CONFLICT") {
        const list = Array.isArray(e.details?.conflicts)
          ? (e.details!.conflicts as FolderConflictItem[])
          : [];
        setConflicts(list);
      } else {
        toast.error(e instanceof Error ? e.message : "解散文件夹失败，请重试。");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
      title={`解散「${folder.title}」`}
      description="仅移除这一层文件夹外壳，所有概念与子文件夹都会安全上移一层。"
    >
      <div className="dialog-form">
        <p className="muted">
          解散后，当前文件夹内的
          {[
            childCount ? ` ${childCount} 个子文件夹` : "",
            directItems ? ` ${directItems} 条概念` : "",
          ]
            .filter(Boolean)
            .join("、") || "全部内容"}
          将直接上移到「<strong>{parentLabel}</strong>」，不会删除任何概念。
        </p>
        {conflicts && (
          <div className="conflict-box" role="alert">
            <div className="conflict-box-head">
              <AlertTriangle size={15} />
              <strong>上级目录已有同名子文件夹</strong>
            </div>
            <p className="muted small">
              「{parentLabel}」中已存在
              {conflicts.map((c) => `「${c.title}」`).join("、")}
              ，请选择处理方式：
            </p>
            <div className="conflict-box-actions">
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => void runDissolve("merge")}
              >
                合并同名文件夹
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void runDissolve("keepBoth")}
              >
                保留两者（自动编号）
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setConflicts(null)}
              >
                取消
              </Button>
            </div>
          </div>
        )}
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          取消
        </Button>
        {!conflicts && (
          <Button disabled={busy} onClick={() => void runDissolve("abort")}>
            {busy ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <FolderMinus size={15} />
            )}{" "}
            解散文件夹
          </Button>
        )}
      </div>
    </Dialog>
  );
}

export function DeleteConceptFolderDialog({
  folder,
  folders,
  mutate,
  onClose,
  onSwitchToDissolve,
  onDone,
}: {
  folder: ConceptFolderView | null;
  folders: readonly ConceptFolderView[];
  mutate: WorkspaceMutate;
  onClose: () => void;
  onSwitchToDissolve?: (folder: ConceptFolderView) => void;
  onDone?: (parentId: string | null) => void;
}) {
  const index = useMemo(() => buildConceptFolderIndex(folders), [folders]);
  const [busy, setBusy] = useState(false);

  if (!folder) return null;

  const parentId =
    folder.parentId && index.byId.has(folder.parentId) ? folder.parentId : null;
  const subtreeIds = index.descendantIds(folder.id);
  const subFolderCount = Math.max(0, subtreeIds.size - 1);

  async function handleDelete() {
    if (!folder || busy) return;
    setBusy(true);
    try {
      const res = await deleteConceptFolder(mutate, folder.id);
      if (res) {
        const deletedConcepts = Number(res.deletedConcepts ?? 0);
        toast.success(
          deletedConcepts > 0
            ? `已删除「${folder.title}」及其中的 ${deletedConcepts} 条概念。`
            : `已删除文件夹「${folder.title}」。`,
        );
        onClose();
        onDone?.(parentId);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
      title={`删除「${folder.title}」`}
      description="删除文件夹及其子文件夹内的全部概念（题目已有批注正文仍保留）。"
    >
      <div className="dialog-form">
        <p>
          此操作将永久移除「<strong>{folder.title}</strong>」
          {subFolderCount > 0 ? `及其 ${subFolderCount} 个子文件夹` : ""}
          {folder.count > 0 ? (
            <>
              ，并删除其中的 <strong>{folder.count} 条概念</strong>
            </>
          ) : (
            ""
          )}
          。
        </p>
        {onSwitchToDissolve && folder.count > 0 && (
          <p className="muted small">
            如果只想去掉文件夹外壳、保留概念内容，建议改用{" "}
            <button
              type="button"
              className="text-button"
              onClick={() => {
                onClose();
                onSwitchToDissolve(folder);
              }}
            >
              解散文件夹
            </button>
            。
          </p>
        )}
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => void handleDelete()}
        >
          {busy ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />}{" "}
          确认删除
        </Button>
      </div>
    </Dialog>
  );
}
