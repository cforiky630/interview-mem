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
  const ref = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const anchor = ref.current;
    const menu = panel.current;
    if (!open || !anchor || !menu) return;

    // The top layer avoids clipping inside scrollable dialogs and cards.
    const floating = typeof menu.showPopover === "function";
    if (floating) menu.showPopover();
    const viewport = window.visualViewport;
    const place = () => {
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
    window.addEventListener("scroll", place, true);
    viewport?.addEventListener("resize", place);
    viewport?.addEventListener("scroll", place);
    return () => {
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
          setOpen(!open);
        }}
      >
        <MoreHorizontal size={19} />
      </summary>
      <div
        ref={panel}
        popover="manual"
        onClick={(event) => {
          if (!(event.target as Element).closest("button,a")) return;
          setOpen(false);
          trigger.current?.focus({ preventScroll: true });
        }}
      >
        {children}
      </div>
    </details>
  );
}
