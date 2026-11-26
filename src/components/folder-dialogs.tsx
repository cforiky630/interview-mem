"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  FolderMinus,
  FolderPlus,
  Loader2,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type {
  DeckView,
  FolderConflictItem,
  FolderConflictStrategy,
} from "@/lib/types";
import {
  RequestError,
  createFolder,
  deleteFolderToTrash,
  dissolveFolder,
  editFolder,
  groupIntoNewFolder,
  type WorkspaceMutate,
} from "@/lib/client";
import {
  ROOT_FOLDER_LABEL,
  buildFolderIndex,
  validateFolderTitle,
} from "@/lib/folders";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

export function isImeComposing(
  event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
): boolean {
  return (
    event.nativeEvent.isComposing ||
    (event.nativeEvent as unknown as { keyCode?: number }).keyCode === 229
  );
}

const FOLDER_COLORS = [
  { id: "sage", label: "鼠尾草绿" },
  { id: "blue", label: "雾蓝" },
  { id: "sand", label: "暖沙" },
  { id: "rose", label: "浅玫瑰" },
] as const;

export function FolderColorSwatches({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <div className="color-options">
      {FOLDER_COLORS.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`color-swatch color-${c.id} ${value === c.id ? "selected" : ""}`}
          aria-label={c.label}
          aria-pressed={value === c.id}
          onClick={() => onChange(c.id)}
        >
          {value === c.id && <Check size={18} />}
        </button>
      ))}
    </div>
  );
}

export function CreateFolderDialog({
  open,
  parentId,
  decks,
  mutate,
  onClose,
  onCreated,
}: {
  open: boolean;
  parentId: string | null;
  decks: readonly DeckView[];
  mutate: WorkspaceMutate;
  onClose: () => void;
  onCreated?: (id: string) => void;
}) {
  const index = useMemo(() => buildFolderIndex(decks), [decks]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("sage");
  const [busy, setBusy] = useState(false);

  const parentPath = parentId ? index.pathOf(parentId) : ROOT_FOLDER_LABEL;
  const validationError = title.trim() ? validateFolderTitle(title) : null;
  const canSubmit = !busy && !!title.trim() && !validationError;

  useEffect(() => {
    if (open) {
      setTitle("");
      setDescription("");
      const parent = parentId ? index.byId.get(parentId) : undefined;
      setColor(parent?.color || "sage");
    }
  }, [open, parentId, index]);

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      const result = await createFolder(mutate, {
        title: title.trim(),
        parentId,
        description,
        color,
      });
      if (result) {
        const deck = result.deck as { id: string } | undefined;
        const id = deck?.id ?? String(result.id ?? "");
        toast.success("文件夹已创建。");
        onClose();
        if (id) onCreated?.(id);
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
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isImeComposing(e) && canSubmit) {
                  e.preventDefault();
                  void handleSubmit();
                }
              }}
              maxLength={80}
              disabled={busy}
              placeholder="例如：MySQL、字节面经、系统设计"
              autoFocus
            />
            {validationError && (
              <small className="danger-text">{validationError}</small>
            )}
          </label>
          <label className="field">
            简介（可选）
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              rows={3}
              disabled={busy}
              placeholder="写一句话备注目录范围或复习重心（可选）…"
            />
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

