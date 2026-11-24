"use client";
import { useSyncExternalStore } from "react";

export type ThemeMode = "light" | "dark";
export type Palette = "forest" | "lavender";
export type AppearanceSnapshot = {
  theme: ThemeMode;
  palette: Palette;
};

const THEME_STORAGE_KEY = "shiyi:theme";
const PALETTE_STORAGE_KEY = "shiyi:palette";
const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_HYDRATE_GUARD_MS = 5_000;
const SERVER_SNAPSHOT: AppearanceSnapshot = {
  theme: "light",
  palette: "forest",
};

type FetchLike = typeof fetch;

let currentSnapshot: AppearanceSnapshot = SERVER_SNAPSHOT;
let initialized = false;
let listenersAttached = false;
const subscribers = new Set<() => void>();

let activeSessionId: string | null = null;
let hydratedSessionId: string | null = null;
let lastSeenServerTheme: ThemeMode | null = null;
let localVersion = 0;
let localUpdatedAt = 0;
let pendingTheme: ThemeMode | null = null;
let dirtyForRetry = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let inFlightController: AbortController | null = null;
let switchFrameId = 0;

let configDebounceMs = DEFAULT_DEBOUNCE_MS;
let configHydrateGuardMs = DEFAULT_HYDRATE_GUARD_MS;
let clockNow: () => number = () => Date.now();
let fetchImpl: FetchLike | null = null;

function resolveFetch(): FetchLike | null {
  if (fetchImpl) return fetchImpl;
  if (typeof globalThis.fetch === "function") return globalThis.fetch.bind(globalThis);
  return null;
}

function normalizeTheme(value: unknown): ThemeMode | null {
  return value === "dark" || value === "light" ? value : null;
}

function normalizePalette(value: unknown): Palette | null {
  return value === "lavender" || value === "forest" ? value : null;
}

function safeReadStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWriteStorage(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* Ignore storage quota or private-mode access errors. */
  }
}

function readSystemTheme(): ThemeMode {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

function readClientAppearance(): AppearanceSnapshot {
  if (typeof document === "undefined") return SERVER_SNAPSHOT;
  const dataset = document.documentElement.dataset;
  const domTheme = normalizeTheme(dataset.theme);
  const storedTheme = normalizeTheme(safeReadStorage(THEME_STORAGE_KEY));
  const theme: ThemeMode = domTheme ?? storedTheme ?? readSystemTheme();

  const domPalette = normalizePalette(dataset.palette);
  const storedPalette = normalizePalette(safeReadStorage(PALETTE_STORAGE_KEY));
  const palette: Palette = domPalette ?? storedPalette ?? "forest";

  return { theme, palette };
}

function themeMetaColor(theme: ThemeMode, palette: Palette): string {
  if (palette === "lavender") {
    return theme === "dark" ? "#0D0C13" : "#F6F4F8";
  }
  return theme === "dark" ? "#0C0F0E" : "#F5F7F6";
}

function emit() {
  for (const listener of subscribers) {
    listener();
  }
}

function setSnapshot(nextTheme: ThemeMode, nextPalette: Palette): boolean {
  if (
    currentSnapshot.theme === nextTheme &&
    currentSnapshot.palette === nextPalette
  ) {
    return false;
  }
  currentSnapshot = { theme: nextTheme, palette: nextPalette };
  emit();
  return true;
}

export function syncDocumentTheme(
  theme: ThemeMode,
  palette: Palette,
  options?: { instant?: boolean },
) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const color = themeMetaColor(theme, palette);
  const themeChanged = root.dataset.theme !== theme;
  const paletteChanged = root.dataset.palette !== palette;
  const suppressTransitions =
    Boolean(options?.instant) && (themeChanged || paletteChanged);

  if (suppressTransitions) {
    if (switchFrameId && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(switchFrameId);
      switchFrameId = 0;
    }
    root.dataset.themeSwitching = "";
  }

  if (themeChanged) {
    root.dataset.theme = theme;
  }
  if (paletteChanged) {
    root.dataset.palette = palette;
  }

  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    if (meta.getAttribute("content") !== color) {
      meta.setAttribute("content", color);
    }
  });
  document.querySelectorAll('meta[name="color-scheme"]').forEach((meta) => {
    if (meta.getAttribute("content") !== theme) {
      meta.setAttribute("content", theme);
    }
  });

  if (suppressTransitions) {
    if (
      typeof window !== "undefined" &&
      typeof window.getComputedStyle === "function"
    ) {
      void window.getComputedStyle(root).color;
    }
    if (typeof requestAnimationFrame === "function") {
      switchFrameId = requestAnimationFrame(() => {
        switchFrameId = 0;
        delete root.dataset.themeSwitching;
      });
    } else {
      delete root.dataset.themeSwitching;
    }
  }
}

