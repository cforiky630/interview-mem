"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
} from "react";
import dynamic from "next/dynamic";
import {
  BookOpen,
  LayoutDashboard,
  Layers2,
  RotateCcw,
  Rss,
  Star,
  Inbox,
  History,
  Search,
  Plus,
  LogOut,
  Menu,
  Loader2,
  Cloud,
  RefreshCw,
  Upload,
  WifiOff,
  Sun,
  Moon,
  X,
  ArrowLeft,
  Plug,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { api } from "@/lib/client";
import { useDeviceProfile } from "@/lib/device-profile";
import {
  computeDeckReadingOrder,
  computeReaderGroupContext,
  groupDecksByName,
  listDeckGroupNames,
  OTHER_DECKS_LABEL,
} from "@/lib/grouping";
import type {
  Workspace,
  QuestionView,
  CatalogDeck,
  DeckGroupView,
  DeckView,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { extractNoteAliases, normalizedNoteTitle } from "@/lib/markdown-source";
import { practiceDraftKey, savePracticeDraft } from "@/lib/drafts";
import { syncDocumentTheme, type Palette } from "@/lib/theme";
import {
  buildSearchFromRoute,
  extractSubscribeParam,
  parseRouteFromSearch,
  type AppView,
  type RouteState,
} from "@/lib/navigation";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ui/confirm-dialog";
import { AuthScreen } from "./auth-screen";
import { Dashboard } from "./dashboard";
import { Library, Catalog } from "./library";
import { ReviewHub } from "./review-hub";
import { useAiAnswerDraft } from "./use-ai-answer-draft";
import { useAppShortcuts } from "./use-app-shortcuts";
import { usePageScroll } from "./use-page-scroll";
import { useWorkspaceSync } from "./use-workspace-sync";
import { UserMenu } from "./user-menu";
import {
  AiIsland,
  clampAiDockWidth,
  type AiIslandMode,
  type AiTrigger,
} from "./ai-island";
const QuestionReader = dynamic(
  () => import("./question-reader").then((m) => m.QuestionReader),
  {
    loading: () => (
      <div className="view-loading">
        <Loader2 className="spin" size={20} />
      </div>
    ),
  },
);
const ReviewComplete = dynamic(() =>
  import("./question-reader").then((m) => m.ReviewComplete),
);
const HistoryView = dynamic(() =>
  import("./history").then((m) => m.HistoryView),
);
const AiAnswerDialog = dynamic(() =>
  import("./ai-answer-dialog").then((m) => m.AiAnswerDialog),
);
const CreateDeckDialog = dynamic(() =>
  import("./dialogs").then((m) => m.CreateDeckDialog),
);
const EditDeckDialog = dynamic(() =>
  import("./dialogs").then((m) => m.EditDeckDialog),
);
const CreateQuestionDialog = dynamic(() =>
  import("./dialogs").then((m) => m.CreateQuestionDialog),
);
const ImportDialog = dynamic(() =>
  import("./import-dialog").then((m) => m.ImportDialog),
);
const PublishDialog = dynamic(() =>
  import("./dialogs").then((m) => m.PublishDialog),
);
const SettingsCard = dynamic(() =>
  import("./settings-card").then((m) => m.SettingsCard),
);
import type { SettingsTab } from "./settings-card";
const DeleteDeckDialog = dynamic(() =>
  import("./deck-delete-dialog").then((m) => m.DeleteDeckDialog),
);

const QuestionActionDialog = dynamic(() =>
  import("./question-action-dialog").then((m) => m.QuestionActionDialog),
);
const DeckGroupDialog = dynamic(() =>
  import("./deck-group-dialog").then((m) => m.DeckGroupDialog),
);
const SetDeckGroupDialog = dynamic(() =>
  import("./deck-group-dialog").then((m) => m.SetDeckGroupDialog),
);
const ManageDeckGroupsDialog = dynamic(() =>
  import("./deck-group-dialog").then((m) => m.ManageDeckGroupsDialog),
);

import type { ImportSeed } from "./import-dialog";

type View = AppView;
export type { Palette };

function clearCardPracticeDrafts(
  userId: string,
  questionId: string,
  revisions: number[],
) {
  for (const rev of new Set(revisions)) {
    savePracticeDraft(practiceDraftKey(userId, questionId, rev), "");
    const paraPrefix = practiceDraftKey(userId, questionId, rev, "paragraph");
    try {
      const toRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(paraPrefix)) toRemove.push(k);
      }
      for (const k of toRemove) localStorage.removeItem(k);
    } catch {
      /* Ignore storage access failures. */
    }
  }
}

export function StudyApp() {
  const { data: session, isPending } = authClient.useSession();
  useEffect(() => {
    try {
      const cached = localStorage.getItem("shiyi:theme");
      const media = window.matchMedia?.("(prefers-color-scheme: dark)");
      const resolved: "light" | "dark" =
        cached === "light" || cached === "dark"
          ? cached
          : media?.matches
            ? "dark"
            : "light";
      const savedPalette: Palette =
        localStorage.getItem("shiyi:palette") === "lavender"
          ? "lavender"
          : "forest";
      syncDocumentTheme(resolved, savedPalette);
      if (cached !== "light" && cached !== "dark" && media) {
        const onChange = (event: MediaQueryListEvent) => {
          const next = event.matches ? "dark" : "light";
          const activePal =
            document.documentElement.dataset.palette === "lavender"
              ? "lavender"
              : "forest";
          syncDocumentTheme(next, activePal);
        };
        media.addEventListener("change", onChange);
        return () => media.removeEventListener("change", onChange);
      }
    } catch {
      /* Ignore storage access failures. */
    }
  }, []);
  if (isPending)
    return (
      <div className="app-loading">
        <span className="brand-mark">
          <BookOpen size={27} />
        </span>
        <p>让知识，慢慢留下来。</p>
        <Loader2 size={20} className="spin" />
      </div>
    );
  if (!session) return <AuthScreen />;
  return <WorkspaceApp key={session.user.id} sessionId={session.user.id} />;
}

