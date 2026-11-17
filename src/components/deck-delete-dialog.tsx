"use client";
import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import type { DeckView } from "@/lib/types";
import type { Mutate } from "./dialogs";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";

export function DeleteDeckDialog({
  deck,
  mutate,
  onClose,
  onDeleted,
}: {
  deck: DeckView;
  mutate: Mutate;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    try {
      if (await mutate("/api/decks", { action: "delete", deckId: deck.id })) {
        onClose();
        onDeleted();
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title="删除题库"
    >
      <div className="dialog-form">
        <h3>{deck.title}</h3>
        <p className="muted">
          仅删除题库分类。题目会移到“未分类”，答案、笔记和复习记录保留。
        </p>
        {deck.publishedVersion > 0 && (
          <p className="muted">已有订阅者保留最后发布的内容，不再接收更新。</p>
        )}
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button variant="danger" disabled={busy} onClick={() => void remove()}>
          {busy ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />}
          删除题库，保留题目
        </Button>
      </div>
    </Dialog>
  );
}
