"use client";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";

export function ActionMenu({
  label = "更多操作",
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [sheetMode, setSheetMode] = useState(false);
  const ref = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const anchor = ref.current;
    const menu = panel.current;
    if (!open || !anchor || !menu) return;

    const isMobile = window.matchMedia("(max-width: 760px)").matches;
    setSheetMode(isMobile);
    menu.dataset.sheet = isMobile ? "true" : "false";

    // The top layer avoids clipping inside scrollable dialogs and cards.
    const floating = typeof menu.showPopover === "function";
    if (floating) menu.showPopover();
    let previousOverflow: string | null = null;
    const viewport = window.visualViewport;
    const place = () => {
      if (window.matchMedia("(max-width: 760px)").matches) {
        menu.dataset.sheet = "true";
        setSheetMode(true);
        menu.style.left = "";
        menu.style.top = "";
        menu.style.right = "";
        menu.style.bottom = "";
        menu.style.maxWidth = "";
        menu.style.maxHeight = "";
        menu.style.transformOrigin = "";
        return;
      }
      menu.dataset.sheet = "false";
      setSheetMode(false);
      const bounds = anchor.getBoundingClientRect();
      const margin = 8;
      const gap = 4;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const right =
        left + (viewport?.width ?? document.documentElement.clientWidth);
      const bottom = top + (viewport?.height ?? window.innerHeight);
      if (bounds.bottom <= top || bounds.top >= bottom) {
        setOpen(false);
        return;
      }

      menu.style.maxWidth = `${Math.max(0, right - left - 2 * margin)}px`;
      const width = menu.offsetWidth;
      const x = Math.max(
        left + margin,
        Math.min(bounds.right - width, right - margin - width),
      );
      const below = bottom - margin - bounds.bottom - gap;
      const above = bounds.top - gap - top - margin;
      const height = menu.scrollHeight + menu.offsetHeight - menu.clientHeight;
      const opensAbove = height > below && above > below;
      menu.style.maxHeight = `${Math.max(0, opensAbove ? above : below)}px`;
      if (floating) {
        menu.style.left = `${x}px`;
        menu.style.top = `${opensAbove ? bounds.top - gap - menu.offsetHeight : bounds.bottom + gap}px`;
      } else {
        menu.style.right = `${bounds.right - x - width}px`;
        menu.style.top = opensAbove ? "auto" : "calc(100% + 4px)";
        menu.style.bottom = opensAbove ? "calc(100% + 4px)" : "auto";
      }
      menu.style.transformOrigin = opensAbove ? "bottom right" : "top right";
    };
    if (isMobile) {
      previousOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = "hidden";
    }
    place();
    const outside = (event: PointerEvent) => {
      if (!anchor.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape, true);
    window.addEventListener("resize", place);
    if (!isMobile) window.addEventListener("scroll", place, true);
    viewport?.addEventListener("resize", place);
    if (!isMobile) viewport?.addEventListener("scroll", place);
    return () => {
      if (previousOverflow !== null) {
        document.documentElement.style.overflow = previousOverflow;
      }
      if (floating && menu.matches(":popover-open")) menu.hidePopover();
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      viewport?.removeEventListener("resize", place);
      viewport?.removeEventListener("scroll", place);
    };
  }, [open]);
  return (
    <details ref={ref} open={open} className="reader-more action-menu">
      <summary
        ref={trigger}
        className="icon-button"
        aria-label={label}
        onClick={(event) => {
          event.preventDefault();
          const next = !open;
          if (next) {
            setSheetMode(window.matchMedia("(max-width: 760px)").matches);
          }
          setOpen(next);
        }}
      >
        <MoreHorizontal size={19} />
      </summary>
      <div
        ref={panel}
        popover="manual"
        data-sheet={sheetMode ? "true" : "false"}
        onClick={(event) => {
          if (!(event.target as Element).closest("button,a")) return;
          setOpen(false);
          trigger.current?.focus({ preventScroll: true });
        }}
      >
        {sheetMode ? (
          <>
            <div
              className="action-sheet-backdrop"
              onClick={() => setOpen(false)}
            />
            <div className="action-sheet-card" role="menu" aria-label={label}>
              <div className="sheet-grabber" aria-hidden="true" />
              <div className="action-sheet-title">{label}</div>
              <div className="action-sheet-items">{children}</div>
              <button
                type="button"
                className="action-sheet-cancel"
                onClick={() => setOpen(false)}
              >
                取消
              </button>
            </div>
          </>
        ) : (
          children
        )}
      </div>
    </details>
  );
}
