"use client";
import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import type { QuestionView, Workspace } from "@/lib/types";
import type { Mutate } from "./dialogs";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { FolderMoveDialog } from "./folder-move-dialog";

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

  if (action === "move") {
    return (
      <FolderMoveDialog
        selection={{
          questionIds: [question.id],
          label: question.title,
          initialTargetId: question.deckId,
        }}
        decks={data.decks}
        mutate={mutate}
        onClose={onClose}
        onDone={() => onDone()}
      />
    );
  }

  async function confirmDelete() {
    if (busy) return;
    setBusy(true);
    try {
      if (
        await mutate("/api/questions", {
          action: "delete",
          id: question.id,
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
      title="移入回收站"
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <div className="dialog-form">
        <h3>{question.title}</h3>
        <p className="muted">移入回收站后保留 30 天，可在到期前随时恢复。</p>
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => void confirmDelete()}
        >
          {busy ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />}{" "}
          移入回收站
        </Button>
      </div>
    </Dialog>
  );
}
