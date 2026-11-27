"use client";

import { useEffect, useSyncExternalStore } from "react";

export type DeviceInput = "mouse" | "touch";
export type DeviceShell = "mobile" | "desktop-compact" | "desktop";

export type DeviceProfile = {
  input: DeviceInput;
  shell: DeviceShell;
  isMobileShell: boolean;
  isTouchInput: boolean;
  isDesktopCompact: boolean;
  isKeyboardOpen: boolean;
};

export const DEFAULT_DEVICE_PROFILE: DeviceProfile = Object.freeze({
  input: "mouse",
  shell: "desktop",
  isMobileShell: false,
  isTouchInput: false,
  isDesktopCompact: false,
  isKeyboardOpen: false,
});

/**
 * Pre-hydration inline script (mirrored in `src/app/layout.tsx`) that sets
 * `data-input`, `data-shell`, `--vvh`, and `--kb-offset` on `<html>` before
 * first paint to prevent shell/layout flash.
 */
export const DEVICE_PROFILE_INIT_SCRIPT = `(function(){try{var d=document.documentElement;var mm=window.matchMedia;var coarse=!!(mm&&mm("(pointer: coarse)").matches);var noHover=!!(mm&&mm("(hover: none)").matches);var fineHover=!!(mm&&mm("(hover: hover) and (pointer: fine)").matches);var touch=coarse||(noHover&&!fineHover);var mobile=touch&&!!(mm&&(mm("(max-width: 960px)").matches||mm("(max-height: 540px)").matches));var compact=!touch&&!!(mm&&mm("(max-width: 860px)").matches);d.dataset.input=touch?"touch":"mouse";d.dataset.shell=mobile?"mobile":(compact?"desktop-compact":"desktop");var vv=window.visualViewport;var vvh=Math.round(vv?vv.height:window.innerHeight);if(vvh>0)d.style.setProperty("--vvh",vvh+"px");d.style.setProperty("--kb-offset","0px");}catch(e){}})();`;

const QUERIES = [
  "(pointer: coarse)",
  "(hover: none)",
  "(hover: hover) and (pointer: fine)",
  "(max-width: 960px)",
  "(max-height: 540px)",
  "(max-width: 860px)",
] as const;

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

function isEditableElement(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA") {
    const textarea = el as HTMLTextAreaElement;
    return !textarea.readOnly && !textarea.disabled;
  }
  if (el.tagName === "INPUT") {
    const input = el as HTMLInputElement;
    if (input.readOnly || input.disabled) return false;
    return !NON_TEXT_INPUT_TYPES.has(input.type.toLowerCase());
  }
  return false;
}

const orientationBaselines = { portrait: 0, landscape: 0 };
let cachedProfile: DeviceProfile = DEFAULT_DEVICE_PROFILE;
let initialized = false;
let blurTimer: number | null = null;
const listeners = new Set<() => void>();
let teardownListeners: (() => void) | null = null;

