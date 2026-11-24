"use client";
import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BookOpen,
  Search,
  Plus,
  ArrowUpRight,
  Star,
  ArrowLeft,
  Rss,
  Check,
  CircleDashed,
  Sparkles,
  Trash2,
  FolderInput,
  FolderKanban,
  FolderPlus,
  FolderOpen,
  PenLine,
  PencilLine,
  Play,
  Tags,
  X,
  ChevronDown,
  ChevronRight,
  ArrowUp,
  ArrowDown,
  Archive,
  ArchiveRestore,
  CheckSquare,
  Square,
  Flame,
  Loader2,
  LayoutList,
  Layers2,
  Upload,
  Download,
} from "lucide-react";
import { toast } from "sonner";
import type {
  Workspace,
  QuestionView,
  DeckGroupView,
} from "@/lib/types";
import {
  OTHER_DECKS_LABEL,
  UNGROUPED_LABEL,
  bucketQuestionsByGroup,
  clusterDeckGroupsByCategory,
  computeDeckReadingOrder,
  formatGroupLabel,
  groupDecksByName,
  listDeckCategories,
  readCollapsedGroupIds,
  resolveQuestionGroup,
  writeCollapsedGroupIds,
} from "@/lib/grouping";
import {
  batchMoveQuestionsToSlot,
  createDeckGroup,
  deleteDeckGroup,
  renameDeckCategory,
  renameDeckGroupName,
  reorderDeckGroups,
} from "@/lib/client";
import { markdownDocument, mergeQuestionTags } from "@/lib/markdown-source";
import { relativeDue } from "@/lib/utils";
import { Button } from "./ui/button";
import { ActionMenu } from "./ui/action-menu";
import { Dialog } from "./ui/dialog";
import { LibraryTrash } from "./library-trash";
import { DeckSelectOptions, GroupSelectOptions } from "./deck-select-options";
import type { Mutate } from "./dialogs";

type SortKey = "default" | "due" | "lapses" | "updated";
const UNGROUPED_KEY = "__ungrouped__";
const NEW_GROUP_VALUE = "__new__";
const GROUP_PAGE_SIZE = 24;

