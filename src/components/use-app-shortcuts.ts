"use client";
import { useEffect, useRef } from "react";
import type { AiIslandMode } from "./ai-island";
import type { AppView } from "@/lib/navigation";

function hasBlockingOverlay() {
  return Boolean(
    document.querySelector(
      "[role='dialog']:not([hidden]), .action-menu[open], .action-menu:popover-open, .user-menu-popover:popover-open",
    ),
  );
}

export function useAppShortcuts({
  view,
  reviewRevealed,
  isEditing,
  aiMode,
  onToggleAi,
  onCloseAi,
  onCloseSidebar,
  onQuickSearch,
}: {
  view: AppView;
  reviewRevealed: boolean;
  isEditing: boolean;
  aiMode: AiIslandMode;
  onToggleAi: () => void;
  onCloseAi: () => void;
  onCloseSidebar: () => void;
  onQuickSearch: (viaSlash: boolean) => void;
}) {
  const ctxRef = useRef({
    view,
    reviewRevealed,
    isEditing,
    aiMode,
    onToggleAi,
    onCloseAi,
    onCloseSidebar,
    onQuickSearch,
  });
  ctxRef.current = {
    view,
    reviewRevealed,
    isEditing,
    aiMode,
    onToggleAi,
    onCloseAi,
    onCloseSidebar,
    onQuickSearch,
  };

  useEffect(() => {
    function shortcuts(event: KeyboardEvent) {
      if (event.isComposing) return;
      const ctx = ctxRef.current;
      const target = event.target as HTMLElement | null;
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "j"
      ) {
        if (ctx.isEditing || hasBlockingOverlay()) return;
        if (ctx.view === "review" && !ctx.reviewRevealed) return;
        event.preventDefault();
        ctx.onToggleAi();
        return;
      }
      if (event.key === "Escape") {
        if (hasBlockingOverlay()) return;
        try {
          if (document.querySelector("select:open")) return;
        } catch {
          /* Ignore browsers without :open selector support. */
        }
        if (
          ctx.aiMode !== "collapsed" &&
          (!target?.closest("input,textarea,[contenteditable='true']") ||
            !!target.closest(".ai-island-panel"))
        ) {
          event.preventDefault();
          ctx.onCloseAi();
          return;
        }
        ctx.onCloseSidebar();
        return;
      }
      if (
        ctx.isEditing ||
        target?.closest("input,textarea,select,[contenteditable='true']") ||
        hasBlockingOverlay()
      )
        return;
      const isPlainSlash =
        event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey;
      const isModK =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "k";
      if (isPlainSlash || isModK) {
        event.preventDefault();
        ctx.onQuickSearch(isPlainSlash);
      }
    }
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  }, []);
}
