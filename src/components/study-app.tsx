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
  BookMarked,
  BookOpen,
  LayoutDashboard,
  Layers2,
  RotateCcw,
  Rss,
  Star,
  Inbox,
  History,
  Search,
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
  Folder,
} from "lucide-react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import {
  applyAllDeckUpdates,
  applyDeckUpdate,
  dismissDeckUpdate,
} from "@/lib/client";
import {
  CONCEPT_ROOT_LABEL,
  buildConceptFolderIndex,
} from "@/lib/concepts";
import { clampAiDockWidth } from "@/lib/ai-stream";
import { useDeviceProfile } from "@/lib/device-profile";
import {
  ROOT_FOLDER_LABEL,
  buildFolderIndex,
  recordRecentQuestionId,
} from "@/lib/folders";
import type { QuestionView, DeckView } from "@/lib/types";
import { cn, createUuid } from "@/lib/utils";
import { buildReviewQueue } from "@/lib/review-queue";
import { extractNoteAliases, normalizedNoteTitle } from "@/lib/markdown-source";
import { practiceDraftKey, savePracticeDraft } from "@/lib/drafts";
import {
  hydrateServerTheme,
  initAppearance,
  setAppearancePalette,
  setAppearanceSession,
  toggleAppearancePalette,
  toggleAppearanceTheme,
  useAppearance,
  type Palette,
} from "@/lib/theme";
import {
  buildSearchFromRoute,
  extractAuthorParam,
  extractSubscribeParam,
  parseRouteFromSearch,
  type AppView,
  type LibraryQuickView,
  type RouteState,
} from "@/lib/navigation";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ui/confirm-dialog";
import { AuthScreen } from "./auth-screen";
import { Dashboard } from "./dashboard";
const Library = dynamic(
  () => import("./library").then((m) => m.Library),
  {
    ssr: false,
    loading: () => (
      <div className="view-loading">
        <Loader2 className="spin" size={20} />
      </div>
    ),
  },
);
const Catalog = dynamic(
  () => import("./catalog").then((m) => m.Catalog),
  {
    ssr: false,
    loading: () => (
      <div className="view-loading">
        <Loader2 className="spin" size={20} />
      </div>
    ),
  },
);
const ReviewHub = dynamic(
  () => import("./review-hub").then((m) => m.ReviewHub),
  {
    ssr: false,
    loading: () => (
      <div className="view-loading">
        <Loader2 className="spin" size={20} />
      </div>
    ),
  },
);
import { useAiAnswerDraft } from "./use-ai-answer-draft";
import { useAppShortcuts } from "./use-app-shortcuts";
import { usePageScroll } from "./use-page-scroll";
import { useWorkspaceSync } from "./use-workspace-sync";
import { UserMenu } from "./user-menu";
import type { AiIslandMode, AiTrigger } from "./ai-island";
const AiIsland = dynamic(
  () => import("./ai-island").then((m) => m.AiIsland),
  { ssr: false },
);
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
const ConceptsView = dynamic(
  () => import("./concepts-view").then((m) => m.ConceptsView),
  {
    loading: () => (
      <div className="view-loading">
        <Loader2 className="spin" size={20} />
      </div>
    ),
  },
);
const AiAnswerDialog = dynamic(() =>
  import("./ai-answer-dialog").then((m) => m.AiAnswerDialog),
);
const CreateFolderDialog = dynamic(() =>
  import("./folder-dialogs").then((m) => m.CreateFolderDialog),
);
const EditFolderDialog = dynamic(() =>
  import("./folder-dialogs").then((m) => m.EditFolderDialog),
);
const GroupIntoNewFolderDialog = dynamic(() =>
  import("./folder-dialogs").then((m) => m.GroupIntoNewFolderDialog),
);
const DissolveFolderDialog = dynamic(() =>
  import("./folder-dialogs").then((m) => m.DissolveFolderDialog),
);
const DeleteFolderTrashDialog = dynamic(() =>
  import("./folder-dialogs").then((m) => m.DeleteFolderTrashDialog),
);
const FolderMoveDialog = dynamic(() =>
  import("./folder-move-dialog").then((m) => m.FolderMoveDialog),
);
import type { MoveSelection } from "./folder-move-dialog";
const CreateQuestionDialog = dynamic(() =>
  import("./dialogs").then((m) => m.CreateQuestionDialog),
);
const ImportDialog = dynamic(() =>
  import("./import-dialog").then((m) => m.ImportDialog),
);
const PublishDialog = dynamic(() =>
  import("./dialogs").then((m) => m.PublishDialog),
);
const PublishBatchDialog = dynamic(() =>
  import("./publish-batch-dialog").then((m) => m.PublishBatchDialog),
);
const SettingsCard = dynamic(() =>
  import("./settings-card").then((m) => m.SettingsCard),
);
import type { SettingsTab } from "./settings-card";
const QuestionActionDialog = dynamic(() =>
  import("./question-action-dialog").then((m) => m.QuestionActionDialog),
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

function TopbarAppearanceCluster() {
  const { theme: activeTheme, palette } = useAppearance();
  return (
    <div className="topbar-cluster" role="group" aria-label="外观切换">
      <button
        type="button"
        className="palette-quick-btn"
        onClick={toggleAppearancePalette}
        aria-label={
          palette === "forest" ? "切换至熏衣紫主题色" : "切换至青瓷绿主题色"
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
        onClick={toggleAppearanceTheme}
        aria-label={activeTheme === "dark" ? "切换浅色模式" : "切换深色模式"}
        title={activeTheme === "dark" ? "切换浅色模式" : "切换深色模式"}
      >
        {activeTheme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
      </button>
    </div>
  );
}

function SidebarMobileAppearance() {
  const { palette } = useAppearance();
  return (
    <div className="sidebar-mobile-appearance">
      <div className="sidebar-appearance-group" role="group" aria-label="色系切换">
        <button
          type="button"
          className={palette === "forest" ? "is-active" : ""}
          aria-pressed={palette === "forest"}
          onClick={() => setAppearancePalette("forest")}
        >
          <span className="appearance-swatch" style={{ background: "#1A6347" }} />
          青瓷
        </button>
        <button
          type="button"
          className={palette === "lavender" ? "is-active" : ""}
          aria-pressed={palette === "lavender"}
          onClick={() => setAppearancePalette("lavender")}
        >
          <span className="appearance-swatch" style={{ background: "#5D4B99" }} />
          熏衣
        </button>
      </div>
    </div>
  );
}

export function StudyApp() {
  const { data: session, isPending } = authClient.useSession();
  useEffect(() => {
    initAppearance();
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
  const initialShared = useRef<string | null>(null);
  const initialAuthor = useRef<string | null>(null);
  if (initialRoute.current === null) {
    if (typeof window !== "undefined") {
      const sub = extractSubscribeParam(window.location.search);
      const author = extractAuthorParam(window.location.search);
      initialShared.current = sub;
      initialAuthor.current = author;
      initialRoute.current = sub
        ? { view: "catalog", ...(author ? { authorId: author } : {}) }
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
      ? (initialRoute.current.deckId ?? null)
      : initialRoute.current.originDeckId,
  );
  const [quickView, setQuickView] = useState<LibraryQuickView | null>(() =>
    initialRoute.current?.view === "library"
      ? (initialRoute.current.quickView ?? null)
      : null,
  );
  const [subGroupId, setSubGroupId] = useState<string | null>(() =>
    initialRoute.current?.view === "library"
      ? (initialRoute.current.groupId ?? null)
      : null,
  );
  const [conceptFolderId, setConceptFolderId] = useState<string | null>(() =>
    initialRoute.current?.view === "concepts"
      ? (initialRoute.current.conceptFolderId ?? null)
      : (initialRoute.current?.originConceptFolderId ?? null),
  );
  const [focusConceptId, setFocusConceptId] = useState<string | null>(() =>
    initialRoute.current?.view === "concepts"
      ? (initialRoute.current.conceptId ?? null)
      : null,
  );
  const [focusConceptNonce, setFocusConceptNonce] = useState(0);
  const [recentVersion, setRecentVersion] = useState(0);
  const [selectionResetToken, setSelectionResetToken] = useState(0);
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
  const [importTargetFolderId, setImportTargetFolderId] = useState<
    string | null | undefined
  >(undefined);
  const importCommitted = useRef<(() => void) | null>(null);
  const [createFolderParentId, setCreateFolderParentId] = useState<
    string | null | undefined
  >(undefined);
  const [editFolderTarget, setEditFolderTarget] = useState<DeckView | null>(
    null,
  );
  const [dissolveFolderTarget, setDissolveFolderTarget] =
    useState<DeckView | null>(null);
  const [deleteFolderTrashTarget, setDeleteFolderTrashTarget] =
    useState<DeckView | null>(null);
  const [moveSelection, setMoveSelection] = useState<MoveSelection | null>(
    null,
  );
  const [groupIntoNewSelection, setGroupIntoNewSelection] = useState<{
    parentId: string | null;
    folderIds: string[];
    questionIds: string[];
    subscriptionDeckIds: string[];
  } | null>(null);
  const [createQuestionOpen, setCreateQuestionOpen] = useState(false);
  const [createQuestionFolderId, setCreateQuestionFolderId] = useState<
    string | null
  >(null);
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
  const [publishId, setPublishId] = useState<string | null>(null);
  const [batchPublishOpen, setBatchPublishOpen] = useState(false);
  const [sharedDeckId, setSharedDeckId] = useState<string | null>(
    initialShared.current,
  );
  const [catalogAuthorId, setCatalogAuthorId] = useState<string | null>(
    initialAuthor.current ??
      (initialRoute.current.view === "catalog"
        ? (initialRoute.current.authorId ?? null)
        : null),
  );
  const [questionAction, setQuestionAction] = useState<{
    question: QuestionView;
    action: "delete" | "move";
  } | null>(null);
  const [searchToken, setSearchToken] = useState(0);
  const [aiMode, setAiMode] = useState<AiIslandMode>("collapsed");
  const [aiDockWidth, setAiDockWidth] = useState<number | null>(null);
  const [aiDockResizing, setAiDockResizing] = useState(false);
  const [aiTrigger, setAiTrigger] = useState<AiTrigger | null>(null);
  const [hasOpenedAi, setHasOpenedAi] = useState(false);
  const triggerSeq = useRef(0);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiUnread, setAiUnread] = useState(false);
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
  const origin = useRef<{
    view: View;
    deckId?: string | null;
    quickView?: LibraryQuickView | null;
    conceptFolderId?: string | null;
  }>({
    view: initialRoute.current.originView ?? "library",
    ...(initialRoute.current.originDeckId !== undefined
      ? { deckId: initialRoute.current.originDeckId }
      : {}),
    ...(initialRoute.current.originQuickView
      ? { quickView: initialRoute.current.originQuickView }
      : {}),
    ...(initialRoute.current.originConceptFolderId
      ? { conceptFolderId: initialRoute.current.originConceptFolderId }
      : {}),
  });
  const reviewOrigin = useRef<{
    view: View;
    deckId?: string | null;
    questionId?: string | null;
  }>({ view: "today" });
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
  const eventId = useRef(createUuid());
  const pageKey =
    view === "question"
      ? `question:${questionId}`
      : view === "review"
        ? reviewSessionActive
          ? `review:${reviewIndex}:${queue[reviewIndex]?.id ?? "done"}`
          : "review:hub"
        : view === "library"
          ? `library:${quickView ? `quick:${quickView}` : deckId ? `folder:${deckId}${subGroupId ? `:group:${subGroupId}` : ""}` : "root"}`
          : view === "concepts"
            ? `concepts:${conceptFolderId ?? "root"}`
            : view;
  const rememberScroll = usePageScroll(pageKey, !!data);

  // Legacy URL compatibility: if ?group=<gid> points to a migrated owned subfolder, open it directly as folderId.
  useEffect(() => {
    if (!data || !subGroupId) return;
    const migratedOwned = data.decks.find(
      (d) => d.id === subGroupId && d.isOwner,
    );
    if (migratedOwned) {
      setDeckId(migratedOwned.id);
      setSubGroupId(null);
      if (typeof window !== "undefined") {
        const nextSearch = buildSearchFromRoute({
          view: "library",
          deckId: migratedOwned.id,
        });
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${nextSearch}`,
        );
      }
    }
  }, [data, subGroupId]);
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
            ? "找到多个同名条目，请在资料中搜索。"
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
  useEffect(() => {
    if (!sessionId) return;
    const shared = extractSubscribeParam(window.location.search);
    const author = extractAuthorParam(window.location.search);
    if (shared) {
      setSharedDeckId(shared);
      setCatalogAuthorId(author);
      setView("catalog");
      setNavigationTarget("catalog");
      return;
    }
    const hydrated = parseRouteFromSearch(window.location.search, true);
    if (hydrated.view === "catalog") {
      setCatalogAuthorId(hydrated.authorId ?? null);
    }
    const canonical = buildSearchFromRoute(hydrated);
    if (window.location.search !== canonical) {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${canonical}`,
      );
    }
  }, [sessionId]);
  useEffect(() => {
    function onPopState() {
      setSidebarOpen(false);
      const shared = extractSubscribeParam(window.location.search);
      const author = extractAuthorParam(window.location.search);
      if (shared) {
        setSharedDeckId(shared);
        setCatalogAuthorId(author);
        setNavigationTarget("catalog");
        startTransition(() => {
          setReviewSessionActive(false);
          setView("catalog");
        });
        return;
      }
      setSharedDeckId(null);
      const next = parseRouteFromSearch(window.location.search);
      setNavigationTarget(next.view);
      startTransition(() => {
        if (next.view !== "review" || queueLength.current === 0) {
          setReviewSessionActive(false);
        }
        if (next.view === "catalog") {
          setCatalogAuthorId(next.authorId ?? null);
        } else {
          setCatalogAuthorId(null);
        }
        if (next.view === "library") {
          setDeckId(next.deckId ?? null);
          setQuickView(next.quickView ?? null);
          setSubGroupId(next.groupId ?? null);
        } else if (next.view === "concepts") {
          setConceptFolderId(next.conceptFolderId ?? null);
          setFocusConceptId(next.conceptId ?? null);
          if (next.conceptId) {
            setFocusConceptNonce((n) => n + 1);
          }
        } else if (next.view === "question") {
          origin.current = {
            view: next.originView ?? "library",
            deckId: next.originDeckId,
            quickView: next.originQuickView ?? null,
            conceptFolderId: next.originConceptFolderId ?? null,
          };
          setDeckId(next.originDeckId);
          setQuickView(next.originQuickView ?? null);
          setQuestionId(next.questionId ?? null);
        }
        setView(next.view);
      });
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    setAppearanceSession(sessionId);
    return () => {
      setAppearanceSession(null);
    };
  }, [sessionId]);
  useEffect(() => {
    if (!data) return;
    hydrateServerTheme(sessionId, data.settings.theme);
  }, [sessionId, data?.settings.theme]);
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
      if (viaSlash && viewRef.current === "concepts") {
        (
          document.querySelector(
            "input[aria-label='搜索概念']",
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
  useEffect(() => {
    if (aiMode !== "collapsed" && !aiHiddenInReview) {
      setAiUnread(false);
    }
  }, [aiMode, aiHiddenInReview]);
  useEffect(() => {
    if (aiMode !== "collapsed" || aiTrigger !== null) {
      setHasOpenedAi(true);
    }
  }, [aiMode, aiTrigger]);
  const viewedQuestionId =
    view === "question" &&
    questionId &&
    data?.questions.some((q) => q.id === questionId)
      ? questionId
      : null;
  useEffect(() => {
    if (!viewedQuestionId) return;
    recordRecentQuestionId(sessionId, viewedQuestionId);
    setRecentVersion((n) => n + 1);
  }, [sessionId, viewedQuestionId]);
  const answerDraft = useAiAnswerDraft(data, mutate, () =>
    openSettings("ai"),
  );
  function openImport(targetFolderId?: string | null) {
    setImportSeed(undefined);
    setImportTargetFolderId(targetFolderId);
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
        if (
          next === "library" ||
          next === "favorites" ||
          next === "inbox" ||
          next === "archived" ||
          next === "today" ||
          next === "history"
        ) {
          setDeckId(null);
          setQuickView(null);
          setSubGroupId(null);
        }
        if (next === "concepts") {
          setConceptFolderId(null);
          setFocusConceptId(null);
        }
        if (next === "catalog") {
          setSharedDeckId(null);
          setCatalogAuthorId(null);
        }
        if (next !== "question") {
          setReadingIds([]);
        }
      },
      { route: { view: next } },
    );
    setSidebarOpen(false);
  }
  function openConceptFolder(fid: string | null) {
    const normalized = fid ?? null;
    changePage(
      "concepts",
      () => {
        setReviewSessionActive(false);
        setConceptFolderId(normalized);
        setFocusConceptId(null);
      },
      {
        route: {
          view: "concepts",
          ...(normalized ? { conceptFolderId: normalized } : {}),
        },
      },
    );
    setSidebarOpen(false);
  }
  function openConcept(conceptId: string) {
    const targetFolderId =
      data?.concepts?.find((c) => c.id === conceptId)?.folderId ?? null;
    setReviewSessionActive(false);
    setFocusConceptId(conceptId);
    setFocusConceptNonce((n) => n + 1);
    changePage(
      "concepts",
      () => {
        setConceptFolderId(targetFolderId);
      },
      {
        route: {
          view: "concepts",
          ...(targetFolderId ? { conceptFolderId: targetFolderId } : {}),
          conceptId,
        },
      },
    );
    setSidebarOpen(false);
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
  function openDeck(id?: string | null, nextSubGroupId?: string | null) {
    const normalized = id ?? null;
    const normalizedSub = normalized && nextSubGroupId ? nextSubGroupId : null;
    changePage(
      "library",
      () => {
        setReviewSessionActive(false);
        setDeckId(normalized);
        setQuickView(null);
        setSubGroupId(normalizedSub);
      },
      {
        route: {
          view: "library",
          ...(normalized ? { deckId: normalized } : {}),
          ...(normalizedSub ? { groupId: normalizedSub } : {}),
        },
      },
    );
    setSidebarOpen(false);
  }
  function openSubGroup(nextSubGroupId: string | null) {
    const normalizedDeck = deckId ?? null;
    const normalizedSub = normalizedDeck && nextSubGroupId ? nextSubGroupId : null;
    changePage(
      "library",
      () => {
        setReviewSessionActive(false);
        setSubGroupId(normalizedSub);
      },
      {
        route: {
          view: "library",
          ...(normalizedDeck ? { deckId: normalizedDeck } : {}),
          ...(normalizedSub ? { groupId: normalizedSub } : {}),
        },
      },
    );
  }
  function selectLibraryQuickView(nextQuick: LibraryQuickView | null) {
    changePage(
      "library",
      () => {
        setReviewSessionActive(false);
        setQuickView(nextQuick);
        setDeckId(null);
        setSubGroupId(null);
      },
      {
        route: {
          view: "library",
          ...(nextQuick ? { quickView: nextQuick } : {}),
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
    if (view !== "question") {
      origin.current = { view, deckId, quickView, conceptFolderId };
    }
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
          ...(origin.current.quickView
            ? { originQuickView: origin.current.quickView }
            : {}),
          ...(origin.current.view === "concepts" &&
          origin.current.conceptFolderId
            ? { originConceptFolderId: origin.current.conceptFolderId }
            : {}),
        },
      },
    );
  }
  const openQuestionRef = useRef(openQuestion);
  openQuestionRef.current = openQuestion;
  const openConceptFolderRef = useRef(openConceptFolder);
  openConceptFolderRef.current = openConceptFolder;
  const handleSelectConceptFolder = useCallback((fid: string | null) => {
    openConceptFolderRef.current(fid);
  }, []);
  const handleClearFocusConcept = useCallback(() => {
    setFocusConceptId(null);
    if (
      typeof window !== "undefined" &&
      viewRef.current === "concepts"
    ) {
      const params = new URLSearchParams(window.location.search);
      if (params.has("concept")) {
        params.delete("concept");
        const nextSearch = params.toString()
          ? `?${params.toString()}`
          : "";
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${nextSearch}`,
        );
      }
    }
  }, []);
  const handleOpenConceptQuestion = useCallback((q: QuestionView) => {
    openQuestionRef.current(q, []);
  }, []);
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
    let subtreeDeckIds: Set<string> | undefined;
    if (targetDeck) {
      const folderIndex = buildFolderIndex(data.decks);
      const target = folderIndex.byId.get(targetDeck);
      if (target && target.isOwner) {
        const owned = folderIndex.subtreeOwnedIds(targetDeck);
        subtreeDeckIds = new Set<string>(owned);
        for (const fid of owned) {
          for (const sub of folderIndex.subscriptionsByFolder.get(fid) ?? []) {
            subtreeDeckIds.add(sub.id);
          }
        }
      } else {
        subtreeDeckIds = new Set<string>([targetDeck]);
      }
    }
    const { queue: builtQueue } = buildReviewQueue(data.questions, {
      dailyNewLimit: data.settings.dailyNewLimit,
      newLearnedToday: data.stats.newLearnedToday,
      ...(subtreeDeckIds ? { deckIds: subtreeDeckIds } : {}),
    });
    setReviewRevealed(false);
    setReviewMode("fsrs");
    setCramLabel("");
    setReviewResults([]);
    changePage(
      "review",
      () => {
        setReviewSessionActive(true);
        setQueue(single ? [single] : builtQueue);
        setReviewIndex(0);
        setRatings([]);
      },
      { replace: view === "review", route: { view: "review" } },
    );
    setSidebarOpen(false);
    eventId.current = createUuid();
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
    eventId.current = createUuid();
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
      eventId.current = createUuid();
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
        eventId.current = createUuid();
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
    eventId.current = createUuid();
  }, [data, view, queue, reviewIndex, queueQuestion, currentReview]);
  if (!data)
    return (
      <div className="app-loading">
        <span className="brand-mark">
          <BookOpen size={27} />
        </span>
        <h2>{error ? "暂时没有连接上资料库" : "正在打开你的知识空间"}</h2>
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
      ? data.questions.filter((q) => {
          if (origin.current.view === "archived") return q.archived;
          if (q.archived) return false;
          if (origin.current.view === "favorites") return q.favorite;
          if (origin.current.view === "inbox") return q.needsEditing;
          if (origin.current.deckId === null)
            return q.isOwner && q.deckId === null;
          if (origin.current.deckId !== undefined)
            return q.deckId === origin.current.deckId;
          return true;
        })
      : [];
  const readingIndex = currentQuestion
    ? readingList.findIndex((q) => q.id === currentQuestion.id)
    : -1;
  const folderIndex = buildFolderIndex(data.decks);
  const topLevelSidebarFolders = [
    ...(folderIndex.ownedChildren.get(null) ?? []),
    ...(folderIndex.subscriptionsByFolder.get(null) ?? []),
  ];
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
  const activeFolderObj =
    typeof activeDeckId === "string"
      ? (folderIndex.byId.get(activeDeckId) ?? null)
      : null;
  const conceptFolderIndex = buildConceptFolderIndex(data.conceptFolders ?? []);
  const activeConceptFolderObj = conceptFolderId
    ? (conceptFolderIndex.byId.get(conceptFolderId) ?? null)
    : null;
  const effectiveQuickView: LibraryQuickView | null =
    libraryView === "favorites"
      ? "favorites"
      : libraryView === "inbox"
        ? "inbox"
        : libraryView === "archived"
          ? "archived"
          : quickView;
  const displayedView = isNavigating ? navigationTarget : view;
  const isImmersiveMobile = isReaderView;
  const hasMobileDeckBack =
    device.isMobileShell &&
    ((["library", "favorites", "inbox", "archived"].includes(displayedView) &&
      (Boolean(activeFolderObj) || Boolean(effectiveQuickView))) ||
      (displayedView === "concepts" && Boolean(activeConceptFolderObj)));
  const mobileView = ["question", "favorites", "inbox", "archived"].includes(
    navigationTarget,
  )
    ? navigationTarget === "question" && origin.current.view === "concepts"
      ? "concepts"
      : "library"
    : navigationTarget === "history"
      ? "review"
      : navigationTarget;
  const nav = [
    { id: "today" as const, label: "今日", mobileLabel: "今日", icon: LayoutDashboard },
    { id: "library" as const, label: ROOT_FOLDER_LABEL, mobileLabel: "资料", icon: Layers2 },
    {
      id: "concepts" as const,
      label: "概念",
      mobileLabel: "概念",
      icon: BookMarked,
      count: data.concepts?.length ?? 0,
    },
    {
      id: "review" as const,
      label: "复习中心",
      mobileLabel: "复习",
      icon: RotateCcw,
      count: data.stats.due,
    },
    { id: "catalog" as const, label: "发现资料", mobileLabel: "发现", icon: Rss },
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
        aria-hidden="true"
        tabIndex={-1}
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
            aria-label="Shiyi 返回今日"
            onClick={() => navigate("today")}
          >
            <span className="brand-mark">
              <BookOpen size={17} />
            </span>
            <span className="brand-wordmark">Shiyi</span>
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
          <div className="nav-section-label">文件夹</div>
          {topLevelSidebarFolders.slice(0, 8).map((d) => (
            <button
              className={cn(
                "sidebar-deck",
                activeNavView === "library" &&
                  !effectiveQuickView &&
                  activeDeckId === d.id &&
                  "selected",
              )}
              onClick={() => openDeck(d.id)}
              key={d.id}
            >
              {d.isOwner ? (
                <Folder size={13} className={`deck-dot-icon color-${d.color}`} />
              ) : (
                <Rss size={12} className="deck-dot-icon" />
              )}
              <span>{d.title}</span>
              <small>{d.count}</small>
            </button>
          ))}
          {topLevelSidebarFolders.length > 8 && (
            <button
              className="sidebar-deck"
              onClick={() => navigate("library")}
            >
              <Layers2 size={13} />
              <span>查看全部（{topLevelSidebarFolders.length}）</span>
            </button>
          )}
        </div>
        <div className="sidebar-bottom">
          <SidebarMobileAppearance />
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
                aria-label="返回上一级"
                onClick={() => {
                  if (displayedView === "concepts" && activeConceptFolderObj) {
                    openConceptFolder(activeConceptFolderObj.parentId ?? null);
                  } else if (effectiveQuickView) {
                    selectLibraryQuickView(null);
                  } else if (
                    activeFolderObj &&
                    !activeFolderObj.isOwner &&
                    subGroupId
                  ) {
                    const currentGrp = activeFolderObj.groups.find(
                      (g) => g.id === subGroupId,
                    );
                    openSubGroup(currentGrp?.parentId ?? null);
                  } else if (activeFolderObj?.parentId) {
                    openDeck(activeFolderObj.parentId);
                  } else {
                    openDeck(null);
                  }
                }}
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
              ) : displayedView === "concepts" && activeConceptFolderObj ? (
                <>
                  <button
                    type="button"
                    className="topbar-crumb-link"
                    onClick={() => openConceptFolder(null)}
                  >
                    {CONCEPT_ROOT_LABEL}
                  </button>
                  <span className="topbar-crumb-sep" aria-hidden="true">
                    /
                  </span>
                  <strong>{activeConceptFolderObj.title}</strong>
                </>
              ) : displayedView === "concepts" ? (
                <strong>概念</strong>
              ) : displayedView === "library" && effectiveQuickView ? (
                <>
                  <button
                    type="button"
                    className="topbar-crumb-link"
                    onClick={() => openDeck(null)}
                  >
                    {ROOT_FOLDER_LABEL}
                  </button>
                  <span className="topbar-crumb-sep" aria-hidden="true">
                    /
                  </span>
                  <strong>
                    {
                      {
                        recent: "最近打开",
                        favorites: "收藏",
                        inbox: "待补答案",
                        duplicates: "重复内容",
                        archived: "已归档",
                        trash: "回收站",
                      }[effectiveQuickView]
                    }
                  </strong>
                </>
              ) : displayedView === "library" && activeFolderObj ? (
                <>
                  <button
                    type="button"
                    className="topbar-crumb-link"
                    onClick={() => openDeck(null)}
                  >
                    {ROOT_FOLDER_LABEL}
                  </button>
                  <span className="topbar-crumb-sep" aria-hidden="true">
                    /
                  </span>
                  <strong>
                    {(!activeFolderObj.isOwner &&
                      subGroupId &&
                      activeFolderObj.groups.find((g) => g.id === subGroupId)
                        ?.title) ||
                      activeFolderObj.title}
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
                        () => {
                          setDeckId(origin.current.deckId);
                          setQuickView(origin.current.quickView ?? null);
                          if (origin.current.view === "concepts") {
                            setConceptFolderId(
                              origin.current.conceptFolderId ?? null,
                            );
                          }
                        },
                        {
                          route: {
                            view: origin.current.view,
                            ...(origin.current.view === "library" &&
                            origin.current.quickView
                              ? { quickView: origin.current.quickView }
                              : origin.current.view === "library"
                                ? { deckId: origin.current.deckId }
                                : origin.current.view === "concepts" &&
                                    origin.current.conceptFolderId
                                  ? {
                                      conceptFolderId:
                                        origin.current.conceptFolderId,
                                    }
                                  : {}),
                          },
                        },
                      )
                    }
                  >
                    {
                      {
                        today: "今日",
                        library: ROOT_FOLDER_LABEL,
                        concepts: "概念",
                        favorites: "我的收藏",
                        inbox: "待补答案",
                        archived: "已归档",
                        history: "回顾记录",
                        review: "答题",
                        catalog: "发现资料",
                        question: ROOT_FOLDER_LABEL,
                      }[origin.current.view]
                    }
                  </button>
                  <span className="topbar-crumb-sep" aria-hidden="true">
                    /
                  </span>
                  <strong>{currentQuestion?.folderPath ?? "学习卡"}</strong>
                </>
              ) : displayedView === "library" ? (
                <strong>{ROOT_FOLDER_LABEL}</strong>
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
                        catalog: "发现资料",
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
            {![
              "today",
              "library",
              "concepts",
              "favorites",
              "inbox",
              "archived",
            ].includes(displayedView) && (
              <button
                type="button"
                className="icon-button topbar-import-btn"
                aria-label="导入题目"
                title="导入题目"
                onClick={() => openImport()}
              >
                <Upload size={16} />
              </button>
            )}
            <span className="topbar-divider" />
            <TopbarAppearanceCluster />
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
                  aiUnread && aiMode === "collapsed" && "has-unread",
                )}
                title={
                  aiMode !== "collapsed"
                    ? "收起 AI 助手 (Ctrl/⌘ + J)"
                    : aiBusy
                      ? "AI 正在后台回复中（点击查看）"
                      : aiUnread
                        ? "AI 已回复完成（点击查看）"
                        : "AI 助手 (Ctrl/⌘ + J)"
                }
                aria-label={
                  aiMode !== "collapsed"
                    ? "收起 AI 助手"
                    : aiBusy
                      ? "打开 AI 助手（正在后台回复中）"
                      : aiUnread
                        ? "打开 AI 助手（有已完成的新回复）"
                        : "打开 AI 助手"
                }
                aria-pressed={aiMode !== "collapsed"}
                onClick={() => toggleAi()}
              >
                <Sparkles size={16} />
                {(aiBusy || (aiUnread && aiMode === "collapsed")) && (
                  <span className="ai-trigger-dot" aria-hidden="true" />
                )}
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
              onCram={startCram}
              onQuestion={(q, ids) => openQuestion(q, ids)}
              onApplyAllUpdates={async (deckIds) => {
                const res = await applyAllDeckUpdates(mutate, deckIds);
                if (res) {
                  toast.success(
                    `已更新 ${Number(res.updated ?? 0)} 份订阅资料。`,
                  );
                }
              }}
              onDeck={openDeck}
              onImport={() => openImport(null)}
              onCatalog={() => navigate("catalog")}
              onLibrary={() => navigate("library")}
              onInbox={() => navigate("inbox")}
              onSeed={async () => {
                const result = await mutate("/api/workspace", {});
                if (result)
                  toast.success(
                    Number(result.added)
                      ? `已载入 ${result.added} 道示例题，可自由编辑或归档。`
                      : "示例资料已经载入过了。",
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
                  data={data}
                  folderId={
                    libraryView === "library" && !effectiveQuickView
                      ? (deckId ?? null)
                      : null
                  }
                  quickView={effectiveQuickView}
                  subGroupId={subGroupId}
                  recentVersion={recentVersion}
                  selectionResetToken={selectionResetToken}
                  searchToken={searchToken}
                  mutate={mutate}
                  onSelectFolder={(fid, gid) => openDeck(fid, gid)}
                  onSelectSubGroup={(gid) => openSubGroup(gid)}
                  onSelectQuickView={(q) => selectLibraryQuickView(q)}
                  onOpenQuestion={openQuestion}
                  onPractice={(question) => startReview(undefined, question)}
                  onReviewFolder={(fid) => startReview(fid)}
                  onCram={startCram}
                  onCreateFolder={(parentId) => setCreateFolderParentId(parentId)}
                  onEditFolder={(folder) => setEditFolderTarget(folder)}
                  onDissolveFolder={(folder) => setDissolveFolderTarget(folder)}
                  onDeleteFolderTrash={(folder) =>
                    setDeleteFolderTrashTarget(folder)
                  }
                  onOpenMoveDialog={(sel) => setMoveSelection(sel)}
                  onOpenGroupIntoNew={(sel) => setGroupIntoNewSelection(sel)}
                  onPublishFolder={(fid) => setPublishId(fid)}
                  onBatchPublish={() => setBatchPublishOpen(true)}
                  onCreateQuestion={(fid) => {
                    setCreateQuestionFolderId(fid);
                    setCreateQuestionOpen(true);
                  }}
                  onImport={(fid) => openImport(fid)}
                  onDeleteQuestion={(q) =>
                    setQuestionAction({ question: q, action: "delete" })
                  }
                  onFavorite={(q) => void favorite(q)}
                  onGenerateAnswer={answerDraft.open}
                  onApplyUpdate={async (id, targetVersion) => {
                    const res = await applyDeckUpdate(mutate, id, targetVersion);
                    if (res) toast.success(`已更新到 v${targetVersion}。`);
                  }}
                  onDismissUpdate={async (id, version) => {
                    await dismissDeckUpdate(mutate, id, version);
                  }}
                  onUnsubscribe={(id) => {
                    setConfirmState({
                      open: true,
                      title: "取消订阅资料",
                      description:
                        "取消订阅后不再接收更新，已有的个人笔记和复习记录仍会保留。",
                      confirmLabel: "取消订阅",
                      variant: "danger",
                      action: async () => {
                        const result = await mutate("/api/decks", {
                          action: "unsubscribe",
                          deckId: id,
                        });
                        if (result) openDeck(null);
                      },
                    });
                  }}
                  onOpenAiDedup={() => {
                    askAi({
                      quote: "",
                      prompt:
                        "请扫描我资料库中语义相近或内容高度重叠的题目，列出对比并给出合并建议。",
                    });
                  }}
                />
              </div>
            )}
          {view === "concepts" && (
            <ConceptsView
              data={data}
              mutate={mutate}
              folderId={conceptFolderId}
              focusConceptId={focusConceptId}
              focusNonce={focusConceptNonce}
              onSelectFolder={handleSelectConceptFolder}
              onClearFocusConcept={handleClearFocusConcept}
              onOpenQuestion={handleOpenConceptQuestion}
            />
          )}
          {view === "question" && currentQuestion && (
            <QuestionReader
              key={currentQuestion.id}
              question={currentQuestion}
              data={data}
              onBack={() => {
                changePage(
                  origin.current.view,
                  () => {
                    setDeckId(origin.current.deckId);
                    setQuickView(origin.current.quickView ?? null);
                    if (origin.current.view === "concepts") {
                      setConceptFolderId(
                        origin.current.conceptFolderId ?? null,
                      );
                    }
                  },
                  {
                    route: {
                      view: origin.current.view,
                      ...(origin.current.view === "library" &&
                      origin.current.quickView
                        ? { quickView: origin.current.quickView }
                        : origin.current.view === "library"
                          ? { deckId: origin.current.deckId }
                          : origin.current.view === "concepts" &&
                              origin.current.conceptFolderId
                            ? {
                                conceptFolderId:
                                  origin.current.conceptFolderId,
                              }
                            : {}),
                    },
                  },
                );
              }}
              backLabel={
                origin.current.view === "concepts"
                  ? "返回概念"
                  : origin.current.view === "history"
                    ? "返回记录"
                    : origin.current.view === "inbox"
                      ? "返回待整理"
                      : origin.current.view === "favorites"
                        ? "返回收藏"
                        : origin.current.view === "today"
                          ? "返回今日"
                          : "返回资料"
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
                setImportTargetFolderId(seed.deckId ?? null);
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
              aiOpen={aiMode !== "collapsed"}
              aiDocked={aiMode === "docked" && !aiHiddenInReview}
              onToggleAi={toggleAi}
              onAskAi={askAi}
              onBeforeOpenAnnotations={() => {
                if (aiMode === "docked") setAiMode("collapsed");
              }}
              readingList={readingList}
              onJumpQuestion={(target) =>
                openQuestion(target, undefined, "replace")
              }
              onOpenFolder={(fid) => openDeck(fid)}
              onOpenConcept={openConcept}
            />
          )}
          {view === "question" && !currentQuestion && (
            <div className="empty-state">
              <BookOpen size={32} />
              <h3>题目已不可访问</h3>
              <Button variant="outline" onClick={() => navigate("library")}>
                返回资料
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
              onImport={() => openImport(null)}
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
                aiOpen={aiMode !== "collapsed"}
                aiDocked={aiMode === "docked" && !aiHiddenInReview}
                onToggleAi={toggleAi}
                onAskAi={askAi}
                onBeforeOpenAnnotations={() => {
                  if (aiMode === "docked") setAiMode("collapsed");
                }}
                onRevealedChange={setReviewRevealed}
                onOpenConcept={openConcept}
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
            <Catalog
              data={data}
              mutate={mutate}
              initialAuthorId={catalogAuthorId}
              initialSharedDeckId={sharedDeckId}
              onOpenDeck={(id) => openDeck(id)}
              onMoveSubscription={(deck) =>
                setMoveSelection({
                  subscriptionDeckIds: [deck.id],
                  label: deck.title,
                  initialTargetId: deck.parentId,
                })
              }
              onClearDeepLink={() => {
                setSharedDeckId(null);
                pushRouteUrl(
                  {
                    view: "catalog",
                    ...(catalogAuthorId ? { authorId: catalogAuthorId } : {}),
                  },
                  true,
                );
              }}
              onSelectAuthorUrl={(authorId) => {
                setCatalogAuthorId(authorId);
                pushRouteUrl(
                  {
                    view: "catalog",
                    ...(authorId ? { authorId } : {}),
                  },
                  false,
                );
              }}
            />
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
            setImportTargetFolderId(undefined);
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
              : importTargetFolderId !== undefined
                ? importTargetFolderId
                : deckId && data.decks.find((d) => d.id === deckId)?.isOwner
                  ? deckId
                  : null
          }
          mutate={mutate}
          onView={(fid) => openDeck(fid)}
          onInbox={() => selectLibraryQuickView("inbox")}
          onSettings={() => {
            setImportOpen(false);
            openSettings("ai");
          }}
        />
      )}
      {createFolderParentId !== undefined && (
        <CreateFolderDialog
          open
          parentId={createFolderParentId}
          decks={data.decks}
          onClose={() => setCreateFolderParentId(undefined)}
          mutate={mutate}
          onCreated={(id) => openDeck(id)}
        />
      )}
      {editFolderTarget && (
        <EditFolderDialog
          folder={
            data.decks.find((d) => d.id === editFolderTarget.id) ??
            editFolderTarget
          }
          onClose={() => setEditFolderTarget(null)}
          mutate={mutate}
        />
      )}
      {moveSelection && (
        <FolderMoveDialog
          selection={moveSelection}
          decks={data.decks}
          mutate={mutate}
          onClose={() => setMoveSelection(null)}
          onDone={() => setSelectionResetToken((n) => n + 1)}
        />
      )}
      {groupIntoNewSelection && (
        <GroupIntoNewFolderDialog
          open
          parentId={groupIntoNewSelection.parentId}
          decks={data.decks}
          folderIds={groupIntoNewSelection.folderIds}
          questionIds={groupIntoNewSelection.questionIds}
          subscriptionDeckIds={groupIntoNewSelection.subscriptionDeckIds}
          mutate={mutate}
          onClose={() => setGroupIntoNewSelection(null)}
          onDone={(createdId) => {
            setSelectionResetToken((n) => n + 1);
            openDeck(createdId);
          }}
        />
      )}
      {dissolveFolderTarget && (
        <DissolveFolderDialog
          folder={
            data.decks.find((d) => d.id === dissolveFolderTarget.id) ??
            dissolveFolderTarget
          }
          decks={data.decks}
          mutate={mutate}
          onClose={() => setDissolveFolderTarget(null)}
          onDone={(parentId) => {
            if (deckId === dissolveFolderTarget.id) openDeck(parentId);
          }}
        />
      )}
      {deleteFolderTrashTarget && (
        <DeleteFolderTrashDialog
          folder={
            data.decks.find((d) => d.id === deleteFolderTrashTarget.id) ??
            deleteFolderTrashTarget
          }
          decks={data.decks}
          mutate={mutate}
          onClose={() => setDeleteFolderTrashTarget(null)}
          onSwitchToDissolve={(folder) => setDissolveFolderTarget(folder)}
          onDone={(parentId) => {
            if (deckId === deleteFolderTrashTarget.id) openDeck(parentId);
          }}
        />
      )}
      {createQuestionOpen && (
        <CreateQuestionDialog
          open={createQuestionOpen}
          defaultDeckId={createQuestionFolderId}
          data={data}
          mutate={mutate}
          onClose={() => {
            setCreateQuestionOpen(false);
            setCreateQuestionFolderId(null);
          }}
          onCreated={(id) => {
            if (view !== "question") {
              origin.current = { view, deckId, quickView, conceptFolderId };
            }
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
                  ...(origin.current.quickView
                    ? { originQuickView: origin.current.quickView }
                    : {}),
                  ...(origin.current.view === "concepts" &&
                  origin.current.conceptFolderId
                    ? { originConceptFolderId: origin.current.conceptFolderId }
                    : {}),
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
          onRefreshWorkspace={() => refresh(false)}
          onSignOut={() => {
            setSettingsState((prev) => ({ ...prev, open: false }));
            signOutPrompt();
          }}
        />
      )}
      {publishId && (
        <PublishDialog
          deck={data.decks.find((d) => d.id === publishId) ?? null}
          decks={data.decks}
          onClose={() => setPublishId(null)}
          mutate={mutate}
        />
      )}
      {batchPublishOpen && (
        <PublishBatchDialog
          open={batchPublishOpen}
          userId={data.user.id}
          decks={data.decks}
          mutate={mutate}
          onClose={() => setBatchPublishOpen(false)}
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
                  setQuickView(origin.current.quickView ?? null);
                  if (origin.current.view === "concepts") {
                    setConceptFolderId(origin.current.conceptFolderId ?? null);
                  }
                },
                {
                  route: {
                    view: origin.current.view,
                    ...(origin.current.view === "library" &&
                    origin.current.quickView
                      ? { quickView: origin.current.quickView }
                      : origin.current.view === "library"
                        ? { deckId: origin.current.deckId }
                        : origin.current.view === "concepts" &&
                            origin.current.conceptFolderId
                          ? {
                              conceptFolderId: origin.current.conceptFolderId,
                            }
                          : {}),
                  },
                },
              );
            }
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
      {hasOpenedAi && (
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
          onUnreadChange={setAiUnread}
          mutate={mutate}
        />
      )}
    </div>
  );
}
