"use client";
import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { api } from "@/lib/client";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";

type Source = { raw: string; name?: string | null; sha256?: string | null };
export function SourceDialog({
  questionId,
  userId,
  onClose,
}: {
  questionId: string;
  userId: string;
  onClose: () => void;
}) {
  const [source, setSource] = useState<Source | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void api<Source>(
      `/api/questions/source?questionId=${questionId}`,
      undefined,
      { userId, signal: controller.signal },
    )
      .then(setSource)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [questionId, userId]);
  function download() {
    if (!source) return;
    const url = URL.createObjectURL(
      new Blob([source.raw], { type: "text/plain;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = source.name?.split(/[\\/]/).at(-1) || "导入原文.md";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
      title="导入原文"
      className="source-dialog"
    >
      {error ? (
        <p className="form-error dialog-form" role="alert">
          {error}
        </p>
      ) : source ? (
        <div className="source-content">
          <p className="muted">{source.name || "本批导入资料"}</p>
          <textarea
            readOnly
            aria-label="导入原文内容"
            value={source.raw}
            spellCheck={false}
          />
        </div>
      ) : (
        <div className="view-loading">
          <Loader2 size={20} className="spin" />
        </div>
      )}
      <div className="dialog-footer">
        <Button variant="outline" disabled={!source} onClick={download}>
          <Download size={15} />
          下载原文
        </Button>
        <Button onClick={onClose}>完成</Button>
      </div>
    </Dialog>
  );
}
