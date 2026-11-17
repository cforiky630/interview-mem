"use client";
import { useState } from "react";
import { FolderInput, Loader2, Trash2 } from "lucide-react";
import type { QuestionView, Workspace } from "@/lib/types";
import type { Mutate } from "./dialogs";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";

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
  async function save() {
    setBusy(true);
    try {
      if (
        await mutate("/api/questions", {
          action,
          id: question.id,
          ...(action === "move" ? { deckId: deckId || null } : {}),
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
          <label className="field">
            移动到
            <select
              aria-label="移动到题库"
              value={deckId}
              disabled={busy}
              onChange={(e) => setDeckId(e.target.value)}
            >
              <option value="">未分类</option>
              {data.decks
                .filter((d) => d.isOwner)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                  </option>
                ))}
            </select>
          </label>
        )}
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button
          variant={action === "delete" ? "danger" : "default"}
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? (
            <Loader2 size={15} className="spin" />
          ) : action === "delete" ? (
            <Trash2 size={15} />
          ) : (
            <FolderInput size={15} />
          )}{" "}
          {action === "delete" ? "移入回收站" : "确认移动"}
        </Button>
      </div>
    </Dialog>
  );
}
