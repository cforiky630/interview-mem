"use client";
import { useId, useMemo, useState } from "react";
import { FolderInput, Loader2, Trash2 } from "lucide-react";
import type { QuestionView, Workspace } from "@/lib/types";
import { createDeckGroup } from "@/lib/client";
import { listDeckCategories } from "@/lib/grouping";
import type { Mutate } from "./dialogs";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { DeckSelectOptions, GroupSelectOptions } from "./deck-select-options";

const NEW_GROUP_VALUE = "__new__";

export function QuestionActionDialog({
  question,
  action,
  data,
  mutate,
  onClose,
  onDone,
}: {
  question: QuestionView;
  action: "delete" | "move";
  data: Workspace;
  mutate: Mutate;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [deckId, setDeckId] = useState(question.deckId ?? "");
  const [groupId, setGroupId] = useState(question.groupId ?? "");
  const [newGroupCategory, setNewGroupCategory] = useState("");
  const [newGroupTitle, setNewGroupTitle] = useState("");
  const categoryListId = useId();
  const ownedDecks = data.decks.filter((d) => d.isOwner);
  const targetDeck = ownedDecks.find((d) => d.id === deckId);
  const targetGroups = targetDeck?.groups ?? [];
  const targetCategories = useMemo(
    () => listDeckCategories(targetGroups),
    [targetGroups],
  );
  const creatingNewGroup =
    action === "move" && Boolean(targetDeck) && groupId === NEW_GROUP_VALUE;
  const trimmedNewTitle = newGroupTitle.trim();
  const trimmedNewCategory = newGroupCategory.trim();
  const newGroupInvalid =
    creatingNewGroup &&
    (!trimmedNewTitle ||
      trimmedNewTitle.length > 80 ||
      trimmedNewCategory.length > 40);

  async function save() {
    if (busy || newGroupInvalid) return;
    setBusy(true);
    try {
      let resolvedGroupId: string | null =
        deckId && groupId && groupId !== NEW_GROUP_VALUE ? groupId : null;
      if (action === "move" && creatingNewGroup && targetDeck) {
        const created = await createDeckGroup(mutate, {
          deckId: targetDeck.id,
          title: trimmedNewTitle,
          category: trimmedNewCategory,
        });
        const createdId = (created?.group as { id?: string } | undefined)?.id;
        if (!createdId) return;
        resolvedGroupId = createdId;
        setGroupId(createdId);
      }
      if (
        await mutate("/api/questions", {
          action,
          id: question.id,
          ...(action === "move"
            ? {
                deckId: deckId || null,
                groupId: deckId ? resolvedGroupId : null,
              }
            : {}),
        })
      ) {
        onClose();
        onDone();
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      title={action === "delete" ? "删除题目" : "移动题目"}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <div className="dialog-form">
        <h3>{question.title}</h3>
        {action === "delete" ? (
          <p className="muted">移入回收站后保留 30 天，可在到期前恢复。</p>
        ) : (
          <>
            <label className="field">
              移动到题库
              <select
                aria-label="移动到题库"
                value={deckId}
                disabled={busy}
                onChange={(e) => {
                  const nextDeckId = e.target.value;
                  setDeckId(nextDeckId);
                  setGroupId(
                    nextDeckId === (question.deckId ?? "")
                      ? (question.groupId ?? "")
                      : "",
                  );
                  setNewGroupCategory("");
                  setNewGroupTitle("");
                }}
              >
                <option value="">未分类</option>
                <DeckSelectOptions decks={ownedDecks} />
              </select>
            </label>
            {targetDeck && (
              <label className="field">
                所属分组（可选）
                <select
                  aria-label="移动到分组"
                  value={groupId}
                  disabled={busy}
                  onChange={(e) => setGroupId(e.target.value)}
                >
                  <GroupSelectOptions groups={targetGroups} />
                  <option value={NEW_GROUP_VALUE}>+ 新建分组并移入…</option>
                </select>
              </label>
            )}
            {creatingNewGroup && (
              <div className="inline-group-create">
                <label className="field">
                  分类 / 公司（可选）
                  <input
                    list={targetCategories.length ? categoryListId : undefined}
                    value={newGroupCategory}
                    onChange={(e) => setNewGroupCategory(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.nativeEvent.isComposing &&
                        !busy &&
                        !newGroupInvalid
                      ) {
                        e.preventDefault();
                        void save();
                      }
                    }}
                    maxLength={40}
                    disabled={busy}
                    placeholder="如：字节跳动（可留空）"
                  />
                </label>
                <label className="field">
                  新分组名称
                  <input
                    value={newGroupTitle}
                    onChange={(e) => setNewGroupTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.nativeEvent.isComposing &&
                        !busy &&
                        !newGroupInvalid
                      ) {
                        e.preventDefault();
                        void save();
                      }
                    }}
                    maxLength={80}
                    disabled={busy}
                    placeholder="如：抖音后端一面"
                    autoFocus
                  />
                </label>
                {targetCategories.length > 0 && (
                  <datalist id={categoryListId}>
                    {targetCategories.map((cat) => (
                      <option key={cat} value={cat} />
                    ))}
                  </datalist>
                )}
              </div>
            )}
          </>
        )}
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button
          variant={action === "delete" ? "danger" : "default"}
          disabled={busy || newGroupInvalid}
          onClick={() => void save()}
        >
          {busy ? (
            <Loader2 size={15} className="spin" />
          ) : action === "delete" ? (
            <Trash2 size={15} />
          ) : (
            <FolderInput size={15} />
          )}{" "}
          {action === "delete" ? "移入回收站" : "移动"}
        </Button>
      </div>
    </Dialog>
  );
}
