export type AppView =
  | "today"
  | "library"
  | "concepts"
  | "favorites"
  | "inbox"
  | "archived"
  | "review"
  | "catalog"
  | "history"
  | "question";

export type LibraryQuickView =
  | "recent"
  | "favorites"
  | "inbox"
  | "duplicates"
  | "archived"
  | "trash";

export type RouteState = {
  view: AppView;
  deckId?: string | null;
  groupId?: string;
  category?: string;
  quickView?: LibraryQuickView;
  authorId?: string;
  conceptFolderId?: string | null;
  conceptId?: string;
  questionId?: string | null;
  originView?: AppView;
  originDeckId?: string | null;
  originQuickView?: LibraryQuickView;
  originConceptFolderId?: string | null;
};

const VALID_VIEWS = new Set<AppView>([
  "today",
  "library",
  "concepts",
  "favorites",
  "inbox",
  "archived",
  "review",
  "catalog",
  "history",
  "question",
]);

const VALID_QUICK_VIEWS = new Set<LibraryQuickView>([
  "recent",
  "favorites",
  "inbox",
  "duplicates",
  "archived",
  "trash",
]);

const ORIGIN_VIEWS = new Set<AppView>([
  "today",
  "library",
  "concepts",
  "favorites",
  "inbox",
  "archived",
  "catalog",
  "history",
]);

function normalizeIdParam(raw: string | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null") return undefined;
  return trimmed.slice(0, 128);
}

/** Extract `?subscribe=<deckId>` deep-link parameter if present. */
export function extractSubscribeParam(search: string): string | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return normalizeIdParam(params.get("subscribe")) ?? null;
}

/** Extract `?author=<userId>` creator deep-link parameter if present. */
export function extractAuthorParam(search: string): string | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return normalizeIdParam(params.get("author")) ?? null;
}

/** Parse window location query string into an application route state. */
export function parseRouteFromSearch(search: string, coldLoad = false): RouteState {
  void coldLoad;
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const rawView = params.get("view") as AppView | null;
  if (!rawView || !VALID_VIEWS.has(rawView)) {
    const authorId = normalizeIdParam(params.get("author"));
    if (authorId) return { view: "catalog", authorId };
    return { view: "today" };
  }
  if (rawView === "review") {
    return { view: "review" };
  }
  if (rawView === "catalog") {
    const authorId = normalizeIdParam(params.get("author"));
    return { view: "catalog", ...(authorId ? { authorId } : {}) };
  }
  if (rawView === "concepts") {
    const conceptFolderId = normalizeIdParam(params.get("folder"));
    const conceptId = normalizeIdParam(params.get("concept"));
    return {
      view: "concepts",
      ...(conceptFolderId ? { conceptFolderId } : {}),
      ...(conceptId ? { conceptId } : {}),
    };
  }
  if (rawView === "library") {
    const rawQuick = params.get("quick") as LibraryQuickView | null;
    if (rawQuick && VALID_QUICK_VIEWS.has(rawQuick)) {
      return { view: "library", quickView: rawQuick };
    }
    const rawDeck = params.get("deck") ?? params.get("folder");
    const deckId =
      rawDeck === "unfiled" || rawDeck === "root"
        ? null
        : normalizeIdParam(rawDeck);
    const groupId =
      typeof deckId === "string" ? normalizeIdParam(params.get("group")) : undefined;
    const category =
      typeof deckId === "string" ? normalizeIdParam(params.get("cat")) : undefined;
    return {
      view: "library",
      ...(deckId !== undefined ? { deckId } : {}),
      ...(groupId ? { groupId } : {}),
      ...(category ? { category } : {}),
    };
  }
  if (rawView === "question") {
    const questionId = normalizeIdParam(params.get("id"));
    if (!questionId) return { view: "library" };
    const rawFrom = params.get("from") as AppView | null;
    const originView: AppView =
      rawFrom && ORIGIN_VIEWS.has(rawFrom) ? rawFrom : "library";
    const rawDeck = params.get("deck") ?? params.get("folder");
    const originDeckId =
      originView === "library"
        ? rawDeck === "unfiled" || rawDeck === "root"
          ? null
          : normalizeIdParam(rawDeck)
        : undefined;
    const rawQuick = params.get("quick") as LibraryQuickView | null;
    const originQuickView =
      originView === "library" && rawQuick && VALID_QUICK_VIEWS.has(rawQuick)
        ? rawQuick
        : undefined;
    const originConceptFolderId =
      originView === "concepts"
        ? normalizeIdParam(params.get("folder"))
        : undefined;
    return {
      view: "question",
      questionId,
      originView,
      ...(originDeckId !== undefined ? { originDeckId } : {}),
      ...(originQuickView ? { originQuickView } : {}),
      ...(originConceptFolderId ? { originConceptFolderId } : {}),
    };
  }
  return { view: rawView };
}

/** Serialize an application route state to a URL search string (`""` or `"?..."`). */
export function buildSearchFromRoute(state: RouteState): string {
  const params = new URLSearchParams();
  if (state.view === "today") return "";
  if (state.view === "question") {
    if (!state.questionId) {
      params.set("view", "library");
      return `?${params.toString()}`;
    }
    params.set("view", "question");
    params.set("id", state.questionId);
    const originView =
      state.originView && ORIGIN_VIEWS.has(state.originView)
        ? state.originView
        : "library";
    if (originView !== "library") {
      params.set("from", originView);
      if (originView === "concepts" && state.originConceptFolderId?.trim()) {
        params.set("folder", state.originConceptFolderId.trim());
      }
    } else if (state.originQuickView) {
      params.set("quick", state.originQuickView);
    } else if (state.originDeckId !== undefined) {
      params.set("deck", state.originDeckId === null ? "unfiled" : state.originDeckId);
    }
    return `?${params.toString()}`;
  }
  params.set("view", state.view);
  if (state.view === "catalog" && state.authorId?.trim()) {
    params.set("author", state.authorId.trim());
  }
  if (state.view === "concepts") {
    if (state.conceptFolderId?.trim()) {
      params.set("folder", state.conceptFolderId.trim());
    }
    if (state.conceptId?.trim()) {
      params.set("concept", state.conceptId.trim());
    }
  }
  if (state.view === "library") {
    if (state.quickView && VALID_QUICK_VIEWS.has(state.quickView)) {
      params.set("quick", state.quickView);
    } else if (state.deckId !== undefined) {
      params.set("deck", state.deckId === null ? "unfiled" : state.deckId);
      if (typeof state.deckId === "string") {
        if (state.groupId?.trim()) params.set("group", state.groupId.trim());
        if (state.category?.trim()) params.set("cat", state.category.trim());
      }
    }
  }
  return `?${params.toString()}`;
}
