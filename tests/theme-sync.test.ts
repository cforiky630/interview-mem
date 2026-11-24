import { afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Workspace } from "../src/lib/types";
import {
  __configureAppearanceStoreForTests,
  __getAppearanceDebugStateForTests,
  __triggerAppearanceOnlineForTests,
  __triggerAppearancePageHideForTests,
  getAppearance,
  hydrateServerTheme,
  setAppearancePalette,
  setAppearanceSession,
  setAppearanceTheme,
  toggleAppearancePalette,
  toggleAppearanceTheme,
} from "../src/lib/theme";

Object.assign(process.env, {
  NODE_ENV: "test",
  LOCAL_DATABASE_PATH: ":memory:",
  BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  KEY_ENCRYPTION_SECRET: randomBytes(32).toString("hex"),
});
delete process.env.DATABASE_URL;
delete process.env.PGHOST;

const { getAuth } = await import("../src/server/auth");
const workspace = await import("../src/app/api/workspace/route");
const settingsRoute = await import("../src/app/api/settings/route");

type MockDomEnv = {
  dataset: Record<string, string | undefined>;
  storage: Map<string, string>;
  storageSetCalls: Array<{ key: string; value: string }>;
  metaThemeColor: string;
  metaColorScheme: string;
  flushRaf: () => void;
  dispatchStorage: (key: string, newValue: string | null) => void;
  dispatchMediaChange: (matches: boolean) => void;
};

