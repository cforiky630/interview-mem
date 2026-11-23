"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { MoreHorizontal } from "lucide-react";

function menuItems(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      "button:not(:disabled), a[href]",
    ),
  ).filter((el) => getComputedStyle(el).display !== "none");
}

export function ActionMenu({
  label = "更多操作",
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [sheetMode, setSheetMode] = useState(false);
  const ref = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);
  const closeTokenRef = useRef(0);
  const focusFirstOnOpenRef = useRef(false);

  const requestClose = useCallback(
    (restoreFocus: "keyboard" | "none" = "none") => {
      const token = ++closeTokenRef.current;
      if (restoreFocus === "keyboard") {
        trigger.current?.focus({ preventScroll: true });
      }
      const menu = panel.current;
      if (!menu || (!open && !closingRef.current)) {
        closingRef.current = false;
        setClosing(false);
        setOpen(false);
        return;
      }
      closingRef.current = true;
      setClosing(true);
      setOpen(false);

      void (async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        if (closeTokenRef.current !== token) return;
        const animations = menu.getAnimations({ subtree: true });
        if (animations.length > 0) {
          await Promise.race([
            Promise.allSettled(animations.map((a) => a.finished)),
            new Promise((resolve) => setTimeout(resolve, 320)),
          ]);
        }
        if (closeTokenRef.current !== token) return;
        if (menu.matches(":popover-open")) menu.hidePopover();
        closingRef.current = false;
        setClosing(false);
      })();
    },
    [open],
  );

  useEffect(() => {
    const menu = panel.current;
    if (!open && !closing && menu?.matches(":popover-open")) {
      menu.hidePopover();
    }
  }, [open, closing]);

  useEffect(() => {
    const menu = panel.current;
    return () => {
      if (menu?.matches(":popover-open")) menu.hidePopover();
    };
  }, []);

  useLayoutEffect(() => {
    const anchor = ref.current;
    const menu = panel.current;
    if (!open || !anchor || !menu) return;

    const isMobile = window.matchMedia("(max-width: 760px)").matches;
    setSheetMode(isMobile);
    menu.dataset.sheet = isMobile ? "true" : "false";

    // The top layer avoids clipping inside scrollable dialogs and cards.
    const floating = typeof menu.showPopover === "function";
    if (floating && !menu.matches(":popover-open")) menu.showPopover();
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
        requestClose("none");
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
    if (focusFirstOnOpenRef.current) {
      focusFirstOnOpenRef.current = false;
      requestAnimationFrame(() => {
        menuItems(menu)[0]?.focus({ preventScroll: true });
      });
    }
    const outside = (event: PointerEvent) => {
      if (!anchor.contains(event.target as Node)) requestClose("none");
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        requestClose("keyboard");
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = menuItems(menu);
      if (!items.length) return;
      event.preventDefault();
      event.stopPropagation();
      const current = items.indexOf(document.activeElement as HTMLElement);
      let next = 0;
      if (event.key === "Home") next = 0;
      else if (event.key === "End") next = items.length - 1;
      else if (current < 0) next = event.key === "ArrowUp" ? items.length - 1 : 0;
      else
        next =
          (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) %
          items.length;
      items[next]?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("resize", place);
    if (!isMobile) window.addEventListener("scroll", place, true);
    viewport?.addEventListener("resize", place);
    if (!isMobile) viewport?.addEventListener("scroll", place);
    return () => {
      if (floating && !closingRef.current && menu.matches(":popover-open")) {
        menu.hidePopover();
      }
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      viewport?.removeEventListener("resize", place);
      viewport?.removeEventListener("scroll", place);
    };
  }, [open, requestClose]);

  return (
    <details ref={ref} open={open || closing} className="reader-more action-menu">
      <summary
        ref={trigger}
        className="icon-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            focusFirstOnOpenRef.current = true;
            if (!open) {
              closeTokenRef.current += 1;
              closingRef.current = false;
              setClosing(false);
              setSheetMode(window.matchMedia("(max-width: 760px)").matches);
              setOpen(true);
            } else {
              menuItems(panel.current)[0]?.focus({ preventScroll: true });
            }
          }
        }}
        onClick={(event) => {
          event.preventDefault();
          if (open) {
            requestClose(event.detail === 0 ? "keyboard" : "none");
          } else {
            closeTokenRef.current += 1;
            closingRef.current = false;
            setClosing(false);
            focusFirstOnOpenRef.current = event.detail === 0;
            setSheetMode(window.matchMedia("(max-width: 760px)").matches);
            setOpen(true);
          }
        }}
      >
        <MoreHorizontal size={19} />
      </summary>
      <div
        ref={panel}
        popover="manual"
        data-sheet={sheetMode ? "true" : "false"}
        data-closing={closing ? "" : undefined}
        onClick={(event) => {
          if (!(event.target as Element).closest("button,a")) return;
          requestClose(event.detail === 0 ? "keyboard" : "none");
        }}
      >
        {sheetMode ? (
          <>
            <div
              className="action-sheet-backdrop"
              onClick={() => requestClose("none")}
            />
            <div className="action-sheet-card" role="menu" aria-label={label}>
              <div className="sheet-grabber" aria-hidden="true" />
              <div className="action-sheet-title">{label}</div>
              <div className="action-sheet-items">{children}</div>
              <button
                type="button"
                className="action-sheet-cancel"
                onClick={() => requestClose("none")}
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