function WorkspaceApp({ sessionId }: { sessionId: string }) {
  const initialRoute = useRef<RouteState | null>(null);
  if (initialRoute.current === null) {
    if (typeof window !== "undefined") {
      const sub = extractSubscribeParam(window.location.search);
      initialRoute.current = sub
        ? { view: "catalog" }
        : parseRouteFromSearch(window.location.search, true);
    } else {
      initialRoute.current = { view: "today" };
    }
  }
  const {
    data,
    error,
    syncError,
    pending,
    lifetime,
    refresh,
    mutate,
  } = useWorkspaceSync(sessionId);
  const device = useDeviceProfile();
  const [view, setView] = useState<View>(initialRoute.current.view);
  const [navigationTarget, setNavigationTarget] = useState<View>(
    initialRoute.current.view,
  );
  const [isNavigating, startTransition] = useTransition();
  const [deckId, setDeckId] = useState<string | null | undefined>(
    initialRoute.current.view === "library"
      ? initialRoute.current.deckId
      : initialRoute.current.originDeckId,
  );
  const [libraryGroupFilter, setLibraryGroupFilter] = useState<{
    groupId?: string | null;
    category?: string | null;
  }>(() =>
    initialRoute.current?.view === "library"
      ? {
          groupId: initialRoute.current.groupId,
          category: initialRoute.current.category,
        }
      : {},
  );
  const [questionId, setQuestionId] = useState<string | null>(
    initialRoute.current.questionId ?? null,
  );
  const [readingIds, setReadingIds] = useState<string[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [drawerDragX, setDrawerDragX] = useState(0);
  const drawerTouch = useRef<{
    x: number;
    y: number;
    time: number;
    locked: "h" | "v" | null;
  } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importSeed, setImportSeed] = useState<ImportSeed>();
  const [importPreferredGroupId, setImportPreferredGroupId] = useState<
    string | undefined
  >(undefined);
  const importCommitted = useRef<(() => void) | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createDeckDefaultGroup, setCreateDeckDefaultGroup] = useState("");
  const [manageDeckGroupsOpen, setManageDeckGroupsOpen] = useState(false);
  const [editDeck, setEditDeck] = useState<Workspace["decks"][number] | null>(
    null,
  );
  const [groupDialog, setGroupDialog] = useState<{
    deck: DeckView;
    group?: DeckGroupView;
    defaultCategory?: string;
  } | null>(null);
  const [setDeckGroupTarget, setSetDeckGroupTarget] = useState<DeckView | null>(
    null,
  );
  const [createQuestionOpen, setCreateQuestionOpen] = useState(false);
  const [createQuestionGroupId, setCreateQuestionGroupId] = useState<
    string | undefined
  >(undefined);
  const [settingsState, setSettingsState] = useState<{
    open: boolean;
    tab: SettingsTab;
  }>({ open: false, tab: "study" });
  const [settingsMounted, setSettingsMounted] = useState(false);
  const openSettings = useCallback(
    (tab: SettingsTab = "study", options?: { toggle?: boolean }) => {
      setSettingsMounted(true);
      setSettingsState((prev) => {
        if (options?.toggle && prev.open && prev.tab === tab) {
          return { ...prev, open: false };
        }
        return { open: true, tab };
      });
    },
    [],
  );
  const toggleSettings = useCallback(() => {
    setSettingsMounted(true);
    setSettingsState((prev) => ({
      open: !prev.open,
      tab: prev.open ? prev.tab : "study",
    }));
  }, []);
  const [palette, setPalette] = useState<Palette>("forest");
  const [themeOverride, setThemeOverride] = useState<"light" | "dark" | null>(
    null,
  );
  const [publishId, setPublishId] = useState<string | null>(null);
  const [deleteDeck, setDeleteDeck] = useState<
    Workspace["decks"][number] | null
  >(null);
  const [questionAction, setQuestionAction] = useState<{
    question: QuestionView;
    action: "delete" | "move";
  } | null>(null);
  const [searchToken, setSearchToken] = useState(0);
  const [aiMode, setAiMode] = useState<AiIslandMode>("collapsed");
  const [aiDockWidth, setAiDockWidth] = useState<number | null>(null);
  const [aiDockResizing, setAiDockResizing] = useState(false);
  const [aiTrigger, setAiTrigger] = useState<AiTrigger | null>(null);
  const triggerSeq = useRef(0);
  const [aiBusy, setAiBusy] = useState(false);
  const [reviewRevealed, setReviewRevealed] = useState(false);
  const [confirmState, setConfirmState] = useState<{
    open: boolean;
    title: string;
    description: string;
    confirmLabel: string;
    variant?: "default" | "danger";
    action: () => void | Promise<void>;
  } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const origin = useRef<{ view: View; deckId?: string | null }>({
    view: initialRoute.current.originView ?? "library",
    ...(initialRoute.current.originDeckId !== undefined
      ? { deckId: initialRoute.current.originDeckId }
      : {}),
  });
  const reviewOrigin = useRef<{
    view: View;
    deckId?: string | null;
    questionId?: string | null;
  }>({ view: "today" });
  const [catalog, setCatalog] = useState<CatalogDeck[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [queue, setQueue] = useState<QuestionView[]>([]);
  const queueLength = useRef(0);
  queueLength.current = queue.length;
  const [reviewSessionActive, setReviewSessionActive] = useState(false);
  const [reviewMode, setReviewMode] = useState<"fsrs" | "cram">("fsrs");
  const [cramLabel, setCramLabel] = useState("");
  const [reviewIndex, setReviewIndex] = useState(0);
  const [ratings, setRatings] = useState<number[]>([]);
  const [reviewResults, setReviewResults] = useState<
    { question: QuestionView; rating: number }[]
  >([]);
  const [reviewBusy, setReviewBusy] = useState(false);
  const grading = useRef(false);
  const eventId = useRef(crypto.randomUUID());
  const pageKey =
    view === "question"
      ? `question:${questionId}`
      : view === "review"
        ? reviewSessionActive
          ? `review:${reviewIndex}:${queue[reviewIndex]?.id ?? "done"}`
          : "review:hub"
        : view === "library"
          ? `library:${deckId === null ? "unfiled" : (deckId ?? "all")}`
          : view;
  const rememberScroll = usePageScroll(pageKey, !!data);
  useEffect(() => {
    if (!data) return;
    const connection = (
      navigator as Navigator & {
        connection?: { saveData?: boolean; effectiveType?: string };
      }
    ).connection;
    if (
      connection?.saveData ||
      /(^|-)2g$/.test(connection?.effectiveType ?? "")
    )
      return;
    // 首页可用后再空闲预热阅读器，让手机第一次点题目时不必等待整块脚本。
    const warm = () => {
      void import("./question-reader").catch(() => {});
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(warm, { timeout: 500 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(warm, 150);
    return () => window.clearTimeout(id);
  }, [data?.user.id]);
  useEffect(() => {
    try {
      const saved = localStorage.getItem("shiyi.aiDockWidth");
      if (saved) {
        const parsed = Number.parseInt(saved, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          setAiDockWidth(clampAiDockWidth(parsed, window.innerWidth));
        }
      }
    } catch {
      /* Ignore storage restrictions. */
    }
  }, []);
  const handleAiDockWidthChange = useCallback((next: number | null) => {
    const clamped =
      next === null
        ? null
        : clampAiDockWidth(
            next,
            typeof window !== "undefined" ? window.innerWidth : 1440,
          );
    setAiDockWidth(clamped);
    try {
      if (clamped === null) {
        localStorage.removeItem("shiyi.aiDockWidth");
      } else {
        localStorage.setItem("shiyi.aiDockWidth", String(clamped));
      }
    } catch {
      /* Ignore storage restrictions. */
    }
  }, []);
  useEffect(() => {
    if (!sidebarOpen) {
      setDrawerDragX(0);
      drawerTouch.current = null;
    }
  }, [sidebarOpen]);
  const viewRef = useRef(view);
  viewRef.current = view;
  const deckIdRef = useRef(deckId);
  deckIdRef.current = deckId;
  useEffect(() => {
    function openLinkedNote(event: Event) {
      const target = (event as CustomEvent<unknown>).detail;
      if (typeof target !== "string" || !data) return;
      const normalized = normalizedNoteTitle(target);
      if (!normalized) return;
      const exact = data.questions.filter(
        (q) =>
          !q.archived &&
          (normalizedNoteTitle(q.title) === normalized ||
            normalizedNoteTitle(q.validation?.sourcePath ?? "") ===
              normalized ||
            extractNoteAliases(q.answer).some(
              (alias) => normalizedNoteTitle(alias) === normalized,
            )),
      );
      const matches = exact.length
        ? exact
        : data.questions.filter(
            (q) =>
              !q.archived &&
              normalizedNoteTitle(q.title).startsWith(normalized),
          );
      if (matches.length !== 1) {
        toast.info(
          matches.length
            ? "找到多个同名条目，请在题库中搜索。"
            : "当前账号还没有这个关联条目。",
        );
        return;
      }
      if (viewRef.current !== "question") {
        origin.current = { view: viewRef.current, deckId: deckIdRef.current };
      }
      setReadingIds([]);
      changePage(
        "question",
        () => {
          setQuestionId(matches[0].id);
        },
        {
          route: {
            view: "question",
            questionId: matches[0].id,
            originView: origin.current.view,
            originDeckId: origin.current.deckId,
          },
        },
      );
    }
    window.addEventListener("shiyi:open-note", openLinkedNote);
    return () => window.removeEventListener("shiyi:open-note", openLinkedNote);
  }, [data?.questions]);
  const loadCatalog = useCallback(
    async (shared?: string) => {
      const signal = lifetime.current?.signal;
      if (!signal || signal.aborted) return;
      setCatalogLoading(true);
      try {
        const result = await api<CatalogDeck[]>(
          `/api/catalog${shared ? `?id=${encodeURIComponent(shared)}` : ""}`,
          undefined,
          { userId: sessionId, signal },
        );
        setCatalog(result);
      } catch (e) {
        if (signal.aborted) return;
        toast.error(e instanceof Error ? e.message : "题库暂时无法加载。");
      } finally {
        setCatalogLoading(false);
      }
    },
    [sessionId, lifetime],
  );
  useEffect(() => {
    if (!sessionId) return;
    const shared = extractSubscribeParam(window.location.search);
    if (shared) {
      setView("catalog");
      setNavigationTarget("catalog");
      void loadCatalog(shared);
      return;
    }
    const hydrated = parseRouteFromSearch(window.location.search, true);
    if (hydrated.view === "catalog") void loadCatalog();
    const canonical = buildSearchFromRoute(hydrated);
    if (window.location.search !== canonical) {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${canonical}`,
      );
    }
  }, [sessionId, loadCatalog]);
  useEffect(() => {
    function onPopState() {
      setSidebarOpen(false);
      const next = parseRouteFromSearch(window.location.search);
      setNavigationTarget(next.view);
      startTransition(() => {
        if (next.view !== "review" || queueLength.current === 0) {
          setReviewSessionActive(false);
        }
        if (next.view === "library") {
          setDeckId(next.deckId);
          setLibraryGroupFilter({
            groupId: next.groupId,
            category: next.category,
          });
        } else if (next.view === "question") {
          origin.current = {
            view: next.originView ?? "library",
            deckId: next.originDeckId,
          };
          setDeckId(next.originDeckId);
          setQuestionId(next.questionId ?? null);
        }
        setView(next.view);
      });
      if (next.view === "catalog") void loadCatalog();
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [loadCatalog]);
  const paletteRef = useRef<Palette>(palette);
  paletteRef.current = palette;
  const activeThemeRef = useRef<"light" | "dark">("light");
  activeThemeRef.current =
    (themeOverride ?? data?.settings.theme) === "dark" ? "dark" : "light";

  useEffect(() => {
    try {
      const savedPalette =
        localStorage.getItem("shiyi:palette") === "lavender"
          ? "lavender"
          : "forest";
      setPalette(savedPalette);
      syncDocumentTheme(activeThemeRef.current, savedPalette);
    } catch {
      syncDocumentTheme(activeThemeRef.current, "forest");
    }
  }, []);
  const applyPalette = useCallback((next: Palette) => {
    setPalette(next);
    syncDocumentTheme(activeThemeRef.current, next);
    try {
      localStorage.setItem("shiyi:palette", next);
    } catch {
      /* Ignore storage access failures. */
    }
  }, []);
  useEffect(() => {
    if (!data) return;
    setThemeOverride(null);
    const nextTheme = data.settings.theme === "dark" ? "dark" : "light";
    syncDocumentTheme(nextTheme, paletteRef.current);
    try {
      localStorage.setItem("shiyi:theme", nextTheme);
    } catch {
      /* Ignore storage access failures. */
    }
  }, [data?.settings.theme]);
  useEffect(() => {
    syncDocumentTheme(activeThemeRef.current, palette);
  }, [palette]);
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === "shiyi:theme") {
        if (event.newValue === "light" || event.newValue === "dark") {
          setThemeOverride(event.newValue);
          syncDocumentTheme(event.newValue, paletteRef.current);
        }
      } else if (event.key === "shiyi:palette") {
        const nextPal: Palette =
          event.newValue === "lavender" ? "lavender" : "forest";
        setPalette(nextPal);
        syncDocumentTheme(activeThemeRef.current, nextPal);
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const preferredAiOpenMode = useRef<"docked" | "floating">("docked");
  const handleAiModeChange = useCallback((next: AiIslandMode) => {
    if (next !== "collapsed") preferredAiOpenMode.current = next;
    setAiMode(next);
  }, []);
  useAppShortcuts({
    view,
    reviewRevealed,
    isEditing: false,
    aiMode,
    onToggleAi: () =>
      setAiMode((current) =>
        current === "collapsed" ? preferredAiOpenMode.current : "collapsed",
      ),
    onCloseAi: () => setAiMode("collapsed"),
    onCloseSidebar: () => setSidebarOpen(false),
    onToggleSettings: toggleSettings,
    onQuickSearch: (viaSlash) => {
      if (viaSlash && viewRef.current === "library") {
        (
          document.querySelector(
            "input[aria-label='搜索题目']",
          ) as HTMLInputElement | null
        )?.focus();
        return;
      }
      changePage(
        "library",
        () => {
          setDeckId(undefined);
          setSearchToken((n) => n + 1);
        },
        { route: { view: "library" } },
      );
      setTimeout(
        () =>
          (
            document.querySelector(
              "input[aria-label='搜索题目']",
            ) as HTMLInputElement
          )?.focus(),
        70,
      );
    },
  });
  const toggleAi = useCallback((open?: boolean) => {
    setAiMode((current) => {
      if (open === false) return "collapsed";
      if (open === true)
        return current === "collapsed" ? preferredAiOpenMode.current : current;
      return current === "collapsed"
        ? preferredAiOpenMode.current
        : "collapsed";
    });
  }, []);
  const askAi = useCallback(
    (request: { quote: string; prompt: string; attempt?: string }) => {
      setAiTrigger({ ...request, nonce: ++triggerSeq.current });
      setAiMode((current) =>
        current === "collapsed" ? preferredAiOpenMode.current : current,
      );
    },
    [],
  );
  const aiHiddenInReview =
    view === "review" && reviewSessionActive && !reviewRevealed;
  const queueCardId = queue[reviewIndex]?.id;
  useEffect(() => {
    setReviewRevealed(false);
  }, [view, reviewIndex, queueCardId]);
  useEffect(() => {
    if (aiHiddenInReview && aiMode !== "collapsed") {
      setAiMode("collapsed");
    }
  }, [aiHiddenInReview, aiMode]);
  const answerDraft = useAiAnswerDraft(data, mutate, () =>
    openSettings("ai"),
  );
  function openImport() {
    setImportSeed(undefined);
    setImportPreferredGroupId(undefined);
    importCommitted.current = null;
    setImportOpen(true);
  }
  function pushRouteUrl(route: RouteState, replace = false) {
    if (typeof window === "undefined") return;
    const nextSearch = buildSearchFromRoute(route);
    if (nextSearch === window.location.search) return;
    const url = `${window.location.pathname}${nextSearch}`;
    if (replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
  }
  function navigate(next: View) {
    changePage(
      next,
      () => {
        setReviewSessionActive(false);
        if (next === "library" || next === "today" || next === "history") {
          setDeckId(undefined);
          setLibraryGroupFilter({});
        }
        if (next !== "question") {
          setReadingIds([]);
        }
      },
      { route: { view: next } },
    );
    setSidebarOpen(false);
    if (next === "catalog") void loadCatalog();
  }
  function changePage(
    next: View,
    prepare?: () => void,
    options?: { replace?: boolean; skipHistory?: boolean; route?: RouteState },
  ) {
    rememberScroll();
    if (!options?.skipHistory) {
      pushRouteUrl(options?.route ?? { view: next }, options?.replace);
    }
    setNavigationTarget(next);
    // 导航反馈先提交，长文的 Markdown 渲染可被下一次触控打断。
    startTransition(() => {
      prepare?.();
      setView(next);
    });
  }
  function openDeck(
    id?: string | null,
    groupFilter?: { groupId?: string; category?: string },
  ) {
    const nextFilter =
      typeof id === "string" && groupFilter ? groupFilter : {};
    changePage(
      "library",
      () => {
        setReviewSessionActive(false);
        setDeckId(id);
        setLibraryGroupFilter(nextFilter);
      },
      {
        route: {
          view: "library",
          deckId: id,
          ...(typeof id === "string" && nextFilter.groupId
            ? { groupId: nextFilter.groupId }
            : {}),
          ...(typeof id === "string" && nextFilter.category
            ? { category: nextFilter.category }
            : {}),
        },
      },
    );
    setSidebarOpen(false);
  }
  function openQuestion(
    question: QuestionView,
    orderedIds?: string[],
    historyMode: "push" | "replace" = "push",
  ) {
    if (view !== "question") origin.current = { view, deckId };
    if (orderedIds !== undefined) {
      setReadingIds(orderedIds);
    } else if (view !== "question") {
      setReadingIds([]);
    }
    changePage(
      "question",
      () => {
        setReviewSessionActive(false);
        setQuestionId(question.id);
      },
      {
        replace: historyMode === "replace",
        route: {
          view: "question",
          questionId: question.id,
          originView: origin.current.view,
          originDeckId: origin.current.deckId,
        },
      },
    );
  }
  function startReview(targetDeck?: string, single?: QuestionView) {
    if (!data) return;
    if (
      view === "review" &&
      reviewSessionActive &&
      !targetDeck &&
      !single &&
      queue[reviewIndex]
    ) {
      if (navigationTarget !== "review") {
        changePage("review", undefined, { replace: true, route: { view: "review" } });
      }
      setSidebarOpen(false);
      return;
    }
    if (view !== "review" || !reviewSessionActive) {
      reviewOrigin.current = { view, deckId, questionId };
    }
    const active = data.questions.filter(
      (q) =>
        !q.archived &&
        q.answer.trim() &&
        (!targetDeck || q.deckId === targetDeck),
    );
    const majorReview = active
      .filter((q) => q.fsrs && q.majorRevision > q.reviewedRevision)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const majorIds = new Set(majorReview.map((q) => q.id));
    const due = active
      .filter(
        (q) =>
          !majorIds.has(q.id) &&
          q.fsrs &&
          new Date(q.fsrs.due).getTime() <= Date.now(),
      )
      .sort(
        (a, b) =>
          new Date(a.fsrs!.due).getTime() - new Date(b.fsrs!.due).getTime(),
      );
    const fresh = active
      .filter((q) => !q.fsrs)
      .slice(
        0,
        Math.max(0, data.settings.dailyNewLimit - data.stats.newLearnedToday),
      );
    setReviewRevealed(false);
    setReviewMode("fsrs");
    setCramLabel("");
    setReviewResults([]);
    changePage(
      "review",
      () => {
        setReviewSessionActive(true);
        setQueue(single ? [single] : [...majorReview, ...due, ...fresh]);
        setReviewIndex(0);
        setRatings([]);
      },
      { replace: view === "review", route: { view: "review" } },
    );
    setSidebarOpen(false);
    eventId.current = crypto.randomUUID();
    rememberScroll();
  }
  function startCram(items: QuestionView[], label: string) {
    if (!data) return;
    if (view !== "review" || !reviewSessionActive) {
      reviewOrigin.current = { view, deckId, questionId };
    }
    const cramList = items.filter((q) => !q.archived && q.answer.trim());
    setReviewRevealed(false);
    setReviewMode("cram");
    setCramLabel(label);
    setReviewResults([]);
    changePage(
      "review",
      () => {
        setReviewSessionActive(true);
        setQueue(cramList);
        setReviewIndex(0);
        setRatings([]);
      },
      { replace: view === "review", route: { view: "review" } },
    );
    setSidebarOpen(false);
    eventId.current = crypto.randomUUID();
    rememberScroll();
  }
  async function favorite(question: QuestionView) {
    await mutate("/api/questions", {
      action: "favorite",
      id: question.id,
      favorite: !question.favorite,
    });
  }
  async function grade(rating: number, answer = "") {
    if (grading.current || isNavigating) return;
    const q = queue[reviewIndex];
    if (!q) return;
    const latest = data?.questions.find((item) => item.id === q.id);
    if (reviewMode === "cram") {
      if (data) {
        clearCardPracticeDrafts(data.user.id, q.id, [
          q.revision,
          latest?.revision ?? q.revision,
        ]);
      }
      setRatings((previous) => [...previous, rating]);
      setReviewResults((previous) => [
        ...previous,
        { question: latest ?? q, rating },
      ]);
      setReviewIndex((n) => n + 1);
      rememberScroll();
      return;
    }
    if (!latest || latest.studyVersion !== q.studyVersion || latest.archived) {
      toast.info(
        "这道题的复习进度已在其他页面更新或被归档，已跳过。",
      );
      setReviewIndex((n) => n + 1);
      eventId.current = crypto.randomUUID();
      return;
    }
    grading.current = true;
    setReviewBusy(true);
    try {
      const result = await mutate("/api/reviews", {
        questionId: q.id,
        eventId: eventId.current,
        expectedVersion: q.studyVersion,
        questionRevision: latest.revision,
        rating,
        answer,
      });
      if (result) {
        if (data) {
          clearCardPracticeDrafts(data.user.id, q.id, [
            q.revision,
            latest.revision,
          ]);
        }
        setRatings((previous) => [...previous, rating]);
        setReviewResults((previous) => [
          ...previous,
          { question: latest, rating },
        ]);
        setReviewIndex((n) => n + 1);
        eventId.current = crypto.randomUUID();
        rememberScroll();
      }
    } finally {
      grading.current = false;
      setReviewBusy(false);
    }
  }
  const currentQuestion = data?.questions.find((q) => q.id === questionId);
  const queueQuestion = queue[reviewIndex];
  const currentReview = data?.questions.find((q) => q.id === queueQuestion?.id);
  useEffect(() => {
    if (
      !data ||
      view !== "review" ||
      !queueQuestion ||
      currentReview ||
      grading.current
    )
      return;
    const nextAlive = queue.findIndex(
      (item, idx) =>
        idx > reviewIndex && data.questions.some((q) => q.id === item.id),
    );
    setReviewIndex(nextAlive >= 0 ? nextAlive : queue.length);
    eventId.current = crypto.randomUUID();
  }, [data, view, queue, reviewIndex, queueQuestion, currentReview]);
  if (!data)
    return (
      <div className="app-loading">
        <span className="brand-mark">
          <BookOpen size={27} />
        </span>
        <h2>{error ? "暂时没有连接上题库" : "正在打开你的知识空间"}</h2>
        <p>{error || "给积累一点时间。"}</p>
        {error ? (
          <>
            <Button variant="outline" onClick={() => void refresh()}>
              重新连接
            </Button>
            <Button variant="ghost" onClick={() => void authClient.signOut()}>
              退出登录
            </Button>
          </>
        ) : (
          <Loader2 size={21} className="spin" />
        )}
      </div>
    );
  const activeTheme: "light" | "dark" =
    (themeOverride ?? data.settings.theme) === "dark" ? "dark" : "light";
  async function setThemeMode(next: "light" | "dark") {
    if (!data || next === activeTheme) return;
    const previousTheme = activeTheme;
    setThemeOverride(next);
    syncDocumentTheme(next, palette);
    try {
      localStorage.setItem("shiyi:theme", next);
    } catch {
      /* Ignore storage access failures. */
    }
    const result = await mutate("/api/settings", {
      action: "preferences",
      dailyGoal: data.settings.dailyGoal,
      dailyNewLimit: data.settings.dailyNewLimit,
      theme: next,
      timeZone: data.settings.timeZone,
    });
    if (!result) {
      setThemeOverride(null);
      syncDocumentTheme(previousTheme, palette);
      try {
        localStorage.setItem("shiyi:theme", previousTheme);
      } catch {
        /* Ignore storage access failures. */
      }
    }
  }
  function toggleTheme() {
    void setThemeMode(activeTheme === "dark" ? "light" : "dark");
  }
  function openQuickSearch() {
    navigate("library");
    setSearchToken((n) => n + 1);
    setTimeout(
      () =>
        (
          document.querySelector(
            "input[aria-label='搜索题目']",
          ) as HTMLInputElement
        )?.focus(),
      70,
    );
  }
  function signOutPrompt() {
    setConfirmState({
      open: true,
      title: "退出登录",
      description: "退出当前账号？",
      confirmLabel: "退出登录",
      variant: "danger",
      action: () => {
        void authClient.signOut();
        changePage("today");
      },
    });
  }
  const isReaderView =
    (view === "question" && Boolean(currentQuestion)) ||
    (view === "review" && reviewSessionActive && Boolean(currentReview));
  const readingList = readingIds.length
    ? readingIds
        .map((id) => data.questions.find((q) => q.id === id))
        .filter((q): q is QuestionView => !!q)
    : view === "question" &&
        currentQuestion &&
        ["library", "favorites", "inbox", "archived"].includes(
          origin.current.view,
        )
      ? (() => {
          const matched = data.questions.filter((q) => {
            if (origin.current.view === "archived") return q.archived;
            if (q.archived) return false;
            if (origin.current.view === "favorites") return q.favorite;
            if (origin.current.view === "inbox") return q.needsEditing;
            if (origin.current.deckId === null)
              return q.isOwner && q.deckId === null;
            if (origin.current.deckId !== undefined)
              return q.deckId === origin.current.deckId;
            return true;
          });
          if (
            origin.current.view === "library" &&
            typeof origin.current.deckId === "string"
          ) {
            const originDeck = data.decks.find(
              (d) => d.id === origin.current.deckId,
            );
            if (originDeck && originDeck.groups.length > 0) {
              return computeDeckReadingOrder(matched, originDeck.groups);
            }
          }
          return matched;
        })()
      : [];
  const readingIndex = currentQuestion
    ? readingList.findIndex((q) => q.id === currentQuestion.id)
    : -1;
  const currentQuestionDeck = currentQuestion?.deckId
    ? data.decks.find((d) => d.id === currentQuestion.deckId)
    : undefined;
  const readerGroupContext =
    view === "question" &&
    currentQuestion &&
    currentQuestionDeck?.groups.length
      ? computeReaderGroupContext(
          readingList.length ? readingList : [currentQuestion],
          readingIndex !== -1 ? readingIndex : 0,
          currentQuestionDeck.groups,
        )
      : null;
  const existingDeckGroups = listDeckGroupNames(data.decks);
  const sidebarDeckGroups = groupDecksByName(data.decks);
  const weakQuestions = Array.from(
    new Map(
      reviewResults
        .filter((r) => r.rating <= 2)
        .map((r) => {
          const latest =
            data.questions.find((q) => q.id === r.question.id) ?? r.question;
          return [latest.id, latest] as const;
        }),
    ).values(),
  ).filter((q) => !q.archived && q.answer.trim());
  const libraryView = view === "question" ? origin.current.view : view;
  const activeNavView = view === "question" ? origin.current.view : view;
  const activeDeckId = view === "question" ? origin.current.deckId : deckId;
  const displayedView = isNavigating ? navigationTarget : view;
  const isImmersiveMobile = isReaderView;
  const hasMobileDeckBack =
    device.isMobileShell &&
    displayedView === "library" &&
    activeDeckId !== undefined;
  const mobileView = ["question", "favorites", "inbox", "archived"].includes(
    navigationTarget,
  )
    ? "library"
    : navigationTarget === "history"
      ? "review"
      : navigationTarget;
  const nav = [
    { id: "today" as const, label: "今日", mobileLabel: "今日", icon: LayoutDashboard },
    { id: "library" as const, label: "我的题库", mobileLabel: "题库", icon: Layers2 },
    {
      id: "review" as const,
      label: "复习中心",
      mobileLabel: "复习",
      icon: RotateCcw,
      count: data.stats.due,
    },
    { id: "catalog" as const, label: "发现题库", mobileLabel: "发现", icon: Rss },
  ];
  return (
    <div
      className={cn(
        "app-shell",
        isReaderView && "mobile-reader-active",
        isImmersiveMobile && "mobile-immersive",
        aiMode === "docked" && !aiHiddenInReview && "ai-pushed",
        aiDockResizing && "ai-resizing",
      )}
      style={
        aiDockWidth !== null
          ? ({ "--ai-dock-width": `${aiDockWidth}px` } as CSSProperties)
          : undefined
      }
      onPointerDownCapture={rememberScroll}
      onKeyDownCapture={rememberScroll}
    >
      <button
        type="button"
        className={cn("sidebar-backdrop", sidebarOpen && "is-open")}
        aria-label="关闭导航"
        aria-hidden={!sidebarOpen}
        inert={!sidebarOpen}
        style={
          drawerDragX < 0
            ? { opacity: Math.max(0, 1 + drawerDragX / 280), transition: "none" }
            : undefined
        }
        onClick={() => setSidebarOpen(false)}
      />
      <aside
        className={cn("sidebar", sidebarOpen && "sidebar-open")}
        style={
          drawerDragX < 0
            ? { translate: `${drawerDragX}px 0`, transition: "none" }
            : undefined
        }
        onTouchStart={(event) => {
          if (!sidebarOpen || event.touches.length !== 1) return;
          const touch = event.touches[0];
          drawerTouch.current = {
            x: touch.clientX,
            y: touch.clientY,
            time: Date.now(),
            locked: null,
          };
        }}
        onTouchMove={(event) => {
          const state = drawerTouch.current;
          if (!state || event.touches.length !== 1) return;
          const touch = event.touches[0];
          const dx = touch.clientX - state.x;
          const dy = touch.clientY - state.y;
          if (!state.locked) {
            if (Math.hypot(dx, dy) < 8) return;
            state.locked =
              dx < 0 && Math.abs(dx) > Math.abs(dy) * 1.25 ? "h" : "v";
          }
          if (state.locked === "h") {
            setDrawerDragX(Math.min(0, dx));
          }
        }}
        onTouchEnd={(event) => {
          const state = drawerTouch.current;
          drawerTouch.current = null;
          if (!state || state.locked !== "h") {
            setDrawerDragX(0);
            return;
          }
          const endX = event.changedTouches[0]?.clientX ?? state.x;
          const dx = endX - state.x;
          const velocity = dx / Math.max(1, Date.now() - state.time);
          if (dx < -72 || velocity < -0.45) {
            setSidebarOpen(false);
          }
          setDrawerDragX(0);
        }}
        onTouchCancel={() => {
          drawerTouch.current = null;
          setDrawerDragX(0);
        }}
      >
        <div className="sidebar-head">
          <button
            className="brand brand-button"
            onClick={() => navigate("today")}
          >
            <span className="brand-mark">
              <BookOpen size={23} />
            </span>
            <div>
              拾忆<span>SHIYI</span>
            </div>
          </button>
          <button
            type="button"
            className="icon-button sidebar-close-btn"
            aria-label="关闭导航"
            onClick={() => setSidebarOpen(false)}
          >
            <X size={18} />
          </button>
        </div>
        <button
          className="sidebar-search"
          onClick={openQuickSearch}
        >
          <Search size={16} />
          <span>搜索题目</span>
          <kbd>Ctrl K</kbd>
        </button>
        <nav className="primary-nav">
          {nav.map(({ id, label, icon: Icon, count }) => (
            <button
              key={id}
              className={cn("nav-item", activeNavView === id && "active")}
              onClick={() => navigate(id)}
            >
              <Icon size={18} strokeWidth={1.6} />
              <span>{label}</span>
              {!!count && <small>{count}</small>}
            </button>
          ))}
        </nav>
        <nav className="secondary-nav">
          {[
            { id: "favorites" as const, label: "我的收藏", icon: Star },
            { id: "inbox" as const, label: "待整理", icon: Inbox },
            { id: "history" as const, label: "回顾记录", icon: History },
          ].map(({ id, label, icon: Icon }) => (
            <button
              className={cn("nav-item", activeNavView === id && "active")}
              key={id}
              onClick={() => navigate(id)}
            >
              <Icon size={17} strokeWidth={1.5} />
              <span>{label}</span>
              {id === "inbox" &&
                data.questions.some((q) => q.needsEditing && !q.archived) && (
                  <span className="nav-dot" />
                )}
            </button>
          ))}
        </nav>
        <div className="sidebar-decks">
          <div className="nav-section-label">
            题库
            <button
              className="icon-button"
              aria-label="新建题库"
              onClick={() => {
                setCreateDeckDefaultGroup("");
                setCreateOpen(true);
              }}
            >
              <Plus size={14} />
            </button>
          </div>
          {sidebarDeckGroups.hasGroups ? (
            (() => {
              let remaining = 8;
              return sidebarDeckGroups.buckets.map((bucket) => {
                if (remaining <= 0) return null;
                const slice = bucket.decks.slice(0, remaining);
                remaining -= slice.length;
                if (!slice.length) return null;
                return (
                  <div
                    className="sidebar-deck-group"
                    key={bucket.groupName || "__other__"}
                  >
                    <div className="sidebar-deck-group-label">
                      {bucket.groupName || OTHER_DECKS_LABEL}
                    </div>
                    {slice.map((d) => (
                      <button
                        className={cn(
                          "sidebar-deck",
                          activeNavView === "library" &&
                            activeDeckId === d.id &&
                            "selected",
                        )}
                        onClick={() => openDeck(d.id)}
                        key={d.id}
                      >
                        <span className={`deck-dot color-${d.color}`} />
                        <span>{d.title}</span>
                        <small>{d.count}</small>
                      </button>
                    ))}
                  </div>
                );
              });
            })()
          ) : (
            data.decks.slice(0, 5).map((d) => (
              <button
                className={cn(
                  "sidebar-deck",
                  activeNavView === "library" &&
                    activeDeckId === d.id &&
                    "selected",
                )}
                onClick={() => openDeck(d.id)}
                key={d.id}
              >
                <span className={`deck-dot color-${d.color}`} />
                <span>{d.title}</span>
                <small>{d.count}</small>
              </button>
            ))
          )}
          {data.decks.length > (sidebarDeckGroups.hasGroups ? 8 : 5) && (
            <button
              className="sidebar-deck"
              onClick={() => navigate("library")}
            >
              <Layers2 size={13} />
              <span>查看全部（{data.decks.length}）</span>
            </button>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="sidebar-mobile-appearance">
            <div className="sidebar-appearance-group" role="group" aria-label="色系切换">
              <button
                type="button"
                className={palette === "forest" ? "is-active" : ""}
                onClick={() => applyPalette("forest")}
              >
                <span className="appearance-swatch" style={{ background: "#1A6347" }} />
                青瓷
              </button>
              <button
                type="button"
                className={palette === "lavender" ? "is-active" : ""}
                onClick={() => applyPalette("lavender")}
              >
                <span className="appearance-swatch" style={{ background: "#5D4B99" }} />
                熏衣
              </button>
            </div>
            <div className="sidebar-appearance-group" role="group" aria-label="明暗切换">
              <button
                type="button"
                className={activeTheme === "light" ? "is-active" : ""}
                onClick={() => setThemeMode("light")}
              >
                <Sun size={14} /> 浅色
              </button>
              <button
                type="button"
                className={activeTheme === "dark" ? "is-active" : ""}
                onClick={() => setThemeMode("dark")}
              >
                <Moon size={14} /> 深色
              </button>
            </div>
          </div>
          <button
            type="button"
            className="sidebar-mobile-ai-btn"
            data-settings-trigger="ai"
            onClick={() => {
              setSidebarOpen(false);
              openSettings("ai");
            }}
          >
            <span
              className={cn(
                "ai-status-dot",
                data.settings.hasKey && "is-connected",
              )}
              aria-hidden="true"
            />
            <span className="sidebar-mobile-ai-label">
              <strong>AI 模型配置</strong>
              <small>
                {data.settings.hasKey
                  ? data.settings.model || "已连接"
                  : "未配置连接"}
              </small>
            </span>
            <Sparkles size={15} />
          </button>
          <UserMenu
            user={data.user}
            settingsOpen={settingsState.open}
            hasAiKey={data.settings.hasKey}
            aiModel={data.settings.model}
            onOpenSettings={(tab) => openSettings(tab)}
            onBeforeOpenMenu={() =>
              setSettingsState((prev) =>
                prev.open ? { ...prev, open: false } : prev,
              )
            }
            onSignOut={signOutPrompt}
            onCloseMobileDrawer={() => setSidebarOpen(false)}
          />
          <button
            type="button"
            className="sidebar-mobile-logout"
            onClick={signOutPrompt}
          >
            <LogOut size={15} />
            <span>退出登录</span>
          </button>
        </div>
      </aside>
      <main className="main-layout" aria-busy={isNavigating}>
        {isNavigating && (
          <div className="page-transition-progress" aria-hidden="true" />
        )}
        <header className={cn("topbar", hasMobileDeckBack && "has-mobile-back")}>
          <div>
            {hasMobileDeckBack ? (
              <button
                type="button"
                className="icon-button mobile-back-btn"
                aria-label="返回我的题库"
                onClick={() => openDeck()}
              >
                <ArrowLeft size={20} />
              </button>
            ) : (
              <button
                className="icon-button mobile-menu"
                aria-label="打开导航"
                aria-expanded={sidebarOpen}
                onClick={() => setSidebarOpen(true)}
              >
                <Menu size={21} />
              </button>
            )}
            <span className="topbar-breadcrumb">
              {displayedView === "today" ? (
                <strong>今日</strong>
              ) : displayedView === "library" && activeDeckId !== undefined ? (
                <>
                  <button
                    type="button"
                    className="topbar-crumb-link"
                    onClick={() => openDeck()}
                  >
                    我的题库
                  </button>
                  <span className="topbar-crumb-sep" aria-hidden="true">
                    /
                  </span>
                  <strong>
                    {activeDeckId === null
                      ? "未分类"
                      : (data.decks.find((d) => d.id === activeDeckId)?.title ??
                        "题库")}
                  </strong>
                </>
              ) : displayedView === "question" ? (
                <>
                  <button
                    type="button"
                    className="topbar-crumb-link"
                    onClick={() =>
                      changePage(
                        origin.current.view,
                        () => setDeckId(origin.current.deckId),
                        {
                          route: {
                            view: origin.current.view,
                            deckId:
                              origin.current.view === "library"
                                ? origin.current.deckId
                                : undefined,
                          },
                        },
                      )
                    }
                  >
                    {
                      {
                        today: "今日",
                        library: "我的题库",
                        favorites: "我的收藏",
                        inbox: "待整理",
                        archived: "已归档",
                        history: "回顾记录",
                        review: "答题",
                        catalog: "发现题库",
                        question: "我的题库",
                      }[origin.current.view]
                    }
                  </button>
                  <span className="topbar-crumb-sep" aria-hidden="true">
                    /
                  </span>
                  <strong>{currentQuestion?.deckTitle ?? "学习卡"}</strong>
                </>
              ) : displayedView === "library" ? (
                <strong>我的题库</strong>
              ) : (
                <>
                  <button
                    type="button"
                    className="topbar-crumb-link"
                    onClick={() => navigate("today")}
                  >
                    今日
                  </button>
                  <span className="topbar-crumb-sep" aria-hidden="true">
                    /
                  </span>
                  <strong>
                    {
                      {
                        favorites: "我的收藏",
                        inbox: "待整理",
                        archived: "已归档",
                        review: reviewSessionActive ? "答题" : "复习中心",
                        catalog: "发现题库",
                        history: "回顾记录",
                      }[displayedView]
                    }
                  </strong>
                </>
              )}
            </span>
          </div>
          <div className="topbar-actions">
            <span
              className={cn(
                "sync-state",
                syncError && "sync-offline",
                !pending && !syncError && "sync-idle",
              )}
            >
              {pending ? (
                <RefreshCw size={13} className="spin" />
              ) : syncError ? (
                <WifiOff size={13} />
              ) : (
                <Cloud size={14} />
              )}
              <span className={syncError ? "" : "sr-only"}>
                {pending ? "正在同步" : syncError ? "连接中断" : "已同步"}
              </span>
            </span>
            <button
              type="button"
              className="icon-button mobile-search-trigger"
              aria-label="搜索题目"
              onClick={openQuickSearch}
            >
              <Search size={18} />
            </button>
            {displayedView !== "today" && displayedView !== "library" && (
              <button
                type="button"
                className="icon-button topbar-import-btn"
                aria-label="导入题目"
                title="导入题目"
                onClick={openImport}
              >
                <Upload size={16} />
              </button>
            )}
            <span className="topbar-divider" />
            <div className="topbar-cluster" role="group" aria-label="外观切换">
              <button
                type="button"
                className="palette-quick-btn"
                onClick={() =>
                  applyPalette(palette === "forest" ? "lavender" : "forest")
                }
                aria-label={
                  palette === "forest"
                    ? "切换至熏衣紫主题色"
                    : "切换至青瓷绿主题色"
                }
                title={
                  palette === "forest"
                    ? "当前：青瓷（点击切换熏衣紫）"
                    : "当前：熏衣（点击切换青瓷绿）"
                }
              >
                <span className="palette-quick-dots" aria-hidden="true">
                  <i
                    style={{
                      background: palette === "forest" ? "#1A6347" : "#5D4B99",
                    }}
                  />
                  <i
                    style={{
                      background: palette === "forest" ? "#4EC496" : "#A796F0",
                    }}
                  />
                </span>
              </button>
              <button
                type="button"
                className="topbar-theme-btn"
                onClick={toggleTheme}
                aria-label={
                  activeTheme === "dark" ? "切换浅色模式" : "切换深色模式"
                }
                title={activeTheme === "dark" ? "切换浅色模式" : "切换深色模式"}
              >
                {activeTheme === "dark" ? (
                  <Sun size={15} />
                ) : (
                  <Moon size={15} />
                )}
              </button>
            </div>
            <button
              type="button"
              className={cn(
                "topbar-ai-config-btn",
                data.settings.hasKey && "is-connected",
                settingsState.open && settingsState.tab === "ai" && "is-active",
              )}
              data-settings-trigger="ai"
              aria-label="AI 模型配置"
              aria-expanded={settingsState.open && settingsState.tab === "ai"}
              aria-controls="settings-modal"
              title={
                data.settings.hasKey
                  ? `AI 模型连接：${data.settings.model || "已连接"}`
                  : "配置 AI 模型连接"
              }
              onClick={() => openSettings("ai", { toggle: true })}
            >
              <Plug size={15} />
              <span className="ai-status-dot" aria-hidden="true" />
            </button>
            {!aiHiddenInReview && (
              <button
                type="button"
                className={cn(
                  "icon-button topbar-ai-trigger",
                  aiMode !== "collapsed" && "is-active",
                  aiBusy && "is-busy",
                )}
                title={
                  aiMode !== "collapsed"
                    ? "收起 AI 助手 (Ctrl/⌘ + J)"
                    : "AI 助手 (Ctrl/⌘ + J)"
                }
                aria-label={aiMode !== "collapsed" ? "收起 AI 助手" : "打开 AI 助手"}
                aria-pressed={aiMode !== "collapsed"}
                onClick={() => toggleAi()}
              >
                <Sparkles size={16} />
                {aiBusy && <span className="ai-trigger-dot" aria-hidden="true" />}
              </button>
            )}
          </div>
        </header>
        <div className="workspace-content">
          {syncError && (
            <div className="connection-banner">
              <WifiOff size={14} />{" "}
              当前显示上次读取的内容。请恢复网络后再保存或复习。
              <button onClick={() => void refresh(true)}>重试连接</button>
            </div>
          )}
          {view === "today" && (
            <Dashboard
              data={data}
              onReview={() => startReview()}
              onPractice={(question) => startReview(undefined, question)}
              onDeck={openDeck}
              onImport={openImport}
              onCatalog={() => navigate("catalog")}
              onLibrary={() => navigate("library")}
              onInbox={() => navigate("inbox")}
              onSeed={async () => {
                const result = await mutate("/api/workspace", {});
                if (result)
                  toast.success(
                    Number(result.added)
                      ? `已载入 ${result.added} 道示例题，可自由编辑或归档。`
                      : "示例题库已经载入过了。",
                  );
              }}
            />
          )}
          {["library", "favorites", "inbox", "archived"].includes(
            libraryView,
          ) &&
            (view === libraryView || view === "question") && (
              <div hidden={view === "question"}>
                <Library
                  key={`${libraryView}:${deckId === null ? "unfiled" : (deckId ?? "all")}`}
                  data={data}
                  deckId={libraryView === "library" ? deckId : undefined}
                  filter={libraryView === "library" ? undefined : libraryView}
                  searchToken={searchToken}
                  initialGroupId={
                    libraryView === "library"
                      ? libraryGroupFilter.groupId
                      : undefined
                  }
                  initialCategory={
                    libraryView === "library"
                      ? libraryGroupFilter.category
                      : undefined
                  }
                  mutate={mutate}
                  onDelete={setDeleteDeck}
                  onEditDeck={setEditDeck}
                  onDeleteQuestion={(q) =>
                    setQuestionAction({ question: q, action: "delete" })
                  }
                  onMoveQuestion={(q) =>
                    setQuestionAction({ question: q, action: "move" })
                  }
                  onQuestion={openQuestion}
                  onPractice={(question) => startReview(undefined, question)}
                  onCram={startCram}
                  onDeck={openDeck}
                  onImport={openImport}
                  onImportToGroup={(gid) => {
                    setImportSeed(undefined);
                    importCommitted.current = null;
                    setImportPreferredGroupId(gid);
                    setImportOpen(true);
                  }}
                  onCreateQuestion={() => {
                    setCreateQuestionGroupId(undefined);
                    setCreateQuestionOpen(true);
                  }}
                  onCreateQuestionInGroup={(gid) => {
                    setCreateQuestionGroupId(gid);
                    setCreateQuestionOpen(true);
                  }}
                  onCreate={() => {
                    setCreateDeckDefaultGroup("");
                    setCreateOpen(true);
                  }}
                  onManageDeckGroups={() => setManageDeckGroupsOpen(true)}
                  onCreateDeckInGroup={(groupName) => {
                    setCreateDeckDefaultGroup(groupName);
                    setCreateOpen(true);
                  }}
                  onOpenGroupDialog={(deck, group, defaultCategory) =>
                    setGroupDialog({ deck, group, defaultCategory })
                  }
                  onSetDeckGroup={(deck) => setSetDeckGroupTarget(deck)}
                  onReview={startReview}
                  onPublish={setPublishId}
                  onFavorite={(q) => void favorite(q)}
                  onGenerateAnswer={answerDraft.open}
                  onAcknowledge={async (id, version) => {
                    await mutate("/api/decks", {
                      action: "acknowledge",
                      deckId: id,
                      version,
                    });
                  }}
                  onUnsubscribe={(id) => {
                    setConfirmState({
                      open: true,
                      title: "取消订阅题库",
                      description:
                        "取消订阅后不再接收更新，已有的个人笔记和复习记录仍会保留。",
                      confirmLabel: "取消订阅",
                      variant: "danger",
                      action: async () => {
                        const result = await mutate("/api/decks", {
                          action: "unsubscribe",
                          deckId: id,
                        });
                        if (result) openDeck();
                      },
                    });
                  }}
                />
              </div>
            )}
          {view === "question" && currentQuestion && (
            <QuestionReader
              key={currentQuestion.id}
              question={currentQuestion}
              data={data}
              onBack={() => {
                changePage(
                  origin.current.view,
                  () => setDeckId(origin.current.deckId),
                  {
                    route: {
                      view: origin.current.view,
                      deckId:
                        origin.current.view === "library"
                          ? origin.current.deckId
                          : undefined,
                    },
                  },
                );
              }}
              backLabel={
                origin.current.view === "history"
                  ? "返回记录"
                  : origin.current.view === "inbox"
                    ? "返回待整理"
                    : origin.current.view === "favorites"
                      ? "返回收藏"
                      : origin.current.view === "today"
                        ? "返回今日"
                        : "返回题库"
              }
              prevNext={
                readingIndex !== -1 && readingList.length > 1
                  ? {
                      index: readingIndex,
                      total: readingList.length,
                      hasPrev: readingIndex > 0,
                      hasNext: readingIndex < readingList.length - 1,
                      prevTitle: readingList[readingIndex - 1]?.title,
                      nextTitle: readingList[readingIndex + 1]?.title,
                      onPrev: () => {
                        const target = readingList[readingIndex - 1];
                        if (target) openQuestion(target, undefined, "replace");
                      },
                      onNext: () => {
                        const target = readingList[readingIndex + 1];
                        if (target) openQuestion(target, undefined, "replace");
                      },
                    }
                  : undefined
              }
              onBatchImport={(seed, onCommitted) => {
                setImportSeed(seed);
                setImportPreferredGroupId(undefined);
                importCommitted.current = onCommitted;
                setImportOpen(true);
              }}
              onDelete={() =>
                setQuestionAction({
                  question: currentQuestion,
                  action: "delete",
                })
              }
              onMove={() =>
                setQuestionAction({ question: currentQuestion, action: "move" })
              }
              onGenerateAnswer={answerDraft.open}
              onFavorite={() => void favorite(currentQuestion)}
              mutate={mutate}
              onSingleReview={() => startReview(undefined, currentQuestion)}
              activeTheme={activeTheme}
              onToggleTheme={toggleTheme}
              aiOpen={aiMode !== "collapsed"}
              onToggleAi={toggleAi}
              onAskAi={askAi}
              groupContext={readerGroupContext}
              readingList={readingList}
              onJumpQuestion={(target) =>
                openQuestion(target, undefined, "replace")
              }
              onOpenGroup={(targetDeckId, opts) => openDeck(targetDeckId, opts)}
            />
          )}
          {view === "question" && !currentQuestion && (
            <div className="empty-state">
              <BookOpen size={32} />
              <h3>题目已不可访问</h3>
              <Button variant="outline" onClick={() => navigate("library")}>
                返回题库
              </Button>
            </div>
          )}
          {view === "review" && !reviewSessionActive && (
            <ReviewHub
              data={data}
              onStartReview={(targetDeck) => startReview(targetDeck)}
              onStartCram={startCram}
              onOpenDeck={(targetDeck) => openDeck(targetDeck)}
              onOpenHistory={() => navigate("history")}
              onOpenInbox={() => navigate("inbox")}
              onImport={openImport}
            />
          )}
          {view === "review" &&
            reviewSessionActive &&
            (currentReview ? (
              <QuestionReader
                key={`review:${currentReview.id}:${reviewIndex}`}
                question={currentReview}
                data={data}
                review
                cram={reviewMode === "cram"}
                cramLabel={cramLabel}
                onBack={() => {
                  setReviewSessionActive(false);
                  const back = reviewOrigin.current;
                  if (back.view === "review") {
                    return;
                  }
                  if (back.view === "question" && back.questionId) {
                    changePage(
                      "question",
                      () => setQuestionId(back.questionId!),
                      {
                        route: {
                          view: "question",
                          questionId: back.questionId,
                          originView: origin.current.view,
                          originDeckId: origin.current.deckId,
                        },
                      },
                    );
                  } else if (back.view === "library") {
                    changePage(
                      "library",
                      () => setDeckId(back.deckId),
                      { route: { view: "library", deckId: back.deckId } },
                    );
                  } else {
                    navigate(back.view);
                  }
                }}
                onDelete={() =>
                  setQuestionAction({
                    question: currentReview,
                    action: "delete",
                  })
                }
                onMove={() =>
                  setQuestionAction({ question: currentReview, action: "move" })
                }
                onGenerateAnswer={answerDraft.open}
                onFavorite={() => void favorite(currentReview)}
                mutate={mutate}
                progress={{ current: reviewIndex + 1, total: queue.length }}
                onGrade={(rating, answer) => void grade(rating, answer)}
                busy={reviewBusy}
                activeTheme={activeTheme}
                onToggleTheme={toggleTheme}
                aiOpen={aiMode !== "collapsed"}
                onToggleAi={toggleAi}
                onAskAi={askAi}
                onRevealedChange={setReviewRevealed}
              />
            ) : (
              <ReviewComplete
                count={ratings.length}
                ratings={ratings}
                cram={reviewMode === "cram"}
                cramLabel={cramLabel}
                weakCount={weakQuestions.length}
                onDrillWeak={() => startCram(weakQuestions, "薄弱巩固")}
                onBack={() => {
                  setReviewSessionActive(false);
                  navigate("today");
                }}
                onLibrary={() => {
                  setReviewSessionActive(false);
                  navigate("library");
                }}
              />
            ))}
          {view === "catalog" && (
            <>
              {catalogLoading && (
                <div className="catalog-loading">
                  <Loader2 size={16} className="spin" /> 正在更新题库列表
                </div>
              )}
              <Catalog
                entries={catalog}
                busy={pending > 0}
                onSubscribe={async (id) => {
                  const result = await mutate("/api/decks", {
                    action: "subscribe",
                    deckId: id,
                  });
                  if (result) {
                    toast.success("订阅成功，后续发布的更新会自动同步。");
                    openDeck(id);
                  }
                }}
                onOpen={openDeck}
                onCreate={() => navigate("library")}
                onRefresh={() => void loadCatalog()}
              />
            </>
          )}
          {view === "history" && (
            <HistoryView data={data} onQuestion={openQuestion} />
          )}
        </div>
      </main>
      <nav className="mobile-bottom-nav" aria-label="手机主导航">
        {nav.map(({ id, mobileLabel, icon: Icon, count }) => (
          <button
            key={id}
            className={mobileView === id ? "active" : ""}
            aria-current={mobileView === id ? "page" : undefined}
            onClick={() => navigate(id)}
          >
            <span className="mobile-nav-icon-wrap">
              <Icon size={20} />
              {id === "review" && !!count && (
                <span className="mobile-nav-badge" aria-label={`${count} 题待复习`}>
                  {count > 99 ? "99+" : count}
                </span>
              )}
            </span>
            <span>{mobileLabel}</span>
          </button>
        ))}
      </nav>
      {importOpen && (
        <ImportDialog
          open={importOpen}
          onClose={() => {
            setImportOpen(false);
            setImportSeed(undefined);
            setImportPreferredGroupId(undefined);
            importCommitted.current = null;
          }}
          data={data}
          seed={importSeed}
          onImported={() => {
            importCommitted.current?.();
            importCommitted.current = null;
          }}
          preferredDeck={
            importSeed?.deckId !== undefined
              ? importSeed.deckId
              : deckId === null
                ? null
                : deckId && data.decks.find((d) => d.id === deckId)?.isOwner
                  ? deckId
                  : undefined
          }
          preferredGroupId={importPreferredGroupId}
          mutate={mutate}
          onView={openDeck}
          onInbox={() => navigate("inbox")}
          onSettings={() => {
            setImportOpen(false);
            openSettings("ai");
          }}
        />
      )}
      {createOpen && (
        <CreateDeckDialog
          open={createOpen}
          existingGroups={existingDeckGroups}
          defaultGroupName={createDeckDefaultGroup}
          onClose={() => {
            setCreateOpen(false);
            setCreateDeckDefaultGroup("");
          }}
          mutate={mutate}
          onCreated={openDeck}
        />
      )}
      {editDeck && (
        <EditDeckDialog
          deck={editDeck}
          existingGroups={existingDeckGroups}
          onClose={() => setEditDeck(null)}
          mutate={mutate}
        />
      )}
      {groupDialog && (
        <DeckGroupDialog
          open
          deck={
            data.decks.find((d) => d.id === groupDialog.deck.id) ??
            groupDialog.deck
          }
          group={groupDialog.group ?? null}
          defaultCategory={groupDialog.defaultCategory ?? ""}
          mutate={mutate}
          onClose={() => setGroupDialog(null)}
        />
      )}
      {setDeckGroupTarget && (
        <SetDeckGroupDialog
          deck={
            data.decks.find((d) => d.id === setDeckGroupTarget.id) ??
            setDeckGroupTarget
          }
          existingGroups={existingDeckGroups}
          mutate={mutate}
          onClose={() => setSetDeckGroupTarget(null)}
        />
      )}
      {manageDeckGroupsOpen && (
        <ManageDeckGroupsDialog
          open={manageDeckGroupsOpen}
          decks={data.decks}
          mutate={mutate}
          onClose={() => setManageDeckGroupsOpen(false)}
          onCreateDeckInGroup={(groupName) => {
            setManageDeckGroupsOpen(false);
            setCreateDeckDefaultGroup(groupName);
            setCreateOpen(true);
          }}
        />
      )}
      {createQuestionOpen && (
        <CreateQuestionDialog
          open={createQuestionOpen}
          defaultDeckId={
            libraryView === "library" && typeof deckId === "string"
              ? deckId
              : null
          }
          defaultGroupId={createQuestionGroupId}
          data={data}
          mutate={mutate}
          onClose={() => {
            setCreateQuestionOpen(false);
            setCreateQuestionGroupId(undefined);
          }}
          onCreated={(id) => {
            if (view !== "question") origin.current = { view, deckId };
            setReadingIds([]);
            changePage(
              "question",
              () => {
                setQuestionId(id);
              },
              {
                route: {
                  view: "question",
                  questionId: id,
                  originView: origin.current.view,
                  originDeckId: origin.current.deckId,
                },
              },
            );
          }}
        />
      )}
      {settingsMounted && (
        <SettingsCard
          open={settingsState.open}
          tab={settingsState.tab}
          onTabChange={(tab) =>
            setSettingsState((prev) => ({ ...prev, tab }))
          }
          onClose={() =>
            setSettingsState((prev) => ({ ...prev, open: false }))
          }
          data={data}
          mutate={mutate}
          palette={palette}
          activeTheme={activeTheme}
          onPaletteChange={applyPalette}
          onThemeChange={(next) => void setThemeMode(next)}
          onSignOut={() => {
            setSettingsState((prev) => ({ ...prev, open: false }));
            signOutPrompt();
          }}
        />
      )}
      {publishId && (
        <PublishDialog
          deck={data.decks.find((d) => d.id === publishId) ?? null}
          onClose={() => setPublishId(null)}
          mutate={mutate}
        />
      )}
      {answerDraft.question && <AiAnswerDialog draft={answerDraft} />}
      {questionAction && (
        <QuestionActionDialog
          {...questionAction}
          data={data}
          mutate={mutate}
          onClose={() => setQuestionAction(null)}
          onDone={() => {
            if (
              questionAction.action === "delete" &&
              view === "question" &&
              questionId === questionAction.question.id
            ) {
              changePage(
                origin.current.view,
                () => {
                  setQuestionId(null);
                  setDeckId(origin.current.deckId);
                },
                {
                  route: {
                    view: origin.current.view,
                    deckId:
                      origin.current.view === "library"
                        ? origin.current.deckId
                        : undefined,
                  },
                },
              );
            }
          }}
        />
      )}
      {deleteDeck && (
        <DeleteDeckDialog
          deck={deleteDeck}
          mutate={mutate}
          onClose={() => setDeleteDeck(null)}
          onDeleted={() => {
            openDeck(null);
          }}
        />
      )}
      <ConfirmDialog
        open={!!confirmState?.open}
        onOpenChange={(next) => {
          if (!next && !confirmBusy) {
            setConfirmState((prev) => (prev ? { ...prev, open: false } : null));
          }
        }}
        title={confirmState?.title ?? ""}
        description={confirmState?.description ?? ""}
        confirmLabel={confirmState?.confirmLabel}
        variant={confirmState?.variant}
        busy={confirmBusy}
        onConfirm={async () => {
          if (!confirmState || confirmBusy) return;
          setConfirmBusy(true);
          try {
            await confirmState.action();
            setConfirmState((prev) =>
              prev ? { ...prev, open: false } : null,
            );
          } finally {
            setConfirmBusy(false);
          }
        }}
      />
      <AiIsland
        key={data.user.id}
        data={data}
        question={
          view === "question"
            ? currentQuestion
            : view === "review" && reviewSessionActive && reviewRevealed
              ? currentReview
              : undefined
        }
        activeDeck={
          (view === "library" || view === "question") && activeDeckId
            ? data.decks.find((d) => d.id === activeDeckId)
            : undefined
        }
        mode={aiMode}
        allowDock
        hidden={aiHiddenInReview}
        trigger={aiTrigger}
        dockWidth={aiDockWidth}
        onDockWidthChange={handleAiDockWidthChange}
        onResizingDockChange={setAiDockResizing}
        onModeChange={handleAiModeChange}
        onOpenQuestion={(target) => openQuestion(target, [])}
        onSettings={() => openSettings("ai")}
        onBusyChange={setAiBusy}
        mutate={mutate}
      />
    </div>
  );
}
