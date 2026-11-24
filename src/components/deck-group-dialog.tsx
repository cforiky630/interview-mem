"use client";
import { useEffect, useId, useMemo, useState } from "react";
import { Check, FolderOpen, Loader2, PencilLine, Plus } from "lucide-react";
import { toast } from "sonner";
import type { DeckGroupView, DeckView } from "@/lib/types";
import {
  createDeckGroup,
  editDeckGroup,
  renameDeckGroupName,
  setSubscriptionDeckGroup,
  type WorkspaceMutate,
} from "@/lib/client";
import {
  groupDecksByName,
  listDeckCategories,
  listDeckGroupNames,
} from "@/lib/grouping";
import type { Mutate } from "./dialogs";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

function submitOnEnter(
  event: React.KeyboardEvent<HTMLInputElement>,
  canSubmit: boolean,
  submit: () => void | Promise<void>,
) {
  if (event.key === "Enter" && !event.nativeEvent.isComposing && canSubmit) {
    event.preventDefault();
    void submit();
  }
}

function submitOnCtrlEnter(
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  canSubmit: boolean,
  submit: () => void | Promise<void>,
) {
  if (
    event.key === "Enter" &&
    (event.ctrlKey || event.metaKey) &&
    !event.nativeEvent.isComposing &&
    canSubmit
  ) {
    event.preventDefault();
    void submit();
  }
}

/** Create or edit an intra-deck group (interview session / chapter). */
export function DeckGroupDialog({
  open,
  deck,
  group = null,
  defaultCategory = "",
  mutate,
  onClose,
  onSaved,
}: {
  open: boolean;
  deck: DeckView | null;
  group?: DeckGroupView | null;
  defaultCategory?: string;
  mutate: WorkspaceMutate;
  onClose: () => void;
  onSaved?: (group: DeckGroupView) => void;
}) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const categoryListId = useId();

  const existingCategories = useMemo(
    () => (deck ? listDeckCategories(deck.groups) : []),
    [deck],
  );

  useEffect(() => {
    if (!open) return;
    if (group) {
      setTitle(group.title);
      setCategory(group.category);
      setDescription(group.description);
    } else {
      setTitle("");
      setCategory(defaultCategory);
      setDescription("");
    }
  }, [open, group, defaultCategory]);

  const isEdit = Boolean(group);
  const trimmedTitle = title.trim();
  const trimmedCategory = category.trim();
  const trimmedDesc = description.trim();
  const dirty = isEdit
    ? trimmedTitle !== group!.title ||
      trimmedCategory !== group!.category ||
      trimmedDesc !== group!.description
    : Boolean(trimmedTitle);
  const invalid =
    !trimmedTitle ||
    trimmedTitle.length > 80 ||
    trimmedCategory.length > 40 ||
    trimmedDesc.length > 300;

  async function save() {
    if (!deck || invalid || busy || (isEdit && !dirty)) return;
    setBusy(true);
    try {
      const result = isEdit
        ? await editDeckGroup(mutate, {
            id: group!.id,
            title: trimmedTitle,
            category: trimmedCategory,
            description: trimmedDesc,
          })
        : await createDeckGroup(mutate, {
            deckId: deck.id,
            title: trimmedTitle,
            category: trimmedCategory,
            description: trimmedDesc,
          });
      if (result) {
        const saved = result.group as DeckGroupView | undefined;
        toast.success(isEdit ? "分组已更新。" : "分组已创建。");
        onClose();
        if (saved) onSaved?.(saved);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open && Boolean(deck)}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title={isEdit ? "编辑分组" : "新建分组"}
      description={
        deck ? `所属题库：${deck.title}` : "按公司场次或章节拆分题库内容"
      }
    >
      <div className="dialog-form">
        <label className="field">
          一级分类 / 公司（可选）
          <input
            list={categoryListId}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            onKeyDown={(e) =>
              submitOnEnter(e, !busy && !invalid && dirty, save)
            }
            maxLength={40}
            disabled={busy}
            placeholder="例如：字节跳动、阿里巴巴（按章节分可留空）"
          />
          <datalist id={categoryListId}>
            {existingCategories.map((cat) => (
              <option key={cat} value={cat} />
            ))}
          </datalist>
        </label>
        <label className="field">
          分组名称
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) =>
              submitOnEnter(e, !busy && !invalid && dirty, save)
            }
            maxLength={80}
            disabled={busy}
            placeholder="例如：抖音后端一面 · 2026.03 或 事务与 MVCC"
            autoFocus
          />
        </label>
        <label className="field">
          备注说明（可选）
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) =>
              submitOnCtrlEnter(e, !busy && !invalid && dirty, save)
            }
            maxLength={300}
            rows={3}
            disabled={busy}
            placeholder="记录面试日期、岗位、考察重心或本章节要点…"
          />
        </label>
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button
          disabled={busy || invalid || !dirty}
          onClick={() => void save()}
        >
          {busy ? (
            <Loader2 size={15} className="spin" />
          ) : isEdit ? (
            <Check size={15} />
          ) : (
            <Plus size={15} />
          )}{" "}
          {isEdit ? "保存修改" : "创建分组"}
        </Button>
      </div>
    </Dialog>
  );
}

