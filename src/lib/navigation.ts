export type AppView =
  | "today"
  | "library"
  | "favorites"
  | "inbox"
  | "archived"
  | "review"
  | "catalog"
  | "history"
  | "question";

export type RouteState = {
  view: AppView;
  deckId?: string | null;
  groupId?: string;
  category?: string;
  authorId?: string;
  questionId?: string | null;
  originView?: AppView;
  originDeckId?: string | null;
};

const VALID_VIEWS = new Set<AppView>([
  "today",
  "library",
  "favorites",
  "inbox",
  "archived",
  "review",
  "catalog",
  "history",
  "question",
]);

const ORIGIN_VIEWS = new Set<AppView>([
  "today",
  "library",
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
  if (rawView === "library") {
    const rawDeck = params.get("deck");
    const deckId =
      rawDeck === "unfiled" ? null : normalizeIdParam(rawDeck);
    const groupId = typeof deckId === "string" ? normalizeIdParam(params.get("group")) : undefined;
    const category = typeof deckId === "string" ? normalizeIdParam(params.get("cat")) : undefined;
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
    const rawDeck = params.get("deck");
    const originDeckId =
      originView === "library"
        ? rawDeck === "unfiled"
          ? null
          : normalizeIdParam(rawDeck)
        : undefined;
    return {
      view: "question",
      questionId,
      originView,
      ...(originDeckId !== undefined ? { originDeckId } : {}),
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
    } else if (state.originDeckId !== undefined) {
      params.set("deck", state.originDeckId === null ? "unfiled" : state.originDeckId);
    }
    return `?${params.toString()}`;
  }
  params.set("view", state.view);
  if (state.view === "catalog" && state.authorId?.trim()) {
    params.set("author", state.authorId.trim());
  }
  if (state.view === "library" && state.deckId !== undefined) {
    params.set("deck", state.deckId === null ? "unfiled" : state.deckId);
    if (typeof state.deckId === "string") {
      if (state.groupId?.trim()) params.set("group", state.groupId.trim());
      if (state.category?.trim()) params.set("cat", state.category.trim());
    }
  }
  return `?${params.toString()}`;
}
