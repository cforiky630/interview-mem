"use client";
import { Loader2 } from "lucide-react";
import { Button } from "./button";
import { Dialog } from "./dialog";

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "确定",
  cancelLabel = "取消",
  variant = "default",
  busy = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "danger";
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title={title}
    >
      <div className="dialog-form">
        <p className="muted">{description}</p>
      </div>
      <div className="dialog-footer">
        <Button
          type="button"
          variant="outline"
          autoFocus
          disabled={busy}
          onClick={() => onOpenChange(false)}
        >
          {cancelLabel}
        </Button>
        <Button
          type="button"
          variant={variant === "danger" ? "danger" : "default"}
          disabled={busy}
          onClick={() => void onConfirm()}
        >
          {busy && <Loader2 size={15} className="spin" />}
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