/** Helper to assign a single owned or subscribed deck to a deck-level group. */
async function assignDeckGroup(
  mutate: WorkspaceMutate,
  deck: DeckView,
  nextGroupName: string,
) {
  return deck.isOwner
    ? mutate("/api/decks", {
        action: "edit",
        deckId: deck.id,
        expected: {
          title: deck.title,
          description: deck.description,
          groupName: deck.groupName,
        },
        title: deck.title,
        description: deck.description,
        groupName: nextGroupName,
      })
    : setSubscriptionDeckGroup(mutate, deck.id, nextGroupName);
}

/** Set a deck's personal deck-level group (used for subscribed decks or quick-filing). */
export function SetDeckGroupDialog({
  deck,
  existingGroups = [],
  mutate,
  onClose,
}: {
  deck: DeckView | null;
  existingGroups?: string[];
  mutate: WorkspaceMutate;
  onClose: () => void;
}) {
  const [groupName, setGroupName] = useState("");
  const [busy, setBusy] = useState(false);
  const groupListId = useId();

  useEffect(() => {
    if (deck) setGroupName(deck.groupName);
  }, [deck]);

  const trimmed = groupName.trim();
  const dirty = Boolean(deck) && trimmed !== (deck?.groupName ?? "");

  async function save() {
    if (!deck || busy || !dirty || trimmed.length > 40) return;
    setBusy(true);
    try {
      const result = await assignDeckGroup(mutate, deck, trimmed);
      if (result) {
        toast.success(trimmed ? `已归入「${trimmed}」。` : "已移出题库分组。");
        onClose();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={Boolean(deck)}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title="设置题库分组"
      description={deck?.title}
    >
      <div className="dialog-form">
        <label className="field">
          题库分组（留空表示不分组）
          <input
            list={groupListId}
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            onKeyDown={(e) => submitOnEnter(e, !busy && dirty, save)}
            maxLength={40}
            disabled={busy}
            placeholder="例如：八股专题、公司面经、AI / RAG"
            autoFocus
          />
          <datalist id={groupListId}>
            {existingGroups.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
        {(existingGroups.length > 0 || Boolean(deck?.groupName)) && (
          <div
            className="deck-group-bar"
            role="group"
            aria-label="快速选择题库分组"
            style={{ marginBottom: 0 }}
          >
            <button
              type="button"
              className={`deck-group-pill ${trimmed === "" ? "is-active" : ""}`}
              aria-pressed={trimmed === ""}
              disabled={busy}
              onClick={() => setGroupName("")}
            >
              不分组
            </button>
            {existingGroups.map((name) => (
              <button
                type="button"
                key={name}
                className={`deck-group-pill ${trimmed === name ? "is-active" : ""}`}
                aria-pressed={trimmed === name}
                disabled={busy}
                onClick={() => setGroupName(name)}
              >
                {name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button
          disabled={busy || !dirty || trimmed.length > 40}
          onClick={() => void save()}
        >
          {busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}{" "}
          保存分组
        </Button>
      </div>
    </Dialog>
  );
}

/** Central organizer for deck-level groups: create + batch-assign, rename/dissolve, and quick-assign every deck. */
export function ManageDeckGroupsDialog({
  open,
  decks,
  mutate,
  onClose,
  onCreateDeckInGroup,
}: {
  open: boolean;
  decks: DeckView[];
  mutate: Mutate;
  onClose: () => void;
  onCreateDeckInGroup?: (groupName: string) => void;
}) {
  const [newGroupName, setNewGroupName] = useState("");
  const [selectedDeckIds, setSelectedDeckIds] = useState<string[]>([]);
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [dissolvingGroup, setDissolvingGroup] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyDeckId, setBusyDeckId] = useState<string | null>(null);
  const groupListId = useId();

  useEffect(() => {
    if (!open) {
      setNewGroupName("");
      setSelectedDeckIds([]);
      setRenamingGroup(null);
      setRenameValue("");
      setDissolvingGroup(null);
    }
  }, [open]);

  const groupNames = useMemo(() => listDeckGroupNames(decks), [decks]);
  const existingGroupSet = useMemo(() => new Set(groupNames), [groupNames]);
  const namedBuckets = useMemo(
    () => groupDecksByName(decks).buckets.filter((b) => b.groupName !== ""),
    [decks],
  );
  const deckIdSet = useMemo(() => new Set(decks.map((d) => d.id)), [decks]);
  const activeSelectedIds = useMemo(
    () => selectedDeckIds.filter((id) => deckIdSet.has(id)),
    [selectedDeckIds, deckIdSet],
  );
  const activeSelectedSet = useMemo(
    () => new Set(activeSelectedIds),
    [activeSelectedIds],
  );

  // Present ungrouped decks first in the batch-pick strip so organizing new decks is effortless.
  const pickableDecks = useMemo(
    () => [
      ...decks.filter((d) => !d.groupName.trim()),
      ...decks.filter((d) => Boolean(d.groupName.trim())),
    ],
    [decks],
  );

  const trimmedNewName = newGroupName.trim();
  const isLocked = busy || busyDeckId !== null;
  const canBatchAssign =
    !isLocked &&
    Boolean(trimmedNewName) &&
    trimmedNewName.length <= 40 &&
    activeSelectedIds.length > 0;
  const canCreateDeckInNewGroup =
    !isLocked &&
    Boolean(trimmedNewName) &&
    trimmedNewName.length <= 40 &&
    activeSelectedIds.length === 0 &&
    Boolean(onCreateDeckInGroup);

  function togglePickDeck(id: string) {
    setSelectedDeckIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  }

  async function handleCreateAndAssign() {
    if (!canBatchAssign) return;
    const targets = decks.filter(
      (d) => activeSelectedSet.has(d.id) && d.groupName !== trimmedNewName,
    );
    if (!targets.length) {
      toast.info(`所选题库已在「${trimmedNewName}」中。`);
      setSelectedDeckIds([]);
      return;
    }
    setBusy(true);
    try {
      let updated = 0;
      for (const target of targets) {
        const res = await assignDeckGroup(mutate, target, trimmedNewName);
        if (res) updated += 1;
      }
      if (updated > 0) {
        toast.success(`已将 ${updated} 个题库归入「${trimmedNewName}」。`);
        setNewGroupName("");
        setSelectedDeckIds([]);
      }
    } finally {
      setBusy(false);
    }
  }

  const trimmedRename = renameValue.trim();
  const canSaveRename =
    !isLocked &&
    Boolean(renamingGroup) &&
    Boolean(trimmedRename) &&
    trimmedRename.length <= 40 &&
    trimmedRename !== renamingGroup;

  async function handleSaveRename() {
    if (!renamingGroup || !canSaveRename) return;
    const from = renamingGroup;
    const to = trimmedRename;
    const isMerge = existingGroupSet.has(to);
    setBusy(true);
    try {
      const res = await renameDeckGroupName(mutate, from, to);
      if (res) {
        toast.success(
          isMerge
            ? `已将「${from}」合并到「${to}」。`
            : `分组已重命名为「${to}」。`,
        );
        setRenamingGroup(null);
        setRenameValue("");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleDissolve(groupName: string) {
    if (isLocked) return;
    setBusy(true);
    try {
      const res = await renameDeckGroupName(mutate, groupName, "");
      if (res) {
        toast.success(`已解散分组「${groupName}」，题库已保留在未分组中。`);
        setDissolvingGroup(null);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleQuickAssign(deck: DeckView, nextGroupName: string) {
    if (isLocked || nextGroupName === deck.groupName) return;
    setBusyDeckId(deck.id);
    try {
      const res = await assignDeckGroup(mutate, deck, nextGroupName);
      if (res) {
        toast.success(
          nextGroupName
            ? `「${deck.title}」已归入「${nextGroupName}」。`
            : `「${deck.title}」已移出分组。`,
        );
      }
    } finally {
      setBusyDeckId(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !isLocked) onClose();
      }}
      title="整理题库分组"
      description="按方向或专题归类题库，便于筛选与切换（不影响题库内题目）"
      className="deck-organizer-dialog"
    >
      <div className="dialog-form">
        <div className="deck-organizer-create">
          <span className="deck-group-count" style={{ fontWeight: 600 }}>
            新建分组并归类题库
          </span>
          <div className="deck-organizer-create-row">
            <input
              list={groupListId}
              aria-label="新题库分组名称"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => {
                if (canBatchAssign) {
                  submitOnEnter(e, true, handleCreateAndAssign);
                } else if (canCreateDeckInNewGroup && onCreateDeckInGroup) {
                  submitOnEnter(e, true, () =>
                    onCreateDeckInGroup(trimmedNewName),
                  );
                }
              }}
              maxLength={40}
              disabled={isLocked}
              placeholder="输入分组名，如：公司面经、八股专题、AI / RAG"
            />
            <datalist id={groupListId}>
              {groupNames.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            {activeSelectedIds.length > 0 ? (
              <Button
                size="sm"
                disabled={!canBatchAssign}
                onClick={() => void handleCreateAndAssign()}
              >
                {busy ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <Check size={14} />
                )}{" "}
                归入分组 ({activeSelectedIds.length})
              </Button>
            ) : onCreateDeckInGroup ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!canCreateDeckInNewGroup}
                onClick={() => onCreateDeckInGroup(trimmedNewName)}
              >
                <Plus size={14} /> 新建题库
              </Button>
            ) : (
              <Button size="sm" disabled>
                归入分组
              </Button>
            )}
          </div>
          {pickableDecks.length > 0 && (
            <>
              <span className="deck-group-count">
                点击勾选要立即归入的题库（可选；未勾选时可直接在该分组下新建题库）：
              </span>
              <div
                className="deck-organizer-create-picks"
                role="group"
                aria-label="勾选要批量归入该分组的题库"
              >
                {pickableDecks.map((d) => {
                  const picked = activeSelectedSet.has(d.id);
                  return (
                    <button
                      type="button"
                      key={d.id}
                      className={`deck-group-pill color-${d.color} ${picked ? "is-active" : ""}`}
                      aria-pressed={picked}
                      disabled={isLocked}
                      onClick={() => togglePickDeck(d.id)}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: "50%",
                          background: "var(--deck-accent)",
                          flexShrink: 0,
                        }}
                      />
                      <span>{d.title}</span>
                      {d.groupName && <small>{d.groupName}</small>}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {namedBuckets.length > 0 && (
          <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="deck-group-heading-main">
              <strong style={{ fontSize: "0.82rem", color: "var(--subtle)" }}>
                已有分组
              </strong>
              <span className="deck-group-count">
                {namedBuckets.length} 个分组
              </span>
            </div>
            <div className="deck-organizer-groups">
              {namedBuckets.map((bucket) => {
                const isRenaming = renamingGroup === bucket.groupName;
                const isDissolving = dissolvingGroup === bucket.groupName;
                return (
                  <div
                    className="deck-organizer-group-row"
                    key={bucket.groupName}
                  >
                    {isRenaming ? (
                      <>
                        <div style={{ alignItems: "center" }}>
                          <input
                            aria-label={`重命名分组：${bucket.groupName}`}
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") {
                                e.stopPropagation();
                                setRenamingGroup(null);
                              } else {
                                submitOnEnter(
                                  e,
                                  canSaveRename,
                                  handleSaveRename,
                                );
                              }
                            }}
                            maxLength={40}
                            disabled={isLocked}
                            autoFocus
                            style={{
                              flex: 1,
                              minWidth: 140,
                              minHeight: 32,
                              padding: "4px 10px",
                              fontSize: "0.84rem",
                            }}
                          />
                        </div>
                        <div className="deck-group-heading-actions">
                          <Button
                            size="sm"
                            disabled={!canSaveRename}
                            onClick={() => void handleSaveRename()}
                          >
                            {busy ? (
                              <Loader2 size={13} className="spin" />
                            ) : (
                              <Check size={13} />
                            )}{" "}
                            保存
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isLocked}
                            onClick={() => setRenamingGroup(null)}
                          >
                            取消
                          </Button>
                        </div>
                      </>
                    ) : isDissolving ? (
                      <>
                        <div>
                          <small>
                            解散「{bucket.groupName}」？组内{" "}
                            {bucket.decks.length} 个题库会保留在未分组中。
                          </small>
                        </div>
                        <div className="deck-group-heading-actions">
                          <Button
                            variant="danger"
                            size="sm"
                            disabled={isLocked}
                            onClick={() =>
                              void handleDissolve(bucket.groupName)
                            }
                          >
                            {busy && <Loader2 size={13} className="spin" />}{" "}
                            确认解散
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isLocked}
                            onClick={() => setDissolvingGroup(null)}
                          >
                            取消
                          </Button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div style={{ alignItems: "center" }}>
                          <FolderOpen
                            size={14}
                            aria-hidden="true"
                            style={{ color: "var(--muted)", flexShrink: 0 }}
                          />
                          <strong>{bucket.groupName}</strong>
                          <small>{bucket.decks.length} 个题库</small>
                        </div>
                        <div className="deck-group-heading-actions">
                          {onCreateDeckInGroup && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={isLocked}
                              onClick={() =>
                                onCreateDeckInGroup(bucket.groupName)
                              }
                            >
                              <Plus size={13} /> 新建题库
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isLocked}
                            onClick={() => {
                              setDissolvingGroup(null);
                              setRenamingGroup(bucket.groupName);
                              setRenameValue(bucket.groupName);
                            }}
                          >
                            <PencilLine size={13} /> 重命名
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="danger-text"
                            disabled={isLocked}
                            onClick={() => {
                              setRenamingGroup(null);
                              setDissolvingGroup(bucket.groupName);
                            }}
                          >
                            解散分组
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {decks.length > 0 ? (
          <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="deck-group-heading-main">
              <strong style={{ fontSize: "0.82rem", color: "var(--subtle)" }}>
                全部题库快速归类
              </strong>
              <span className="deck-group-count">
                {decks.length} 个题库
                {groupNames.length === 0 ? " · 先在上方新建分组即可切换" : ""}
              </span>
            </div>
            <div className="deck-organizer-decks">
              {decks.map((deck) => (
                <div
                  className={`deck-organizer-deck-row color-${deck.color}`}
                  key={deck.id}
                >
                  <div className="deck-organizer-deck-info">
                    <span
                      aria-hidden="true"
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: "var(--deck-accent)",
                        flexShrink: 0,
                      }}
                    />
                    <strong
                      style={{
                        fontSize: "0.86rem",
                        fontWeight: 600,
                        color: "var(--text)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {deck.title}
                    </strong>
                    <small
                      style={{
                        fontSize: "0.74rem",
                        color: "var(--muted)",
                        flexShrink: 0,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {deck.count} 题{!deck.isOwner ? " · 订阅" : ""}
                    </small>
                  </div>
                  <select
                    aria-label={`设置「${deck.title}」的题库分组`}
                    value={deck.groupName}
                    disabled={isLocked || groupNames.length === 0}
                    onChange={(e) =>
                      void handleQuickAssign(deck, e.target.value)
                    }
                  >
                    <option value="">未分组</option>
                    {groupNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </section>
        ) : (
          <p className="muted">还没有题库，先新建一个题库再整理分组吧。</p>
        )}
      </div>
      <div className="dialog-footer">
        <Button variant="outline" disabled={isLocked} onClick={onClose}>
          完成
        </Button>
      </div>
    </Dialog>
  );
}
