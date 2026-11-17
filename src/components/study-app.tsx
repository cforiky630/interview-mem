"use client";
import { useCallback, useEffect, useRef, useState } from "react";
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
  ArrowUpRight,
  LogOut,
  Menu,
  X,
  Loader2,
  Check,
  Cloud,
  RefreshCw,
  Archive,
  Sprout,
  WifiOff,
} from "lucide-react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { api, RequestError } from "@/lib/client";
import type { Workspace, QuestionView, CatalogDeck } from "@/lib/types";
import { cn } from "@/lib/utils";
import { normalizedNoteTitle } from "@/lib/markdown-source";
import { practiceDraftKey, savePracticeDraft } from "@/lib/study-document";
import { Button } from "./ui/button";
import { AuthScreen } from "./auth-screen";
import { Dashboard } from "./dashboard";
import { Library, Catalog } from "./library";
import { QuestionReader, ReviewComplete } from "./question-reader";
import { HistoryView } from "./history";
import {
  CreateDeckDialog,
  EditQuestionDialog,
  ImportDialog,
  PublishDialog,
  SettingsDialog,
  type Mutate,
} from "./dialogs";

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
export function StudyApp() {
  const { data: session, isPending } = authClient.useSession();
  const [data, setData] = useState<Workspace | null>(null);
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState(false);
  const [view, setView] = useState<View>("today");
  const [deckId, setDeckId] = useState<string | undefined>();
  const [questionId, setQuestionId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editQuestion, setEditQuestion] = useState<QuestionView | null>(null);
  const [publishId, setPublishId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogDeck[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [pending, setPending] = useState(0);
  const [queue, setQueue] = useState<QuestionView[]>([]);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [ratings, setRatings] = useState<number[]>([]);
  const [reviewBusy, setReviewBusy] = useState(false);
  const grading = useRef(false);
  const eventId = useRef(crypto.randomUUID());
  const sessionId = session?.user.id;
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
            normalizedNoteTitle(q.validation?.sourcePath ?? "") === normalized),
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
      setQuestionId(matches[0].id);
      setView("question");
      window.scrollTo({ top: 0, behavior: "instant" });
    }
    window.addEventListener("shiyi:open-note", openLinkedNote);
    return () => window.removeEventListener("shiyi:open-note", openLinkedNote);
  }, [data?.questions]);
  const refresh = useCallback(async (silent = false) => {
    try {
      const result = await api<Workspace>("/api/workspace");
      setData(result);
      setError("");
      setSyncError(false);
      return result;
    } catch (e) {
      if (e instanceof RequestError && e.status === 401) {
        setData(null);
        void authClient.signOut();
      } else if (silent) setSyncError(true);
      else setError(e instanceof Error ? e.message : "题库暂时无法读取。");
      return null;
    }
  }, []);
  const loadCatalog = useCallback(async (shared?: string) => {
    setCatalogLoading(true);
    try {
      const result = await api<CatalogDeck[]>(
        `/api/catalog${shared ? `?id=${encodeURIComponent(shared)}` : ""}`,
      );
      setCatalog(result);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "题库暂时无法加载。");
    } finally {
      setCatalogLoading(false);
    }
  }, []);
  useEffect(() => {
    setData(null);
    setError("");
    if (!sessionId) return;
    void refresh();
    const shared = new URL(window.location.href).searchParams.get("subscribe");
    if (shared) {
      setView("catalog");
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
    if (data) document.documentElement.dataset.theme = data.settings.theme;
  }, [data?.settings.theme]);
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
        setView("library");
        setDeckId(undefined);
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
    setPending((n) => n + 1);
    try {
      const result = await api<Record<string, unknown>>(url, payload);
      await refresh(true);
      return result;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败，请重试。");
      if (e instanceof RequestError && e.status === 409) await refresh(true);
      return null;
    } finally {
      setPending((n) => n - 1);
    }
  };
  function navigate(next: View) {
    setView(next);
    setSidebarOpen(false);
    if (next === "library") setDeckId(undefined);
    if (next === "catalog") void loadCatalog();
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function openDeck(id?: string) {
    setDeckId(id);
    setView("library");
    setSidebarOpen(false);
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function openQuestion(question: QuestionView) {
    setQuestionId(question.id);
    setView("question");
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function startReview(targetDeck?: string, single?: QuestionView) {
    if (!data) return;
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
      .slice(0, data.settings.dailyGoal);
    setQueue(single ? [single] : [...due, ...fresh]);
    setReviewIndex(0);
    setRatings([]);
    setView("review");
    setSidebarOpen(false);
    eventId.current = crypto.randomUUID();
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  async function favorite(question: QuestionView) {
    await mutate("/api/questions", {
      action: "favorite",
      id: question.id,
      favorite: !question.favorite,
    });
  }
  async function grade(rating: number, answer = "") {
    if (grading.current) return;
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
        window.scrollTo({ top: 0, behavior: "instant" });
      }
    } finally {
      grading.current = false;
      setReviewBusy(false);
    }
  }
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
  const currentQuestion = data.questions.find((q) => q.id === questionId);
  const queueQuestion = queue[reviewIndex];
  const currentReview =
    data.questions.find((q) => q.id === queueQuestion?.id) ?? queueQuestion;
  const nav = [
    { id: "today" as const, label: "今日", icon: LayoutDashboard },
    { id: "library" as const, label: "我的题库", icon: Layers2 },
    {
      id: "review" as const,
      label: "开始复习",
      icon: RotateCcw,
      count: data.stats.due,
    },
    { id: "catalog" as const, label: "发现题库", icon: Rss },
  ];
  return (
    <div className="app-shell">
      {sidebarOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="关闭导航"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className={cn("sidebar", sidebarOpen && "sidebar-open")}>
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
          className="sidebar-search"
          onClick={() => {
            navigate("library");
            setTimeout(
              () =>
                (
                  document.querySelector(
                    "input[aria-label='搜索题目']",
                  ) as HTMLInputElement
                )?.focus(),
              70,
            );
          }}
        >
          <Search size={16} />
          <span>搜索题目</span>
          <kbd>Ctrl K</kbd>
        </button>
        <nav className="primary-nav">
          {nav.map(({ id, label, icon: Icon, count }) => (
            <button
              key={id}
              className={cn(
                "nav-item",
                (view === id || (id === "library" && view === "question")) &&
                  "active",
              )}
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
            { id: "archived" as const, label: "已归档", icon: Archive },
          ].map(({ id, label, icon: Icon }) => (
            <button
              className={cn("nav-item", view === id && "active")}
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
                view === "library" && deckId === d.id && "selected",
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
        <div className="sidebar-bottom">
          <button className="user-button" onClick={() => setSettingsOpen(true)}>
            <span className="user-avatar">
              {data.user.name.slice(0, 1).toUpperCase()}
            </span>
            <span>
              <strong>{data.user.name}</strong>
            </span>
            <Settings2 size={16} />
          </button>
        </div>
      </aside>
      <main className="main-layout">
        <header className="topbar">
          <div>
            <button
              className="icon-button mobile-menu"
              aria-label="打开导航"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={21} />
            </button>
            <span className="topbar-breadcrumb">
              <strong>
                {
                  {
                    today: "今日",
                    library: "我的题库",
                    favorites: "我的收藏",
                    inbox: "待整理",
                    archived: "已归档",
                    review: "答题",
                    catalog: "发现题库",
                    history: "回顾记录",
                    question: "学习卡",
                  }[view]
                }
              </strong>
            </span>
          </div>
          <div className="topbar-actions">
            <span className={`sync-state ${syncError ? "sync-offline" : ""}`}>
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
            <span className="topbar-divider" />
            <span className="topbar-date">
              {new Intl.DateTimeFormat("zh-CN", {
                timeZone: data.settings.timeZone,
                month: "long",
                day: "numeric",
                weekday: "long",
              }).format(new Date())}
            </span>
            <button
              className="icon-button"
              aria-label="设置"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 size={17} />
            </button>
            <button
              className="icon-button logout-button"
              aria-label="退出登录"
              onClick={() => {
                if (confirm("退出当前账号？")) {
                  void authClient.signOut();
                  setView("today");
                }
              }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </header>
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
            onImport={() => setImportOpen(true)}
            onCatalog={() => navigate("catalog")}
            onLibrary={() => navigate("library")}
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
        {["library", "favorites", "inbox", "archived"].includes(view) && (
          <Library
            key={`${view}:${deckId ?? "all"}`}
            data={data}
            deckId={view === "library" ? deckId : undefined}
            filter={view === "library" ? undefined : view}
            onQuestion={openQuestion}
            onDeck={openDeck}
            onImport={() => setImportOpen(true)}
            onCreate={() => setCreateOpen(true)}
            onReview={startReview}
            onPublish={setPublishId}
            onFavorite={(q) => void favorite(q)}
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
        )}
        {view === "question" && currentQuestion && (
          <QuestionReader
            key={`${currentQuestion.id}:${currentQuestion.revision}`}
            question={currentQuestion}
            data={data}
            onBack={() => openDeck(currentQuestion.deckId)}
            onEdit={() => setEditQuestion(currentQuestion)}
            onSettings={() => setSettingsOpen(true)}
            onFavorite={() => void favorite(currentQuestion)}
            mutate={mutate}
            onSingleReview={() => startReview(undefined, currentQuestion)}
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
              onBack={() => navigate("today")}
              onEdit={() => setEditQuestion(currentReview)}
              onSettings={() => setSettingsOpen(true)}
              onFavorite={() => void favorite(currentReview)}
              mutate={mutate}
              progress={{ current: reviewIndex + 1, total: queue.length }}
              onGrade={(rating, answer) => void grade(rating, answer)}
              busy={reviewBusy}
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
      </main>
      <nav className="mobile-bottom-nav">
        {nav.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={view === id ? "active" : ""}
            onClick={() => (id === "review" ? startReview() : navigate(id))}
          >
            <Icon size={20} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        data={data}
        preferredDeck={
          deckId && data.decks.find((d) => d.id === deckId)?.isOwner
            ? deckId
            : undefined
        }
        mutate={mutate}
        onView={openDeck}
      />
      <CreateDeckDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        mutate={mutate}
        onCreated={openDeck}
      />
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        data={data}
        mutate={mutate}
      />
      <EditQuestionDialog
        question={editQuestion}
        onClose={() => setEditQuestion(null)}
        mutate={mutate}
      />
      <PublishDialog
        deck={data.decks.find((d) => d.id === publishId) ?? null}
        onClose={() => setPublishId(null)}
        mutate={mutate}
      />
    </div>
  );
}
