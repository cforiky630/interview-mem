"use client";
import { useEffect, useRef } from "react";
import type { AiIslandMode } from "./ai-island";
import type { AppView } from "@/lib/navigation";

export function useAppShortcuts({
  view,
  reviewRevealed,
  aiMode,
  onToggleAi,
  onCloseAi,
  onCloseSidebar,
  onQuickSearch,
}: {
  view: AppView;
  reviewRevealed: boolean;
  aiMode: AiIslandMode;
  onToggleAi: () => void;
  onCloseAi: () => void;
  onCloseSidebar: () => void;
  onQuickSearch: () => void;
}) {
  const ctxRef = useRef({
    view,
    reviewRevealed,
    aiMode,
    onToggleAi,
    onCloseAi,
    onCloseSidebar,
    onQuickSearch,
  });
  ctxRef.current = {
    view,
    reviewRevealed,
    aiMode,
    onToggleAi,
    onCloseAi,
    onCloseSidebar,
    onQuickSearch,
  };

  useEffect(() => {
    function shortcuts(event: KeyboardEvent) {
      const ctx = ctxRef.current;
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "j"
      ) {
        if (document.querySelector("[role='dialog']:not([hidden])")) return;
        if (ctx.view === "review" && !ctx.reviewRevealed) return;
        event.preventDefault();
        ctx.onToggleAi();
        return;
      }
      if (event.key === "Escape") {
        if (
          !document.querySelector("[role='dialog']:not([hidden])") &&
          ctx.aiMode !== "collapsed" &&
          (!(event.target as HTMLElement).closest(
            "input,textarea,[contenteditable='true']",
          ) ||
            !!(event.target as HTMLElement).closest(".ai-island-panel"))
        ) {
          event.preventDefault();
          ctx.onCloseAi();
          return;
        }
      }
      if (
        (event.target as HTMLElement).closest(
          "input,textarea,[contenteditable='true']",
        ) ||
        document.querySelector("[role='dialog']:not([hidden])")
      )
        return;
      if (
        event.key === "/" ||
        ((event.metaKey || event.ctrlKey) && event.key === "k")
      ) {
        event.preventDefault();
        ctx.onQuickSearch();
      }
      if (event.key === "Escape") ctx.onCloseSidebar();
    }
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  }, []);
}