export function Library({
  data,
  deckId,
  filter,
  initialGroupId,
  initialCategory,
  onQuestion,
  onPractice,
  onCram,
  onDeck,
  onImport,
  onImportToGroup,
  onCreateQuestion,
  onCreateQuestionInGroup,
  onCreate,
  onEditDeck,
  onOpenGroupDialog,
  onSetDeckGroup,
  onManageDeckGroups,
  onCreateDeckInGroup,
  onReview,
  onPublish,
  onBatchPublish,
  onFavorite,
  onGenerateAnswer,
  onAcknowledge,
  onApplyUpdate,
  onDismissUpdate,
  onApplyAllUpdates,
  onUnsubscribe,
  onDelete,
  onDeleteQuestion,
  onMoveQuestion,
  mutate,
  searchToken = 0,
}: {
  data: Workspace;
  deckId?: string | null;
  filter?: string;
  initialGroupId?: string | null;
  initialCategory?: string | null;
  onQuestion: (q: QuestionView, orderedIds?: string[]) => void;
  onPractice?: (q: QuestionView) => void;
  onCram: (questions: QuestionView[], label: string) => void;
  onDeck: (id?: string | null) => void;
  onImport: () => void;
  onImportToGroup?: (groupId: string) => void;
  onCreateQuestion: () => void;
  onCreateQuestionInGroup?: (groupId: string) => void;
  onCreate: () => void;
  onEditDeck: (deck: Workspace["decks"][number]) => void;
  onOpenGroupDialog?: (
    deck: Workspace["decks"][number],
    group?: DeckGroupView,
    defaultCategory?: string,
  ) => void;
  onSetDeckGroup?: (deck: Workspace["decks"][number]) => void;
  onManageDeckGroups?: () => void;
  onCreateDeckInGroup?: (groupName: string) => void;
  onReview: (deckId?: string) => void;
  onPublish: (id: string) => void;
  onBatchPublish?: () => void;
  onFavorite: (q: QuestionView) => void;
  onGenerateAnswer: (q: QuestionView) => void;
  onAcknowledge?: (id: string, version: number) => void;
  onApplyUpdate?: (
    deckId: string,
    targetVersion: number,
  ) => void | Promise<void>;
  onDismissUpdate?: (deckId: string, version: number) => void | Promise<void>;
  onApplyAllUpdates?: (deckIds?: string[]) => void | Promise<void>;
  onUnsubscribe: (id: string) => void;
  onDelete: (deck: Workspace["decks"][number]) => void;
  onDeleteQuestion: (q: QuestionView) => void;
  onMoveQuestion: (q: QuestionView) => void;
  mutate: Mutate;
  searchToken?: number;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [sortBy, setSortBy] = useState<SortKey>("default");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [mobileTagsOpen, setMobileTagsOpen] = useState(false);
  const [hasTagOverflow, setHasTagOverflow] = useState(false);
  const [section, setSection] = useState("decks");
  const [selectedDeckGroup, setSelectedDeckGroup] = useState<string | null>(
    null,
  );
  const [selectedCategory, setSelectedCategory] = useState<string | null>(
    initialCategory ?? null,
  );
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(
    initialGroupId ?? null,
  );
  const [viewMode, setViewMode] = useState<"grouped" | "flat">("grouped");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const [groupVisibleCounts, setGroupVisibleCounts] = useState<
    Record<string, number>
  >({});
  const [deleteGroupTarget, setDeleteGroupTarget] =
    useState<DeckGroupView | null>(null);
  const [renameDeckGroupTarget, setRenameDeckGroupTarget] = useState<
    string | null
  >(null);
  const [renameDeckGroupValue, setRenameDeckGroupValue] = useState("");
  const [dissolveDeckGroupTarget, setDissolveDeckGroupTarget] = useState<
    string | null
  >(null);
  const [renameCategoryTarget, setRenameCategoryTarget] = useState<
    string | null
  >(null);
  const [renameCategoryValue, setRenameCategoryValue] = useState("");
  const [groupActionBusy, setGroupActionBusy] = useState(false);
  const [visibleCount, setVisibleCount] = useState(40);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchDialog, setBatchDialog] = useState<"move" | "delete" | null>(null);
  const [batchTargetDeckId, setBatchTargetDeckId] = useState("");
  const [batchTargetGroupId, setBatchTargetGroupId] = useState("");
  const [batchNewGroupCategory, setBatchNewGroupCategory] = useState("");
  const [batchNewGroupTitle, setBatchNewGroupTitle] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updatingAll, setUpdatingAll] = useState(false);
  const batchCategoryListId = useId();
  const more = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const tagChipsRef = useRef<HTMLDivElement>(null);
  const query = useDeferredValue(search.trim().toLowerCase());
  useEffect(() => {
    if (searchToken) {
      setSection("questions");
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }, [searchToken]);
  useEffect(() => {
    setSelectedTag(null);
    setTagsExpanded(false);
    setMobileTagsOpen(false);
  }, [deckId, filter, section]);
  const root = deckId === undefined && !filter;
  const unfiled = deckId === null || (root && section === "unfiled");
  const archived = filter === "archived" || (root && section === "archived");
  const listVisible = !root || (section !== "decks" && section !== "trash");
  useEffect(() => {
    if (!listVisible) return;
    function onSlash(event: KeyboardEvent) {
      if (
        event.key !== "/" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.isComposing
      )
        return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, select, [contenteditable='true'], [role='dialog']:not([hidden])",
        ) ||
        document.querySelector(
          "[role='dialog']:not([hidden]), .action-menu[open]",
        )
      )
        return;
      event.preventDefault();
      searchInputRef.current?.focus();
    }
    window.addEventListener("keydown", onSlash);
    return () => window.removeEventListener("keydown", onSlash);
  }, [listVisible]);
  const deck = data.decks.find((d) => d.id === deckId);
  const deckGroups = deck?.groups ?? [];
  const hasDeckGroups = Boolean(deck && !filter && deckGroups.length > 0);
  const deckGrouping = useMemo(
    () => groupDecksByName(data.decks),
    [data.decks],
  );
  const activeDeckGroupFilter =
    selectedDeckGroup !== null &&
    deckGrouping.buckets.some((b) => b.groupName === selectedDeckGroup)
      ? selectedDeckGroup
      : null;
  const visibleDeckBuckets = useMemo(
    () =>
      activeDeckGroupFilter === null
        ? deckGrouping.buckets
        : deckGrouping.buckets.filter(
            (b) => b.groupName === activeDeckGroupFilter,
          ),
    [deckGrouping.buckets, activeDeckGroupFilter],
  );
  const groupCluster = useMemo(
    () => clusterDeckGroupsByCategory(deckGroups),
    [deckGroups],
  );
  const groupById = useMemo(
    () => new Map(deckGroups.map((g) => [g.id, g])),
    [deckGroups],
  );
  useEffect(() => {
    if (!deck || !deck.groups.length) {
      setCollapsedGroups(new Set());
      return;
    }
    const saved = readCollapsedGroupIds(data.user.id, deck.id);
    if (saved) {
      if (initialGroupId) saved.delete(initialGroupId);
      setCollapsedGroups(saved);
      return;
    }
    const ordered = clusterDeckGroupsByCategory(deck.groups).orderedGroups;
    const defaults = new Set<string>(
      ordered.length > 5 ? ordered.slice(3).map((g) => g.id) : [],
    );
    if (initialGroupId) defaults.delete(initialGroupId);
    setCollapsedGroups(defaults);
  }, [data.user.id, deck?.id]);
  useEffect(() => {
    if (initialGroupId) {
      setSelectedGroupId(initialGroupId);
      setSelectedCategory(null);
      setCollapsedGroups((prev) => {
        if (!prev.has(initialGroupId)) return prev;
        const next = new Set(prev);
        next.delete(initialGroupId);
        return next;
      });
    } else if (initialCategory) {
      setSelectedCategory(initialCategory);
      setSelectedGroupId(null);
    } else {
      setSelectedGroupId(null);
      setSelectedCategory(null);
    }
  }, [initialGroupId, initialCategory, deckId]);
  const activeGroupId =
    selectedGroupId && groupById.has(selectedGroupId) ? selectedGroupId : null;
  const activeCategory =
    !activeGroupId && selectedCategory !== null
      ? selectedCategory === UNGROUPED_KEY ||
        groupCluster.categories.some((c) => c.category === selectedCategory)
        ? selectedCategory
        : null
      : null;
  const isGroupedView =
    hasDeckGroups && sortBy === "default" && viewMode === "grouped";
  function toggleGroupCollapse(groupKey: string) {
    if (!deck) return;
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      writeCollapsedGroupIds(data.user.id, deck.id, next);
      return next;
    });
  }
  const scopedQuestions = useMemo(
    () =>
      data.questions.filter((q) => {
        if (deckId !== undefined && q.deckId !== deckId) return false;
        if (unfiled && (!q.isOwner || q.deckId !== null)) return false;
        if (archived ? !q.archived : q.archived) return false;
        if (filter === "favorites" && !q.favorite) return false;
        if (filter === "inbox" && !q.needsEditing) return false;
        return true;
      }),
    [data.questions, deckId, unfiled, archived, filter],
  );
  const groupTotalsById = useMemo(() => {
    const counts = new Map<string, number>();
    for (const q of scopedQuestions) {
      const key =
        q.groupId && groupById.has(q.groupId) ? q.groupId : UNGROUPED_KEY;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [scopedQuestions, groupById]);
  const categoryStats = useMemo(() => {
    if (!hasDeckGroups || !groupCluster.hasCategories) {
      return { items: [], uncategorizedCount: 0 };
    }
    const items = groupCluster.categories
      .filter((c) => c.category !== "")
      .map((c) => ({
        category: c.category,
        groupCount: c.groups.length,
        questionCount: c.groups.reduce(
          (sum, g) => sum + (groupTotalsById.get(g.id) ?? 0),
          0,
        ),
      }));
    const uncategorizedGroupQuestions = groupCluster.categories
      .filter((c) => c.category === "")
      .flatMap((c) => c.groups)
      .reduce((sum, g) => sum + (groupTotalsById.get(g.id) ?? 0), 0);
    const ungroupedCount = groupTotalsById.get(UNGROUPED_KEY) ?? 0;
    return {
      items,
      uncategorizedCount: uncategorizedGroupQuestions + ungroupedCount,
    };
  }, [hasDeckGroups, groupCluster, groupTotalsById]);
  const tagsByQuestionId = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const q of scopedQuestions) {
      const noteTags =
        q.answer.startsWith("---") || q.answer.startsWith("\uFEFF---")
          ? markdownDocument(q.answer).tags
          : [];
      map.set(q.id, mergeQuestionTags(q.tags, noteTags));
    }
    return map;
  }, [scopedQuestions]);
  const availableTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tags of tagsByQuestionId.values()) {
      for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "zh-CN"));
  }, [tagsByQuestionId]);
  useEffect(() => {
    if (!listVisible || !availableTags.length) {
      setHasTagOverflow(false);
      return;
    }
    const el = tagChipsRef.current;
    if (!el) return;
    const measure = () => {
      if (!tagsExpanded) {
        setHasTagOverflow(el.scrollWidth > el.clientWidth + 4);
      }
    };
    measure();
    const raf = requestAnimationFrame(measure);
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    ro?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [listVisible, availableTags, tagsExpanded, section, deckId, filter]);
  useEffect(() => {
    if (!selectedTag || tagsExpanded) return;
    const el = tagChipsRef.current;
    const active = el?.querySelector<HTMLElement>('[data-active-tag="true"]');
    active?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "smooth",
    });
  }, [selectedTag, tagsExpanded]);
  const filtered = useMemo(
    () =>
      scopedQuestions.filter((q) => {
        if (activeGroupId && q.groupId !== activeGroupId) return false;
        if (activeCategory !== null) {
          const grp = q.groupId ? groupById.get(q.groupId) : undefined;
          if (activeCategory === UNGROUPED_KEY) {
            if (grp && grp.category.trim() !== "") return false;
          } else if (!grp || grp.category.trim() !== activeCategory) {
            return false;
          }
        }
        const tags = tagsByQuestionId.get(q.id) ?? q.tags;
        if (selectedTag && !tags.includes(selectedTag)) return false;
        if (status === "new" && q.fsrs) return false;
        if (
          status === "due" &&
          (!q.fsrs || new Date(q.fsrs.due).getTime() > Date.now())
        )
          return false;
        if (!query) return true;
        const tagTerms = tags.map((t) => `${t} #${t}`).join(" ");
        const groupLabel = formatGroupLabel(
          resolveQuestionGroup(data.decks, q),
          " ",
        );
        return `${q.title} ${q.answer} ${tagTerms} ${groupLabel}`
          .toLowerCase()
          .includes(query);
      }),
    [
      scopedQuestions,
      activeGroupId,
      activeCategory,
      groupById,
      tagsByQuestionId,
      selectedTag,
      status,
      query,
      data.decks,
    ],
  );
  const sorted = useMemo(() => {
    if (sortBy === "default") {
      if (hasDeckGroups) {
        return computeDeckReadingOrder(filtered, deckGroups);
      }
      return [...filtered].sort((a, b) => {
        const diff =
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        return diff !== 0 ? diff : a.id.localeCompare(b.id);
      });
    }
    const now = Date.now();
    const withMeta = filtered.map((q) => ({
      q,
      dueMs: q.fsrs ? new Date(q.fsrs.due).getTime() : Number.POSITIVE_INFINITY,
      updatedMs: new Date(q.updatedAt).getTime(),
    }));
    if (sortBy === "due") {
      const bucket = (entry: (typeof withMeta)[number]) =>
        !entry.q.fsrs ? 1 : entry.dueMs <= now ? 0 : 2;
      withMeta.sort((a, b) => {
        const diff = bucket(a) - bucket(b);
        if (diff !== 0) return diff;
        if (a.q.fsrs && b.q.fsrs) return a.dueMs - b.dueMs;
        return b.updatedMs - a.updatedMs;
      });
    } else if (sortBy === "lapses") {
      withMeta.sort((a, b) => {
        const diff = (b.q.fsrs?.lapses ?? 0) - (a.q.fsrs?.lapses ?? 0);
        if (diff !== 0) return diff;
        if (a.q.fsrs && b.q.fsrs) return a.dueMs - b.dueMs;
        return a.q.fsrs ? -1 : b.q.fsrs ? 1 : 0;
      });
    } else if (sortBy === "updated") {
      withMeta.sort((a, b) => b.updatedMs - a.updatedMs);
    }
    return withMeta.map((entry) => entry.q);
  }, [filtered, sortBy, hasDeckGroups, deckGroups]);
  const hasActiveListFilter = Boolean(
    query || selectedTag !== null || status !== "all",
  );
  const visibleDeckGroups = useMemo(() => {
    if (!hasDeckGroups) return [];
    if (activeGroupId) {
      const grp = groupById.get(activeGroupId);
      return grp ? [grp] : [];
    }
    if (activeCategory !== null) {
      if (activeCategory === UNGROUPED_KEY) {
        return deckGroups.filter((g) => g.category.trim() === "");
      }
      return deckGroups.filter((g) => g.category.trim() === activeCategory);
    }
    return deckGroups;
  }, [hasDeckGroups, activeGroupId, activeCategory, groupById, deckGroups]);
  const groupedBuckets = useMemo(
    () =>
      isGroupedView
        ? bucketQuestionsByGroup(sorted, visibleDeckGroups, {
            includeEmptyGroups: !hasActiveListFilter,
          })
        : null,
    [isGroupedView, sorted, visibleDeckGroups, hasActiveListFilter],
  );
  const orderedQuestions = groupedBuckets ? groupedBuckets.flatOrdered : sorted;
  const orderedIds = useMemo(
    () => orderedQuestions.map((item) => item.id),
    [orderedQuestions],
  );
  const cramEligible = useMemo(
    () => orderedQuestions.filter((q) => !q.archived && q.answer.trim()),
    [orderedQuestions],
  );
  const ownedFiltered = useMemo(
    () => orderedQuestions.filter((q) => q.isOwner),
    [orderedQuestions],
  );
  const ownedVisibleIds = useMemo(
    () => ownedFiltered.map((q) => q.id),
    [ownedFiltered],
  );
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const activeSelectedIds = useMemo(
    () => ownedVisibleIds.filter((id) => selectedSet.has(id)),
    [ownedVisibleIds, selectedSet],
  );
  function toggleSelect(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  }
  useEffect(() => {
    setBatchMode(false);
    setSelectedIds([]);
  }, [deckId, filter, section]);
  useEffect(() => {
    setVisibleCount(40);
    setGroupVisibleCounts({});
  }, [
    deckId,
    filter,
    status,
    sortBy,
    selectedTag,
    query,
    section,
    activeCategory,
    activeGroupId,
  ]);
  useEffect(() => {
    if (isGroupedView) return;
    const button = more.current;
    if (!button || visibleCount >= orderedQuestions.length) return;
    // 长题库逐步展开，保留已展开的条目以便返回时恢复滚动。
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          setVisibleCount((count) => count + 40);
      },
      { rootMargin: "400px" },
    );
    observer.observe(button);
    return () => observer.disconnect();
  }, [visibleCount, orderedQuestions.length, isGroupedView, section, deckId, filter]);
  const heading =
    (deckId === null ? "未分类" : deck?.title) ??
    (filter === "favorites"
      ? "我的收藏"
      : filter === "inbox"
        ? "待整理"
        : filter === "archived"
          ? "已归档"
          : "我的题库");
  const missingDeck = typeof deckId === "string" && !deck;
  const focusedGroup = activeGroupId ? groupById.get(activeGroupId) : undefined;
  const cramLabel = selectedTag
    ? `#${selectedTag}`
    : query
      ? `搜索：${search.trim().slice(0, 12)}`
      : focusedGroup
        ? formatGroupLabel(focusedGroup)
        : activeCategory && activeCategory !== UNGROUPED_KEY
          ? activeCategory
          : heading;
  const ownedDecks = data.decks.filter((d) => d.isOwner);
  const ownedChangedCount = ownedDecks.filter(
    (d) => d.publishStatus === "changes",
  ).length;
  const outdatedSubDecks = data.decks.filter(
    (d) => !d.isOwner && Boolean(d.pendingUpdate),
  );
  async function handleApplySingleUpdate(
    targetDeckId: string,
    targetVersion: number,
  ) {
    if (updateBusy) return;
    setUpdateBusy(true);
    try {
      if (onApplyUpdate) {
        await onApplyUpdate(targetDeckId, targetVersion);
      } else if (onAcknowledge) {
        onAcknowledge(targetDeckId, targetVersion);
      }
    } finally {
      setUpdateBusy(false);
    }
  }
  async function handleDismissSingleUpdate(
    targetDeckId: string,
    version: number,
  ) {
    if (updateBusy || !onDismissUpdate) return;
    setUpdateBusy(true);
    try {
      await onDismissUpdate(targetDeckId, version);
    } finally {
      setUpdateBusy(false);
    }
  }
  async function handleApplyAllUpdates() {
    if (updatingAll || !onApplyAllUpdates || !outdatedSubDecks.length) return;
    setUpdatingAll(true);
    try {
      await onApplyAllUpdates(outdatedSubDecks.map((d) => d.id));
    } finally {
      setUpdatingAll(false);
    }
  }
  const batchTargetDeck = ownedDecks.find((d) => d.id === batchTargetDeckId);
  const batchTargetGroups = batchTargetDeck?.groups ?? [];
  const batchTargetCategories = useMemo(
    () => listDeckCategories(batchTargetGroups),
    [batchTargetGroups],
  );
  const batchCreatingNewGroup =
    batchDialog === "move" &&
    Boolean(batchTargetDeck) &&
    batchTargetGroupId === NEW_GROUP_VALUE;
  const batchNewGroupInvalid =
    batchCreatingNewGroup &&
    (!batchNewGroupTitle.trim() ||
      batchNewGroupTitle.trim().length > 80 ||
      batchNewGroupCategory.trim().length > 40);
  async function handleReorderGroup(groupId: string, delta: -1 | 1) {
    if (!deck || groupActionBusy) return;
    const currentOrder = groupCluster.orderedGroups.map((g) => g.id);
    const idx = currentOrder.indexOf(groupId);
    const targetIdx = idx + delta;
    if (idx < 0 || targetIdx < 0 || targetIdx >= currentOrder.length) return;
    const nextOrder = [...currentOrder];
    [nextOrder[idx], nextOrder[targetIdx]] = [
      nextOrder[targetIdx],
      nextOrder[idx],
    ];
    setGroupActionBusy(true);
    try {
      await reorderDeckGroups(mutate, deck.id, nextOrder);
    } finally {
      setGroupActionBusy(false);
    }
  }
  async function confirmDeleteGroup() {
    if (!deleteGroupTarget || groupActionBusy) return;
    setGroupActionBusy(true);
    try {
      const result = await deleteDeckGroup(mutate, deleteGroupTarget.id);
      if (result) {
        if (selectedGroupId === deleteGroupTarget.id) setSelectedGroupId(null);
        setDeleteGroupTarget(null);
        toast.success("分组已删除，组内题目已保留在未分组中。");
      }
    } finally {
      setGroupActionBusy(false);
    }
  }
  async function confirmRenameDeckGroup() {
    const from = renameDeckGroupTarget;
    const to = renameDeckGroupValue.trim();
    if (!from || !to || to.length > 40 || to === from || groupActionBusy) return;
    const isMerge = deckGrouping.buckets.some((b) => b.groupName === to);
    setGroupActionBusy(true);
    try {
      const result = await renameDeckGroupName(mutate, from, to);
      if (result) {
        if (selectedDeckGroup === from) setSelectedDeckGroup(to);
        setRenameDeckGroupTarget(null);
        setRenameDeckGroupValue("");
        toast.success(
          isMerge
            ? `已将「${from}」合并到「${to}」。`
            : `分组已重命名为「${to}」。`,
        );
      }
    } finally {
      setGroupActionBusy(false);
    }
  }
  async function confirmDissolveDeckGroup() {
    const target = dissolveDeckGroupTarget;
    if (!target || groupActionBusy) return;
    setGroupActionBusy(true);
    try {
      const result = await renameDeckGroupName(mutate, target, "");
      if (result) {
        if (selectedDeckGroup === target) setSelectedDeckGroup(null);
        setDissolveDeckGroupTarget(null);
        toast.success(`已解散分组「${target}」，题库已安全保留。`);
      }
    } finally {
      setGroupActionBusy(false);
    }
  }
  async function confirmRenameCategory() {
    const from = renameCategoryTarget;
    const to = renameCategoryValue.trim();
    if (
      !deck ||
      !from ||
      !to ||
      to.length > 40 ||
      to === from ||
      groupActionBusy
    )
      return;
    setGroupActionBusy(true);
    try {
      const result = await renameDeckCategory(mutate, deck.id, from, to);
      if (result) {
        if (selectedCategory === from) setSelectedCategory(to);
        setRenameCategoryTarget(null);
        setRenameCategoryValue("");
        toast.success(`已将分类「${from}」重命名为「${to}」。`);
      }
    } finally {
      setGroupActionBusy(false);
    }
  }
  async function runBatch(
    operation: "move" | "archive" | "unarchive" | "delete",
    targetDeckId?: string | null,
    targetGroupId?: string | null,
  ) {
    if (!activeSelectedIds.length || batchBusy) return;
    if (operation === "move" && batchNewGroupInvalid) return;
    setBatchBusy(true);
    try {
      let resolvedGroupId = targetDeckId ? (targetGroupId ?? null) : null;
      if (
        operation === "move" &&
        targetDeckId &&
        targetGroupId === NEW_GROUP_VALUE
      ) {
        const created = await createDeckGroup(mutate, {
          deckId: targetDeckId,
          title: batchNewGroupTitle.trim(),
          category: batchNewGroupCategory.trim(),
        });
        const createdId = (created?.group as { id?: string } | undefined)?.id;
        if (!createdId) return;
        resolvedGroupId = createdId;
        setBatchTargetGroupId(createdId);
      }
      const result =
        operation === "move"
          ? await batchMoveQuestionsToSlot(
              mutate,
              activeSelectedIds,
              targetDeckId ?? null,
              resolvedGroupId,
            )
          : await mutate("/api/questions", {
              action: "batch",
              ids: activeSelectedIds,
              operation,
            });
      if (result) {
        const updated = Number(result.updated ?? 0);
        const skipped = Number(result.skipped ?? 0);
        if (operation === "move") {
          toast.success(
            skipped > 0
              ? `已移动 ${updated} 题，跳过 ${skipped} 题（已在目标位置或内容重复）。`
              : `已移动 ${updated} 道题目。`,
          );
        } else if (operation === "archive") {
          toast.success(`已归档 ${updated} 道题目。`);
        } else if (operation === "unarchive") {
          toast.success(`已恢复 ${updated} 道题目。`);
        } else {
          toast.success(`已将 ${updated} 道题目移入回收站。`);
        }
        setBatchDialog(null);
        setBatchNewGroupCategory("");
        setBatchNewGroupTitle("");
        setSelectedIds([]);
        setBatchMode(false);
      }
    } finally {
      setBatchBusy(false);
    }
  }
  if (missingDeck) {
    return (
      <div className="page library-page">
        <div className="empty-state">
          <BookOpen size={34} />
          <h3>题库不存在或已删除</h3>
          <p>该题库可能已被移除，原收录的题目已安全保留在「未分类」中。</p>
          <Button variant="outline" onClick={() => onDeck()}>
            返回我的题库
          </Button>
        </div>
      </div>
    );
  }
  const renderDeckCard = (d: Workspace["decks"][number]) => (
    <article className={`library-book color-${d.color}`} key={d.id}>
      <button className="library-book-main" onClick={() => onDeck(d.id)}>
        <span className="deck-icon">
          <BookOpen size={23} />
        </span>
        <div className="library-book-meta">
          <h3>{d.title}</h3>
          <p>
            {d.count} 道题
            {d.groups.length > 0 ? ` · ${d.groups.length} 分组` : ""}
            {d.due > 0 ? ` · ${d.due} 待复习` : ""}
            {!d.isOwner ? ` · ${d.ownerName}` : ""}
            {!d.isOwner && d.pendingUpdate ? (
              <>
                {" "}
                <span className="deck-status-pill is-update">
                  有更新 v{d.pendingUpdate.toVersion}
                </span>
              </>
            ) : d.isOwner && d.publishStatus === "changes" ? (
              <>
                {" "}
                <span className="deck-status-pill is-changes">有改动</span>
              </>
            ) : null}
          </p>
        </div>
        <ArrowUpRight size={17} />
      </button>
      <ActionMenu label={`管理题库：${d.title}`}>
        {d.isOwner ? (
          <>
            <button onClick={() => onEditDeck(d)}>
              <PencilLine size={15} />
              编辑题库
            </button>
            {onSetDeckGroup && (
              <button onClick={() => onSetDeckGroup(d)}>
                <FolderOpen size={15} />
                设置题库分组
              </button>
            )}
            <button onClick={() => onPublish(d.id)}>
              <Rss size={15} />
              {d.publishedVersion ? "发布更新" : "发布题库"}
            </button>
            <button className="danger-text" onClick={() => onDelete(d)}>
              <Trash2 size={15} />
              删除题库
            </button>
          </>
        ) : (
          <>
            {onSetDeckGroup && (
              <button onClick={() => onSetDeckGroup(d)}>
                <FolderOpen size={15} />
                设置题库分组
              </button>
            )}
            <button onClick={() => onUnsubscribe(d.id)}>取消订阅</button>
          </>
        )}
      </ActionMenu>
    </article>
  );
  const renderQuestionRow = (
    q: QuestionView,
    i: number,
    showGroupPill: boolean,
  ) => {
    const questionTags = tagsByQuestionId.get(q.id) ?? [];
    const batchSelectable = batchMode && q.isOwner;
    const isSelected = batchSelectable && selectedSet.has(q.id);
    const questionGroup = showGroupPill
      ? resolveQuestionGroup(data.decks, q)
      : null;
    const groupPillText = formatGroupLabel(questionGroup);
    return (
      <div
        className={`question-row ${batchMode ? "is-batch-mode" : ""} ${batchSelectable ? "is-selectable" : ""} ${isSelected ? "is-selected" : ""}`}
        key={q.id}
        onClick={batchSelectable ? () => toggleSelect(q.id) : undefined}
      >
        <div className="question-row-head">
          <div className="question-row-head-left">
            {batchMode &&
              (q.isOwner ? (
                <button
                  type="button"
                  className={`batch-check-btn ${isSelected ? "is-checked" : ""}`}
                  aria-label={
                    isSelected ? `取消选中：${q.title}` : `选中：${q.title}`
                  }
                  aria-pressed={isSelected}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleSelect(q.id);
                  }}
                >
                  {isSelected ? (
                    <CheckSquare size={18} />
                  ) : (
                    <Square size={18} />
                  )}
                </button>
              ) : (
                <span className="tag">订阅题</span>
              ))}
            <span className="row-index">{String(i + 1).padStart(2, "0")}</span>
            {!deckId && (
              <span className="question-deck-name">{q.deckTitle}</span>
            )}
            {groupPillText && (
              <span className="group-pill" title={groupPillText}>
                {groupPillText}
              </span>
            )}
            {q.fsrs && q.fsrs.lapses > 0 && (
              <span
                className={`tag ${q.fsrs.lapses >= 2 ? "tag-warn" : "tag-lapses"}`}
              >
                易忘 {q.fsrs.lapses} 次
              </span>
            )}
            {q.needsEditing && <span className="tag tag-warn">待整理</span>}
            {q.majorRevision > q.reviewedRevision && q.fsrs && (
              <span className="tag tag-warn">内容已更新</span>
            )}
          </div>
          {!batchMode && (
            <div className="question-row-tools">
              <button
                className={`icon-button favorite-button ${q.favorite ? "is-favorite" : ""}`}
                aria-label={q.favorite ? "取消收藏" : "收藏题目"}
                onClick={() => onFavorite(q)}
              >
                <Star size={17} fill={q.favorite ? "currentColor" : "none"} />
              </button>
              {q.isOwner && (
                <ActionMenu label={`更多题目操作：${q.title}`}>
                  <button onClick={() => onMoveQuestion(q)}>
                    <FolderInput size={15} />
                    移动到题库 / 分组
                  </button>
                  <button
                    className="danger-text"
                    onClick={() => onDeleteQuestion(q)}
                  >
                    <Trash2 size={15} />
                    删除题目
                  </button>
                </ActionMenu>
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          className="question-row-main"
          onClick={(e) => {
            if (batchSelectable) {
              e.stopPropagation();
              toggleSelect(q.id);
            } else if (!batchMode) {
              onQuestion(q, orderedIds);
            }
          }}
        >
          <strong>{q.title}</strong>
        </button>
        {questionTags.length > 0 && (
          <div className="question-row-tags" aria-label="题目标签">
            {questionTags.slice(0, 4).map((tag) =>
              batchMode ? (
                <span
                  key={tag}
                  title={`#${tag}`}
                  className={`tag ${selectedTag === tag ? "tag-active" : ""}`}
                >
                  <span className="tag-hash" aria-hidden="true">
                    #
                  </span>
                  <span className="tag-text">{tag}</span>
                </span>
              ) : (
                <button
                  type="button"
                  key={tag}
                  title={`#${tag}`}
                  className={`tag tag-interactive ${selectedTag === tag ? "tag-active" : ""}`}
                  aria-pressed={selectedTag === tag}
                  onClick={() =>
                    setSelectedTag((current) => (current === tag ? null : tag))
                  }
                >
                  <span className="tag-hash" aria-hidden="true">
                    #
                  </span>
                  <span className="tag-text">{tag}</span>
                </button>
              ),
            )}
            {questionTags.length > 4 && (
              <span
                className="tag tag-more"
                title={questionTags
                  .slice(4)
                  .map((t) => `#${t}`)
                  .join(" ")}
              >
                +{questionTags.length - 4}
              </span>
            )}
          </div>
        )}
        <div className="question-row-foot">
          {!batchMode && q.isOwner && !q.archived && !q.answer.trim() ? (
            <Button
              className="row-generate-answer"
              variant="ghost"
              size="sm"
              onClick={() => onGenerateAnswer(q)}
              aria-label={`AI 写答案：${q.title}`}
            >
              <Sparkles size={15} />
              <span>AI 写答案</span>
            </Button>
          ) : (
            <span
              className={`row-study-status ${!q.fsrs ? "is-new" : new Date(q.fsrs.due).getTime() <= Date.now() ? "is-due" : ""}`}
            >
              <span />
              {q.archived
                ? "已归档"
                : !q.answer.trim()
                  ? "待补答案"
                  : relativeDue(q.fsrs?.due)}
            </span>
          )}
          {!batchMode &&
            (!q.archived && q.answer.trim() && onPractice ? (
              <button
                type="button"
                className="icon-button row-action-btn is-practice"
                title="开始答题"
                aria-label={`开始答题：${q.title}`}
                onClick={() => onPractice(q)}
              >
                <Play size={14} />
              </button>
            ) : !q.archived && !q.answer.trim() ? (
              <button
                type="button"
                className="icon-button row-action-btn"
                title="补全答案"
                aria-label={`补全答案：${q.title}`}
                onClick={() => onQuestion(q, orderedIds)}
              >
                <PencilLine size={14} />
              </button>
            ) : (
              <button
                type="button"
                className="icon-button row-action-btn"
                title="查看题目"
                aria-label={`查看题目：${q.title}`}
                onClick={() => onQuestion(q, orderedIds)}
              >
                <ArrowUpRight size={15} />
              </button>
            ))}
        </div>
      </div>
    );
  };
  const showGroupedContent =
    isGroupedView &&
    groupedBuckets !== null &&
    groupedBuckets.categoryBuckets.length > 0;
  const hasAnyFilter =
    Boolean(search) ||
    status !== "all" ||
    selectedTag !== null ||
    activeCategory !== null ||
    activeGroupId !== null;
  return (
    <div className="page library-page">
      <div className="page-heading">
        <div>
          {(deck || deckId === null || filter) && (
            <button className="back-link" onClick={() => onDeck()}>
              <ArrowLeft size={14} /> 全部题库
            </button>
          )}
          <div className="deck-title-row">
            <h1>{heading}</h1>
            {deck && onSetDeckGroup && (
              <button
                type="button"
                className={`deck-current-group-pill ${deck.groupName ? "" : "is-empty"}`}
                onClick={() => onSetDeckGroup(deck)}
                title={
                  deck.groupName
                    ? `所属题库分组：${deck.groupName}（点击修改）`
                    : "为当前题库设置分组"
                }
              >
                {deck.groupName ? (
                  <>
                    <FolderOpen size={13} aria-hidden="true" />
                    <span>{deck.groupName}</span>
                  </>
                ) : (
                  <>
                    <FolderPlus size={13} aria-hidden="true" />
                    <span>归入题库分组</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
        <div className="heading-actions">
          {deck?.isOwner && (
            <ActionMenu label="管理当前题库">
              <button onClick={() => onEditDeck(deck)}>
                <PencilLine size={15} />
                编辑题库
              </button>
              <button onClick={() => onPublish(deck.id)}>
                <Rss size={15} />
                {deck.publishedVersion ? "发布更新" : "发布题库"}
              </button>
              <button className="danger-text" onClick={() => onDelete(deck)}>
                <Trash2 size={15} />
                删除题库
              </button>
            </ActionMenu>
          )}
          {root &&
            section === "decks" &&
            ownedDecks.length > 0 &&
            onBatchPublish && (
              <Button variant="outline" onClick={onBatchPublish}>
                <Rss size={15} />{" "}
                {ownedChangedCount > 0
                  ? `发布更新 (${ownedChangedCount})`
                  : "批量发布"}
              </Button>
            )}
          {root &&
            section === "decks" &&
            data.decks.length > 0 &&
            onManageDeckGroups && (
              <Button variant="outline" onClick={onManageDeckGroups}>
                <FolderKanban size={15} /> 整理分组
              </Button>
            )}
          {root && (
            <Button variant="outline" onClick={onCreate}>
              <Plus size={16} /> 新建题库
            </Button>
          )}
          {deck?.isOwner && filter !== "archived" && onOpenGroupDialog && (
            <Button
              variant="outline"
              onClick={() =>
                onOpenGroupDialog(
                  deck,
                  undefined,
                  activeCategory && activeCategory !== UNGROUPED_KEY
                    ? activeCategory
                    : "",
                )
              }
            >
              <FolderPlus size={15} /> 新建分组
            </Button>
          )}
          {(!deck || deck.isOwner) &&
            filter !== "archived" &&
            (!root || (section !== "decks" && section !== "trash")) && (
              <Button
                variant="outline"
                onClick={() =>
                  activeGroupId && onCreateQuestionInGroup
                    ? onCreateQuestionInGroup(activeGroupId)
                    : onCreateQuestion()
                }
              >
                <PenLine size={15} /> 新建单题
              </Button>
            )}
          <Button
            onClick={() =>
              activeGroupId && onImportToGroup
                ? onImportToGroup(activeGroupId)
                : onImport()
            }
          >
            <Plus size={16} /> 导入题目
          </Button>
        </div>
      </div>
      {root && (
        <div className="library-sections" role="tablist" aria-label="题库内容">
          {[
            ["decks", "题库"],
            ["questions", "全部题目"],
            ["unfiled", "未分类"],
            ["archived", "已归档"],
            ["trash", "回收站"],
          ].map(([id, label]) => (
            <button
              role="tab"
              aria-selected={section === id}
              key={id}
              onClick={() => {
                setSection(id);
                setSearch("");
                setStatus("all");
                setSelectedTag(null);
                setTagsExpanded(false);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {deck && !deck.isOwner && (
        <div className="subscription-banner">
          <Rss size={17} />
          <div>
            <strong>
              {deck.sourceDeleted ? "已停止更新" : "持续订阅"} ·{" "}
              {deck.ownerName}
            </strong>
            <span>v{deck.syncedVersion ?? deck.seenVersion}</span>
          </div>
          {deck.pendingUpdate &&
            (deck.dismissedVersion ?? 0) >= deck.pendingUpdate.toVersion && (
              <button
                type="button"
                className="subscription-update-pill"
                disabled={updateBusy}
                onClick={() =>
                  void handleApplySingleUpdate(
                    deck.id,
                    deck.pendingUpdate!.toVersion,
                  )
                }
              >
                {updateBusy ? (
                  <Loader2 size={12} className="spin" />
                ) : (
                  <Download size={12} />
                )}
                <span>有新版本 v{deck.pendingUpdate.toVersion} · 点击更新</span>
              </button>
            )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onUnsubscribe(deck.id)}
          >
            取消订阅
          </Button>
        </div>
      )}
      {deck &&
        !deck.isOwner &&
        deck.pendingUpdate &&
        (deck.dismissedVersion ?? 0) < deck.pendingUpdate.toVersion && (
          <div className="update-banner">
            <div className="update-banner-main">
              <div className="update-banner-head">
                <strong>
                  v{deck.pendingUpdate.fromVersion} → v
                  {deck.pendingUpdate.toVersion} 有新更新
                </strong>
                <div className="update-diff-pills">
                  {deck.pendingUpdate.added > 0 && (
                    <span className="update-diff-pill is-added">
                      +{deck.pendingUpdate.added} 新增
                    </span>
                  )}
                  {deck.pendingUpdate.updated > 0 && (
                    <span className="update-diff-pill is-updated">
                      ~{deck.pendingUpdate.updated} 修改
                    </span>
                  )}
                  {deck.pendingUpdate.removed > 0 && (
                    <span className="update-diff-pill is-removed">
                      -{deck.pendingUpdate.removed} 移除
                    </span>
                  )}
                  {deck.pendingUpdate.added === 0 &&
                    deck.pendingUpdate.updated === 0 &&
                    deck.pendingUpdate.removed === 0 &&
                    deck.pendingUpdate.groupsChanged && (
                      <span className="update-diff-pill">分组已调整</span>
                    )}
                </div>
              </div>
              {deck.pendingUpdate.summary && (
                <p className="update-banner-summary">
                  {deck.pendingUpdate.summary}
                </p>
              )}
            </div>
            <div className="update-banner-actions">
              {onDismissUpdate && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={updateBusy}
                  onClick={() =>
                    void handleDismissSingleUpdate(
                      deck.id,
                      deck.pendingUpdate!.toVersion,
                    )
                  }
                >
                  暂不更新
                </Button>
              )}
              <Button
                size="sm"
                disabled={updateBusy}
                onClick={() =>
                  void handleApplySingleUpdate(
                    deck.id,
                    deck.pendingUpdate!.toVersion,
                  )
                }
              >
                {updateBusy ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <Download size={14} />
                )}{" "}
                立即更新
              </Button>
            </div>
          </div>
        )}
      {root && section === "decks" && (
        <>
          {outdatedSubDecks.length > 0 && onApplyAllUpdates && (
            <div className="library-updates-bar">
              <div>
                <strong>{outdatedSubDecks.length} 个订阅题库</strong>
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
                一键更新全部
              </Button>
            </div>
          )}
          {deckGrouping.hasGroups ? (
            <>
              <div
                className="deck-group-bar"
                role="group"
                aria-label="按题库分组筛选"
              >
                <button
                  type="button"
                  className={`deck-group-pill ${activeDeckGroupFilter === null ? "is-active" : ""}`}
                  aria-pressed={activeDeckGroupFilter === null}
                  onClick={() => setSelectedDeckGroup(null)}
                >
                  全部
                  <small>{data.decks.length}</small>
                </button>
                {deckGrouping.buckets.map((bucket) => {
                  const key = bucket.groupName;
                  const label = bucket.groupName || OTHER_DECKS_LABEL;
                  const active = activeDeckGroupFilter === key;
                  return (
                    <button
                      type="button"
                      key={key || "__other__"}
                      className={`deck-group-pill ${active ? "is-active" : ""}`}
                      aria-pressed={active}
                      onClick={() =>
                        setSelectedDeckGroup((curr) =>
                          curr === key ? null : key,
                        )
                      }
                    >
                      {label}
                      <small>{bucket.decks.length}</small>
                    </button>
                  );
                })}
                {onManageDeckGroups && (
                  <button
                    type="button"
                    className="deck-group-bar-manage"
                    onClick={onManageDeckGroups}
                  >
                    <FolderKanban size={13} aria-hidden="true" />
                    <span>管理分组</span>
                  </button>
                )}
              </div>
              <div className="deck-group-sections">
                {visibleDeckBuckets.map((bucket) => (
                  <section
                    className="deck-group-section"
                    key={bucket.groupName || "__other__"}
                  >
                    <div className="deck-group-heading">
                      <div className="deck-group-heading-main">
                        <h2>{bucket.groupName || OTHER_DECKS_LABEL}</h2>
                        <span className="deck-group-count">
                          {bucket.decks.length} 个题库
                        </span>
                      </div>
                      {bucket.groupName !== "" && (
                        <div className="deck-group-heading-actions">
                          {onCreateDeckInGroup && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                onCreateDeckInGroup(bucket.groupName)
                              }
                            >
                              <Plus size={13} /> 新建题库
                            </Button>
                          )}
                          <ActionMenu
                            label={`管理题库分组：${bucket.groupName}`}
                          >
                            <button
                              onClick={() => {
                                setRenameDeckGroupTarget(bucket.groupName);
                                setRenameDeckGroupValue(bucket.groupName);
                              }}
                            >
                              <PencilLine size={15} />
                              重命名分组
                            </button>
                            <button
                              className="danger-text"
                              onClick={() =>
                                setDissolveDeckGroupTarget(bucket.groupName)
                              }
                            >
                              <Trash2 size={15} />
                              解散分组
                            </button>
                          </ActionMenu>
                        </div>
                      )}
                    </div>
                    <div className="library-book-grid">
                      {bucket.decks.map(renderDeckCard)}
                    </div>
                  </section>
                ))}
              </div>
            </>
          ) : (
            <div className="library-book-grid">
              {data.decks.map(renderDeckCard)}
              {!data.decks.length && (
                <div className="empty-state">
                  <BookOpen size={32} />
                  <h3>新建一个题库，开始整理</h3>
                  <p>按技术栈或面试专题拆分题库，也可公开发布供同伴订阅。</p>
                  <Button onClick={onCreate}>新建题库</Button>
                </div>
              )}
            </div>
          )}
        </>
      )}
      {root && section === "trash" && (
        <LibraryTrash userId={data.user.id} mutate={mutate} />
      )}
      {(!root || (section !== "decks" && section !== "trash")) && (
        <div className="question-list-panel">
          <div className="library-filter-dock">
            <div className="list-toolbar">
              <div className={`search-field ${search ? "has-query" : ""}`}>
                <Search size={17} />
                <input
                  ref={searchInputRef}
                  aria-label="搜索题目"
                  placeholder={
                    hasDeckGroups
                      ? "搜索题目标题、分组、答案关键词或 #标签…"
                      : "搜索题目标题、答案关键词或 #标签…"
                  }
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search ? (
                  <button
                    type="button"
                    className="search-clear"
                    aria-label="清空搜索"
                    onClick={() => {
                      setSearch("");
                      searchInputRef.current?.focus();
                    }}
                  >
                    <X size={14} />
                  </button>
                ) : (
                  <kbd>/</kbd>
                )}
              </div>
              {!archived && (
                <>
                  <select
                    className="desktop-status-select"
                    aria-label="筛选学习状态"
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                  >
                    <option value="all">全部状态</option>
                    <option value="due">待复习</option>
                    <option value="new">未学习</option>
                  </select>
                  <div
                    className="mobile-status-pills"
                    role="group"
                    aria-label="筛选学习状态"
                  >
                    {[
                      ["all", "全部"],
                      ["due", "待复习"],
                      ["new", "未学习"],
                    ].map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        className={status === val ? "is-active" : ""}
                        aria-pressed={status === val}
                        onClick={() => setStatus(val)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </>
              )}
              <select
                className="library-sort-select"
                aria-label="排序方式"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortKey)}
              >
                <option value="default">默认排序</option>
                <option value="due">到期优先</option>
                <option value="lapses">易忘优先</option>
                <option value="updated">最近更新</option>
              </select>
              {hasDeckGroups && sortBy === "default" && (
                <div
                  className="group-view-toggle"
                  role="group"
                  aria-label="列表展示方式"
                >
                  <button
                    type="button"
                    className={viewMode === "grouped" ? "is-active" : ""}
                    aria-pressed={viewMode === "grouped"}
                    title="按分组展示"
                    onClick={() => setViewMode("grouped")}
                  >
                    <Layers2 size={14} />
                    <span>分组</span>
                  </button>
                  <button
                    type="button"
                    className={viewMode === "flat" ? "is-active" : ""}
                    aria-pressed={viewMode === "flat"}
                    title="平铺展示"
                    onClick={() => setViewMode("flat")}
                  >
                    <LayoutList size={14} />
                    <span>平铺</span>
                  </button>
                </div>
              )}
              <span className="list-count">{orderedQuestions.length} 道题</span>
              {!archived && cramEligible.length > 0 && !batchMode && (
                <Button
                  variant="outline"
                  size="sm"
                  className="cram-trigger-btn"
                  onClick={() => onCram(cramEligible, cramLabel)}
                >
                  <Flame size={14} /> 突击当前 ({cramEligible.length})
                </Button>
              )}
              {deck && filter !== "archived" && !batchMode && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onReview(deck.id)}
                >
                  复习题库
                  <ArrowRightIcon />
                </Button>
              )}
              {ownedFiltered.length > 0 && (
                <button
                  type="button"
                  className={`icon-button batch-toggle-btn ${batchMode ? "is-active" : ""}`}
                  title={batchMode ? "退出批量整理" : "批量整理"}
                  aria-label={batchMode ? "退出批量整理" : "批量整理"}
                  aria-pressed={batchMode}
                  onClick={() => {
                    if (batchMode) {
                      setBatchMode(false);
                      setSelectedIds([]);
                    } else {
                      setBatchMode(true);
                    }
                  }}
                >
                  <CheckSquare size={15} />
                </button>
              )}
              {availableTags.length > 0 && (
                <button
                  type="button"
                  className={`icon-button mobile-tag-toggle ${mobileTagsOpen || selectedTag ? "is-active" : ""}`}
                  title="按标签筛选"
                  aria-label="按标签筛选"
                  aria-expanded={mobileTagsOpen || Boolean(selectedTag)}
                  onClick={() => setMobileTagsOpen((v) => !v)}
                >
                  <Tags size={15} />
                </button>
              )}
            </div>
            {hasDeckGroups &&
              (groupCluster.hasCategories || focusedGroup) && (
                <div
                  className="group-category-bar"
                  role="group"
                  aria-label="按公司或分类筛选"
                >
                  <button
                    type="button"
                    className={`group-category-pill ${activeCategory === null && !focusedGroup ? "is-active" : ""}`}
                    aria-pressed={activeCategory === null && !focusedGroup}
                    onClick={() => {
                      setSelectedCategory(null);
                      setSelectedGroupId(null);
                    }}
                  >
                    全部
                    <small>{scopedQuestions.length}</small>
                  </button>
                  {categoryStats.items.map((item) => {
                    const active =
                      !focusedGroup && activeCategory === item.category;
                    return (
                      <button
                        type="button"
                        key={item.category}
                        className={`group-category-pill ${active ? "is-active" : ""}`}
                        aria-pressed={active}
                        onClick={() => {
                          setSelectedGroupId(null);
                          setSelectedCategory((curr) =>
                            curr === item.category ? null : item.category,
                          );
                        }}
                      >
                        {item.category}
                        <small>
                          {item.groupCount}场 · {item.questionCount}题
                        </small>
                      </button>
                    );
                  })}
                  {categoryStats.uncategorizedCount > 0 && (
                    <button
                      type="button"
                      className={`group-category-pill ${!focusedGroup && activeCategory === UNGROUPED_KEY ? "is-active" : ""}`}
                      aria-pressed={
                        !focusedGroup && activeCategory === UNGROUPED_KEY
                      }
                      onClick={() => {
                        setSelectedGroupId(null);
                        setSelectedCategory((curr) =>
                          curr === UNGROUPED_KEY ? null : UNGROUPED_KEY,
                        );
                      }}
                    >
                      {UNGROUPED_LABEL}
                      <small>{categoryStats.uncategorizedCount}</small>
                    </button>
                  )}
                  {focusedGroup && (
                    <button
                      type="button"
                      className="group-category-pill is-active"
                      aria-label={`清除分组筛选：${formatGroupLabel(focusedGroup)}`}
                      onClick={() => setSelectedGroupId(null)}
                    >
                      <span>{formatGroupLabel(focusedGroup)}</span>
                      <X size={12} aria-hidden="true" />
                    </button>
                  )}
                </div>
              )}
            {availableTags.length > 0 && (
              <div
                className={`library-tag-bar ${tagsExpanded ? "is-expanded" : ""} ${hasTagOverflow && !tagsExpanded ? "has-overflow" : ""} ${mobileTagsOpen || selectedTag ? "is-mobile-open" : ""}`}
                role="region"
                aria-label="按标签筛选"
              >
                <span className="tag-bar-label" aria-hidden="true">
                  <Tags size={14} />
                </span>
                <div className="tag-bar-chips" ref={tagChipsRef}>
                  <button
                    type="button"
                    className={`tag-filter-pill ${selectedTag === null ? "is-active" : ""}`}
                    aria-pressed={selectedTag === null}
                    onClick={() => setSelectedTag(null)}
                  >
                    全部标签
                  </button>
                  {availableTags.map(({ tag, count }) => (
                    <button
                      type="button"
                      key={tag}
                      data-active-tag={selectedTag === tag ? "true" : undefined}
                      className={`tag-filter-pill ${selectedTag === tag ? "is-active" : ""}`}
                      aria-pressed={selectedTag === tag}
                      title={`#${tag} (${count})`}
                      onClick={() =>
                        setSelectedTag((current) =>
                          current === tag ? null : tag,
                        )
                      }
                    >
                      <span className="tag-pill-label">
                        <span className="tag-hash" aria-hidden="true">
                          #
                        </span>
                        {tag}
                      </span>
                      <small>{count}</small>
                    </button>
                  ))}
                </div>
                {(hasTagOverflow || tagsExpanded) && (
                  <button
                    type="button"
                    className="tag-bar-toggle"
                    aria-expanded={tagsExpanded}
                    title={
                      tagsExpanded
                        ? "收起标签"
                        : `展开全部 ${availableTags.length} 个标签`
                    }
                    aria-label={
                      tagsExpanded
                        ? "收起标签"
                        : `展开全部 ${availableTags.length} 个标签`
                    }
                    onClick={() => setTagsExpanded((open) => !open)}
                  >
                    {!tagsExpanded && <span>+{availableTags.length}</span>}
                    <ChevronDown size={13} />
                  </button>
                )}
              </div>
            )}
          </div>
          {showGroupedContent && groupedBuckets ? (
            <div className="group-sections">
              {groupedBuckets.categoryBuckets.map((catBucket) => {
                const showCategoryHead =
                  groupedBuckets.hasCategories &&
                  catBucket.category !== "" &&
                  !focusedGroup;
                const catEligible = catBucket.sections.flatMap((s) =>
                  s.questions.filter((q) => !q.archived && q.answer.trim()),
                );
                return (
                  <section
                    className="group-category-section"
                    key={catBucket.category || "__uncat__"}
                  >
                    {showCategoryHead && (
                      <div className="group-category-head">
                        <div>
                          <h2>{catBucket.category}</h2>
                          <span>
                            {catBucket.sections.length} 场 ·{" "}
                            {catBucket.questionCount} 题
                          </span>
                        </div>
                        {!batchMode && (
                          <div className="group-category-actions">
                            {!archived && catEligible.length > 0 && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  onCram(catEligible, catBucket.category)
                                }
                              >
                                <Flame size={13} /> 突击本公司 (
                                {catEligible.length})
                              </Button>
                            )}
                            {deck?.isOwner && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setRenameCategoryTarget(catBucket.category);
                                  setRenameCategoryValue(catBucket.category);
                                }}
                              >
                                <PencilLine size={13} /> 重命名
                              </Button>
                            )}
                            {deck?.isOwner && onOpenGroupDialog && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  onOpenGroupDialog(
                                    deck,
                                    undefined,
                                    catBucket.category,
                                  )
                                }
                              >
                                <Plus size={13} /> 新建场次
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    {catBucket.sections.map((sec) => {
                      const group = sec.group;
                      const groupKey = group ? group.id : UNGROUPED_KEY;
                      const expanded =
                        hasActiveListFilter ||
                        Boolean(focusedGroup) ||
                        !collapsedGroups.has(groupKey);
                      const secVisible =
                        groupVisibleCounts[groupKey] ?? GROUP_PAGE_SIZE;
                      const secEligible = sec.questions.filter(
                        (q) => !q.archived && q.answer.trim(),
                      );
                      const secDueCount = secEligible.filter(
                        (q) =>
                          q.fsrs &&
                          new Date(q.fsrs.due).getTime() <= Date.now(),
                      ).length;
                      const totalInGroup = groupTotalsById.get(groupKey) ?? 0;
                      const orderIdx = group
                        ? groupCluster.orderedGroups.findIndex(
                            (g) => g.id === group.id,
                          )
                        : -1;
                      const groupLabel = group
                        ? formatGroupLabel(group)
                        : UNGROUPED_LABEL;
                      return (
                        <div
                          className="group-accordion"
                          key={groupKey}
                          data-collapsed={!expanded}
                        >
                          <div className="group-accordion-head">
                            <button
                              type="button"
                              className="group-accordion-toggle"
                              aria-expanded={expanded}
                              onClick={() => toggleGroupCollapse(groupKey)}
                            >
                              {expanded ? (
                                <ChevronDown size={15} aria-hidden="true" />
                              ) : (
                                <ChevronRight size={15} aria-hidden="true" />
                              )}
                              <div className="group-accordion-title-wrap">
                                <h3>{group ? group.title : UNGROUPED_LABEL}</h3>
                                {group?.description && (
                                  <p className="group-accordion-desc">
                                    {group.description}
                                  </p>
                                )}
                              </div>
                              <span className="group-accordion-meta">
                                {hasActiveListFilter
                                  ? `匹配 ${sec.questions.length} / ${totalInGroup} 题`
                                  : `${sec.questions.length} 题`}
                                {secDueCount > 0 ? ` · ${secDueCount} 待复习` : ""}
                              </span>
                            </button>
                            {!batchMode && (
                              <div className="group-accordion-tools">
                                {!archived && secEligible.length > 0 && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() =>
                                      onCram(secEligible, groupLabel)
                                    }
                                  >
                                    <Flame size={13} /> 突击本组
                                  </Button>
                                )}
                                {group && deck?.isOwner && (
                                  <ActionMenu label={`管理分组：${group.title}`}>
                                    {onOpenGroupDialog && (
                                      <button
                                        onClick={() =>
                                          onOpenGroupDialog(deck, group)
                                        }
                                      >
                                        <PencilLine size={15} />
                                        编辑分组
                                      </button>
                                    )}
                                    {onCreateQuestionInGroup && (
                                      <button
                                        onClick={() =>
                                          onCreateQuestionInGroup(group.id)
                                        }
                                      >
                                        <PenLine size={15} />
                                        在此新建题目
                                      </button>
                                    )}
                                    {onImportToGroup && (
                                      <button
                                        onClick={() => onImportToGroup(group.id)}
                                      >
                                        <Upload size={15} />
                                        导入到此分组
                                      </button>
                                    )}
                                    {orderIdx > 0 && (
                                      <button
                                        disabled={groupActionBusy}
                                        onClick={() =>
                                          void handleReorderGroup(group.id, -1)
                                        }
                                      >
                                        <ArrowUp size={15} />
                                        上移分组
                                      </button>
                                    )}
                                    {orderIdx >= 0 &&
                                      orderIdx <
                                        groupCluster.orderedGroups.length -
                                          1 && (
                                        <button
                                          disabled={groupActionBusy}
                                          onClick={() =>
                                            void handleReorderGroup(group.id, 1)
                                          }
                                        >
                                          <ArrowDown size={15} />
                                          下移分组
                                        </button>
                                      )}
                                    <button
                                      className="danger-text"
                                      onClick={() => setDeleteGroupTarget(group)}
                                    >
                                      <Trash2 size={15} />
                                      删除分组（保留题目）
                                    </button>
                                  </ActionMenu>
                                )}
                              </div>
                            )}
                          </div>
                          {expanded && (
                            <div className="group-accordion-body">
                              {sec.questions.length ? (
                                <>
                                  <div className="question-list">
                                    {sec.questions
                                      .slice(0, secVisible)
                                      .map((q, i) =>
                                        renderQuestionRow(q, i, false),
                                      )}
                                  </div>
                                  {secVisible < sec.questions.length && (
                                    <button
                                      type="button"
                                      className="load-more-questions"
                                      onClick={() =>
                                        setGroupVisibleCounts((prev) => ({
                                          ...prev,
                                          [groupKey]:
                                            secVisible + GROUP_PAGE_SIZE,
                                        }))
                                      }
                                    >
                                      展开剩余{" "}
                                      {sec.questions.length - secVisible} 道题
                                    </button>
                                  )}
                                </>
                              ) : (
                                <div className="group-empty-note">
                                  <span>这个分组还没有题目。</span>
                                  {group && deck?.isOwner && (
                                    <div>
                                      {onImportToGroup && (
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          onClick={() =>
                                            onImportToGroup(group.id)
                                          }
                                        >
                                          <Upload size={13} /> 导入到此分组
                                        </Button>
                                      )}
                                      {onCreateQuestionInGroup && (
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          onClick={() =>
                                            onCreateQuestionInGroup(group.id)
                                          }
                                        >
                                          <PenLine size={13} /> 新建单题
                                        </Button>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </section>
                );
              })}
            </div>
          ) : orderedQuestions.length ? (
            <div className="question-list">
              {orderedQuestions
                .slice(0, visibleCount)
                .map((q, i) => renderQuestionRow(q, i, true))}
              {visibleCount < orderedQuestions.length && (
                <button
                  ref={more}
                  className="load-more-questions"
                  onClick={() => setVisibleCount((count) => count + 40)}
                >
                  加载更多题目
                </button>
              )}
            </div>
          ) : (
            <div className="empty-state">
              <CircleDashed size={34} />
              <h3>
                {hasAnyFilter ? "没有找到匹配的题目" : "这里还没有题目"}
              </h3>
              <p>
                {hasAnyFilter
                  ? "没有匹配题目，试试调整搜索词、分组、标签或状态筛选。"
                  : archived
                    ? "归档的题目存放在这里，随时可恢复练习。"
                    : filter === "favorites"
                      ? "在题目页点击星标收藏重点题，方便集中复习。"
                      : filter === "inbox"
                        ? "当前没有缺答案的题目；导入「只有题目」的清单会汇集到这里。"
                        : "导入 Markdown / txt 笔记，自动识别题目与 Obsidian 标签。"}
              </p>
              {hasAnyFilter ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSearch("");
                    setStatus("all");
                    setSelectedTag(null);
                    setSelectedCategory(null);
                    setSelectedGroupId(null);
                  }}
                >
                  清除筛选
                </Button>
              ) : (
                !archived &&
                filter !== "favorites" &&
                (!deck || deck.isOwner) && (
                  <Button variant="outline" size="sm" onClick={onImport}>
                    导入题目
                  </Button>
                )
              )}
            </div>
          )}
        </div>
      )}
      {batchMode && (
        <div
          className="batch-action-bar"
          role="region"
          aria-label="批量整理操作栏"
        >
          <div className="batch-bar-meta">
            <strong>
              已选 {activeSelectedIds.length} / {ownedVisibleIds.length}
            </strong>
            <button
              type="button"
              className="text-button"
              disabled={batchBusy || ownedVisibleIds.length === 0}
              onClick={() =>
                setSelectedIds(
                  activeSelectedIds.length === ownedVisibleIds.length
                    ? []
                    : ownedVisibleIds,
                )
              }
            >
              {activeSelectedIds.length === ownedVisibleIds.length
                ? "清空"
                : "全选"}
            </button>
          </div>
          <div className="batch-bar-actions">
            <Button
              variant="outline"
              size="sm"
              disabled={!activeSelectedIds.length || batchBusy}
              onClick={() => {
                if (deck?.isOwner) {
                  setBatchTargetDeckId(deck.id);
                  setBatchTargetGroupId("");
                } else {
                  const candidate = ownedDecks.find((d) => d.id !== deckId);
                  setBatchTargetDeckId(candidate?.id ?? "");
                  setBatchTargetGroupId("");
                }
                setBatchNewGroupCategory("");
                setBatchNewGroupTitle("");
                setBatchDialog("move");
              }}
            >
              <FolderInput size={14} /> 移动
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!activeSelectedIds.length || batchBusy}
              onClick={() =>
                void runBatch(archived ? "unarchive" : "archive")
              }
            >
              {archived ? (
                <ArchiveRestore size={14} />
              ) : (
                <Archive size={14} />
              )}{" "}
              {archived ? "恢复" : "归档"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="danger-text"
              disabled={!activeSelectedIds.length || batchBusy}
              onClick={() => setBatchDialog("delete")}
            >
              <Trash2 size={14} /> 删除
            </Button>
            <Button
              size="sm"
              disabled={batchBusy}
              onClick={() => {
                setBatchMode(false);
                setSelectedIds([]);
              }}
            >
              完成
            </Button>
          </div>
        </div>
      )}
      <Dialog
        open={batchDialog !== null}
        onOpenChange={(open) => {
          if (!open && !batchBusy) setBatchDialog(null);
        }}
        title={batchDialog === "delete" ? "批量删除题目" : "批量移动题目"}
        description={`已选 ${activeSelectedIds.length} 道题`}
      >
        <div className="dialog-form">
          {batchDialog === "delete" ? (
            <p className="muted">
              选中的 {activeSelectedIds.length}{" "}
              道题目将移入回收站保留 30 天，到期前随时可以恢复。
            </p>
          ) : (
            <>
              <label className="field">
                目标题库
                <select
                  aria-label="批量移动目标题库"
                  value={batchTargetDeckId}
                  disabled={batchBusy}
                  onChange={(e) => {
                    setBatchTargetDeckId(e.target.value);
                    setBatchTargetGroupId("");
                    setBatchNewGroupCategory("");
                    setBatchNewGroupTitle("");
                  }}
                >
                  <option value="">未分类</option>
                  <DeckSelectOptions decks={ownedDecks} />
                </select>
              </label>
              {batchTargetDeck && (
                <label className="field">
                  目标分组（可选）
                  <select
                    aria-label="批量移动目标分组"
                    value={batchTargetGroupId}
                    disabled={batchBusy}
                    onChange={(e) => setBatchTargetGroupId(e.target.value)}
                  >
                    <GroupSelectOptions groups={batchTargetGroups} />
                    <option value={NEW_GROUP_VALUE}>+ 新建分组并移入…</option>
                  </select>
                </label>
              )}
              {batchCreatingNewGroup && (
                <div className="inline-group-create">
                  <label className="field">
                    分类 / 公司（可选）
                    <input
                      list={
                        batchTargetCategories.length
                          ? batchCategoryListId
                          : undefined
                      }
                      value={batchNewGroupCategory}
                      onChange={(e) => setBatchNewGroupCategory(e.target.value)}
                      onKeyDown={(e) => {
                        if (
                          e.key === "Enter" &&
                          !e.nativeEvent.isComposing &&
                          !batchBusy &&
                          !batchNewGroupInvalid &&
                          activeSelectedIds.length > 0
                        ) {
                          e.preventDefault();
                          void runBatch(
                            "move",
                            batchTargetDeckId || null,
                            batchTargetDeckId && batchTargetGroupId
                              ? batchTargetGroupId
                              : null,
                          );
                        }
                      }}
                      maxLength={40}
                      disabled={batchBusy}
                      placeholder="如：字节跳动（可留空）"
                    />
                  </label>
                  <label className="field">
                    新分组名称
                    <input
                      value={batchNewGroupTitle}
                      onChange={(e) => setBatchNewGroupTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (
                          e.key === "Enter" &&
                          !e.nativeEvent.isComposing &&
                          !batchBusy &&
                          !batchNewGroupInvalid &&
                          activeSelectedIds.length > 0
                        ) {
                          e.preventDefault();
                          void runBatch(
                            "move",
                            batchTargetDeckId || null,
                            batchTargetDeckId && batchTargetGroupId
                              ? batchTargetGroupId
                              : null,
                          );
                        }
                      }}
                      maxLength={80}
                      disabled={batchBusy}
                      placeholder="如：抖音后端一面"
                      autoFocus
                    />
                  </label>
                  {batchTargetCategories.length > 0 && (
                    <datalist id={batchCategoryListId}>
                      {batchTargetCategories.map((cat) => (
                        <option key={cat} value={cat} />
                      ))}
                    </datalist>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        <div className="dialog-footer">
          <Button
            variant="ghost"
            disabled={batchBusy}
            onClick={() => setBatchDialog(null)}
          >
            取消
          </Button>
          <Button
            variant={batchDialog === "delete" ? "danger" : "default"}
            disabled={
              batchBusy ||
              !activeSelectedIds.length ||
              (batchDialog === "move" && batchNewGroupInvalid)
            }
            onClick={() =>
              void runBatch(
                batchDialog === "delete" ? "delete" : "move",
                batchDialog === "move" ? batchTargetDeckId || null : undefined,
                batchDialog === "move"
                  ? batchTargetDeckId && batchTargetGroupId
                    ? batchTargetGroupId
                    : null
                  : undefined,
              )
            }
          >
            {batchBusy ? (
              <Loader2 size={15} className="spin" />
            ) : batchDialog === "delete" ? (
              <Trash2 size={15} />
            ) : (
              <FolderInput size={15} />
            )}{" "}
            {batchDialog === "delete" ? "移入回收站" : "移动"}
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={deleteGroupTarget !== null}
        onOpenChange={(open) => {
          if (!open && !groupActionBusy) setDeleteGroupTarget(null);
        }}
        title="删除分组"
        description={
          deleteGroupTarget ? formatGroupLabel(deleteGroupTarget) : undefined
        }
      >
        <div className="dialog-form">
          <p className="muted">
            仅删除该分组标签，组内题目会安全保留在当前题库的「未分组」中，答案、笔记与复习记录不会丢失。
          </p>
        </div>
        <div className="dialog-footer">
          <Button
            variant="ghost"
            disabled={groupActionBusy}
            onClick={() => setDeleteGroupTarget(null)}
          >
            取消
          </Button>
          <Button
            variant="danger"
            disabled={groupActionBusy}
            onClick={() => void confirmDeleteGroup()}
          >
            {groupActionBusy ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <Trash2 size={15} />
            )}{" "}
            删除分组，保留题目
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={renameDeckGroupTarget !== null}
        onOpenChange={(open) => {
          if (!open && !groupActionBusy) setRenameDeckGroupTarget(null);
        }}
        title="重命名题库分组"
        description={
          renameDeckGroupTarget
            ? `当前分组：${renameDeckGroupTarget}`
            : undefined
        }
      >
        <div className="dialog-form">
          <label className="field">
            新分组名称
            <input
              value={renameDeckGroupValue}
              onChange={(e) => setRenameDeckGroupValue(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.nativeEvent.isComposing &&
                  !groupActionBusy &&
                  Boolean(renameDeckGroupValue.trim()) &&
                  renameDeckGroupValue.trim().length <= 40 &&
                  renameDeckGroupValue.trim() !== renameDeckGroupTarget
                ) {
                  e.preventDefault();
                  void confirmRenameDeckGroup();
                }
              }}
              maxLength={40}
              disabled={groupActionBusy}
              placeholder="输入新的题库分组名称"
              autoFocus
            />
          </label>
        </div>
        <div className="dialog-footer">
          <Button
            variant="ghost"
            disabled={groupActionBusy}
            onClick={() => setRenameDeckGroupTarget(null)}
          >
            取消
          </Button>
          <Button
            disabled={
              groupActionBusy ||
              !renameDeckGroupValue.trim() ||
              renameDeckGroupValue.trim().length > 40 ||
              renameDeckGroupValue.trim() === renameDeckGroupTarget
            }
            onClick={() => void confirmRenameDeckGroup()}
          >
            {groupActionBusy ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <Check size={15} />
            )}{" "}
            保存名称
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={dissolveDeckGroupTarget !== null}
        onOpenChange={(open) => {
          if (!open && !groupActionBusy) setDissolveDeckGroupTarget(null);
        }}
        title="解散题库分组"
        description={
          dissolveDeckGroupTarget
            ? `分组：${dissolveDeckGroupTarget}`
            : undefined
        }
      >
        <div className="dialog-form">
          <p className="muted">
            仅移除该分组名称，组内所有题库与题目都会安全保留在题库列表中，不会被删除。
          </p>
        </div>
        <div className="dialog-footer">
          <Button
            variant="ghost"
            disabled={groupActionBusy}
            onClick={() => setDissolveDeckGroupTarget(null)}
          >
            取消
          </Button>
          <Button
            variant="danger"
            disabled={groupActionBusy}
            onClick={() => void confirmDissolveDeckGroup()}
          >
            {groupActionBusy ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <Trash2 size={15} />
            )}{" "}
            确认解散
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={renameCategoryTarget !== null}
        onOpenChange={(open) => {
          if (!open && !groupActionBusy) setRenameCategoryTarget(null);
        }}
        title="重命名分类 / 公司"
        description={
          renameCategoryTarget
            ? `将同步更新「${renameCategoryTarget}」下所有场次`
            : undefined
        }
      >
        <div className="dialog-form">
          <label className="field">
            新分类名称
            <input
              value={renameCategoryValue}
              onChange={(e) => setRenameCategoryValue(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.nativeEvent.isComposing &&
                  !groupActionBusy &&
                  Boolean(renameCategoryValue.trim()) &&
                  renameCategoryValue.trim().length <= 40 &&
                  renameCategoryValue.trim() !== renameCategoryTarget
                ) {
                  e.preventDefault();
                  void confirmRenameCategory();
                }
              }}
              maxLength={40}
              disabled={groupActionBusy}
              placeholder="例如：字节跳动"
              autoFocus
            />
          </label>
        </div>
        <div className="dialog-footer">
          <Button
            variant="ghost"
            disabled={groupActionBusy}
            onClick={() => setRenameCategoryTarget(null)}
          >
            取消
          </Button>
          <Button
            disabled={
              groupActionBusy ||
              !renameCategoryValue.trim() ||
              renameCategoryValue.trim().length > 40 ||
              renameCategoryValue.trim() === renameCategoryTarget
            }
            onClick={() => void confirmRenameCategory()}
          >
            {groupActionBusy ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <Check size={15} />
            )}{" "}
            保存修改
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
function ArrowRightIcon() {
  return <ArrowUpRight size={14} />;
}