function clearDebounce() {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

function abortInFlight() {
  if (inFlightController) {
    inFlightController.abort();
    inFlightController = null;
  }
}

async function persistThemeNow(
  userId: string,
  version: number,
  theme: ThemeMode,
  keepalive: boolean,
) {
  const fetcher = resolveFetch();
  if (!fetcher) return;
  if (!keepalive && (version !== localVersion || userId !== activeSessionId)) {
    return;
  }

  if (!keepalive) {
    abortInFlight();
  }
  const controller = keepalive ? null : new AbortController();
  if (controller) {
    inFlightController = controller;
  }

  try {
    const response = await fetcher("/api/settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Workspace-User": userId,
      },
      body: JSON.stringify({ action: "theme", theme }),
      cache: "no-store",
      ...(keepalive ? { keepalive: true } : { signal: controller!.signal }),
    });
    if (controller && inFlightController === controller) {
      inFlightController = null;
    }
    if (userId !== activeSessionId || version !== localVersion) return;

    if (response.ok) {
      pendingTheme = null;
      dirtyForRetry = false;
      lastSeenServerTheme = theme;
    } else if (response.status !== 401 && response.status !== 403) {
      // Keep local choice intact and retry silently when connectivity recovers.
      pendingTheme = theme;
      dirtyForRetry = true;
    }
  } catch (error) {
    if (controller && inFlightController === controller) {
      inFlightController = null;
    }
    if (
      (error instanceof DOMException && error.name === "AbortError") ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      return;
    }
    if (userId !== activeSessionId || version !== localVersion) return;
    // Never roll back local UI theme on offline / transient network failure.
    pendingTheme = theme;
    dirtyForRetry = true;
  }
}

function scheduleThemePersist(version: number, theme: ThemeMode) {
  clearDebounce();
  abortInFlight();
  const userId = activeSessionId;
  if (!userId) return;

  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (activeSessionId !== userId || version !== localVersion) return;
    void persistThemeNow(userId, version, theme, false);
  }, configDebounceMs);
}

function flushPendingKeepalive(targetUserId?: string | null) {
  const userId = targetUserId ?? activeSessionId;
  if (!userId || pendingTheme === null) return;
  const theme = pendingTheme;
  const version = localVersion;
  clearDebounce();
  abortInFlight();
  void persistThemeNow(userId, version, theme, true);
}

function retryDirtyTheme() {
  if (!dirtyForRetry || pendingTheme === null || !activeSessionId) return;
  if (debounceTimer !== null || inFlightController !== null) return;
  dirtyForRetry = false;
  void persistThemeNow(activeSessionId, localVersion, pendingTheme, false);
}

function onStorageEvent(event: StorageEvent) {
  if (event.key === THEME_STORAGE_KEY) {
    const next = normalizeTheme(event.newValue);
    if (!next || next === currentSnapshot.theme) return;
    clearDebounce();
    abortInFlight();
    pendingTheme = null;
    dirtyForRetry = false;
    lastSeenServerTheme = next;
    localUpdatedAt = clockNow();
    syncDocumentTheme(next, currentSnapshot.palette, { instant: true });
    setSnapshot(next, currentSnapshot.palette);
  } else if (event.key === PALETTE_STORAGE_KEY) {
    const next = normalizePalette(event.newValue) ?? "forest";
    if (next === currentSnapshot.palette) return;
    syncDocumentTheme(currentSnapshot.theme, next, { instant: true });
    setSnapshot(currentSnapshot.theme, next);
  }
}

