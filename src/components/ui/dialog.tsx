"use client";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay" />
        <DialogPrimitive.Content className={cn("dialog-content", className)}>
          <div className="dialog-header">
            <div>
              <DialogPrimitive.Title className="dialog-title">
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description
                className={description ? "dialog-description" : "sr-only"}
              >
                {description ?? title}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close className="icon-button" aria-label="关闭">
              <X size={20} />
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
