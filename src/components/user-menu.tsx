"use client";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import {
  Download,
  LogOut,
  Moon,
  Palette as PaletteIcon,
  SlidersHorizontal,
  Sun,
} from "lucide-react";
import type { Palette } from "@/lib/theme";
import { userInitials } from "@/lib/user-display";
import { cn } from "@/lib/utils";
import type { AccountSettingsTab } from "./settings-card";
import "./user-menu.css";

function getMenuButtons(container: HTMLElement | null): HTMLButtonElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
    (item) => !item.disabled && getComputedStyle(item).display !== "none",
  );
}

export function UserMenu({
  user,
  palette,
  activeTheme,
  settingsAccountOpen,
  onOpenAccountSettings,
  onBeforeOpenMenu,
  onTogglePalette,
  onToggleTheme,
  onSignOut,
  onCloseMobileDrawer,
}: {
  user: { name: string; email?: string };
  palette: Palette;
  activeTheme: "light" | "dark";
  settingsAccountOpen: boolean;
  onOpenAccountSettings: (
    tab: AccountSettingsTab,
    anchor: HTMLElement | null,
  ) => void;
  onBeforeOpenMenu?: () => void;
  onTogglePalette: () => void;
  onToggleTheme: () => void;
  onSignOut: () => void;
  onCloseMobileDrawer?: () => void;
}) {
  const triggerId = useId();
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const enterOnOpenRef = useRef(false);
  const pointerTriggerRef = useRef(false);
  const initials = userInitials(user.name);

  const placeFallback = useCallback(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;
    const nativeAnchor =
      typeof CSS !== "undefined" &&
      CSS.supports("position-area", "block-end") &&
      typeof ToggleEvent !== "undefined" &&
      "source" in ToggleEvent.prototype;
    if (nativeAnchor) {
      delete popover.dataset.jsPositioned;
      popover.style.left = "";
      popover.style.top = "";
      return;
    }
    popover.dataset.jsPositioned = "true";
    const margin = 8;
    const gap = 8;
    const rect = trigger.getBoundingClientRect();
    const vv = window.visualViewport;
    const vLeft = vv?.offsetLeft ?? 0;
    const vTop = vv?.offsetTop ?? 0;
    const vWidth = vv?.width ?? document.documentElement.clientWidth;
    const vHeight = vv?.height ?? window.innerHeight;
    const width = popover.offsetWidth || 228;
    const height = popover.offsetHeight || 260;

    const left = Math.max(
      vLeft + margin,
      Math.min(rect.left, vLeft + vWidth - margin - width),
    );
    const fitsAbove = rect.top - gap - height >= vTop + margin;
    const top = fitsAbove
      ? rect.top - gap - height
      : Math.min(rect.bottom + gap, vTop + vHeight - margin - height);

    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(Math.max(vTop + margin, top))}px`;
  }, []);

  const closeMenu = useCallback(
    (restoreFocus?: "keyboard" | "pointer" | "none") => {
      const popover = popoverRef.current;
      const trigger = triggerRef.current;
      if (restoreFocus === "keyboard") {
        trigger?.focus({ preventScroll: true });
      } else if (restoreFocus === "pointer") {
        trigger?.focus({
          preventScroll: true,
          focusVisible: false,
        } as FocusOptions);
      }
      if (typeof popover?.hidePopover === "function") {
        if (popover.matches(":popover-open")) {
          popover.hidePopover();
        }
      } else if (popover?.classList.contains(":popover-open")) {
        popover.classList.remove(":popover-open");
        setOpen(false);
      }
    },
    [],
  );

  useEffect(() => {
    const group = listRef.current;
    if (!group || "focusGroup" in HTMLElement.prototype) return;
    group.setAttribute("role", "menu");
    group.querySelectorAll("button:not([role])").forEach((item) => {
      item.setAttribute("role", "menuitem");
    });
    const onFallbackKeyDown = (event: KeyboardEvent) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = getMenuButtons(group);
      if (!items.length) return;
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      if (current < 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      let next = 0;
      if (event.key === "Home") next = 0;
      else if (event.key === "End") next = items.length - 1;
      else
        next =
          (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) %
          items.length;
      items[next]?.focus({ preventScroll: true });
    };
    group.addEventListener("keydown", onFallbackKeyDown, true);
    return () => group.removeEventListener("keydown", onFallbackKeyDown, true);
  }, []);

  useEffect(() => {
    const popover = popoverRef.current;
    if (!popover) return;
    const onToggle = (event: Event) => {
      const toggleEvent = event as ToggleEvent;
      const nextOpen = toggleEvent.newState === "open";
      if (nextOpen && window.matchMedia("(max-width: 760px)").matches) {
        popover.hidePopover();
        return;
      }
      setOpen(nextOpen);
      if (nextOpen) {
        onBeforeOpenMenu?.();
        placeFallback();
        const shouldEnter = enterOnOpenRef.current || !pointerTriggerRef.current;
        enterOnOpenRef.current = false;
        pointerTriggerRef.current = false;
        if (shouldEnter) {
          requestAnimationFrame(() => {
            getMenuButtons(listRef.current)[0]?.focus({ preventScroll: true });
          });
        } else {
          requestAnimationFrame(() => {
            triggerRef.current?.focus({
              preventScroll: true,
              focusVisible: false,
            } as FocusOptions);
          });
        }
      } else {
        enterOnOpenRef.current = false;
        pointerTriggerRef.current = false;
      }
    };
    popover.addEventListener("toggle", onToggle);
    return () => popover.removeEventListener("toggle", onToggle);
  }, [onBeforeOpenMenu, placeFallback]);

  useEffect(() => {
    if (!open) return;
    const onResizeOrScroll = () => placeFallback();
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (target === triggerRef.current) return;
      closeMenu("none");
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeMenu("keyboard");
      } else if (event.key === "Tab") {
        triggerRef.current?.focus({
          preventScroll: true,
          focusVisible: false,
        } as FocusOptions);
        if (popoverRef.current?.matches(":popover-open")) {
          popoverRef.current.hidePopover();
        }
      }
    };
    window.addEventListener("resize", onResizeOrScroll);
    window.addEventListener("scroll", onResizeOrScroll, true);
    document.addEventListener("focusin", onFocusIn, true);
    popoverRef.current?.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("resize", onResizeOrScroll);
      window.removeEventListener("scroll", onResizeOrScroll, true);
      document.removeEventListener("focusin", onFocusIn, true);
      popoverRef.current?.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, closeMenu, placeFallback]);

  function handleTriggerClick(event: MouseEvent<HTMLButtonElement>) {
    if (window.matchMedia("(max-width: 760px)").matches) {
      event.preventDefault();
      onCloseMobileDrawer?.();
      onOpenAccountSettings("study", null);
      return;
    }
    const hasInvokers = "commandForElement" in HTMLButtonElement.prototype;
    if (hasInvokers) return;
    event.preventDefault();
    const popover = popoverRef.current;
    const trigger = triggerRef.current;
    if (!popover || !trigger) return;
    const hasNativePopover = typeof popover.showPopover === "function";
    const isCurrentlyOpen = hasNativePopover
      ? popover.matches(":popover-open")
      : popover.classList.contains(":popover-open");
    if (isCurrentlyOpen) {
      closeMenu(event.detail === 0 ? "keyboard" : "pointer");
    } else {
      onBeforeOpenMenu?.();
      if (event.detail === 0) enterOnOpenRef.current = true;
      else pointerTriggerRef.current = true;
      if (hasNativePopover) {
        (
          popover as HTMLDivElement & {
            showPopover: (opts?: { source?: HTMLElement }) => void;
          }
        ).showPopover({ source: trigger });
      } else {
        popover.classList.add(":popover-open");
        setOpen(true);
        placeFallback();
        if (event.detail === 0) {
          requestAnimationFrame(() =>
            getMenuButtons(listRef.current)[0]?.focus({ preventScroll: true }),
          );
        }
      }
    }
  }

  function handleItemPointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const item = event.currentTarget;
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    if (!hit || !item.contains(hit)) return;
    if (document.activeElement !== item) {
      item.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
    }
  }

  return (
    <div className="user-menu-root">
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className={cn("user-menu-trigger", settingsAccountOpen && "is-active")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`账号菜单：${user.name}`}
        {...({
          commandfor: menuId,
          command: "toggle-popover",
        } as Record<string, string>)}
        onPointerDown={(event) => {
          if (window.matchMedia("(max-width: 760px)").matches) return;
          event.preventDefault();
          pointerTriggerRef.current = true;
          onBeforeOpenMenu?.();
        }}
        onKeyDown={(event) => {
          if (window.matchMedia("(max-width: 760px)").matches) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            if (popoverRef.current?.matches(":popover-open")) {
              getMenuButtons(listRef.current)[0]?.focus({
                preventScroll: true,
              });
            } else {
              enterOnOpenRef.current = true;
              pointerTriggerRef.current = false;
              triggerRef.current?.click();
            }
          }
        }}
        onClick={handleTriggerClick}
      >
        <span className="user-menu-avatar" aria-hidden="true">
          {initials}
        </span>
        <span className="user-menu-name">{user.name}</span>
      </button>

      <div
        ref={popoverRef}
        id={menuId}
        popover="auto"
        className="user-menu-popover"
      >
        <div className="user-menu-header">
          <span className="user-menu-avatar" aria-hidden="true">
            {initials}
          </span>
          <div className="user-menu-header-meta">
            <strong>{user.name}</strong>
            {user.email && <small title={user.email}>{user.email}</small>}
          </div>
        </div>
        <div
          ref={listRef}
          className="user-menu-list"
          aria-labelledby={triggerId}
          {...({ focusgroup: "menu nomemory" } as Record<string, string>)}
        >
          <button
            type="button"
            onPointerMove={handleItemPointerMove}
            onClick={() => {
              closeMenu("none");
              onOpenAccountSettings("study", triggerRef.current);
            }}
          >
            <span className="user-menu-item-icon" aria-hidden="true">
              <SlidersHorizontal size={15} />
            </span>
            <span>学习偏好</span>
          </button>
          <button
            type="button"
            onPointerMove={handleItemPointerMove}
            onClick={(event) => {
              closeMenu(event.detail === 0 ? "keyboard" : "pointer");
              onTogglePalette();
            }}
          >
            <span className="user-menu-item-icon" aria-hidden="true">
              <PaletteIcon size={15} />
            </span>
            <span>主题色系</span>
            <span className="user-menu-hint" aria-hidden="true">
              {palette === "forest" ? "青瓷" : "熏衣"}
            </span>
          </button>
          <button
            type="button"
            onPointerMove={handleItemPointerMove}
            onClick={(event) => {
              closeMenu(event.detail === 0 ? "keyboard" : "pointer");
              onToggleTheme();
            }}
          >
            <span className="user-menu-item-icon" aria-hidden="true">
              {activeTheme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
            </span>
            <span>{activeTheme === "dark" ? "浅色模式" : "深色模式"}</span>
            <span className="user-menu-hint" aria-hidden="true">
              {activeTheme === "dark" ? "夜读" : "清晨"}
            </span>
          </button>
          <button
            type="button"
            onPointerMove={handleItemPointerMove}
            onClick={() => {
              closeMenu("none");
              onOpenAccountSettings("data", triggerRef.current);
            }}
          >
            <span className="user-menu-item-icon" aria-hidden="true">
              <Download size={15} />
            </span>
            <span>数据备份</span>
          </button>
          <hr className="user-menu-sep" />
          <button
            type="button"
            className="is-danger"
            onPointerMove={handleItemPointerMove}
            onClick={() => {
              closeMenu("none");
              onSignOut();
            }}
          >
            <span className="user-menu-item-icon" aria-hidden="true">
              <LogOut size={15} />
            </span>
            <span>退出登录</span>
          </button>
        </div>
      </div>
    </div>
  );
}
