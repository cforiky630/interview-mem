"use client";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
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
  Settings2,
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
} from "lucide-react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { api, RequestError } from "@/lib/client";
import type { Workspace, QuestionView, CatalogDeck } from "@/lib/types";
import { cn } from "@/lib/utils";
import { extractNoteAliases, normalizedNoteTitle } from "@/lib/markdown-source";
import { practiceDraftKey, savePracticeDraft } from "@/lib/drafts";
import { Button } from "./ui/button";
import { AuthScreen } from "./auth-screen";
import { Dashboard } from "./dashboard";
import { Library, Catalog } from "./library";
import { useAiAnswerDraft } from "./use-ai-answer-draft";
import { usePageScroll } from "./use-page-scroll";
import type { Mutate } from "./dialogs";
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
const QuestionEditPage = dynamic(() =>
  import("./question-edit-page").then((m) => m.QuestionEditPage),
);
const ImportDialog = dynamic(() =>
  import("./import-dialog").then((m) => m.ImportDialog),
);
const PublishDialog = dynamic(() =>
  import("./dialogs").then((m) => m.PublishDialog),
);
const SettingsDialog = dynamic(() =>
  import("./dialogs").then((m) => m.SettingsDialog),
);
const DeleteDeckDialog = dynamic(() =>
  import("./deck-delete-dialog").then((m) => m.DeleteDeckDialog),
);

const QuestionActionDialog = dynamic(() =>
  import("./question-action-dialog").then((m) => m.QuestionActionDialog),
);

import type { ImportSeed } from "./import-dialog";

type View =
  | "today"
  | "library"
  | "favorites"
  | "inbox"
  | "archived"
  | "review"
  | "catalog"
  | "history"
  | "question";
export type Palette = "forest" | "lavender";

