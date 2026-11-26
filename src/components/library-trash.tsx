"use client";
import { useEffect, useState } from "react";
import { Loader2, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import type { TrashedQuestion } from "@/lib/types";
import type { Mutate } from "./dialogs";
import { Button } from "./ui/button";

export function LibraryTrash({
  userId,
  mutate,
}: {
  userId: string;
  mutate: Mutate;
}) {
  const [items, setItems] = useState<TrashedQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void api<TrashedQuestion[]>("/api/questions/trash", undefined, {
      userId,
      signal: controller.signal,
    })
      .then(setItems)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [userId]);
  if (loading)
    return (
      <div className="view-loading">
        <Loader2 size={20} className="spin" />
      </div>
    );
  if (error)
    return (
      <p role="alert" className="form-error">
        {error}
      </p>
    );
  return (
    <div className="trash-list">
      <p className="trash-hint">
        已删除的资料会在回收站保留 30 天（到期后自动彻底清除），恢复后将保留原文件夹位置（若原文件夹已删则回到根目录）、个人笔记与间隔复习记录。
      </p>
      {items.length ? (
        items.map((question) => (
          <article className="trash-row" key={question.id}>
            <Trash2 size={21} />
            <div>
              <h3>{question.title}</h3>
              <p>
                {question.folderPath || question.deckTitle} · 剩余{" "}
                {Math.max(
                  0,
                  Math.ceil(
                    (new Date(question.expiresAt).getTime() - Date.now()) /
                      86400_000,
                  ),
                )}{" "}
                天
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={!!busy}
              onClick={async () => {
                setBusy(question.id);
                try {
                  if (
                    await mutate("/api/questions", {
                      action: "restore",
                      id: question.id,
                    })
                  ) {
                    setItems((previous) =>
                      previous.filter((d) => d.id !== question.id),
                    );
                    toast.success("资料已恢复。");
                  }
                } finally {
                  setBusy(null);
                }
              }}
            >
              <RotateCcw size={15} />
              {busy === question.id ? "恢复中" : "恢复"}
            </Button>
          </article>
        ))
      ) : (
        <div className="empty-state">
          <Trash2 size={32} />
          <h3>回收站是空的</h3>
          <p>删除文件夹或资料后，内容会暂存这里 30 天以防误删，随时可一键还原。</p>
        </div>
      )}
    </div>
  );
}