function computeProfileAndSyncDom(): DeviceProfile {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return DEFAULT_DEVICE_PROFILE;
  }
  const mm =
    typeof window.matchMedia === "function"
      ? (q: string) => window.matchMedia(q).matches
      : () => false;

  const coarse = mm("(pointer: coarse)");
  const noHover = mm("(hover: none)");
  const fineHover = mm("(hover: hover) and (pointer: fine)");
  const isTouchInput = coarse || (noHover && !fineHover);
  const input: DeviceInput = isTouchInput ? "touch" : "mouse";

  const isMobileShell =
    isTouchInput && (mm("(max-width: 960px)") || mm("(max-height: 540px)"));
  const isDesktopCompact = !isTouchInput && mm("(max-width: 860px)");
  const shell: DeviceShell = isMobileShell
    ? "mobile"
    : isDesktopCompact
      ? "desktop-compact"
      : "desktop";

  const vv = window.visualViewport;
  const vvh = Math.max(0, Math.round(vv?.height ?? window.innerHeight));
  const kbOffset = vv
    ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
    : 0;

  const orient =
    window.innerWidth > window.innerHeight ? "landscape" : "portrait";
  const editableFocused = isEditableElement(document.activeElement);
  if (!editableFocused && kbOffset <= 60) {
    orientationBaselines[orient] = Math.max(
      orientationBaselines[orient],
      vvh,
      window.innerHeight,
    );
  }
  const baseline = orientationBaselines[orient] || window.innerHeight;
  const shrink = Math.max(kbOffset, baseline - vvh);
  const isKeyboardOpen =
    isTouchInput &&
    (kbOffset > 120 || (editableFocused && (shrink > 110 || isMobileShell)));

  const root = document.documentElement;
  if (root.dataset.input !== input) root.dataset.input = input;
  if (root.dataset.shell !== shell) root.dataset.shell = shell;
  if (isKeyboardOpen) {
    if (root.dataset.keyboardOpen !== "true") {
      root.dataset.keyboardOpen = "true";
    }
  } else if ("keyboardOpen" in root.dataset) {
    delete root.dataset.keyboardOpen;
  }
  if (vvh > 0) {
    const nextVvh = `${vvh}px`;
    if (root.style.getPropertyValue("--vvh") !== nextVvh) {
      root.style.setProperty("--vvh", nextVvh);
    }
  }
  const nextKbOffset = `${kbOffset}px`;
  if (root.style.getPropertyValue("--kb-offset") !== nextKbOffset) {
    root.style.setProperty("--kb-offset", nextKbOffset);
  }

  if (
    initialized &&
    cachedProfile.input === input &&
    cachedProfile.shell === shell &&
    cachedProfile.isKeyboardOpen === isKeyboardOpen
  ) {
    return cachedProfile;
  }

  initialized = true;
  cachedProfile = Object.freeze({
    input,
    shell,
    isMobileShell,
    isTouchInput,
    isDesktopCompact,
    isKeyboardOpen,
  });
  return cachedProfile;
}

export function syncDeviceProfile(): DeviceProfile {
  const prev = cachedProfile;
  const next = computeProfileAndSyncDom();
  if (next !== prev) {
    listeners.forEach((listener) => listener());
  }
  return next;
}

export function getDeviceProfile(): DeviceProfile {
  if (typeof window === "undefined") return DEFAULT_DEVICE_PROFILE;
  return computeProfileAndSyncDom();
}

function getServerDeviceProfile(): DeviceProfile {
  return DEFAULT_DEVICE_PROFILE;
}

function attachGlobalListeners(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  const onChange = () => {
    syncDeviceProfile();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      event.key === "Tab" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      document.documentElement.dataset.focusModality = "keyboard";
    }
  };
  const onPointerDown = () => {
    delete document.documentElement.dataset.focusModality;
  };
  const onFocusIn = () => {
    if (blurTimer !== null) {
      window.clearTimeout(blurTimer);
      blurTimer = null;
    }
    syncDeviceProfile();
  };
  const onFocusOut = () => {
    if (blurTimer !== null) window.clearTimeout(blurTimer);
    blurTimer = window.setTimeout(() => {
      blurTimer = null;
      syncDeviceProfile();
    }, 100);
  };

  const mediaLists =
    typeof window.matchMedia === "function"
      ? QUERIES.map((q) => window.matchMedia(q))
      : [];
  for (const mql of mediaLists) {
    mql.addEventListener("change", onChange);
  }
  window.addEventListener("resize", onChange, { passive: true });
  window.addEventListener("orientationchange", onChange, { passive: true });
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
  const vv = window.visualViewport;
  vv?.addEventListener("resize", onChange);
  vv?.addEventListener("scroll", onChange);

  syncDeviceProfile();

  return () => {
    if (blurTimer !== null) {
      window.clearTimeout(blurTimer);
      blurTimer = null;
    }
    for (const mql of mediaLists) {
      mql.removeEventListener("change", onChange);
    }
    window.removeEventListener("resize", onChange);
    window.removeEventListener("orientationchange", onChange);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("focusout", onFocusOut, true);
    vv?.removeEventListener("resize", onChange);
    vv?.removeEventListener("scroll", onChange);
  };
}

export function subscribeDeviceProfile(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && !teardownListeners) {
    teardownListeners = attachGlobalListeners();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && teardownListeners) {
      teardownListeners();
      teardownListeners = null;
    }
  };
}

export function useDeviceProfile(): DeviceProfile {
  return useSyncExternalStore(
    subscribeDeviceProfile,
    getDeviceProfile,
    getServerDeviceProfile,
  );
}

/**
 * Mounts global device-profile & visualViewport listeners for the full app
 * lifecycle (including pre-auth screens).
 */
export function DeviceProfileSync() {
  useEffect(() => subscribeDeviceProfile(() => {}), []);
  return null;
}