function syncThemeColorMeta(palette: Palette, theme: "light" | "dark") {
  const color =
    palette === "lavender"
      ? theme === "dark"
        ? "#0D0C13"
        : "#F6F4F8"
      : theme === "dark"
        ? "#0C0F0E"
        : "#F5F7F6";
  document
    .querySelectorAll('meta[name="theme-color"]')
    .forEach((el) => el.setAttribute("content", color));
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
      document.documentElement.dataset.theme = resolved;
      const savedPalette: Palette =
        localStorage.getItem("shiyi:palette") === "lavender"
          ? "lavender"
          : "forest";
      document.documentElement.dataset.palette = savedPalette;
      syncThemeColorMeta(savedPalette, resolved);
      if (cached !== "light" && cached !== "dark" && media) {
        const onChange = (event: MediaQueryListEvent) => {
          const next = event.matches ? "dark" : "light";
          document.documentElement.dataset.theme = next;
          const activePal =
            document.documentElement.dataset.palette === "lavender"
              ? "lavender"
              : "forest";
          syncThemeColorMeta(activePal, next);
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
  const [data, setData] = useState<Workspace | null>(null);
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState(false);
  const [view, setView] = useState<View>("today");
  const [navigationTarget, setNavigationTarget] = useState<View>("today");
  const [isNavigating, startTransition] = useTransition();
  const [deckId, setDeckId] = useState<string | null | undefined>();
  const [questionId, setQuestionId] = useState<string | null>(null);
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
  const importCommitted = useRef<(() => void) | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [palette, setPalette] = useState<Palette>("forest");
  const [themeOverride, setThemeOverride] = useState<"light" | "dark" | null>(
    null,
  );
  const [editQuestion, setEditQuestion] = useState<QuestionView | null>(null);
  const editingId = useRef<string | null>(null);
  editingId.current = editQuestion?.id ?? null;
  const [publishId, setPublishId] = useState<string | null>(null);
  const [deleteDeck, setDeleteDeck] = useState<
    Workspace["decks"][number] | null
  >(null);
  const [questionAction, setQuestionAction] = useState<{
    question: QuestionView;
    action: "delete" | "move";
  } | null>(null);
  const [searchToken, setSearchToken] = useState(0);
  const origin = useRef<{ view: View; deckId?: string | null }>({
    view: "library",
  });
  const reviewOrigin = useRef<{
    view: View;
    deckId?: string | null;
    questionId?: string | null;
  }>({ view: "today" });
  const [catalog, setCatalog] = useState<CatalogDeck[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [pending, setPending] = useState(0);
  const pendingCount = useRef(0);
  pendingCount.current = pending;
  const [queue, setQueue] = useState<QuestionView[]>([]);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [ratings, setRatings] = useState<number[]>([]);
  const [reviewBusy, setReviewBusy] = useState(false);
  const grading = useRef(false);
  const eventId = useRef(crypto.randomUUID());
  const lifetime = useRef<AbortController | null>(null);
  const pageKey = editQuestion
    ? `edit:${editQuestion.id}`
    : view === "question"
      ? `question:${questionId}`
      : view === "review"
        ? `review:${reviewIndex}:${queue[reviewIndex]?.id ?? "done"}`
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
    if (!sidebarOpen) {
      setDrawerDragX(0);
      drawerTouch.current = null;
      return;
    }
    const previous = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = previous;
    };
  }, [sidebarOpen]);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      lifetime.current = null;
    };
  }, []);
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
      if (editingId.current && pendingCount.current) return;
      changePage("question", () => {
        setEditQuestion(null);
        setQuestionId(matches[0].id);
      });
    }
    window.addEventListener("shiyi:open-note", openLinkedNote);
    return () => window.removeEventListener("shiyi:open-note", openLinkedNote);
  }, [data?.questions]);
  const refresh = useCallback(
    async (silent = false) => {
      const signal = lifetime.current?.signal;
      if (!signal || signal.aborted) return null;
      try {
        const result = await api<Workspace>("/api/workspace", undefined, {
          userId: sessionId,
          signal,
        });
        if (result.user.id !== sessionId) {
          window.location.reload();
          return null;
        }
        setData(result);
        setError("");
        setSyncError(false);
        return result;
      } catch (e) {
        if (signal.aborted) return null;
        if (e instanceof RequestError && e.code === "ACCOUNT_CHANGED") {
          window.location.reload();
          return null;
        }
        if (e instanceof RequestError && e.status === 401) {
          setData(null);
          window.location.reload();
        } else if (silent) setSyncError(true);
        else setError(e instanceof Error ? e.message : "题库暂时无法读取。");
        return null;
      }
    },
    [sessionId],
  );
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
    [sessionId],
  );
  useEffect(() => {
    setData(null);
    setError("");
    if (!sessionId) return;
    void refresh();
    const shared = new URL(window.location.href).searchParams.get("subscribe");
    if (shared) {
      setView("catalog");
      setNavigationTarget("catalog");
      void loadCatalog(shared);
    }
    function sync() {
      if (document.visibilityState === "visible") void refresh(true);
    }
    window.addEventListener("focus", sync);
    window.addEventListener("online", sync);
    const timer = setInterval(sync, 60_000);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("online", sync);
      clearInterval(timer);
    };
  }, [sessionId, refresh, loadCatalog]);
  useEffect(() => {
    try {
      const savedPalette =
        localStorage.getItem("shiyi:palette") === "lavender"
          ? "lavender"
          : "forest";
      setPalette(savedPalette);
      document.documentElement.dataset.palette = savedPalette;
    } catch {
      document.documentElement.dataset.palette = "forest";
    }
  }, []);
  const applyPalette = useCallback((next: Palette) => {
    setPalette(next);
    document.documentElement.dataset.palette = next;
    const currentTheme =
      document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    syncThemeColorMeta(next, currentTheme);
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
    document.documentElement.dataset.theme = nextTheme;
    syncThemeColorMeta(palette, nextTheme);
    try {
      localStorage.setItem("shiyi:theme", nextTheme);
    } catch {
      /* Ignore storage access failures. */
    }
  }, [data?.settings.theme, palette]);
  useEffect(() => {
    function shortcuts(event: KeyboardEvent) {
      if (
        (event.target as HTMLElement).closest(
          "input,textarea,[contenteditable='true']",
        ) ||
        document.querySelector("[role='dialog']")
      )
        return;
      if (
        event.key === "/" ||
        ((event.metaKey || event.ctrlKey) && event.key === "k")
      ) {
        event.preventDefault();
        if (editingId.current && pendingCount.current) return;
        changePage("library", () => {
          setEditQuestion(null);
          setDeckId(undefined);
          setSearchToken((n) => n + 1);
        });
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
      if (event.key === "Escape") setSidebarOpen(false);
    }
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  }, []);
  const mutate: Mutate = async (url, payload) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return null;
    setPending((n) => n + 1);
    try {
      const result = await api<Record<string, unknown>>(url, payload, {
        userId: sessionId,
        signal,
      });
      await refresh(true);
      return result;
    } catch (e) {
      if (signal.aborted) return null;
      if (e instanceof RequestError && e.code === "ACCOUNT_CHANGED") {
        window.location.reload();
        return null;
      }
      toast.error(e instanceof Error ? e.message : "操作失败，请重试。");
      if (e instanceof RequestError && e.status === 409) await refresh(true);
      return null;
    } finally {
      setPending((n) => n - 1);
    }
  };
  const answerDraft = useAiAnswerDraft(data, mutate, () =>
    setSettingsOpen(true),
  );
  function openImport() {
    setImportSeed(undefined);
    importCommitted.current = null;
    setImportOpen(true);
  }
  function navigate(next: View) {
    if (editingId.current && pendingCount.current) return;
    changePage(next, () => {
      setEditQuestion(null);
      if (next === "library") setDeckId(undefined);
    });
    setSidebarOpen(false);
    if (next === "catalog") void loadCatalog();
  }
  function changePage(next: View, prepare?: () => void) {
    rememberScroll();
    setNavigationTarget(next);
    // 导航反馈先提交，长文的 Markdown 渲染可被下一次触控打断。
    startTransition(() => {
      prepare?.();
      setView(next);
    });
  }
  function openDeck(id?: string | null) {
    if (editingId.current && pendingCount.current) return;
    changePage("library", () => {
      setEditQuestion(null);
      setDeckId(id);
    });
    setSidebarOpen(false);
  }
  function openQuestion(question: QuestionView) {
    if (editingId.current && pendingCount.current) return;
    origin.current = { view, deckId };
    changePage("question", () => {
      setEditQuestion(null);
      setQuestionId(question.id);
    });
  }
  function startReview(targetDeck?: string, single?: QuestionView) {
    if (editingId.current && pendingCount.current) return;
    setEditQuestion(null);
    if (!data) return;
    if (view === "review" && !targetDeck && !single && queue[reviewIndex]) {
      if (navigationTarget !== "review") changePage("review");
      setSidebarOpen(false);
      return;
    }
    if (view !== "review") reviewOrigin.current = { view, deckId, questionId };
    const active = data.questions.filter(
      (q) =>
        !q.archived &&
        q.answer.trim() &&
        (!targetDeck || q.deckId === targetDeck),
    );
    const due = active
      .filter((q) => q.fsrs && new Date(q.fsrs.due).getTime() <= Date.now())
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
    changePage("review", () => {
      setQueue(single ? [single] : [...due, ...fresh]);
      setReviewIndex(0);
      setRatings([]);
    });
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
    if (
      !latest ||
      latest.studyVersion !== q.studyVersion ||
      latest.revision !== q.revision ||
      latest.archived
    ) {
      toast.info(
        "这道题的内容或复习进度已在其他页面更新，已跳过，稍后可以重新开始。",
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
        questionRevision: q.revision,
        rating,
        answer,
      });
      if (result) {
        if (data)
          savePracticeDraft(
            practiceDraftKey(data.user.id, q.id, q.revision),
            "",
          );
        setRatings((previous) => [...previous, rating]);
        setReviewIndex((n) => n + 1);
        eventId.current = crypto.randomUUID();
        rememberScroll();
      }
    } finally {
      grading.current = false;
      setReviewBusy(false);
    }
  }
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
  function setThemeMode(next: "light" | "dark") {
    if (!data || next === activeTheme) return;
    setThemeOverride(next);
    document.documentElement.dataset.theme = next;
    syncThemeColorMeta(palette, next);
    try {
      localStorage.setItem("shiyi:theme", next);
    } catch {
      /* Ignore storage access failures. */
    }
    void mutate("/api/settings", {
      action: "preferences",
      dailyGoal: data.settings.dailyGoal,
      dailyNewLimit: data.settings.dailyNewLimit,
      theme: next,
      timeZone: data.settings.timeZone,
    });
  }
  function toggleTheme() {
    setThemeMode(activeTheme === "dark" ? "light" : "dark");
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
    if (editingId.current && pendingCount.current) return;
    if (confirm("退出当前账号？")) {
      void authClient.signOut();
      changePage("today");
    }
  }
  const currentQuestion = data.questions.find((q) => q.id === questionId);
  const queueQuestion = queue[reviewIndex];
  const currentReview = data.questions.find((q) => q.id === queueQuestion?.id);
  const libraryView = view === "question" ? origin.current.view : view;
  const activeNavView = view === "question" ? origin.current.view : view;
  const activeDeckId = view === "question" ? origin.current.deckId : deckId;
  const displayedView = isNavigating ? navigationTarget : view;
  const isReaderView = (view === "question" || view === "review") && !editQuestion;
  const isImmersiveMobile = isReaderView || !!editQuestion;
  const hasMobileDeckBack =
    displayedView === "library" && activeDeckId !== undefined && !editQuestion;
  const mobileView = ["question", "favorites", "inbox", "archived"].includes(
    navigationTarget,
  )
    ? "library"
    : navigationTarget;
  const nav = [
    { id: "today" as const, label: "今日", mobileLabel: "今日", icon: LayoutDashboard },
    { id: "library" as const, label: "我的题库", mobileLabel: "题库", icon: Layers2 },
    {
      id: "review" as const,
      label: "开始复习",
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
        editQuestion && "editor-open",
        editQuestion && pending && "editor-saving",
        isReaderView && "mobile-reader-active",
        isImmersiveMobile && "mobile-immersive",
      )}
      onPointerDownCapture={rememberScroll}
      onKeyDownCapture={rememberScroll}
    >
      {sidebarOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="关闭导航"
          style={
            drawerDragX < 0
              ? { opacity: Math.max(0, 1 + drawerDragX / 280) }
              : undefined
          }
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside
        className={cn("sidebar", sidebarOpen && "sidebar-open")}
        style={
          drawerDragX < 0
            ? { transform: `translateX(${drawerDragX}px)`, transition: "none" }
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
              onClick={() => (id === "review" ? startReview() : navigate(id))}
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
              onClick={() => setCreateOpen(true)}
            >
              <Plus size={14} />
            </button>
          </div>
          {data.decks.slice(0, 5).map((d) => (
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
          {data.decks.length > 5 && (
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
            className="user-button"
            onClick={() => {
              setSidebarOpen(false);
              setSettingsOpen(true);
            }}
          >
            <span className="user-avatar">
              {data.user.name.slice(0, 1).toUpperCase()}
            </span>
            <span>
              <strong>{data.user.name}</strong>
              <small>偏好与 AI 设置</small>
            </span>
            <Settings2 size={16} />
          </button>
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
              {editQuestion ? (
                <strong>编辑题目</strong>
              ) : displayedView === "today" ? (
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
                      changePage(origin.current.view, () =>
                        setDeckId(origin.current.deckId),
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
                  <strong>{currentQuestion?.title ?? "学习卡"}</strong>
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
                        review: "答题",
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
            {!editQuestion &&
              displayedView !== "today" &&
              displayedView !== "library" && (
                <button
                  type="button"
                  className="button button-ghost button-sm topbar-import-btn"
                  aria-label="快速导入"
                  title="导入题目"
                  onClick={openImport}
                >
                  <Upload size={14} />
                  <span>导入</span>
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
                <span>{palette === "forest" ? "青瓷" : "熏衣"}</span>
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
              className="icon-button topbar-settings-btn"
              aria-label="设置"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 size={17} />
            </button>
            <button
              className="icon-button logout-button"
              aria-label="退出登录"
              onClick={signOutPrompt}
            >
              <LogOut size={16} />
            </button>
          </div>
        </header>
        <div hidden={!!editQuestion}>
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
                  mutate={mutate}
                  onDelete={setDeleteDeck}
                  onDeleteQuestion={(q) =>
                    setQuestionAction({ question: q, action: "delete" })
                  }
                  onMoveQuestion={(q) =>
                    setQuestionAction({ question: q, action: "move" })
                  }
                  onQuestion={openQuestion}
                  onPractice={(question) => startReview(undefined, question)}
                  onDeck={openDeck}
                  onImport={openImport}
                  onCreate={() => setCreateOpen(true)}
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
                  onUnsubscribe={async (id) => {
                    if (
                      confirm(
                        "取消订阅后停止接收更新，已有个人笔记和复习历史仍保留。确定继续？",
                      )
                    ) {
                      const result = await mutate("/api/decks", {
                        action: "unsubscribe",
                        deckId: id,
                      });
                      if (result) openDeck();
                    }
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
                changePage(origin.current.view, () =>
                  setDeckId(origin.current.deckId),
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
              onEdit={() => setEditQuestion(currentQuestion)}
              onDelete={() =>
                setQuestionAction({
                  question: currentQuestion,
                  action: "delete",
                })
              }
              onMove={() =>
                setQuestionAction({ question: currentQuestion, action: "move" })
              }
              onSettings={() => setSettingsOpen(true)}
              onGenerateAnswer={answerDraft.open}
              onFavorite={() => void favorite(currentQuestion)}
              mutate={mutate}
              onSingleReview={() => startReview(undefined, currentQuestion)}
              activeTheme={activeTheme}
              onToggleTheme={toggleTheme}
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
          {view === "review" &&
            (currentReview ? (
              <QuestionReader
                key={`review:${currentReview.id}:${reviewIndex}`}
                question={currentReview}
                data={data}
                review
                onBack={() => {
                  const back = reviewOrigin.current;
                  if (back.view === "question" && back.questionId) {
                    changePage("question", () =>
                      setQuestionId(back.questionId!),
                    );
                  } else if (back.view === "library") {
                    changePage("library", () => setDeckId(back.deckId));
                  } else {
                    navigate(back.view === "review" ? "today" : back.view);
                  }
                }}
                onEdit={() => setEditQuestion(currentReview)}
                onDelete={() =>
                  setQuestionAction({
                    question: currentReview,
                    action: "delete",
                  })
                }
                onMove={() =>
                  setQuestionAction({ question: currentReview, action: "move" })
                }
                onSettings={() => setSettingsOpen(true)}
                onGenerateAnswer={answerDraft.open}
                onFavorite={() => void favorite(currentReview)}
                mutate={mutate}
                progress={{ current: reviewIndex + 1, total: queue.length }}
                onGrade={(rating, answer) => void grade(rating, answer)}
                busy={reviewBusy}
                activeTheme={activeTheme}
                onToggleTheme={toggleTheme}
              />
            ) : (
              <ReviewComplete
                count={ratings.length}
                ratings={ratings}
                onBack={() => navigate("today")}
                onLibrary={() => navigate("library")}
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
        {editQuestion && (
          <QuestionEditPage
            key={editQuestion.id}
            question={editQuestion}
            current={data.questions.find(
              (q) => q.id === editQuestion.id && q.isOwner,
            )}
            userId={data.user.id}
            mutate={mutate}
            onBack={() => {
              if (pendingCount.current) return;
              setEditQuestion(null);
              rememberScroll();
            }}
            onSaved={() => {
              if (editingId.current === editQuestion.id) {
                setEditQuestion(null);
                rememberScroll();
              }
            }}
            onBatchImport={(seed, onCommitted) => {
              setImportSeed(seed);
              importCommitted.current = onCommitted;
              setImportOpen(true);
            }}
          />
        )}
      </main>
      <nav className="mobile-bottom-nav" aria-label="手机主导航">
        {nav.map(({ id, mobileLabel, icon: Icon, count }) => (
          <button
            key={id}
            className={mobileView === id ? "active" : ""}
            aria-current={mobileView === id ? "page" : undefined}
            onClick={() => (id === "review" ? startReview() : navigate(id))}
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
          mutate={mutate}
          onView={openDeck}
          onInbox={() => navigate("inbox")}
          onSettings={() => {
            setImportOpen(false);
            setSettingsOpen(true);
          }}
        />
      )}
      {createOpen && (
        <CreateDeckDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          mutate={mutate}
          onCreated={openDeck}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          data={data}
          mutate={mutate}
          palette={palette}
          onPaletteChange={applyPalette}
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
              changePage(origin.current.view, () => {
                setQuestionId(null);
                setDeckId(origin.current.deckId);
              });
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
    </div>
  );
}