function onSystemColorSchemeChange(event: MediaQueryListEvent) {
  // Always re-check localStorage dynamically so explicit user choices are never overridden.
  const stored = normalizeTheme(safeReadStorage(THEME_STORAGE_KEY));
  if (stored !== null || pendingTheme !== null) return;
  const next: ThemeMode = event.matches ? "dark" : "light";
  if (next === currentSnapshot.theme) return;
  syncDocumentTheme(next, currentSnapshot.palette, { instant: true });
  setSnapshot(next, currentSnapshot.palette);
}

function onPageHide() {
  flushPendingKeepalive();
}

function onVisibilityChange() {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    flushPendingKeepalive();
  }
}

function onOnline() {
  retryDirtyTheme();
}

let mediaQueryList: MediaQueryList | null = null;

function attachBrowserListeners() {
  if (listenersAttached || typeof window === "undefined") return;
  listenersAttached = true;
  window.addEventListener("storage", onStorageEvent);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("online", onOnline);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  if (typeof window.matchMedia === "function") {
    try {
      mediaQueryList = window.matchMedia("(prefers-color-scheme: dark)");
      mediaQueryList.addEventListener("change", onSystemColorSchemeChange);
    } catch {
      mediaQueryList = null;
    }
  }
}

function ensureInitialized() {
  if (initialized || typeof document === "undefined") return;
  initialized = true;
  const initial = readClientAppearance();
  currentSnapshot = initial;
  syncDocumentTheme(initial.theme, initial.palette);
  attachBrowserListeners();
}

export function initAppearance() {
  ensureInitialized();
}

export function getAppearance(): AppearanceSnapshot {
  ensureInitialized();
  return currentSnapshot;
}