export function EditFolderDialog({
  folder,
  onClose,
  mutate,
}: {
  folder: DeckView | null;
  onClose: () => void;
  mutate: WorkspaceMutate;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("sage");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (folder) {
      setTitle(folder.title);
      setDescription(folder.description);
      setColor(folder.color || "sage");
    }
  }, [folder]);

  const titleChanged = Boolean(folder && title.trim() !== folder.title);
  const validationError =
    titleChanged && title.trim() ? validateFolderTitle(title) : null;
  const dirty =
    Boolean(folder) &&
    (title.trim() !== folder!.title ||
      description !== folder!.description ||
      color !== (folder!.color || "sage"));
  const canSubmit = !busy && !!title.trim() && dirty && !validationError;

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!folder || !canSubmit) return;
    setBusy(true);
    try {
      const result = await editFolder(mutate, {
        deckId: folder.id,
        title: title.trim(),
        description,
        color,
        expected: {
          title: folder.title,
          description: folder.description,
          color: folder.color || "sage",
        },
      });
      if (result) {
        toast.success("文件夹信息已更新。");
        onClose();
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
              onChange={(e) => setTitle(e.target.value)}
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
            {validationError && (
              <small className="danger-text">{validationError}</small>
            )}
          </label>
          <label className="field">
            简介（可选）
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              rows={3}
              disabled={busy}
              placeholder="备注该文件夹范围、目标岗位或复习重点…"
            />
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

export function GroupIntoNewFolderDialog({
  open,
  parentId,
  decks,
  folderIds,
  questionIds,
  subscriptionDeckIds,
  mutate,
  onClose,
  onDone,
}: {
  open: boolean;
  parentId: string | null;
  decks: readonly DeckView[];
  folderIds: string[];
  questionIds: string[];
  subscriptionDeckIds: string[];
  mutate: WorkspaceMutate;
  onClose: () => void;
  onDone?: (createdId: string) => void;
}) {
  const index = useMemo(() => buildFolderIndex(decks), [decks]);
  const [title, setTitle] = useState("");
  const [color, setColor] = useState("sage");
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState<FolderConflictItem[] | null>(null);
  const [parentNameConflict, setParentNameConflict] = useState<string | null>(
    null,
  );

  const totalCount =
    folderIds.length + questionIds.length + subscriptionDeckIds.length;
  const parentPath = parentId ? index.pathOf(parentId) : ROOT_FOLDER_LABEL;
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
      const res = await groupIntoNewFolder(
        mutate,
        {
          parentId,
          title: title.trim(),
          color,
          folderIds,
          questionIds,
          subscriptionDeckIds,
          conflictStrategy: strategy,
        },
        { throwOnCodes: ["FOLDER_NAME_CONFLICT"] },
      );
      if (res) {
        const folder = res.folder as { id: string } | undefined;
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
              placeholder="例如：高并发专题、春招复盘"
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

export function DissolveFolderDialog({
  folder,
  decks,
  mutate,
  onClose,
  onDone,
}: {
  folder: DeckView | null;
  decks: readonly DeckView[];
  mutate: WorkspaceMutate;
  onClose: () => void;
  onDone?: (parentId: string | null) => void;
}) {
  const index = useMemo(() => buildFolderIndex(decks), [decks]);
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState<FolderConflictItem[] | null>(null);

  useEffect(() => {
    setConflicts(null);
  }, [folder?.id]);

  if (!folder) return null;

  const parentId =
    folder.parentId && index.byId.has(folder.parentId) ? folder.parentId : null;
  const parentLabel = parentId ? index.pathOf(parentId) : ROOT_FOLDER_LABEL;
  const childCount = (index.ownedChildren.get(folder.id) ?? []).length;
  const subCount = (index.subscriptionsByFolder.get(folder.id) ?? []).length;
  const directItems = folder.directCount ?? 0;

  async function runDissolve(strategy: FolderConflictStrategy = "abort") {
    if (!folder || busy) return;
    setBusy(true);
    try {
      const res = await dissolveFolder(mutate, folder.id, strategy, {
        throwOnCodes: ["FOLDER_NAME_CONFLICT"],
      });
      if (res) {
        const dupWarn = Number(res.duplicateWarnings ?? 0);
        toast.success(
          dupWarn > 0
            ? `已解散「${folder.title}」，内容已上移到「${parentLabel}」（发现 ${dupWarn} 条与上级内容相同的资料，均已保留，可在「重复内容」中整理）。`
            : `已解散「${folder.title}」，内容已上移到「${parentLabel}」。`,
        );
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
      description="仅移除这一层文件夹外壳，所有内容与复习记录都会安全上移一层。"
    >
      <div className="dialog-form">
        <p className="muted">
          解散后，当前文件夹内的
          {[
            childCount ? ` ${childCount} 个子文件夹` : "",
            directItems ? ` ${directItems} 条资料` : "",
            subCount ? ` ${subCount} 个订阅资料` : "",
          ]
            .filter(Boolean)
            .join("、") || "全部内容"}
          将直接上移到「<strong>{parentLabel}</strong>
          」，不会删除任何题目或复习记录。
        </p>
        {folder.publishedVersion > 0 && folder.visibility !== "private" && (
          <p className="muted small">
            注：该文件夹已发布过（v{folder.publishedVersion}），解散后不再对外公开，已有订阅者的已同步快照和进度不受影响。
          </p>
        )}
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

export function DeleteFolderTrashDialog({
  folder,
  decks,
  mutate,
  onClose,
  onSwitchToDissolve,
  onDone,
}: {
  folder: DeckView | null;
  decks: readonly DeckView[];
  mutate: WorkspaceMutate;
  onClose: () => void;
  onSwitchToDissolve?: (folder: DeckView) => void;
  onDone?: (parentId: string | null) => void;
}) {
  const index = useMemo(() => buildFolderIndex(decks), [decks]);
  const [busy, setBusy] = useState(false);

  if (!folder) return null;

  const parentId =
    folder.parentId && index.byId.has(folder.parentId) ? folder.parentId : null;
  const parentLabel = parentId ? index.pathOf(parentId) : ROOT_FOLDER_LABEL;
  const subtreeIds = index.subtreeOwnedIds(folder.id);
  const subFolderCount = Math.max(0, subtreeIds.size - 1);
  let placedSubCount = 0;
  for (const id of subtreeIds) {
    placedSubCount += (index.subscriptionsByFolder.get(id) ?? []).length;
  }

  async function handleDelete() {
    if (!folder || busy) return;
    setBusy(true);
    try {
      const res = await deleteFolderToTrash(mutate, folder.id);
      if (res) {
        const trashed = Number(res.trashedQuestions ?? 0);
        toast.success(
          trashed > 0
            ? `已删除「${folder.title}」，${trashed} 条资料已移入回收站（30 天内可恢复）。`
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
      description="删除文件夹并将其中全部自有资料移入回收站（30 天内可恢复）。"
    >
      <div className="dialog-form">
        <p>
          此操作将移除「<strong>{folder.title}</strong>」
          {subFolderCount > 0 ? `及其 ${subFolderCount} 个子文件夹` : ""}
          ，并将该目录下的 <strong>{folder.count} 条自有资料</strong>
          移入回收站（保留 30 天，恢复时若原文件夹已删将回到「{parentLabel}」）。
        </p>
        {placedSubCount > 0 && (
          <p className="muted small">
            目录内放置的 {placedSubCount} 个订阅资料不会被删除，将自动上移到「{parentLabel}」。
          </p>
        )}
        {onSwitchToDissolve && (
          <p className="muted small">
            如果只想去掉文件夹外壳、保留所有资料在原地，建议改用{" "}
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
          删除并移入回收站
        </Button>
      </div>
    </Dialog>
  );
}
