"use client";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowUpRight,
  Bell,
  BellOff,
  BookOpen,
  Check,
  CheckSquare,
  Copy,
  Download,
  Eye,
  FolderOpen,
  Info,
  Layers2,
  Loader2,
  RefreshCw,
  Rss,
  Search,
  Square,
  UserCheck,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type {
  CatalogAuthorView,
  CatalogDeck,
  CatalogDeckPreview,
  RichCatalogResponse,
  Workspace,
} from "@/lib/types";
import {
  applyAllDeckUpdates,
  applyDeckUpdate,
  batchSubscribeDecks,
  fetchCatalogDeckPreview,
  fetchRichCatalog,
  followAuthor,
  setAuthorAutoSubscribe,
  subscribeAllByAuthor,
  unfollowAuthor,
} from "@/lib/client";
import { buildFolderIndex, ROOT_FOLDER_LABEL } from "@/lib/folders";
import type { Mutate } from "./dialogs";
import { FolderSelectOptions } from "./folder-select-options";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { useDiscretePresence } from "./use-discrete-presence";

type CatalogTab = "discover" | "authors" | "subscriptions";
type CatalogSort = "recent" | "popular" | "questions";

function formatShortDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const diffDays = Math.floor((Date.now() - ms) / 86_400_000);
  if (diffDays <= 0) return "今天更新";
  if (diffDays === 1) return "昨天更新";
  if (diffDays < 30) return `${diffDays} 天前`;
  const d = new Date(ms);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function Catalog({
  data,
  mutate,
  initialAuthorId,
  initialSharedDeckId,
  onOpenDeck,
  onMoveSubscription,
  onClearDeepLink,
  onSelectAuthorUrl,
}: {
  data: Workspace;
  mutate: Mutate;
  initialAuthorId?: string | null;
  initialSharedDeckId?: string | null;
  onOpenDeck: (deckId: string) => void;
  onMoveSubscription?: (deck: Workspace["decks"][number]) => void;
  onClearDeepLink?: () => void;
  onSelectAuthorUrl?: (authorId: string | null) => void;
}) {
  const [tab, setTab] = useState<CatalogTab>("discover");
  const [catalogData, setCatalogData] = useState<RichCatalogResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const [sortBy, setSortBy] = useState<CatalogSort>("recent");
  const [onlyUnsubscribed, setOnlyUnsubscribed] = useState(false);
  const [authorFilter, setAuthorFilter] = useState<string | null>(
    initialAuthorId ?? null,
  );
  const [authorTabFilter, setAuthorTabFilter] = useState<"all" | "followed">(
    "all",
  );
  const [batchMode, setBatchMode] = useState(false);
  const batchBarPresence = useDiscretePresence<HTMLDivElement>(batchMode);
  const [batchIds, setBatchIds] = useState<string[]>([]);
  const [batchFolderId, setBatchFolderId] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [updatingAll, setUpdatingAll] = useState(false);

  // Deck Preview modal state
  const [previewDeckId, setPreviewDeckId] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<CatalogDeckPreview | null>(
    null,
  );
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewFolderId, setPreviewFolderId] = useState("");
  const [previewFromDeepLink, setPreviewFromDeepLink] = useState(false);

  const fetchAbortRef = useRef<AbortController | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);

  const folderIndex = useMemo(() => buildFolderIndex(data.decks), [data.decks]);
  const ownPublicDeckCount = useMemo(
    () =>
      data.decks.filter(
        (d) => d.isOwner && d.publishedVersion > 0 && d.visibility === "public",
      ).length,
    [data.decks],
  );
  const workspaceDeckMap = useMemo(
    () => new Map(data.decks.map((d) => [d.id, d])),
    [data.decks],
  );
  const subscribedDecks = useMemo(
    () => data.decks.filter((d) => !d.isOwner),
    [data.decks],
  );
  const outdatedSubs = useMemo(
    () => subscribedDecks.filter((d) => Boolean(d.pendingUpdate)),
    [subscribedDecks],
  );
  const followedAuthors = data.followedAuthors ?? [];
  const followedAuthorMap = useMemo(
    () => new Map(followedAuthors.map((a) => [a.authorId, a])),
    [followedAuthors],
  );

  const loadCatalog = useCallback(
    async (opts?: { silent?: boolean }) => {
      fetchAbortRef.current?.abort();
      const ctrl = new AbortController();
      fetchAbortRef.current = ctrl;
      if (!opts?.silent) setLoading(true);
      try {
        const res = await fetchRichCatalog({
          userId: data.user.id,
          signal: ctrl.signal,
          sharedDeckId: initialSharedDeckId ?? undefined,
          authorId: authorFilter ?? initialAuthorId ?? undefined,
        });
        if (!ctrl.signal.aborted) {
          setCatalogData(res);
        }
      } catch (err) {
        if (ctrl.signal.aborted) return;
        toast.error(err instanceof Error ? err.message : "发现资料加载失败。");
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    },
    [data.user.id, initialSharedDeckId, initialAuthorId, authorFilter],
  );

  useEffect(() => {
    void loadCatalog();
    return () => {
      fetchAbortRef.current?.abort();
    };
  }, [loadCatalog]);

  useEffect(() => {
    if (initialAuthorId) {
      setAuthorFilter(initialAuthorId);
      setTab("discover");
    }
  }, [initialAuthorId]);

  const openPreview = useCallback(
    async (deckId: string, fromDeepLink = false) => {
      previewAbortRef.current?.abort();
      const ctrl = new AbortController();
      previewAbortRef.current = ctrl;
      setPreviewDeckId(deckId);
      setPreviewFromDeepLink(fromDeepLink);
      setPreviewData(null);
      setPreviewError("");
      setPreviewFolderId("");
      setPreviewLoading(true);
      try {
        const res = await fetchCatalogDeckPreview(deckId, {
          userId: data.user.id,
          signal: ctrl.signal,
        });
        if (!ctrl.signal.aborted) setPreviewData(res);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setPreviewError(
          err instanceof Error ? err.message : "无法加载该资料预览。",
        );
      } finally {
        if (!ctrl.signal.aborted) setPreviewLoading(false);
      }
    },
    [data.user.id],
  );

  useEffect(() => {
    if (initialSharedDeckId) {
      void openPreview(initialSharedDeckId, true);
    }
  }, [initialSharedDeckId, openPreview]);

  useEffect(() => {
    return () => {
      previewAbortRef.current?.abort();
    };
  }, []);

  function closePreview() {
    previewAbortRef.current?.abort();
    const wasDeepLink = previewFromDeepLink;
    setPreviewDeckId(null);
    setPreviewData(null);
    setPreviewError("");
    setPreviewFromDeepLink(false);
    if (wasDeepLink) onClearDeepLink?.();
  }

  // Merge live workspace subscription & follow state into catalog decks & authors for instant reactivity.
  const enrichedDecks: CatalogDeck[] = useMemo(() => {
    const raw = catalogData?.decks ?? [];
    return raw.map((d) => {
      const wsDeck = workspaceDeckMap.get(d.id);
      const subscribed = wsDeck ? !wsDeck.isOwner : d.subscribed;
      const syncedVersion =
        wsDeck && !wsDeck.isOwner
          ? (wsDeck.syncedVersion ?? wsDeck.seenVersion)
          : d.syncedVersion;
      const hasUpdate = Boolean(
        subscribed &&
        syncedVersion !== null &&
        d.publishedVersion > syncedVersion,
      );
      return {
        ...d,
        subscribed,
        syncedVersion,
        hasUpdate,
        authorFollowed: followedAuthorMap.has(d.ownerId),
      };
    });
  }, [catalogData?.decks, workspaceDeckMap, followedAuthorMap]);

  const enrichedAuthors: CatalogAuthorView[] = useMemo(() => {
    const raw = catalogData?.authors ?? [];
    return raw.map((a) => {
      const follow = followedAuthorMap.get(a.id);
      const decksWithLive = a.decks.map((d) => {
        const wsDeck = workspaceDeckMap.get(d.id);
        return {
          ...d,
          subscribed: wsDeck ? !wsDeck.isOwner : d.subscribed,
        };
      });
      const subscribedDeckCount = decksWithLive.filter(
        (d) => d.subscribed,
      ).length;
      return {
        ...a,
        followed: Boolean(follow),
        autoSubscribeNew: Boolean(follow?.autoSubscribeNew),
        subscribedDeckCount,
        unsubscribedDeckCount: a.isSelf
          ? 0
          : Math.max(0, decksWithLive.length - subscribedDeckCount),
        decks: decksWithLive,
      };
    });
  }, [catalogData?.authors, followedAuthorMap, workspaceDeckMap]);

  const focusedAuthor = useMemo(() => {
    if (!authorFilter) return null;
    return (
      enrichedAuthors.find((a) => a.id === authorFilter) ??
      catalogData?.focusedAuthor ??
      null
    );
  }, [authorFilter, enrichedAuthors, catalogData?.focusedAuthor]);

  const visibleDecks = useMemo(() => {
    const list = enrichedDecks.filter((d) => {
      if (authorFilter && d.ownerId !== authorFilter) return false;
      if (onlyUnsubscribed && (d.subscribed || d.isOwner)) return false;
      if (!deferredSearch) return true;
      const haystack =
        `${d.title} ${d.description} ${d.ownerName} ${d.tags.map((t) => `${t} #${t}`).join(" ")}`.toLowerCase();
      return haystack.includes(deferredSearch);
    });
    const sorted = [...list];
    if (sortBy === "popular") {
      sorted.sort(
        (a, b) =>
          b.subscriberCount - a.subscriberCount ||
          Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
      );
    } else if (sortBy === "questions") {
      sorted.sort(
        (a, b) =>
          b.count - a.count ||
          Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
      );
    } else {
      sorted.sort(
        (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
      );
    }
    return sorted;
  }, [enrichedDecks, authorFilter, onlyUnsubscribed, deferredSearch, sortBy]);

  const subscribableVisibleIds = useMemo(
    () =>
      visibleDecks.filter((d) => !d.isOwner && !d.subscribed).map((d) => d.id),
    [visibleDecks],
  );
  const subscribableSet = useMemo(
    () => new Set(subscribableVisibleIds),
    [subscribableVisibleIds],
  );
  const activeBatchIds = useMemo(
    () => batchIds.filter((id) => subscribableSet.has(id)),
    [batchIds, subscribableSet],
  );
  const activeBatchSet = useMemo(
    () => new Set(activeBatchIds),
    [activeBatchIds],
  );

  const visibleAuthors = useMemo(() => {
    if (authorTabFilter === "followed") {
      return enrichedAuthors.filter((a) => a.followed);
    }
    return enrichedAuthors;
  }, [enrichedAuthors, authorTabFilter]);

  function focusAuthor(authorId: string | null) {
    setAuthorFilter(authorId);
    if (authorId) setTab("discover");
    onSelectAuthorUrl?.(authorId);
  }

  function copyAuthorLink(authorId: string) {
    const share = new URL("/", window.location.origin);
    share.searchParams.set("view", "catalog");
    share.searchParams.set("author", authorId);
    void navigator.clipboard
      .writeText(share.href)
      .then(() => toast.success("创作者主页链接已复制。"));
  }

  function toggleBatchDeck(id: string) {
    setBatchIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  }

  async function handleSubscribeSingle(
    deckId: string,
    folderId = "",
    openAfter = false,
  ) {
    if (busyKey) return;
    setBusyKey(`sub:${deckId}`);
    try {
      const res = await mutate("/api/decks", {
        action: "subscribe",
        deckId,
        folderId: folderId || null,
      });
      if (res) {
        toast.success("订阅成功；作者发布新版本时你可以自行选择是否更新。");
        void loadCatalog({ silent: true });
        if (openAfter) {
          closePreview();
          onOpenDeck(deckId);
        }
      }
    } finally {
      setBusyKey(null);
    }
  }

  async function handleBatchSubscribe() {
    if (!activeBatchIds.length || busyKey) return;
    setBusyKey("batch-sub");
    try {
      const res = await batchSubscribeDecks(
        mutate,
        activeBatchIds,
        batchFolderId || null,
      );
      if (res) {
        const added = Number(res.subscribed ?? activeBatchIds.length);
        const targetLabel = batchFolderId
          ? folderIndex.pathOf(batchFolderId)
          : ROOT_FOLDER_LABEL;
        toast.success(`已批量订阅 ${added} 份资料并放入「${targetLabel}」。`);
        setBatchIds([]);
        setBatchFolderId("");
        setBatchMode(false);
        void loadCatalog({ silent: true });
      }
    } finally {
      setBusyKey(null);
    }
  }

  async function handleApplyUpdate(deckId: string, version: number) {
    if (busyKey) return;
    setBusyKey(`upd:${deckId}`);
    try {
      const res = await applyDeckUpdate(mutate, deckId, version);
      if (res) {
        toast.success(`已更新到 v${version}，个人笔记与复习进度已保留。`);
        void loadCatalog({ silent: true });
      }
    } finally {
      setBusyKey(null);
    }
  }

  async function handleApplyAllUpdates() {
    if (!outdatedSubs.length || updatingAll) return;
    setUpdatingAll(true);
    try {
      const res = await applyAllDeckUpdates(mutate);
      if (res) {
        toast.success(
          `已更新 ${Number(res.updated ?? outdatedSubs.length)} 份订阅资料。`,
        );
        void loadCatalog({ silent: true });
      }
    } finally {
      setUpdatingAll(false);
    }
  }

  async function handleUnsubscribe(deckId: string, title: string) {
    if (busyKey) return;
    setBusyKey(`unsub:${deckId}`);
    try {
      const res = await mutate("/api/decks", {
        action: "unsubscribe",
        deckId,
      });
      if (res) {
        toast.success(`已取消订阅「${title}」，个人笔记与复习记录仍会保留。`);
        void loadCatalog({ silent: true });
      }
    } finally {
      setBusyKey(null);
    }
  }

  async function handleToggleFollow(author: {
    id: string;
    name: string;
    followed: boolean;
  }) {
    if (busyKey) return;
    setBusyKey(`follow:${author.id}`);
    try {
      if (author.followed) {
        const res = await unfollowAuthor(mutate, author.id, false);
        if (res) {
          toast.success(
            `已取消关注「${author.name}」（已订阅的资料保持不变）。`,
          );
          void loadCatalog({ silent: true });
        }
      } else {
        const res = await followAuthor(mutate, {
          authorId: author.id,
          autoSubscribeNew: false,
          subscribeAll: false,
        });
        if (res) {
          toast.success(`已关注创作者「${author.name}」。`);
          void loadCatalog({ silent: true });
        }
      }
    } finally {
      setBusyKey(null);
    }
  }

  async function handleToggleAutoSubscribe(authorId: string, next: boolean) {
    if (busyKey) return;
    setBusyKey(`auto:${authorId}`);
    try {
      const res = await setAuthorAutoSubscribe(mutate, authorId, next);
      if (res) {
        toast.success(
          next
            ? "已开启：该创作者发布新公开资料时将自动订阅。"
            : "已关闭新资料自动订阅。",
        );
        void loadCatalog({ silent: true });
      }
    } finally {
      setBusyKey(null);
    }
  }

  async function handleSubscribeAllByAuthor(
    authorId: string,
    authorName: string,
  ) {
    if (busyKey) return;
    setBusyKey(`suball:${authorId}`);
    try {
      const res = await subscribeAllByAuthor(mutate, authorId);
      if (res) {
        const count = Number(res.subscribed ?? 0);
        toast.success(
          count > 0
            ? `已一键订阅「${authorName}」的 ${count} 份公开资料。`
            : `你已订阅「${authorName}」的全部公开资料。`,
        );
        void loadCatalog({ silent: true });
      }
    } finally {
      setBusyKey(null);
    }
  }

  const previewLiveDeck = useMemo(() => {
    if (!previewData) return null;
    const d = previewData.deck;
    const wsDeck = workspaceDeckMap.get(d.id);
    const subscribed = wsDeck ? !wsDeck.isOwner : d.subscribed;
    const syncedVersion =
      wsDeck && !wsDeck.isOwner
        ? (wsDeck.syncedVersion ?? wsDeck.seenVersion)
        : d.syncedVersion;
    return {
      ...d,
      subscribed,
      syncedVersion,
      hasUpdate: Boolean(
        subscribed &&
        syncedVersion !== null &&
        d.publishedVersion > syncedVersion,
      ),
      authorFollowed: followedAuthorMap.has(d.ownerId),
    };
  }, [previewData, workspaceDeckMap, followedAuthorMap]);

  return (
    <div className="page catalog-page">
      <div className="page-heading">
        <div>
          <h1>
            发现资料
            <span className="greeting-sprout">
              <Rss size={25} />
            </span>
          </h1>
        </div>
        <div className="heading-actions">
          {ownPublicDeckCount > 0 && (
            <Button
              variant="outline"
              onClick={() => copyAuthorLink(data.user.id)}
            >
              <Copy size={14} /> 分享我的主页
            </Button>
          )}
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => void loadCatalog()}
          >
            <RefreshCw size={14} className={loading ? "spin" : undefined} />{" "}
            刷新
          </Button>
        </div>
      </div>

      <div className="catalog-tabs" role="tablist" aria-label="发现与订阅分类">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "discover"}
          onClick={() => setTab("discover")}
        >
          公开资料
          {enrichedDecks.length > 0 && <small>{enrichedDecks.length}</small>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "authors"}
          onClick={() => setTab("authors")}
        >
          创作者
          {enrichedAuthors.length > 0 && (
            <small>{enrichedAuthors.length}</small>
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "subscriptions"}
          onClick={() => setTab("subscriptions")}
        >
          我的订阅
          <small>
            {subscribedDecks.length}
            {outdatedSubs.length > 0 ? ` · ${outdatedSubs.length} 更新` : ""}
          </small>
        </button>
      </div>

      {loading && !catalogData && (
        <div className="catalog-loading">
          <Loader2 size={16} className="spin" /> 正在加载公开资料与创作者…
        </div>
      )}

      {tab === "discover" && (
        <>
          {focusedAuthor && (
            <div className="catalog-author-filter-banner">
              <div className="catalog-author-head">
                <span className="catalog-author-avatar">
                  {focusedAuthor.name.slice(0, 1)}
                </span>
                <div className="catalog-author-meta">
                  <strong>
                    {focusedAuthor.name}
                    {focusedAuthor.isSelf ? "（我）" : ""}
                  </strong>
                  <small>
                    {focusedAuthor.deckCount} 份公开资料 ·{" "}
                    {focusedAuthor.questionCount} 道题 ·{" "}
                    {focusedAuthor.subscriberCount} 人次订阅 ·{" "}
                    {focusedAuthor.followerCount} 人关注
                  </small>
                </div>
              </div>
              <div className="catalog-author-actions">
                {!focusedAuthor.isSelf && (
                  <>
                    <Button
                      size="sm"
                      variant={focusedAuthor.followed ? "outline" : "default"}
                      disabled={busyKey === `follow:${focusedAuthor.id}`}
                      onClick={() => void handleToggleFollow(focusedAuthor)}
                    >
                      {focusedAuthor.followed ? (
                        <>
                          <UserCheck size={14} /> 已关注
                        </>
                      ) : (
                        <>
                          <UserPlus size={14} /> 关注作者
                        </>
                      )}
                    </Button>
                    {focusedAuthor.followed && (
                      <button
                        type="button"
                        className={`catalog-filter-toggle ${focusedAuthor.autoSubscribeNew ? "is-active" : ""}`}
                        aria-pressed={focusedAuthor.autoSubscribeNew}
                        disabled={busyKey === `auto:${focusedAuthor.id}`}
                        onClick={() =>
                          void handleToggleAutoSubscribe(
                            focusedAuthor.id,
                            !focusedAuthor.autoSubscribeNew,
                          )
                        }
                      >
                        {focusedAuthor.autoSubscribeNew ? (
                          <Bell size={13} />
                        ) : (
                          <BellOff size={13} />
                        )}
                        <span>自动订阅新资料</span>
                      </button>
                    )}
                    {focusedAuthor.unsubscribedDeckCount > 0 && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyKey === `suball:${focusedAuthor.id}`}
                        onClick={() =>
                          void handleSubscribeAllByAuthor(
                            focusedAuthor.id,
                            focusedAuthor.name,
                          )
                        }
                      >
                        <Download size={14} /> 一键订阅全部 (
                        {focusedAuthor.unsubscribedDeckCount})
                      </Button>
                    )}
                  </>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => copyAuthorLink(focusedAuthor.id)}
                >
                  <Copy size={13} /> 复制主页链接
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => focusAuthor(null)}
                >
                  <X size={13} /> 查看全部创作者
                </Button>
              </div>
            </div>
          )}

          <div className="catalog-toolbar">
            <div className={`search-field ${search ? "has-query" : ""}`}>
              <Search size={17} />
              <input
                aria-label="搜索公开资料"
                placeholder="搜索资料名称、简介、创作者或 #标签…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button
                  type="button"
                  className="search-clear"
                  aria-label="清空搜索"
                  onClick={() => setSearch("")}
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <select
              aria-label="排序方式"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as CatalogSort)}
            >
              <option value="recent">最近更新</option>
              <option value="popular">最多订阅</option>
              <option value="questions">题目最多</option>
            </select>
            <button
              type="button"
              className={`catalog-filter-toggle ${onlyUnsubscribed ? "is-active" : ""}`}
              aria-pressed={onlyUnsubscribed}
              onClick={() => setOnlyUnsubscribed((v) => !v)}
            >
              仅看未订阅
            </button>
            <button
              type="button"
              className={`catalog-filter-toggle ${batchMode ? "is-active" : ""}`}
              aria-pressed={batchMode}
              disabled={!batchMode && subscribableVisibleIds.length === 0}
              onClick={() => {
                if (batchMode) {
                  setBatchMode(false);
                  setBatchIds([]);
                } else {
                  setBatchMode(true);
                }
              }}
            >
              <CheckSquare size={14} />
              <span>{batchMode ? "退出批量" : "批量订阅"}</span>
            </button>
          </div>

          {visibleDecks.length ? (
            <div className="catalog-grid">
              {visibleDecks.map((deck) => {
                const canBatchSelect = !deck.isOwner && !deck.subscribed;
                const selected = canBatchSelect && activeBatchSet.has(deck.id);
                return (
                  <article
                    key={deck.id}
                    className={`catalog-deck-card color-${deck.color} ${selected ? "is-selected" : ""}`}
                  >
                    <div className="catalog-deck-top">
                      <span className="deck-icon">
                        <BookOpen size={22} />
                      </span>
                      {batchMode && canBatchSelect ? (
                        <button
                          type="button"
                          className={`catalog-deck-select ${selected ? "is-checked" : ""}`}
                          aria-label={
                            selected
                              ? `取消选择：${deck.title}`
                              : `选择订阅：${deck.title}`
                          }
                          aria-pressed={selected}
                          onClick={() => toggleBatchDeck(deck.id)}
                        >
                          {selected ? (
                            <CheckSquare size={17} />
                          ) : (
                            <Square size={17} />
                          )}
                        </button>
                      ) : deck.hasUpdate ? (
                        <span className="deck-status-pill is-update">
                          有更新 v{deck.publishedVersion}
                        </span>
                      ) : (
                        <span className="deck-status-pill">
                          v{deck.publishedVersion}
                        </span>
                      )}
                    </div>
                    <h2 className="catalog-deck-title">{deck.title}</h2>
                    {deck.description && (
                      <p className="catalog-deck-desc">{deck.description}</p>
                    )}
                    {deck.tags.length > 0 && (
                      <div className="catalog-deck-tags" aria-label="资料标签">
                        {deck.tags.slice(0, 4).map((tag) => (
                          <span className="tag" key={tag}>
                            #{tag}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="catalog-deck-stats">
                      <span>{deck.count} 题</span>
                      {deck.groupCount > 0 && (
                        <span>· {deck.groupCount} 个子文件夹</span>
                      )}
                      <span>· {deck.subscriberCount} 人订阅</span>
                      {deck.publishedAt && (
                        <span>· {formatShortDate(deck.publishedAt)}</span>
                      )}
                    </div>
                    <button
                      type="button"
                      className="catalog-deck-author-row"
                      onClick={() => focusAuthor(deck.ownerId)}
                      title={`查看「${deck.ownerName}」的全部公开资料`}
                    >
                      <span
                        className="catalog-author-avatar"
                        style={{ width: 22, height: 22, fontSize: "0.7rem" }}
                      >
                        {deck.ownerName.slice(0, 1)}
                      </span>
                      <span>{deck.ownerName}</span>
                      {deck.authorFollowed && (
                        <span className="deck-status-pill is-update">
                          已关注
                        </span>
                      )}
                    </button>
                    <div className="catalog-deck-actions">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void openPreview(deck.id)}
                      >
                        <Eye size={14} /> 预览
                      </Button>
                      {deck.isOwner ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onOpenDeck(deck.id)}
                        >
                          查看我的资料 <ArrowUpRight size={14} />
                        </Button>
                      ) : deck.subscribed && deck.hasUpdate ? (
                        <Button
                          size="sm"
                          disabled={busyKey === `upd:${deck.id}`}
                          onClick={() =>
                            void handleApplyUpdate(
                              deck.id,
                              deck.publishedVersion,
                            )
                          }
                        >
                          {busyKey === `upd:${deck.id}` ? (
                            <Loader2 size={14} className="spin" />
                          ) : (
                            <Download size={14} />
                          )}{" "}
                          更新至 v{deck.publishedVersion}
                        </Button>
                      ) : deck.subscribed ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onOpenDeck(deck.id)}
                        >
                          打开学习 <ArrowUpRight size={14} />
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          disabled={busyKey === `sub:${deck.id}`}
                          onClick={() => void handleSubscribeSingle(deck.id)}
                        >
                          {busyKey === `sub:${deck.id}` ? (
                            <Loader2 size={14} className="spin" />
                          ) : (
                            <Rss size={14} />
                          )}{" "}
                          订阅
                        </Button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            !loading && (
              <div className="empty-state catalog-empty">
                <Rss size={38} />
                <h3>
                  {search || authorFilter || onlyUnsubscribed
                    ? "没有匹配的公开资料"
                    : "还没有公开资料"}
                </h3>
                <p>
                  {search || authorFilter || onlyUnsubscribed
                    ? "试试调整搜索关键词、取消筛选或切换创作者。"
                    : "在我的资料中点击「批量发布」或单文件夹发布，即可共享给同伴订阅。"}
                </p>
                {(search || authorFilter || onlyUnsubscribed) && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSearch("");
                      setOnlyUnsubscribed(false);
                      focusAuthor(null);
                    }}
                  >
                    清除筛选
                  </Button>
                )}
              </div>
            )
          )}

          <div
            ref={batchBarPresence.ref}
            hidden={batchBarPresence.isHidden}
            data-closing={batchBarPresence.isClosing ? "" : undefined}
            aria-hidden={!batchMode}
            inert={!batchMode || batchBarPresence.isClosing}
            className="catalog-batch-bar"
            role="region"
            aria-label="批量订阅操作栏"
          >
            <div className="batch-bar-meta">
              <strong>
                已选 {activeBatchIds.length} / {subscribableVisibleIds.length}
              </strong>
              <button
                type="button"
                className="text-button"
                disabled={
                  busyKey !== null || subscribableVisibleIds.length === 0
                }
                onClick={() =>
                  setBatchIds(
                    activeBatchIds.length === subscribableVisibleIds.length
                      ? []
                      : subscribableVisibleIds,
                  )
                }
              >
                {activeBatchIds.length === subscribableVisibleIds.length
                  ? "清空"
                  : "全选"}
              </button>
            </div>
            <div className="batch-bar-actions">
              <select
                aria-label="批量订阅目标文件夹"
                value={batchFolderId}
                onChange={(e) => setBatchFolderId(e.target.value)}
                disabled={busyKey === "batch-sub"}
              >
                <FolderSelectOptions
                  decks={data.decks}
                  includeRoot
                  rootLabel={`放到：${ROOT_FOLDER_LABEL}`}
                />
              </select>
              <Button
                size="sm"
                disabled={
                  busyKey === "batch-sub" || activeBatchIds.length === 0
                }
                onClick={() => void handleBatchSubscribe()}
              >
                {busyKey === "batch-sub" ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <Download size={14} />
                )}{" "}
                批量订阅 ({activeBatchIds.length})
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busyKey === "batch-sub"}
                onClick={() => {
                  setBatchMode(false);
                  setBatchIds([]);
                }}
              >
                取消
              </Button>
            </div>
          </div>
        </>
      )}

      {tab === "authors" && (
        <>
          <div className="deck-group-bar" role="group" aria-label="筛选创作者">
            <button
              type="button"
              className={`deck-group-pill ${authorTabFilter === "all" ? "is-active" : ""}`}
              aria-pressed={authorTabFilter === "all"}
              onClick={() => setAuthorTabFilter("all")}
            >
              全部创作者 <small>{enrichedAuthors.length}</small>
            </button>
            <button
              type="button"
              className={`deck-group-pill ${authorTabFilter === "followed" ? "is-active" : ""}`}
              aria-pressed={authorTabFilter === "followed"}
              onClick={() => setAuthorTabFilter("followed")}
            >
              我关注的{" "}
              <small>{enrichedAuthors.filter((a) => a.followed).length}</small>
            </button>
          </div>
          {visibleAuthors.length ? (
            <div className="catalog-authors-grid">
              {visibleAuthors.map((author) => (
                <article key={author.id} className="catalog-author-card">
                  <div className="catalog-author-head">
                    <span className="catalog-author-avatar">
                      {author.name.slice(0, 1)}
                    </span>
                    <div className="catalog-author-meta">
                      <strong>
                        {author.name}
                        {author.isSelf ? "（我）" : ""}
                      </strong>
                      <small>
                        {author.deckCount} 份公开资料 · {author.questionCount} 道题
                        · {author.subscriberCount} 人次订阅 ·{" "}
                        {author.followerCount} 人关注
                      </small>
                    </div>
                  </div>
                  <div className="catalog-author-decks">
                    {author.decks.slice(0, 5).map((d) => (
                      <button
                        type="button"
                        key={d.id}
                        className={`deck-group-pill color-${d.color} ${d.subscribed ? "is-active" : ""}`}
                        onClick={() => void openPreview(d.id)}
                        title={`预览「${d.title}」`}
                      >
                        <span>{d.title}</span>
                        <small>{d.count}题</small>
                      </button>
                    ))}
                    {author.decks.length > 5 && (
                      <button
                        type="button"
                        className="deck-group-pill"
                        onClick={() => focusAuthor(author.id)}
                      >
                        +{author.decks.length - 5} 更多
                      </button>
                    )}
                  </div>
                  <div className="catalog-author-actions">
                    {!author.isSelf && (
                      <>
                        <Button
                          size="sm"
                          variant={author.followed ? "outline" : "default"}
                          disabled={busyKey === `follow:${author.id}`}
                          onClick={() => void handleToggleFollow(author)}
                        >
                          {author.followed ? (
                            <>
                              <UserCheck size={14} /> 已关注
                            </>
                          ) : (
                            <>
                              <UserPlus size={14} /> 关注作者
                            </>
                          )}
                        </Button>
                        {author.followed && (
                          <button
                            type="button"
                            className={`catalog-filter-toggle ${author.autoSubscribeNew ? "is-active" : ""}`}
                            aria-pressed={author.autoSubscribeNew}
                            disabled={busyKey === `auto:${author.id}`}
                            onClick={() =>
                              void handleToggleAutoSubscribe(
                                author.id,
                                !author.autoSubscribeNew,
                              )
                            }
                          >
                            {author.autoSubscribeNew ? (
                              <Bell size={13} />
                            ) : (
                              <BellOff size={13} />
                            )}
                            <span>新资料自动订阅</span>
                          </button>
                        )}
                        {author.unsubscribedDeckCount > 0 && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busyKey === `suball:${author.id}`}
                            onClick={() =>
                              void handleSubscribeAllByAuthor(
                                author.id,
                                author.name,
                              )
                            }
                          >
                            <Download size={14} /> 一键订阅全部 (
                            {author.unsubscribedDeckCount})
                          </Button>
                        )}
                      </>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => focusAuthor(author.id)}
                    >
                      查看资料
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => copyAuthorLink(author.id)}
                    >
                      <Copy size={13} /> 复制主页链接
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            !loading && (
              <div className="empty-state catalog-empty">
                <Users size={36} />
                <h3>
                  {authorTabFilter === "followed"
                    ? "还没有关注的创作者"
                    : "暂无公开创作者"}
                </h3>
                <p>
                  {authorTabFilter === "followed"
                    ? "在创作者列表中点击「关注作者」，即可跟踪其公开资料并可选自动订阅新资料。"
                    : "发布一个公开文件夹后，创作者主页会自动出现在这里。"}
                </p>
              </div>
            )
          )}
        </>
      )}

      {tab === "subscriptions" && (
        <div className="catalog-subs-section">
          {outdatedSubs.length > 0 && (
            <div className="library-updates-bar">
              <div>
                <strong>{outdatedSubs.length} 份订阅资料</strong>
                <span>有新版本可更新</span>
              </div>
              <Button
                size="sm"
                disabled={updatingAll}
                onClick={() => void handleApplyAllUpdates()}
              >
                {updatingAll ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <Download size={14} />
                )}{" "}
                一键更新全部 ({outdatedSubs.length})
              </Button>
            </div>
          )}

          {followedAuthors.length > 0 && (
            <section
              style={{ display: "flex", flexDirection: "column", gap: 8 }}
            >
              <div className="deck-group-heading-main">
                <strong style={{ fontSize: "0.84rem", color: "var(--text)" }}>
                  我关注的创作者
                </strong>
                <span className="deck-group-count">
                  {followedAuthors.length} 位
                </span>
              </div>
              <div className="catalog-followed-strip">
                {followedAuthors.map((author) => (
                  <div
                    className="catalog-sub-row"
                    style={{ flex: "1 1 360px" }}
                    key={author.authorId}
                  >
                    <div className="catalog-author-head">
                      <span className="catalog-author-avatar">
                        {author.authorName.slice(0, 1)}
                      </span>
                      <div className="catalog-author-meta">
                        <strong>{author.authorName}</strong>
                        <small>
                          {author.publicDeckCount} 份公开资料 · 已订阅{" "}
                          {author.subscribedDeckCount} 份
                        </small>
                      </div>
                    </div>
                    <div className="catalog-author-actions">
                      <button
                        type="button"
                        className={`catalog-filter-toggle ${author.autoSubscribeNew ? "is-active" : ""}`}
                        aria-pressed={author.autoSubscribeNew}
                        disabled={busyKey === `auto:${author.authorId}`}
                        onClick={() =>
                          void handleToggleAutoSubscribe(
                            author.authorId,
                            !author.autoSubscribeNew,
                          )
                        }
                      >
                        {author.autoSubscribeNew ? (
                          <Bell size={13} />
                        ) : (
                          <BellOff size={13} />
                        )}
                        <span>自动订阅新资料</span>
                      </button>
                      {author.unsubscribedDeckCount > 0 && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyKey === `suball:${author.authorId}`}
                          onClick={() =>
                            void handleSubscribeAllByAuthor(
                              author.authorId,
                              author.authorName,
                            )
                          }
                        >
                          一键补订新资料 ({author.unsubscribedDeckCount})
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => focusAuthor(author.authorId)}
                      >
                        查看主页
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="danger-text"
                        disabled={busyKey === `follow:${author.authorId}`}
                        onClick={() =>
                          void handleToggleFollow({
                            id: author.authorId,
                            name: author.authorName,
                            followed: true,
                          })
                        }
                      >
                        取消关注
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {subscribedDecks.length ? (
            <div className="catalog-sub-list">
              {subscribedDecks.map((deck) => {
                const pinnedVer = deck.syncedVersion ?? deck.seenVersion;
                const upd = deck.pendingUpdate;
                return (
                  <div
                    key={deck.id}
                    className={`catalog-sub-row color-${deck.color}`}
                  >
                    <div className="deck-organizer-deck-info">
                      <span
                        aria-hidden="true"
                        style={{
                          width: 9,
                          height: 9,
                          borderRadius: "50%",
                          background: "var(--deck-accent)",
                          flexShrink: 0,
                        }}
                      />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            flexWrap: "wrap",
                            gap: "4px 8px",
                          }}
                        >
                          <strong style={{ fontSize: "0.9rem" }}>
                            {deck.title}
                          </strong>
                          <span className="deck-status-pill">v{pinnedVer}</span>
                          {deck.parentId && (
                            <span className="deck-group-badge">
                              {folderIndex.pathOf(deck.parentId)}
                            </span>
                          )}
                          {deck.sourceDeleted && (
                            <span className="deck-status-pill is-unpublished">
                              源已停止更新
                            </span>
                          )}
                        </div>
                        <p
                          style={{
                            margin: "2px 0 0",
                            fontSize: "0.78rem",
                            color: "var(--muted)",
                          }}
                        >
                          {deck.ownerName} · {deck.count} 道题
                          {deck.due > 0 ? ` · ${deck.due} 待复习` : ""}
                        </p>
                        {upd && (
                          <div
                            className="update-diff-pills"
                            style={{ marginTop: 6 }}
                          >
                            <span className="deck-status-pill is-update">
                              v{upd.fromVersion} → v{upd.toVersion}
                            </span>
                            {upd.added > 0 && (
                              <span className="update-diff-pill is-added">
                                +{upd.added} 新增
                              </span>
                            )}
                            {upd.updated > 0 && (
                              <span className="update-diff-pill is-updated">
                                ~{upd.updated} 修改
                              </span>
                            )}
                            {upd.removed > 0 && (
                              <span className="update-diff-pill is-removed">
                                -{upd.removed} 移除
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="catalog-author-actions">
                      {upd && (
                        <Button
                          size="sm"
                          disabled={busyKey === `upd:${deck.id}`}
                          onClick={() =>
                            void handleApplyUpdate(deck.id, upd.toVersion)
                          }
                        >
                          {busyKey === `upd:${deck.id}` ? (
                            <Loader2 size={14} className="spin" />
                          ) : (
                            <Download size={14} />
                          )}{" "}
                          立即更新
                        </Button>
                      )}
                      {onMoveSubscription && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onMoveSubscription(deck)}
                        >
                          <FolderOpen size={14} />{" "}
                          {deck.parentId
                            ? folderIndex.pathOf(deck.parentId)
                            : "移动到文件夹"}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onOpenDeck(deck.id)}
                      >
                        打开 <ArrowUpRight size={14} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="danger-text"
                        disabled={busyKey === `unsub:${deck.id}`}
                        onClick={() =>
                          void handleUnsubscribe(deck.id, deck.title)
                        }
                      >
                        取消订阅
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-state catalog-empty">
              <Layers2 size={36} />
              <h3>还没有订阅任何资料</h3>
              <p>去「发现资料」或「创作者」预览并一键订阅感兴趣的公开资料吧。</p>
              <Button variant="outline" onClick={() => setTab("discover")}>
                去发现资料
              </Button>
            </div>
          )}
        </div>
      )}

      <Dialog
        open={previewDeckId !== null}
        onOpenChange={(next) => {
          if (!next && !busyKey) closePreview();
        }}
        title={previewLiveDeck?.title ?? "资料预览"}
        description={
          previewLiveDeck
            ? `${previewLiveDeck.ownerName} · v${previewLiveDeck.publishedVersion} · ${previewData?.totalQuestions ?? previewLiveDeck.count} 道题`
            : "查看资料目录与内容概览后再决定是否订阅"
        }
        className="catalog-preview-dialog"
      >
        <div className="dialog-form">
          {previewLoading ? (
            <div className="catalog-loading">
              <Loader2 size={16} className="spin" /> 正在加载资料目录…
            </div>
          ) : previewError ? (
            <p className="muted">{previewError}</p>
          ) : previewData && previewLiveDeck ? (
            <>
              {previewLiveDeck.description && (
                <p
                  style={{
                    margin: 0,
                    fontSize: "0.86rem",
                    color: "var(--subtle)",
                  }}
                >
                  {previewLiveDeck.description}
                </p>
              )}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: 8,
                }}
              >
                <div className="catalog-deck-stats">
                  <span>{previewData.totalQuestions} 道题</span>
                  {previewData.groups.length > 0 && (
                    <span>· {previewData.groups.length} 个子文件夹</span>
                  )}
                  <span>· {previewLiveDeck.subscriberCount} 人订阅</span>
                </div>
                {!previewLiveDeck.isOwner && (
                  <Button
                    size="sm"
                    variant={
                      previewLiveDeck.authorFollowed ? "outline" : "ghost"
                    }
                    disabled={busyKey === `follow:${previewLiveDeck.ownerId}`}
                    onClick={() =>
                      void handleToggleFollow({
                        id: previewLiveDeck.ownerId,
                        name: previewLiveDeck.ownerName,
                        followed: previewLiveDeck.authorFollowed,
                      })
                    }
                  >
                    {previewLiveDeck.authorFollowed ? (
                      <>
                        <UserCheck size={14} /> 已关注{" "}
                        {previewLiveDeck.ownerName}
                      </>
                    ) : (
                      <>
                        <UserPlus size={14} /> 关注 {previewLiveDeck.ownerName}
                      </>
                    )}
                  </Button>
                )}
              </div>
              {previewLiveDeck.releaseSummary && (
                <div className="publish-notice">
                  <Rss size={16} />
                  <p>
                    v{previewLiveDeck.publishedVersion} 更新说明：
                    {previewLiveDeck.releaseSummary}
                  </p>
                </div>
              )}
              {!previewLiveDeck.isOwner &&
                (previewData.overlaps?.length ?? 0) > 0 && (
                  <div
                    className="conflict-box catalog-overlap-notice"
                    role="note"
                  >
                    <div className="conflict-box-head">
                      <Info size={15} />
                      <strong>与已有订阅存在内容重叠</strong>
                    </div>
                    {previewData.overlaps!.map((item) => (
                      <p
                        className="muted small"
                        key={item.deckId}
                        style={{ margin: 0 }}
                      >
                        {item.relation === "ancestor"
                          ? `你已订阅该作者的「${item.title}」（包含此目录内容），同时订阅会各自独立记录复习进度。`
                          : item.relation === "descendant"
                            ? `你已订阅该作者的子目录「${item.title}」（被此目录包含），同时订阅会各自独立记录复习进度。`
                            : `你已订阅该作者的「${item.title}」（与本目录有 ${item.overlapCount} 道重合题目），同时订阅会各自独立记录复习进度。`}
                      </p>
                    ))}
                  </div>
                )}
              {previewData.groups.length > 0 && (
                <div>
                  <strong
                    style={{
                      display: "block",
                      fontSize: "0.78rem",
                      color: "var(--muted)",
                      marginBottom: 6,
                    }}
                  >
                    包含目录结构（{previewData.groups.length}）
                  </strong>
                  <div className="catalog-author-decks">
                    {(() => {
                      const byId = new Map(
                        previewData.groups.map((g) => [g.id, g]),
                      );
                      const pathOfGroup = (gid: string) => {
                        const parts: string[] = [];
                        const seen = new Set<string>();
                        let cur: string | null = gid;
                        while (cur && !seen.has(cur)) {
                          seen.add(cur);
                          const node = byId.get(cur);
                          if (!node) break;
                          parts.push(node.title);
                          cur = node.parentId ?? null;
                        }
                        return parts.reverse().join(" / ");
                      };
                      return previewData.groups.map((g) => (
                        <span className="deck-group-pill" key={g.id}>
                          {pathOfGroup(g.id)}
                          <small>{g.count}</small>
                        </span>
                      ));
                    })()}
                  </div>
                </div>
              )}
              <div>
                <strong
                  style={{
                    display: "block",
                    fontSize: "0.78rem",
                    color: "var(--muted)",
                    marginBottom: 6,
                  }}
                >
                  题目预览（
                  {previewData.totalQuestions >
                  previewData.sampleQuestions.length
                    ? `展示前 ${previewData.sampleQuestions.length} / 共 ${previewData.totalQuestions} 题`
                    : `共 ${previewData.sampleQuestions.length} 题`}
                  ）
                </strong>
                <div className="publish-batch-list">
                  {previewData.sampleQuestions.map((q, idx) => (
                    <div className="publish-batch-row" key={q.id}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          minWidth: 0,
                          width: "100%",
                        }}
                      >
                        <span className="row-index">
                          {String(idx + 1).padStart(2, "0")}
                        </span>
                        <span
                          style={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: "0.84rem",
                            color: "var(--text)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {q.title}
                        </span>
                        {!q.hasAnswer && (
                          <span className="tag tag-warn">待补答案</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              {!previewLiveDeck.isOwner && !previewLiveDeck.subscribed && (
                <label className="field">
                  订阅后放入我的文件夹
                  <select
                    aria-label="订阅后放入我的文件夹"
                    value={previewFolderId}
                    onChange={(e) => setPreviewFolderId(e.target.value)}
                    disabled={busyKey !== null}
                  >
                    <FolderSelectOptions
                      decks={data.decks}
                      includeRoot
                      rootLabel={ROOT_FOLDER_LABEL}
                    />
                  </select>
                </label>
              )}
            </>
          ) : null}
        </div>
        <div className="dialog-footer">
          <Button
            variant="ghost"
            disabled={busyKey !== null}
            onClick={closePreview}
          >
            关闭
          </Button>
          {previewLiveDeck &&
            (previewLiveDeck.isOwner ? (
              <Button
                variant="outline"
                onClick={() => {
                  const id = previewLiveDeck.id;
                  closePreview();
                  onOpenDeck(id);
                }}
              >
                查看我的资料 <ArrowUpRight size={15} />
              </Button>
            ) : previewLiveDeck.subscribed && previewLiveDeck.hasUpdate ? (
              <Button
                disabled={busyKey === `upd:${previewLiveDeck.id}`}
                onClick={async () => {
                  await handleApplyUpdate(
                    previewLiveDeck.id,
                    previewLiveDeck.publishedVersion,
                  );
                  closePreview();
                  onOpenDeck(previewLiveDeck.id);
                }}
              >
                <Download size={15} /> 更新至 v
                {previewLiveDeck.publishedVersion}
                并打开
              </Button>
            ) : previewLiveDeck.subscribed ? (
              <Button
                onClick={() => {
                  const id = previewLiveDeck.id;
                  closePreview();
                  onOpenDeck(id);
                }}
              >
                <Check size={15} /> 已订阅 · 开始学习
              </Button>
            ) : (
              <Button
                disabled={busyKey === `sub:${previewLiveDeck.id}`}
                onClick={() =>
                  void handleSubscribeSingle(
                    previewLiveDeck.id,
                    previewFolderId,
                    true,
                  )
                }
              >
                {busyKey === `sub:${previewLiveDeck.id}` ? (
                  <Loader2 size={15} className="spin" />
                ) : (
                  <Rss size={15} />
                )}{" "}
                立即订阅并开始学习
              </Button>
            ))}
        </div>
      </Dialog>
    </div>
  );
}