function subscribe(listener: () => void) {
  ensureInitialized();
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

export function useAppearance(): AppearanceSnapshot {
  return useSyncExternalStore(subscribe, getAppearance, () => SERVER_SNAPSHOT);
}

export function setAppearanceSession(userId: string | null) {
  ensureInitialized();
  if (userId === activeSessionId) return;

  const prevUserId = activeSessionId;
  if (prevUserId !== null && pendingTheme !== null) {
    flushPendingKeepalive(prevUserId);
  }

  clearDebounce();
  abortInFlight();
  activeSessionId = userId;
  hydratedSessionId = null;
  lastSeenServerTheme = null;
  dirtyForRetry = false;

  if (prevUserId !== null) {
    // Switching accounts or signing out resets per-user local write tracking.
    pendingTheme = null;
    localVersion = 0;
    localUpdatedAt = 0;
  } else if (userId !== null && pendingTheme !== null) {
    // User toggled before session finished mounting; persist now.
    scheduleThemePersist(localVersion, pendingTheme);
  }
}

export function setAppearanceTheme(next: ThemeMode) {
  ensureInitialized();
  const changed = next !== currentSnapshot.theme;
  if (!changed && pendingTheme === null) {
    syncDocumentTheme(next, currentSnapshot.palette);
    safeWriteStorage(THEME_STORAGE_KEY, next);
    return;
  }

  localVersion += 1;
  localUpdatedAt = clockNow();
  pendingTheme = next;
  dirtyForRetry = false;

  syncDocumentTheme(next, currentSnapshot.palette, { instant: true });
  safeWriteStorage(THEME_STORAGE_KEY, next);
  setSnapshot(next, currentSnapshot.palette);
  scheduleThemePersist(localVersion, next);
}

export function toggleAppearanceTheme() {
  const { theme } = getAppearance();
  setAppearanceTheme(theme === "dark" ? "light" : "dark");
}

export function setAppearancePalette(next: Palette) {
  ensureInitialized();
  if (next === currentSnapshot.palette) {
    syncDocumentTheme(currentSnapshot.theme, next);
    safeWriteStorage(PALETTE_STORAGE_KEY, next);
    return;
  }
  syncDocumentTheme(currentSnapshot.theme, next, { instant: true });
  safeWriteStorage(PALETTE_STORAGE_KEY, next);
  setSnapshot(currentSnapshot.theme, next);
}

export function toggleAppearancePalette() {
  const { palette } = getAppearance();
  setAppearancePalette(palette === "forest" ? "lavender" : "forest");
}

export function hydrateServerTheme(
  userId: string,
  rawServerTheme: string | null | undefined,
) {
  ensureInitialized();
  const serverTheme: ThemeMode = rawServerTheme === "dark" ? "dark" : "light";

  if (activeSessionId !== userId) {
    setAppearanceSession(userId);
  }

  // Never let server sync overwrite a pending or recent local toggle.
  if (pendingTheme !== null) return;
  if (localVersion > 0 && clockNow() - localUpdatedAt < configHydrateGuardMs) {
    return;
  }

  if (hydratedSessionId !== userId) {
    hydratedSessionId = userId;
    // If the user already toggled before initial workspace hydration, local choice wins.
    if (localVersion > 0) {
      lastSeenServerTheme = currentSnapshot.theme;
      return;
    }
    lastSeenServerTheme = serverTheme;
    if (serverTheme !== currentSnapshot.theme) {
      syncDocumentTheme(serverTheme, currentSnapshot.palette, { instant: true });
      safeWriteStorage(THEME_STORAGE_KEY, serverTheme);
      setSnapshot(serverTheme, currentSnapshot.palette);
    } else if (safeReadStorage(THEME_STORAGE_KEY) === null) {
      safeWriteStorage(THEME_STORAGE_KEY, serverTheme);
    }
    return;
  }

  // After initial hydration, only apply genuine remote cross-device changes.
  if (serverTheme === lastSeenServerTheme) return;
  lastSeenServerTheme = serverTheme;
  if (serverTheme !== currentSnapshot.theme) {
    syncDocumentTheme(serverTheme, currentSnapshot.palette, { instant: true });
    safeWriteStorage(THEME_STORAGE_KEY, serverTheme);
    setSnapshot(serverTheme, currentSnapshot.palette);
  }
}

/** Internal test hooks for deterministic unit testing of debounce, abort, retry, and hydration guards. */
export function __configureAppearanceStoreForTests(options: {
  fetch?: FetchLike | null;
  debounceMs?: number;
  hydrateGuardMs?: number;
  now?: () => number;
  reset?: boolean;
}) {
  if (options.reset) {
    clearDebounce();
    abortInFlight();
    if (switchFrameId && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(switchFrameId);
      switchFrameId = 0;
    }
    if (listenersAttached && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorageEvent);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("online", onOnline);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      if (mediaQueryList) {
        mediaQueryList.removeEventListener("change", onSystemColorSchemeChange);
        mediaQueryList = null;
      }
      listenersAttached = false;
    }
    initialized = false;
    currentSnapshot = SERVER_SNAPSHOT;
    activeSessionId = null;
    hydratedSessionId = null;
    lastSeenServerTheme = null;
    localVersion = 0;
    localUpdatedAt = 0;
    pendingTheme = null;
    dirtyForRetry = false;
    subscribers.clear();
  }
  if (options.fetch !== undefined) fetchImpl = options.fetch;
  if (options.debounceMs !== undefined) configDebounceMs = options.debounceMs;
  if (options.hydrateGuardMs !== undefined) {
    configHydrateGuardMs = options.hydrateGuardMs;
  }
  if (options.now !== undefined) clockNow = options.now;
}

export function __triggerAppearanceOnlineForTests() {
  retryDirtyTheme();
}

export function __triggerAppearancePageHideForTests() {
  flushPendingKeepalive();
}

export function __getAppearanceDebugStateForTests() {
  return {
    snapshot: currentSnapshot,
    activeSessionId,
    hydratedSessionId,
    lastSeenServerTheme,
    localVersion,
    pendingTheme,
    dirtyForRetry,
    hasDebounce: debounceTimer !== null,
    hasInFlight: inFlightController !== null,
  };
}