function installMockBrowser(initial?: {
  domTheme?: string;
  domPalette?: string;
  storedTheme?: string;
  storedPalette?: string;
  prefersDark?: boolean;
}): MockDomEnv {
  const dataset: Record<string, string | undefined> = {};
  if (initial?.domTheme) dataset.theme = initial.domTheme;
  if (initial?.domPalette) dataset.palette = initial.domPalette;

  const storage = new Map<string, string>();
  if (initial?.storedTheme) storage.set("shiyi:theme", initial.storedTheme);
  if (initial?.storedPalette) storage.set("shiyi:palette", initial.storedPalette);

  const storageSetCalls: Array<{ key: string; value: string }> = [];
  const winListeners = new Map<string, Set<(event: unknown) => void>>();
  const docListeners = new Map<string, Set<(event: unknown) => void>>();
  const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();
  const rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
  let nextRafId = 1;

  const env: MockDomEnv = {
    dataset,
    storage,
    storageSetCalls,
    metaThemeColor: "#F5F7F6",
    metaColorScheme: "light dark",
    flushRaf() {
      const pending = rafQueue.splice(0, rafQueue.length);
      for (const item of pending) {
        item.cb(0);
      }
    },
    dispatchStorage(key, newValue) {
      for (const fn of winListeners.get("storage") ?? []) {
        fn({ key, newValue });
      }
    },
    dispatchMediaChange(matches) {
      for (const fn of mediaListeners) {
        fn({ matches } as MediaQueryListEvent);
      }
    },
  };

  const makeMeta = (name: "theme-color" | "color-scheme") => ({
    getAttribute(attr: string) {
      if (attr !== "content") return null;
      return name === "theme-color" ? env.metaThemeColor : env.metaColorScheme;
    },
    setAttribute(attr: string, val: string) {
      if (attr !== "content") return;
      if (name === "theme-color") env.metaThemeColor = val;
      else env.metaColorScheme = val;
    },
  });

  const mockDocument = {
    documentElement: { dataset },
    visibilityState: "visible",
    querySelectorAll(selector: string) {
      if (selector.includes("theme-color")) return [makeMeta("theme-color")];
      if (selector.includes("color-scheme")) return [makeMeta("color-scheme")];
      return [];
    },
    addEventListener(type: string, fn: (event: unknown) => void) {
      let set = docListeners.get(type);
      if (!set) {
        set = new Set();
        docListeners.set(type, set);
      }
      set.add(fn);
    },
    removeEventListener(type: string, fn: (event: unknown) => void) {
      docListeners.get(type)?.delete(fn);
    },
  };

  const mockWindow = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
        storageSetCalls.push({ key, value });
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
    matchMedia: () => ({
      matches: Boolean(initial?.prefersDark),
      addEventListener: (_type: string, fn: (event: MediaQueryListEvent) => void) => {
        mediaListeners.add(fn);
      },
      removeEventListener: (_type: string, fn: (event: MediaQueryListEvent) => void) => {
        mediaListeners.delete(fn);
      },
    }),
    getComputedStyle: () => ({ color: "rgb(0, 0, 0)" }),
    addEventListener(type: string, fn: (event: unknown) => void) {
      let set = winListeners.get(type);
      if (!set) {
        set = new Set();
        winListeners.set(type, set);
      }
      set.add(fn);
    },
    removeEventListener(type: string, fn: (event: unknown) => void) {
      winListeners.get(type)?.delete(fn);
    },
  };

  Object.defineProperty(globalThis, "document", {
    value: mockDocument,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: mockWindow,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    value: (cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafQueue.push({ id, cb });
      return id;
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    value: (id: number) => {
      const idx = rafQueue.findIndex((item) => item.id === id);
      if (idx >= 0) rafQueue.splice(idx, 1);
    },
    configurable: true,
    writable: true,
  });

  return env;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Account = { id: string; cookie: string };
let alice: Account;

function apiRequest(account: Account, path: string, body?: unknown) {
  return new Request(`http://localhost:3000${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie: account.cookie,
      origin: "http://localhost:3000",
      "content-type": "application/json",
      "x-workspace-user": account.id,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function fetchWorkspace(account: Account): Promise<Workspace> {
  const res = await workspace.GET(apiRequest(account, "/api/workspace"));
  assert.equal(res.status, 200);
  return res.json();
}

async function register(name: string): Promise<Account> {
  const res = await (
    await getAuth()
  ).handler(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name,
        email: `${name}@example.test`,
        password: randomUUID(),
      }),
    }),
  );
  assert.equal(res.status, 200);
  const result = await res.json();
  return {
    id: result.user.id,
    cookie: res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  };
}

before(async () => {
  alice = await register("theme-alice");
});

afterEach(() => {
  __configureAppearanceStoreForTests({ reset: true, fetch: null });
  delete (globalThis as Record<string, unknown>).document;
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).requestAnimationFrame;
  delete (globalThis as Record<string, unknown>).cancelAnimationFrame;
});

beforeEach(() => {
  __configureAppearanceStoreForTests({
    reset: true,
    fetch: null,
    debounceMs: 25,
    hydrateGuardMs: 5_000,
    now: () => Date.now(),
  });
});

test("rapid 10x theme toggle coalesces into 1 final POST and suppresses CSS transitions cleanly", async () => {
  const env = installMockBrowser({ domTheme: "light", storedTheme: "light" });
  const calls: Array<{ body: Record<string, unknown>; signal?: AbortSignal | null }> = [];
  __configureAppearanceStoreForTests({
    debounceMs: 30,
    fetch: (async (_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ body: parsed, signal: init?.signal });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch,
  });

  setAppearanceSession("user-1");

  // 11 rapid toggles: light -> dark (odd count ends on dark)
  for (let i = 0; i < 11; i++) {
    toggleAppearanceTheme();
  }

  assert.equal(getAppearance().theme, "dark");
  assert.equal(env.dataset.theme, "dark");
  assert.equal(env.storage.get("shiyi:theme"), "dark");
  // Transition suppression attribute is active synchronously until next RAF
  assert.equal(env.dataset.themeSwitching, "");
  env.flushRaf();
  assert.equal(env.dataset.themeSwitching, undefined);

  // Zero network calls fired before debounce expires
  assert.equal(calls.length, 0);

  await wait(60);
  // Exactly 1 coalesced POST with the final theme
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { action: "theme", theme: "dark" });
  assert.equal(__getAppearanceDebugStateForTests().pendingTheme, null);
});

test("newer click aborts superseded in-flight theme request so out-of-order response cannot reset theme", async () => {
  const env = installMockBrowser({ domTheme: "light", storedTheme: "light" });
  const resolvers: Array<() => void> = [];
  const signals: Array<AbortSignal | null | undefined> = [];
  const sentThemes: string[] = [];

  __configureAppearanceStoreForTests({
    debounceMs: 15,
    fetch: ((_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? "{}"));
      sentThemes.push(parsed.theme);
      signals.push(init?.signal);
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
        resolvers.push(() =>
          resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
        );
      });
    }) as typeof fetch,
  });

  setAppearanceSession("user-1");
  setAppearanceTheme("dark");
  await wait(35);
  assert.deepEqual(sentThemes, ["dark"]);
  assert.equal(signals[0]?.aborted, false);

  // User clicks back to light while Req 1 ("dark") is still in flight
  setAppearanceTheme("light");
  assert.equal(signals[0]?.aborted, true);
  assert.equal(env.dataset.theme, "light");

  // Wait for Req 2 ("light") to launch and complete
  await wait(35);
  assert.deepEqual(sentThemes, ["dark", "light"]);
  resolvers[1]?.();
  await wait(10);

  // Even if stale Req 1 resolver somehow ran late, theme remains "light"
  resolvers[0]?.();
  await wait(10);
  assert.equal(getAppearance().theme, "light");
  assert.equal(env.dataset.theme, "light");
  assert.equal(env.storage.get("shiyi:theme"), "light");
});

test("stale hydrateServerTheme is rejected while pending, during boot after local click, and within guard window; legitimate remote changes still apply", async () => {
  let fakeNow = 10_000;
  const env = installMockBrowser({ domTheme: "dark", storedTheme: "dark" });
  __configureAppearanceStoreForTests({
    debounceMs: 25,
    hydrateGuardMs: 5_000,
    now: () => fakeNow,
    fetch: (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch,
  });

  // Cold-load boot preserves dark mode from DOM/localStorage without clobbering to light
  assert.equal(getAppearance().theme, "dark");
  assert.equal(env.dataset.theme, "dark");

  // User toggles locally BEFORE workspace arrives
  setAppearanceSession("user-1");
  setAppearanceTheme("light");
  assert.equal(env.dataset.theme, "light");

  // Stale initial workspace payload ("dark") arrives while toggle is pending -> MUST NOT reset!
  hydrateServerTheme("user-1", "dark");
  assert.equal(getAppearance().theme, "light");
  assert.equal(env.dataset.theme, "light");

  // Let persist finish
  await wait(50);
  assert.equal(__getAppearanceDebugStateForTests().pendingTheme, null);

  // Stale refresh ("dark") arrives 1s later (within 5s guard window) -> MUST NOT reset!
  fakeNow += 1_000;
  hydrateServerTheme("user-1", "dark");
  assert.equal(getAppearance().theme, "light");
  assert.equal(env.dataset.theme, "light");

  // After guard window expires, baseline hydration sees server "light" -> stays "light"
  fakeNow += 6_000;
  hydrateServerTheme("user-1", "light");
  assert.equal(getAppearance().theme, "light");

  // Repeated polls with same server theme are no-ops
  hydrateServerTheme("user-1", "light");
  assert.equal(getAppearance().theme, "light");

  // Genuine remote change from another device ("dark") after guard window applies smoothly
  hydrateServerTheme("user-1", "dark");
  assert.equal(getAppearance().theme, "dark");
  assert.equal(env.dataset.theme, "dark");
  assert.equal(env.storage.get("shiyi:theme"), "dark");
});

test("offline / 5xx persist failure never rolls back local theme and retries silently on online; pagehide flushes with keepalive", async () => {
  const env = installMockBrowser({ domTheme: "light", storedTheme: "light" });
  let shouldFail = true;
  const requests: Array<{ theme: string; keepalive?: boolean }> = [];

  __configureAppearanceStoreForTests({
    debounceMs: 20,
    fetch: (async (_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? "{}"));
      requests.push({ theme: parsed.theme, keepalive: init?.keepalive });
      if (shouldFail) {
        throw new TypeError("Failed to fetch");
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch,
  });

  setAppearanceSession("user-1");
  setAppearanceTheme("dark");
  await wait(45);

  // Request failed offline, but UI/DOM/localStorage NEVER rolled back!
  assert.equal(requests.length, 1);
  assert.equal(getAppearance().theme, "dark");
  assert.equal(env.dataset.theme, "dark");
  assert.equal(env.storage.get("shiyi:theme"), "dark");
  assert.equal(__getAppearanceDebugStateForTests().dirtyForRetry, true);

  // Stale server poll cannot override dirty offline state
  hydrateServerTheme("user-1", "light");
  assert.equal(getAppearance().theme, "dark");

  // Network comes back online -> silent retry succeeds
  shouldFail = false;
  __triggerAppearanceOnlineForTests();
  await wait(20);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].theme, "dark");
  assert.equal(__getAppearanceDebugStateForTests().dirtyForRetry, false);
  assert.equal(__getAppearanceDebugStateForTests().pendingTheme, null);

  // Toggle right before closing tab -> pagehide flushes immediately with keepalive: true
  setAppearanceTheme("light");
  __triggerAppearancePageHideForTests();
  await wait(10);
  assert.equal(requests.length, 3);
  assert.equal(requests[2].theme, "light");
  assert.equal(requests[2].keepalive, true);
});

test("palette switching is 100% local-first with zero network calls; storage and prefers-color-scheme do not cause ping-pong", async () => {
  const env = installMockBrowser({ domTheme: "light", domPalette: "forest" });
  let fetchCalls = 0;
  __configureAppearanceStoreForTests({
    fetch: (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch,
  });

  setAppearanceSession("user-1");
  toggleAppearancePalette();
  assert.equal(getAppearance().palette, "lavender");
  assert.equal(env.dataset.palette, "lavender");
  assert.equal(env.storage.get("shiyi:palette"), "lavender");

  // Server theme hydration never resets palette
  hydrateServerTheme("user-1", "dark");
  assert.equal(getAppearance().palette, "lavender");
  assert.equal(env.dataset.palette, "lavender");
  assert.equal(fetchCalls, 0);

  // Cross-tab storage event updates local state without writing back to localStorage or firing fetch
  const beforeWrites = env.storageSetCalls.length;
  env.dispatchStorage("shiyi:palette", "forest");
  assert.equal(getAppearance().palette, "forest");
  assert.equal(env.dataset.palette, "forest");
  assert.equal(env.storageSetCalls.length, beforeWrites);
  assert.equal(fetchCalls, 0);

  // Once user explicitly stores shiyi:theme, OS prefers-color-scheme changes are ignored
  setAppearanceTheme("light");
  env.dispatchMediaChange(true);
  assert.equal(getAppearance().theme, "light");
  assert.equal(env.dataset.theme, "light");

  // Resetting palette explicitly stays synchronous
  setAppearancePalette("lavender");
  assert.equal(getAppearance().palette, "lavender");
});

test("POST /api/settings action:'theme' preserves study preferences, works on brand-new accounts, and action:'preferences' without theme preserves theme", async () => {
  // 1. Fresh account without prior GET /api/workspace: action:'theme' fast-path falls back cleanly to ensureWorkspace
  const fresh = await register("theme-fresh");
  const firstThemeRes = await settingsRoute.POST(
    apiRequest(fresh, "/api/settings", { action: "theme", theme: "dark" }),
  );
  assert.equal(firstThemeRes.status, 200);
  const freshWs = await fetchWorkspace(fresh);
  assert.equal(freshWs.settings.theme, "dark");

  // 2. Existing user: set custom study preferences first
  const initialWs = await fetchWorkspace(alice);
  assert.equal(initialWs.settings.theme, "light");

  const setPrefRes = await settingsRoute.POST(
    apiRequest(alice, "/api/settings", {
      action: "preferences",
      dailyGoal: 18,
      dailyNewLimit: 9,
      timeZone: "Asia/Tokyo",
    }),
  );
  assert.equal(setPrefRes.status, 200);

  // 3. Dedicated action:'theme' updates ONLY theme without touching goal/limit/timeZone
  const darkRes = await settingsRoute.POST(
    apiRequest(alice, "/api/settings", { action: "theme", theme: "dark" }),
  );
  assert.equal(darkRes.status, 200);
  const afterDark = await fetchWorkspace(alice);
  assert.equal(afterDark.settings.theme, "dark");
  assert.equal(afterDark.settings.dailyGoal, 18);
  assert.equal(afterDark.settings.dailyNewLimit, 9);
  assert.equal(afterDark.settings.timeZone, "Asia/Tokyo");

  // 4. Saving study preferences WITHOUT theme field MUST preserve theme:'dark'
  const updateGoalRes = await settingsRoute.POST(
    apiRequest(alice, "/api/settings", {
      action: "preferences",
      dailyGoal: 25,
      dailyNewLimit: 12,
      timeZone: "UTC",
    }),
  );
  assert.equal(updateGoalRes.status, 200);
  const afterGoal = await fetchWorkspace(alice);
  assert.equal(afterGoal.settings.theme, "dark");
  assert.equal(afterGoal.settings.dailyGoal, 25);
  assert.equal(afterGoal.settings.dailyNewLimit, 12);
  assert.equal(afterGoal.settings.timeZone, "UTC");

  // 5. Invalid theme value returns 400
  const invalidRes = await settingsRoute.POST(
    apiRequest(alice, "/api/settings", { action: "theme", theme: "sepia" }),
  );
  assert.equal(invalidRes.status, 400);
});
