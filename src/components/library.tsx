"use client";

import dynamic from "next/dynamic";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Archive,
  ArrowLeft,
  ArrowUpDown,
  CheckSquare,
  ChevronRight,
  Clock,
  CopyCheck,
  Download,
  Edit3,
  FilePlus2,
  Flame,
  Folder,
  FolderInput,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  Globe,
  Home,
  Link2,
  PenLine,
  Play,
  RotateCcw,
  Rss,
  Search,
  Sparkles,
  Square,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type {
  DeckView,
  FolderConflictItem,
  QuestionView,
  Workspace,
} from "@/lib/types";
import type { LibraryQuickView } from "@/lib/navigation";
import {
  RequestError,
  batchMoveQuestionsToFolder,
  moveFolder,
  moveQuestionToFolder,
  placeSubscriptionInFolder,
  type WorkspaceMutate,
} from "@/lib/client";
import {
  ROOT_FOLDER_LABEL,
  buildFolderIndex,
  findExactDuplicateClusters,
  readRecentQuestionIds,
  sortQuestionsList,
  type ItemSortKey,
} from "@/lib/folders";
import {
  buildReviewQueue,
  isQuestionDue,
  isQuestionMajorRevisionDue,
} from "@/lib/review-queue";
import { relativeDue } from "@/lib/utils";
import { ActionMenu } from "./ui/action-menu";
import { Button } from "./ui/button";
import {
  DRAG_MIME,
  FolderTree,
  parseDragPayload,
  type DragMovePayload,
} from "./folder-tree";
import type {
  DuplicateConflictDetail,
  MoveSelection,
} from "./folder-move-dialog";
const DuplicatesView = dynamic(
  () => import("./duplicates-view").then((m) => m.DuplicatesView),
  { ssr: false },
);
const LibraryTrash = dynamic(
  () => import("./library-trash").then((m) => m.LibraryTrash),
  { ssr: false },
);
import { useDiscretePresence } from "./use-discrete-presence";

export type LibraryProps = {
  data: Workspace;
  folderId: string | null;
  quickView: LibraryQuickView | null;
  subGroupId: string | null;
  recentVersion?: number;
  selectionResetToken?: number;
  searchToken?: number;
  mutate: WorkspaceMutate;
  onSelectFolder: (folderId: string | null, subGroupId?: string | null) => void;
  onSelectSubGroup: (subGroupId: string | null) => void;
  onSelectQuickView: (quick: LibraryQuickView | null) => void;
  onOpenQuestion: (q: QuestionView, orderedIds?: string[]) => void;
  onPractice: (q: QuestionView) => void;
  onReviewFolder: (folderId?: string) => void;
  onCram: (questions: QuestionView[], label: string) => void;
  onCreateFolder: (parentId: string | null) => void;
  onEditFolder: (folder: DeckView) => void;
  onDissolveFolder: (folder: DeckView) => void;
  onDeleteFolderTrash: (folder: DeckView) => void;
  onOpenMoveDialog: (selection: MoveSelection) => void;
  onOpenGroupIntoNew: (selection: {
    parentId: string | null;
    folderIds: string[];
    questionIds: string[];
    subscriptionDeckIds: string[];
  }) => void;
  onPublishFolder: (folderId: string) => void;
  onBatchPublish: () => void;
  onCreateQuestion: (folderId: string | null) => void;
  onImport: (folderId: string | null) => void;
  onDeleteQuestion: (q: QuestionView) => void;
  onFavorite: (q: QuestionView) => void;
  onGenerateAnswer: (q: QuestionView) => void;
  onApplyUpdate: (deckId: string, version: number) => void;
  onDismissUpdate: (deckId: string, version: number) => void;
  onUnsubscribe: (deckId: string) => void;
  onOpenAiDedup: () => void;
};

const QUICK_VIEW_TITLES: Record<LibraryQuickView, string> = {
  recent: "最近打开",
  favorites: "收藏",
  inbox: "待补答案",
  duplicates: "重复内容",
  archived: "已归档",
  trash: "回收站",
};

export function Library({
  data,
  folderId,
  quickView,
  subGroupId,
  recentVersion = 0,
  selectionResetToken = 0,
  searchToken = 0,
  mutate,
  onSelectFolder,
  onSelectSubGroup,
  onSelectQuickView,
  onOpenQuestion,
  onPractice,
  onReviewFolder,
  onCram,
  onCreateFolder,
  onEditFolder,
  onDissolveFolder,
  onDeleteFolderTrash,
  onOpenMoveDialog,
  onOpenGroupIntoNew,
  onPublishFolder,
  onBatchPublish,
  onCreateQuestion,
  onImport,
  onDeleteQuestion,
  onFavorite,
  onGenerateAnswer,
  onApplyUpdate,
  onDismissUpdate,
  onUnsubscribe,
  onOpenAiDedup,
}: LibraryProps) {
  const index = useMemo(() => buildFolderIndex(data.decks), [data.decks]);
  const activeDeck = folderId ? (index.byId.get(folderId) ?? null) : null;
  const isSubscriptionView = Boolean(activeDeck && !activeDeck.isOwner);
  const currentOwnedFolderId =
    activeDeck && activeDeck.isOwner ? activeDeck.id : null;

  // Search & sorting state.
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const [searchGlobal, setSearchGlobal] = useState(false);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<ItemSortKey>("name");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchToken > 0) {
      searchInputRef.current?.focus();
    }
  }, [searchToken]);

  // Reset folder-scoped toggles when changing location.
  useEffect(() => {
    setSearchGlobal(false);
    setActiveTag(null);
  }, [folderId, quickView]);

  // Multiselect state (supports mixed owned folders, owned items, and subscriptions).
  const [selectMode, setSelectMode] = useState(false);
  const multiselectBarPresence = useDiscretePresence<HTMLDivElement>(selectMode);
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedQuestionIds, setSelectedQuestionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedSubIds, setSelectedSubIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [batchBusy, setBatchBusy] = useState(false);
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);

  // Mobile long-press gesture tracking for entering multiselect.
  const longPressTimer = useRef<number | null>(null);
  const longPressOrigin = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);

  const clearSelection = useCallback(() => {
    setSelectedFolderIds(new Set());
    setSelectedQuestionIds(new Set());
    setSelectedSubIds(new Set());
    setSelectMode(false);
  }, []);

  useEffect(() => {
    clearSelection();
  }, [folderId, quickView, subGroupId, selectionResetToken, clearSelection]);

  const startLongPress = (e: React.PointerEvent, onTrigger: () => void) => {
    if (e.pointerType === "mouse" || selectMode) return;
    longPressOrigin.current = { x: e.clientX, y: e.clientY };
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = window.setTimeout(() => {
      longPressTimer.current = null;
      suppressClickRef.current = true;
      setSelectMode(true);
      onTrigger();
    }, 450);
  };

  const moveLongPress = (e: React.PointerEvent) => {
    if (!longPressTimer.current || !longPressOrigin.current) return;
    if (
      Math.hypot(
        e.clientX - longPressOrigin.current.x,
        e.clientY - longPressOrigin.current.y,
      ) > 10
    ) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const cancelLongPress = () => {
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  // Counts for tree & quick views.
  const recentIds = useMemo(
    () => readRecentQuestionIds(data.user.id),
    [data.user.id, data.questions, recentVersion, quickView],
  );
  const duplicateClusters = useMemo(
    () => findExactDuplicateClusters(data.questions),
    [data.questions],
  );
  const quickCounts = useMemo(() => {
    const activeQs = data.questions.filter((q) => !q.archived);
    const activeMap = new Set(activeQs.map((q) => q.id));
    return {
      all: activeQs.length,
      recent: recentIds.filter((id) => activeMap.has(id)).length,
      favorites: activeQs.filter((q) => q.favorite).length,
      inbox: activeQs.filter((q) => q.isOwner && q.needsEditing).length,
      duplicates: duplicateClusters.length,
      archived: data.questions.filter((q) => q.archived).length,
    };
  }, [data.questions, recentIds, duplicateClusters.length]);

  // Recursive subtree scope for current owned folder (owned folders + placed subscriptions).
  const currentSubtreeDeckIds = useMemo(() => {
    if (!activeDeck) return null;
    if (!activeDeck.isOwner) return new Set<string>([activeDeck.id]);
    const ownedIds = index.subtreeOwnedIds(activeDeck.id);
    const all = new Set<string>(ownedIds);
    for (const fid of ownedIds) {
      for (const sub of index.subscriptionsByFolder.get(fid) ?? []) {
        all.add(sub.id);
      }
    }
    return all;
  }, [activeDeck, index]);

  // Subtree review & cram counts for current folder.
  const folderPracticeStats = useMemo(() => {
    if (quickView) return { sessionReady: 0, cramItems: [] as QuestionView[] };
    const { queue, active } = buildReviewQueue(data.questions, {
      dailyNewLimit: data.settings.dailyNewLimit,
      newLearnedToday: data.stats.newLearnedToday,
      ...(currentSubtreeDeckIds ? { deckIds: currentSubtreeDeckIds } : {}),
    });
    return { sessionReady: queue.length, cramItems: active };
  }, [
    quickView,
    data.questions,
    data.settings.dailyNewLimit,
    data.stats.newLearnedToday,
    currentSubtreeDeckIds,
  ]);

  // Current level child folders & placed subscriptions (when browsing owned folder or root).
  const currentChildFolders = useMemo(() => {
    if (quickView || isSubscriptionView) return [];
    return index.ownedChildren.get(currentOwnedFolderId) ?? [];
  }, [quickView, isSubscriptionView, index, currentOwnedFolderId]);

  const currentPlacedSubs = useMemo(() => {
    if (quickView || isSubscriptionView) return [];
    return index.subscriptionsByFolder.get(currentOwnedFolderId) ?? [];
  }, [quickView, isSubscriptionView, index, currentOwnedFolderId]);

  // Subscribed deck internal subfolders & breadcrumbs.
  const subGroupTree = useMemo(() => {
    if (!isSubscriptionView || !activeDeck) {
      return {
        byId: new Map<string, DeckView["groups"][number]>(),
        children: new Map<string | null, DeckView["groups"]>(),
        breadcrumbs: [] as DeckView["groups"],
        counts: new Map<string, number>(),
      };
    }
    const byId = new Map(activeDeck.groups.map((g) => [g.id, g]));
    const children = new Map<string | null, DeckView["groups"]>();
    children.set(null, []);
    for (const g of activeDeck.groups) {
      const pid = g.parentId && byId.has(g.parentId) ? g.parentId : null;
      const list = children.get(pid);
      if (list) list.push(g);
      else children.set(pid, [g]);
    }
    const directCounts = new Map<string, number>();
    for (const q of data.questions) {
      if (q.archived || q.deckId !== activeDeck.id || !q.groupId) continue;
      if (byId.has(q.groupId)) {
        directCounts.set(q.groupId, (directCounts.get(q.groupId) ?? 0) + 1);
      }
    }
    const counts = new Map<string, number>();
    const countSubtree = (id: string, visiting = new Set<string>()): number => {
      const cached = counts.get(id);
      if (cached !== undefined) return cached;
      if (visiting.has(id)) return 0;
      visiting.add(id);
      let total = directCounts.get(id) ?? 0;
      for (const child of children.get(id) ?? []) {
        total += countSubtree(child.id, visiting);
      }
      counts.set(id, total);
      return total;
    };
    for (const g of activeDeck.groups) {
      countSubtree(g.id);
    }
    const breadcrumbs: DeckView["groups"] = [];
    const seen = new Set<string>();
    let cur = subGroupId && byId.has(subGroupId) ? subGroupId : null;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const node = byId.get(cur);
      if (!node) break;
      breadcrumbs.unshift(node);
      cur = node.parentId && byId.has(node.parentId) ? node.parentId : null;
    }
    return { byId, children, breadcrumbs, counts };
  }, [isSubscriptionView, activeDeck, subGroupId, data.questions]);

  const currentSubChildGroups = useMemo(() => {
    if (!isSubscriptionView) return [];
    const cur =
      subGroupId && subGroupTree.byId.has(subGroupId) ? subGroupId : null;
    return subGroupTree.children.get(cur) ?? [];
  }, [isSubscriptionView, subGroupId, subGroupTree]);

  // Compute displayed questions list according to mode:
  // - Quick views: filter globally, always showing real folderPath
  // - Search active: recursive subtree search (or global if searchGlobal=true)
  // - Browse mode: direct current-level items only (or direct group items inside subscription)
  const { visibleQuestions, availableTags, isSearching } = useMemo(() => {
    const isSearch = Boolean(deferredSearch || activeTag);
    const terms = deferredSearch.split(/\s+/).filter(Boolean);

    let pool: QuestionView[];
    if (quickView === "recent") {
      const byId = new Map(
        data.questions.filter((q) => !q.archived).map((q) => [q.id, q]),
      );
      pool = recentIds
        .map((id) => byId.get(id))
        .filter((q): q is QuestionView => Boolean(q));
    } else if (quickView === "favorites") {
      pool = data.questions.filter((q) => !q.archived && q.favorite);
    } else if (quickView === "inbox") {
      pool = data.questions.filter(
        (q) => !q.archived && q.isOwner && q.needsEditing,
      );
    } else if (quickView === "archived") {
      pool = data.questions.filter((q) => q.archived);
    } else if (quickView === "duplicates" || quickView === "trash") {
      pool = [];
    } else if (isSearch) {
      if (searchGlobal || !currentSubtreeDeckIds) {
        pool = data.questions.filter((q) => !q.archived);
      } else {
        pool = data.questions.filter(
          (q) =>
            !q.archived &&
            q.deckId !== null &&
            currentSubtreeDeckIds.has(q.deckId),
        );
      }
    } else if (isSubscriptionView && activeDeck) {
      const curGroup =
        subGroupId && subGroupTree.byId.has(subGroupId) ? subGroupId : null;
      pool = data.questions.filter(
        (q) =>
          !q.archived &&
          q.deckId === activeDeck.id &&
          (curGroup
            ? q.groupId === curGroup
            : !q.groupId || !subGroupTree.byId.has(q.groupId)),
      );
    } else {
      // Direct items in current owned folder (or root).
      pool = data.questions.filter(
        (q) => !q.archived && q.isOwner && q.deckId === currentOwnedFolderId,
      );
    }

    // Collect top tags from current scope before tag filter.
    const tagCounts = new Map<string, number>();
    for (const q of pool) {
      for (const t of q.tags) {
        tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      }
    }
    const tags = Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
      .slice(0, 12)
      .map(([t]) => t);

    let filtered = pool;
    if (activeTag) {
      filtered = filtered.filter((q) => q.tags.includes(activeTag));
    }
    if (terms.length) {
      filtered = filtered.filter((q) => {
        const hay =
          `${q.title}\n${q.tags.join(" ")}\n${q.folderPath}\n${q.answer.slice(0, 1200)}\n${q.note.slice(0, 400)}`.toLowerCase();
        return terms.every((term) => hay.includes(term));
      });
    }

    const sorted =
      quickView === "recent" && !isSearch
        ? filtered
        : sortQuestionsList(filtered, sortBy);

    return {
      visibleQuestions: sorted,
      availableTags: tags,
      isSearching: isSearch,
    };
  }, [
    data.questions,
    quickView,
    recentIds,
    deferredSearch,
    activeTag,
    searchGlobal,
    currentSubtreeDeckIds,
    isSubscriptionView,
    activeDeck,
    subGroupId,
    subGroupTree.byId,
    currentOwnedFolderId,
    sortBy,
  ]);

  const orderedQuestionIds = useMemo(
    () => visibleQuestions.map((q) => q.id),
    [visibleQuestions],
  );

  // Drag-and-drop move execution (with seamless conflict fallback into FolderMoveDialog!).
  const handleDropMove = useCallback(
    async (targetFolderId: string | null, payload: DragMovePayload) => {
      const rawFolderIds =
        payload.kind === "folder"
          ? payload.ids
          : payload.kind === "mixed"
            ? payload.folderIds
            : [];
      const rawQuestionIds =
        payload.kind === "question"
          ? payload.ids
          : payload.kind === "mixed"
            ? payload.questionIds
            : [];
      const rawSubIds =
        payload.kind === "subscription"
          ? payload.ids
          : payload.kind === "mixed"
            ? payload.subscriptionDeckIds
            : [];

      // Reject self/descendant drop across ANY dragged folder before partially mutating anything.
      if (targetFolderId) {
        const selfCycle = rawFolderIds.some((fid) =>
          index.subtreeOwnedIds(fid).has(targetFolderId),
        );
        if (selfCycle) {
          if (
            rawFolderIds.length === 1 &&
            rawQuestionIds.length === 0 &&
            rawSubIds.length === 0 &&
            rawFolderIds[0] === targetFolderId
          ) {
            return;
          }
          toast.error("不能将文件夹移动到自身或其子文件夹中。");
          return;
        }
      }

      // Skip no-op items already located directly in targetFolderId.
      const questionById = new Map(data.questions.map((q) => [q.id, q]));
      const fIds = rawFolderIds.filter((fid) => {
        const f = index.byId.get(fid);
        return Boolean(f && f.isOwner && f.parentId !== targetFolderId);
      });
      const qIds = rawQuestionIds.filter((qid) => {
        const q = questionById.get(qid);
        return Boolean(q && q.isOwner && q.deckId !== targetFolderId);
      });
      const sIds = rawSubIds.filter((sid) => {
        const sub = index.byId.get(sid);
        return Boolean(
          sub && !sub.isOwner && (sub.parentId ?? null) !== targetFolderId,
        );
      });
      if (fIds.length === 0 && qIds.length === 0 && sIds.length === 0) {
        return;
      }

      const targetLabel = targetFolderId
        ? index.pathOf(targetFolderId)
        : ROOT_FOLDER_LABEL;

      const remainingFolders = [...fIds];
      let remainingQuestions = [...qIds];
      const remainingSubs = [...sIds];
      const pruneMovedSelection = () => {
        if (remainingFolders.length < fIds.length) {
          const remainingSet = new Set(remainingFolders);
          setSelectedFolderIds((prev) => {
            const next = new Set<string>();
            for (const id of prev) {
              if (!fIds.includes(id) || remainingSet.has(id)) next.add(id);
            }
            return next;
          });
        }
        if (remainingQuestions.length < qIds.length) {
          const remainingSet = new Set(remainingQuestions);
          setSelectedQuestionIds((prev) => {
            const next = new Set<string>();
            for (const id of prev) {
              if (!qIds.includes(id) || remainingSet.has(id)) next.add(id);
            }
            return next;
          });
        }
        if (remainingSubs.length < sIds.length) {
          const remainingSet = new Set(remainingSubs);
          setSelectedSubIds((prev) => {
            const next = new Set<string>();
            for (const id of prev) {
              if (!sIds.includes(id) || remainingSet.has(id)) next.add(id);
            }
            return next;
          });
        }
      };

      try {
        while (remainingFolders.length > 0) {
          const fid = remainingFolders[0];
          const res = await moveFolder(
            mutate,
            {
              folderId: fid,
              targetParentId: targetFolderId,
              conflictStrategy: "abort",
            },
            { throwOnCodes: ["FOLDER_NAME_CONFLICT"] },
          );
          if (!res) {
            pruneMovedSelection();
            return;
          }
          remainingFolders.shift();
        }
        if (remainingQuestions.length === 1) {
          const res = await moveQuestionToFolder(
            mutate,
            remainingQuestions[0],
            targetFolderId,
            "check",
            { throwOnCodes: ["DUPLICATE_IN_TARGET"] },
          );
          if (!res) {
            pruneMovedSelection();
            return;
          }
          remainingQuestions = [];
        } else if (remainingQuestions.length > 1) {
          const res = await batchMoveQuestionsToFolder(
            mutate,
            remainingQuestions,
            targetFolderId,
            "check",
            { throwOnCodes: ["DUPLICATE_IN_TARGET"] },
          );
          if (!res) {
            pruneMovedSelection();
            return;
          }
          remainingQuestions = [];
        }
        while (remainingSubs.length > 0) {
          const sid = remainingSubs[0];
          const res = await placeSubscriptionInFolder(
            mutate,
            sid,
            targetFolderId,
          );
          if (!res) {
            pruneMovedSelection();
            return;
          }
          remainingSubs.shift();
        }
        clearSelection();
        toast.success(`已移动到「${targetLabel}」。`);
      } catch (e) {
        if (
          e instanceof RequestError &&
          (e.code === "FOLDER_NAME_CONFLICT" ||
            e.code === "DUPLICATE_IN_TARGET")
        ) {
          pruneMovedSelection();
          const conflicts = Array.isArray(e.details?.conflicts)
            ? e.details!.conflicts
            : [];
          // Open Unified Move Picker with only remaining unmoved items and pre-populated conflict options.
          onOpenMoveDialog({
            folderIds: remainingFolders,
            questionIds: remainingQuestions,
            subscriptionDeckIds: remainingSubs,
            initialTargetId: targetFolderId,
            ...(e.code === "FOLDER_NAME_CONFLICT" && conflicts.length
              ? { initialFolderConflicts: conflicts as FolderConflictItem[] }
              : {}),
            ...(e.code === "DUPLICATE_IN_TARGET" && conflicts.length
              ? { initialDupConflicts: conflicts as DuplicateConflictDetail[] }
              : {}),
          });
          toast.info(
            "目标位置存在同名或重复内容，请在移动面板中选择处理方式。",
          );
        } else {
          pruneMovedSelection();
          toast.error(e instanceof Error ? e.message : "移动失败，请重试。");
        }
      }
    },
    [index, data.questions, mutate, clearSelection, onOpenMoveDialog],
  );

  // Build drag payload when dragging a folder, question, or subscription.
  function startDrag(
    e: React.DragEvent,
    kind: "folder" | "question" | "subscription",
    id: string,
  ) {
    let payload: DragMovePayload;
    const isInSelection =
      (kind === "folder" && selectedFolderIds.has(id)) ||
      (kind === "question" && selectedQuestionIds.has(id)) ||
      (kind === "subscription" && selectedSubIds.has(id));
    if (selectMode && isInSelection) {
      payload = {
        kind: "mixed",
        folderIds: [...selectedFolderIds],
        questionIds: [...selectedQuestionIds],
        subscriptionDeckIds: [...selectedSubIds],
      };
    } else {
      payload = { kind, ids: [id] };
    }
    const encoded = JSON.stringify(payload);
    e.dataTransfer.setData(DRAG_MIME, encoded);
    e.dataTransfer.setData("text/plain", encoded);
    e.dataTransfer.effectAllowed = "move";
  }

  function toggleFolderSelect(id: string) {
    setSelectedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleQuestionSelect(id: string) {
    setSelectedQuestionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSubSelect(id: string) {
    setSelectedSubIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const totalSelectedCount =
    selectedFolderIds.size + selectedQuestionIds.size + selectedSubIds.size;

  async function handleBatchQuestionOp(
    operation: "archive" | "unarchive" | "delete",
  ) {
    const ids = [...selectedQuestionIds];
    if (!ids.length || batchBusy) return;
    setBatchBusy(true);
    try {
      const res = await mutate("/api/questions", {
        action: "batch",
        ids,
        operation,
      });
      if (res) {
        clearSelection();
        toast.success(
          operation === "delete"
            ? `已将 ${ids.length} 条资料移入回收站。`
            : operation === "archive"
              ? `已归档 ${ids.length} 条资料。`
              : `已取消归档 ${ids.length} 条资料。`,
        );
      }
    } finally {
      setBatchBusy(false);
    }
  }

  // Breadcrumbs for current owned folder or subscription placement.
  const ownedBreadcrumbs = useMemo(() => {
    if (quickView) return [];
    if (!activeDeck) return [];
    if (activeDeck.isOwner) return index.breadcrumbsOf(activeDeck.id);
    if (activeDeck.parentId) return index.breadcrumbsOf(activeDeck.parentId);
    return [];
  }, [quickView, activeDeck, index]);

  const ownedCount = data.decks.filter((d) => d.isOwner).length;
  const changedPublishCount = data.decks.filter(
    (d) => d.isOwner && d.publishStatus === "changes",
  ).length;

  function renderPathLabel(q: QuestionView): string {
    if (quickView || searchGlobal || !activeDeck) {
      return q.folderPath ?? q.deckTitle;
    }
    return index.relativePathOf(q.deckId, activeDeck.id, q.groupId);
  }

  const showQuickPillsOnMobile = !quickView && folderId === null;

  return (
    <div className="page library-shell">
      <FolderTree
        userId={data.user.id}
        decks={data.decks}
        activeFolderId={folderId}
        activeQuickView={quickView}
        counts={quickCounts}
        onSelectRoot={() => onSelectFolder(null)}
        onSelectFolder={(id) => onSelectFolder(id)}
        onSelectQuickView={(q) => onSelectQuickView(q)}
        onDropMove={(targetId, payload) =>
          void handleDropMove(targetId, payload)
        }
      />

      <div className="library-main-pane">
        {/* Mobile quick-view strip at root */}
        {showQuickPillsOnMobile && (
          <div
            className="mobile-quick-strip"
            role="navigation"
            aria-label="快捷视图"
          >
            {(
              [
                {
                  id: "recent" as const,
                  label: "最近",
                  icon: Clock,
                  count: quickCounts.recent,
                },
                {
                  id: "favorites" as const,
                  label: "收藏",
                  icon: Star,
                  count: quickCounts.favorites,
                },
                {
                  id: "inbox" as const,
                  label: "待补答案",
                  icon: Edit3,
                  count: quickCounts.inbox,
                },
                {
                  id: "duplicates" as const,
                  label: "重复",
                  icon: CopyCheck,
                  count: quickCounts.duplicates,
                },
                {
                  id: "archived" as const,
                  label: "归档",
                  icon: Archive,
                  count: quickCounts.archived,
                },
                {
                  id: "trash" as const,
                  label: "回收站",
                  icon: Trash2,
                  count: 0,
                },
              ] as const
            ).map(({ id, label, icon: Icon, count }) => (
              <button
                key={id}
                type="button"
                className="mobile-quick-pill"
                onClick={() => onSelectQuickView(id)}
              >
                <Icon size={13} />
                <span>{label}</span>
                {count > 0 && <small>{count}</small>}
              </button>
            ))}
          </div>
        )}

        {/* Breadcrumb bar (also desktop drag-to-move target!) */}
        <nav className="library-breadcrumb" aria-label="当前路径">
          <button
            type="button"
            className={`library-crumb ${!quickView && !activeDeck ? "is-current" : ""} ${dragOverTarget === "CRUMB_ROOT" ? "is-drag-over" : ""}`}
            onClick={() => onSelectFolder(null)}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(DRAG_MIME)) {
                e.preventDefault();
                setDragOverTarget("CRUMB_ROOT");
              }
            }}
            onDragLeave={() => {
              if (dragOverTarget === "CRUMB_ROOT") setDragOverTarget(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverTarget(null);
              const p = parseDragPayload(e.dataTransfer);
              if (p) void handleDropMove(null, p);
            }}
          >
            <Home size={14} />
            <span>{ROOT_FOLDER_LABEL}</span>
          </button>

          {quickView && (
            <>
              <ChevronRight size={13} className="library-crumb-sep" />
              <span className="library-crumb is-current">
                {QUICK_VIEW_TITLES[quickView]}
              </span>
            </>
          )}

          {!quickView &&
            ownedBreadcrumbs.map((crumb, idx) => {
              const isLast =
                !isSubscriptionView && idx === ownedBreadcrumbs.length - 1;
              return (
                <span key={crumb.id} className="library-crumb-wrap">
                  <ChevronRight size={13} className="library-crumb-sep" />
                  <button
                    type="button"
                    className={`library-crumb ${isLast ? "is-current" : ""} ${dragOverTarget === `CRUMB_${crumb.id}` ? "is-drag-over" : ""}`}
                    onClick={() => onSelectFolder(crumb.id)}
                    onDragOver={(e) => {
                      if (e.dataTransfer.types.includes(DRAG_MIME)) {
                        e.preventDefault();
                        setDragOverTarget(`CRUMB_${crumb.id}`);
                      }
                    }}
                    onDragLeave={() => {
                      if (dragOverTarget === `CRUMB_${crumb.id}`)
                        setDragOverTarget(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOverTarget(null);
                      const p = parseDragPayload(e.dataTransfer);
                      if (p) void handleDropMove(crumb.id, p);
                    }}
                  >
                    {crumb.title}
                  </button>
                </span>
              );
            })}

          {!quickView && isSubscriptionView && activeDeck && (
            <>
              <ChevronRight size={13} className="library-crumb-sep" />
              <button
                type="button"
                className={`library-crumb ${subGroupTree.breadcrumbs.length === 0 ? "is-current" : ""}`}
                onClick={() => onSelectSubGroup(null)}
              >
                <Rss size={12} /> {activeDeck.title}
              </button>
              {subGroupTree.breadcrumbs.map((g, idx) => (
                <span key={g.id} className="library-crumb-wrap">
                  <ChevronRight size={13} className="library-crumb-sep" />
                  <button
                    type="button"
                    className={`library-crumb ${idx === subGroupTree.breadcrumbs.length - 1 ? "is-current" : ""}`}
                    onClick={() => onSelectSubGroup(g.id)}
                  >
                    {g.title}
                  </button>
                </span>
              ))}
            </>
          )}
        </nav>

        {/* Header bar with title, subtree stats, and actions */}
        <header className="library-pane-header">
          <div className="library-pane-title-wrap">
            {quickView && (
              <button
                type="button"
                className="icon-button mobile-inline-back"
                aria-label="返回我的资料"
                onClick={() => onSelectFolder(null)}
              >
                <ArrowLeft size={16} />
              </button>
            )}
            <div>
              <h1>
                {quickView
                  ? QUICK_VIEW_TITLES[quickView]
                  : activeDeck
                    ? isSubscriptionView && subGroupTree.breadcrumbs.length > 0
                      ? subGroupTree.breadcrumbs[
                          subGroupTree.breadcrumbs.length - 1
                        ].title
                      : activeDeck.title
                    : ROOT_FOLDER_LABEL}
              </h1>
              {!quickView && activeDeck && (
                <p className="muted small">
                  {activeDeck.isOwner ? (
                    <>
                      共 {activeDeck.count} 条资料
                      {activeDeck.due > 0
                        ? ` · ${activeDeck.due} 题待复习`
                        : ""}
                      {activeDeck.publishedVersion > 0 &&
                        activeDeck.visibility !== "private" &&
                        ` · 已发布 v${activeDeck.publishedVersion}`}
                      {activeDeck.description
                        ? ` · ${activeDeck.description}`
                        : ""}
                    </>
                  ) : (
                    <>
                      只读订阅 · 作者 {activeDeck.ownerName} · v
                      {activeDeck.syncedVersion ?? activeDeck.seenVersion} · 共{" "}
                      {activeDeck.count} 条资料
                    </>
                  )}
                </p>
              )}
            </div>
          </div>

          {!quickView && (
            <div className="library-pane-actions">
              {folderPracticeStats.sessionReady > 0 && (
                <Button
                  size="sm"
                  onClick={() => onReviewFolder(activeDeck?.id)}
                >
                  <RotateCcw size={14} /> 复习 (
                  {folderPracticeStats.sessionReady})
                </Button>
              )}
              {folderPracticeStats.cramItems.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    onCram(
                      folderPracticeStats.cramItems,
                      activeDeck?.title ?? ROOT_FOLDER_LABEL,
                    )
                  }
                >
                  <Flame size={14} /> 突击 (
                  {folderPracticeStats.cramItems.length})
                </Button>
              )}

              {!isSubscriptionView && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onCreateFolder(currentOwnedFolderId)}
                  >
                    <FolderPlus size={14} /> 新建文件夹
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onCreateQuestion(currentOwnedFolderId)}
                  >
                    <FilePlus2 size={14} /> 新建资料
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onImport(currentOwnedFolderId)}
                  >
                    <Upload size={14} /> 导入
                  </Button>
                </>
              )}

              {activeDeck && activeDeck.isOwner && (
                <ActionMenu label="当前文件夹操作">
                  <button
                    type="button"
                    onClick={() => onPublishFolder(activeDeck.id)}
                  >
                    <Rss size={14} />{" "}
                    {activeDeck.publishedVersion ? "发布更新" : "发布分享"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onEditFolder(activeDeck)}
                  >
                    <PenLine size={14} /> 重命名 / 简介
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onOpenMoveDialog({
                        folderIds: [activeDeck.id],
                        label: activeDeck.title,
                        initialTargetId: activeDeck.parentId,
                      })
                    }
                  >
                    <FolderInput size={14} /> 移动到文件夹…
                  </button>
                  <button
                    type="button"
                    onClick={() => onDissolveFolder(activeDeck)}
                  >
                    <FolderMinus size={14} /> 解散文件夹
                  </button>
                  <button
                    type="button"
                    className="danger-text"
                    onClick={() => onDeleteFolderTrash(activeDeck)}
                  >
                    <Trash2 size={14} /> 删除文件夹（移入回收站）
                  </button>
                </ActionMenu>
              )}

              {!activeDeck && ownedCount > 0 && (
                <Button size="sm" variant="ghost" onClick={onBatchPublish}>
                  <Rss size={14} />
                  批量发布
                  {changedPublishCount > 0 && (
                    <span className="pill-badge is-accent">
                      {changedPublishCount}
                    </span>
                  )}
                </Button>
              )}

              {isSubscriptionView && activeDeck && (
                <ActionMenu label="订阅资料操作">
                  <button
                    type="button"
                    onClick={() =>
                      onOpenMoveDialog({
                        subscriptionDeckIds: [activeDeck.id],
                        label: activeDeck.title,
                        initialTargetId: activeDeck.parentId,
                      })
                    }
                  >
                    <FolderInput size={14} /> 移动到文件夹…
                  </button>
                  <button
                    type="button"
                    className="danger-text"
                    onClick={() => onUnsubscribe(activeDeck.id)}
                  >
                    <Trash2 size={14} /> 取消订阅
                  </button>
                </ActionMenu>
              )}
            </div>
          )}
        </header>

        {/* Subscription update banner */}
        {!quickView && isSubscriptionView && activeDeck?.pendingUpdate && (
          <div className="sub-update-banner" role="status">
            <div>
              <strong>
                作者发布了 v{activeDeck.pendingUpdate.toVersion} 更新
              </strong>
              <span className="muted small">
                {activeDeck.pendingUpdate.summary ||
                  `+${activeDeck.pendingUpdate.added} 新增 · ~${activeDeck.pendingUpdate.updated} 修改 · -${activeDeck.pendingUpdate.removed} 移除`}
              </span>
            </div>
            <div className="sub-update-banner-actions">
              <Button
                size="sm"
                onClick={() =>
                  onApplyUpdate(
                    activeDeck.id,
                    activeDeck.pendingUpdate!.toVersion,
                  )
                }
              >
                <Download size={14} /> 更新到 v
                {activeDeck.pendingUpdate.toVersion}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  onDismissUpdate(
                    activeDeck.id,
                    activeDeck.pendingUpdate!.toVersion,
                  )
                }
              >
                暂不提示
              </Button>
            </div>
          </div>
        )}

        {/* Special quick views: Duplicates & Trash */}
        {quickView === "duplicates" ? (
          <DuplicatesView
            questions={data.questions}
            mutate={mutate}
            onOpenQuestion={(id) => {
              const q = data.questions.find((item) => item.id === id);
              if (q) onOpenQuestion(q);
            }}
            onOpenAiDedup={onOpenAiDedup}
          />
        ) : quickView === "trash" ? (
          <LibraryTrash userId={data.user.id} mutate={mutate} />
        ) : (
          <>
            {/* Search, sort & multiselect toolbar */}
            <div className="library-toolbar">
              <div className="library-search-box">
                <Search size={15} />
                <input
                  ref={searchInputRef}
                  type="search"
                  aria-label="搜索题目"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={
                    quickView
                      ? `在「${QUICK_VIEW_TITLES[quickView]}」中搜索…`
                      : searchGlobal || !activeDeck
                        ? "在全部资料中搜索标题、标签、路径或正文…"
                        : `在「${activeDeck.title}」及子文件夹中搜索…`
                  }
                />
                {search && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="清空搜索"
                    onClick={() => setSearch("")}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>

              {!quickView && activeDeck && isSearching && (
                <Button
                  size="sm"
                  variant={searchGlobal ? "secondary" : "outline"}
                  onClick={() => setSearchGlobal((v) => !v)}
                >
                  {searchGlobal
                    ? `仅搜「${activeDeck.title}」`
                    : "在全部资料中搜索"}
                </Button>
              )}

              <div className="library-toolbar-right">
                <label className="library-sort-select" title="排序方式">
                  <ArrowUpDown size={13} aria-hidden="true" />
                  <select
                    aria-label="排序方式"
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as ItemSortKey)}
                  >
                    <option value="name">按名称</option>
                    <option value="updated">按修改时间</option>
                    <option value="due">按复习紧急度</option>
                  </select>
                </label>

                {!isSubscriptionView && (
                  <Button
                    size="sm"
                    variant={selectMode ? "secondary" : "ghost"}
                    onClick={() => {
                      if (selectMode) clearSelection();
                      else setSelectMode(true);
                    }}
                  >
                    <CheckSquare size={14} /> {selectMode ? "完成多选" : "多选"}
                  </Button>
                )}
              </div>
            </div>

            {/* Tag filter pills */}
            {availableTags.length > 0 && (
              <div
                className="library-tag-strip"
                role="group"
                aria-label="按标签筛选"
              >
                {activeTag && (
                  <button
                    type="button"
                    className="library-tag-pill is-clear"
                    onClick={() => setActiveTag(null)}
                  >
                    <X size={12} /> 清除 #{activeTag}
                  </button>
                )}
                {availableTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className={`library-tag-pill ${activeTag === tag ? "is-active" : ""}`}
                    aria-pressed={activeTag === tag}
                    onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                  >
                    #{tag}
                  </button>
                ))}
              </div>
            )}

            {/* Multiselect floating action bar */}
            <div
              ref={multiselectBarPresence.ref}
              hidden={multiselectBarPresence.isHidden}
              data-closing={multiselectBarPresence.isClosing ? "" : undefined}
              aria-hidden={!selectMode}
              inert={!selectMode || multiselectBarPresence.isClosing}
              className="library-multiselect-bar"
              role="region"
              aria-label="批量操作"
            >
              <span className="small">
                已选 <strong>{totalSelectedCount}</strong> 项
              </span>
              <div className="library-multiselect-actions">
                {!quickView && !isSubscriptionView && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={totalSelectedCount === 0 || batchBusy}
                    onClick={() =>
                      onOpenGroupIntoNew({
                        parentId: currentOwnedFolderId,
                        folderIds: [...selectedFolderIds],
                        questionIds: [...selectedQuestionIds],
                        subscriptionDeckIds: [...selectedSubIds],
                      })
                    }
                  >
                    <FolderPlus size={14} /> 归入新文件夹
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={totalSelectedCount === 0 || batchBusy}
                  onClick={() =>
                    onOpenMoveDialog({
                      folderIds: [...selectedFolderIds],
                      questionIds: [...selectedQuestionIds],
                      subscriptionDeckIds: [...selectedSubIds],
                      initialTargetId: currentOwnedFolderId,
                    })
                  }
                >
                  <FolderInput size={14} /> 移动
                </Button>
                {selectedQuestionIds.size > 0 &&
                  selectedFolderIds.size === 0 &&
                  selectedSubIds.size === 0 && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={batchBusy}
                        onClick={() =>
                          void handleBatchQuestionOp(
                            quickView === "archived"
                              ? "unarchive"
                              : "archive",
                          )
                        }
                      >
                        <Archive size={14} />{" "}
                        {quickView === "archived" ? "取消归档" : "归档"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="danger-text"
                        disabled={batchBusy}
                        onClick={() => void handleBatchQuestionOp("delete")}
                      >
                        <Trash2 size={14} /> 移入回收站
                      </Button>
                    </>
                  )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={batchBusy}
                  onClick={clearSelection}
                >
                  取消
                </Button>
              </div>
            </div>

            {/* Current-level Folders & Subscriptions pinned above items (hidden while searching) */}
            {!quickView &&
              !isSearching &&
              !isSubscriptionView &&
              (currentChildFolders.length > 0 ||
                currentPlacedSubs.length > 0) && (
                <section
                  className="library-folders-section"
                  aria-label="子文件夹与订阅"
                >
                  <div className="library-folder-grid">
                    {currentChildFolders.map((folder) => {
                      const checked = selectedFolderIds.has(folder.id);
                      const isDragOver = dragOverTarget === folder.id;
                      const isPublished =
                        folder.publishedVersion > 0 &&
                        folder.visibility !== "private";
                      return (
                        <div
                          key={folder.id}
                          className={`library-folder-row color-${folder.color} ${checked ? "is-selected" : ""} ${isDragOver ? "is-drag-over" : ""}`}
                          draggable={!selectMode || checked}
                          onDragStart={(e) => startDrag(e, "folder", folder.id)}
                          onDragOver={(e) => {
                            if (e.dataTransfer.types.includes(DRAG_MIME)) {
                              e.preventDefault();
                              setDragOverTarget(folder.id);
                            }
                          }}
                          onDragLeave={() => {
                            if (dragOverTarget === folder.id)
                              setDragOverTarget(null);
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            setDragOverTarget(null);
                            const p = parseDragPayload(e.dataTransfer);
                            if (p) void handleDropMove(folder.id, p);
                          }}
                          onPointerDown={(e) =>
                            startLongPress(e, () =>
                              toggleFolderSelect(folder.id),
                            )
                          }
                          onPointerMove={moveLongPress}
                          onPointerUp={cancelLongPress}
                          onPointerCancel={cancelLongPress}
                        >
                          {selectMode && (
                            <button
                              type="button"
                              className="library-row-check"
                              aria-label={`选择文件夹 ${folder.title}`}
                              aria-pressed={checked}
                              onClick={() => toggleFolderSelect(folder.id)}
                            >
                              {checked ? (
                                <CheckSquare size={16} />
                              ) : (
                                <Square size={16} />
                              )}
                            </button>
                          )}
                          <button
                            type="button"
                            className="library-folder-main"
                            onClick={() => {
                              if (suppressClickRef.current) {
                                suppressClickRef.current = false;
                                return;
                              }
                              if (selectMode) {
                                toggleFolderSelect(folder.id);
                              } else {
                                onSelectFolder(folder.id);
                              }
                            }}
                          >
                            <span className="library-folder-icon">
                              <Folder size={18} />
                            </span>
                            <span className="library-folder-info">
                              <strong className="library-folder-name">
                                {folder.title}
                              </strong>
                              <small className="muted">
                                {folder.count} 条资料
                                {folder.due > 0
                                  ? ` · ${folder.due} 待复习`
                                  : ""}
                                {isPublished &&
                                  (folder.visibility === "public"
                                    ? ` · 公开 v${folder.publishedVersion}`
                                    : ` · 链接 v${folder.publishedVersion}`)}
                                {folder.publishStatus === "changes" &&
                                  " · 待更新"}
                              </small>
                            </span>
                            {isPublished && (
                              <span className="library-folder-pub-icon">
                                {folder.visibility === "public" ? (
                                  <Globe size={13} />
                                ) : (
                                  <Link2 size={13} />
                                )}
                              </span>
                            )}
                          </button>
                          {!selectMode && (
                            <ActionMenu label={`文件夹 ${folder.title} 的操作`}>
                              <button
                                type="button"
                                onClick={() => onSelectFolder(folder.id)}
                              >
                                <FolderOpen size={14} /> 打开
                              </button>
                              <button
                                type="button"
                                onClick={() => onEditFolder(folder)}
                              >
                                <PenLine size={14} /> 重命名 / 编辑
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  onOpenMoveDialog({
                                    folderIds: [folder.id],
                                    label: folder.title,
                                    initialTargetId: folder.parentId,
                                  })
                                }
                              >
                                <FolderInput size={14} /> 移动到…
                              </button>
                              <button
                                type="button"
                                onClick={() => onPublishFolder(folder.id)}
                              >
                                <Rss size={14} />{" "}
                                {folder.publishedVersion
                                  ? "发布更新"
                                  : "发布分享"}
                              </button>
                              <button
                                type="button"
                                onClick={() => onDissolveFolder(folder)}
                              >
                                <FolderMinus size={14} /> 解散文件夹
                              </button>
                              <button
                                type="button"
                                className="danger-text"
                                onClick={() => onDeleteFolderTrash(folder)}
                              >
                                <Trash2 size={14} /> 删除（移入回收站）
                              </button>
                            </ActionMenu>
                          )}
                        </div>
                      );
                    })}

                    {currentPlacedSubs.map((sub) => {
                      const checked = selectedSubIds.has(sub.id);
                      return (
                        <div
                          key={sub.id}
                          className={`library-folder-row is-subscription color-${sub.color} ${checked ? "is-selected" : ""}`}
                          draggable={!selectMode || checked}
                          onDragStart={(e) =>
                            startDrag(e, "subscription", sub.id)
                          }
                          onPointerDown={(e) =>
                            startLongPress(e, () => toggleSubSelect(sub.id))
                          }
                          onPointerMove={moveLongPress}
                          onPointerUp={cancelLongPress}
                          onPointerCancel={cancelLongPress}
                        >
                          {selectMode && (
                            <button
                              type="button"
                              className="library-row-check"
                              aria-label={`选择订阅 ${sub.title}`}
                              aria-pressed={checked}
                              onClick={() => toggleSubSelect(sub.id)}
                            >
                              {checked ? (
                                <CheckSquare size={16} />
                              ) : (
                                <Square size={16} />
                              )}
                            </button>
                          )}
                          <button
                            type="button"
                            className="library-folder-main"
                            onClick={() => {
                              if (suppressClickRef.current) {
                                suppressClickRef.current = false;
                                return;
                              }
                              if (selectMode) toggleSubSelect(sub.id);
                              else onSelectFolder(sub.id);
                            }}
                          >
                            <span className="library-folder-icon is-sub">
                              <Rss size={16} />
                            </span>
                            <span className="library-folder-info">
                              <strong className="library-folder-name">
                                {sub.title}
                              </strong>
                              <small className="muted">
                                订阅 · {sub.ownerName} · {sub.count} 条资料
                                {sub.pendingUpdate ? " · 有更新" : ""}
                              </small>
                            </span>
                            {Boolean(sub.pendingUpdate) && (
                              <span className="pill-badge is-accent">更新</span>
                            )}
                          </button>
                          {!selectMode && (
                            <ActionMenu label={`订阅 ${sub.title} 的操作`}>
                              <button
                                type="button"
                                onClick={() => onSelectFolder(sub.id)}
                              >
                                <FolderOpen size={14} /> 打开阅读
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  onOpenMoveDialog({
                                    subscriptionDeckIds: [sub.id],
                                    label: sub.title,
                                    initialTargetId: sub.parentId,
                                  })
                                }
                              >
                                <FolderInput size={14} /> 移动到文件夹…
                              </button>
                              <button
                                type="button"
                                className="danger-text"
                                onClick={() => onUnsubscribe(sub.id)}
                              >
                                <Trash2 size={14} /> 取消订阅
                              </button>
                            </ActionMenu>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

            {/* Subscribed deck read-only subfolders */}
            {!quickView &&
              !isSearching &&
              isSubscriptionView &&
              currentSubChildGroups.length > 0 && (
                <section
                  className="library-folders-section"
                  aria-label="订阅目录"
                >
                  <div className="library-folder-grid">
                    {currentSubChildGroups.map((grp) => (
                      <div
                        key={grp.id}
                        className="library-folder-row is-readonly"
                      >
                        <button
                          type="button"
                          className="library-folder-main"
                          onClick={() => onSelectSubGroup(grp.id)}
                        >
                          <span className="library-folder-icon">
                            <Folder size={17} />
                          </span>
                          <span className="library-folder-info">
                            <strong className="library-folder-name">
                              {grp.title}
                            </strong>
                            <small className="muted">
                              {subGroupTree.counts.get(grp.id) ?? 0} 条资料 ·
                              只读
                            </small>
                          </span>
                          <ChevronRight size={14} className="muted" />
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}

            {/* Question / Material items list */}
            <section className="library-items-section" aria-label="资料列表">
              {visibleQuestions.length > 0 ? (
                <div className="library-item-list">
                  {visibleQuestions.map((q) => {
                    const checked = selectedQuestionIds.has(q.id);
                    const due = Boolean(q.answer.trim()) && isQuestionDue(q);
                    const majorDue = isQuestionMajorRevisionDue(q);
                    const showPath = Boolean(quickView || isSearching);
                    const displayPath = showPath ? renderPathLabel(q) : "";
                    return (
                      <div
                        key={q.id}
                        className={`library-item-row ${checked ? "is-selected" : ""}`}
                        draggable={q.isOwner && (!selectMode || checked)}
                        onDragStart={(e) => {
                          if (!q.isOwner) return;
                          startDrag(e, "question", q.id);
                        }}
                        onPointerDown={(e) => {
                          if (!q.isOwner) return;
                          startLongPress(e, () => toggleQuestionSelect(q.id));
                        }}
                        onPointerMove={moveLongPress}
                        onPointerUp={cancelLongPress}
                        onPointerCancel={cancelLongPress}
                      >
                        {selectMode && q.isOwner && (
                          <button
                            type="button"
                            className="library-row-check"
                            aria-label={`选择 ${q.title}`}
                            aria-pressed={checked}
                            onClick={() => toggleQuestionSelect(q.id)}
                          >
                            {checked ? (
                              <CheckSquare size={16} />
                            ) : (
                              <Square size={16} />
                            )}
                          </button>
                        )}
                        <button
                          type="button"
                          className="library-item-main"
                          onClick={() => {
                            if (suppressClickRef.current) {
                              suppressClickRef.current = false;
                              return;
                            }
                            if (selectMode && q.isOwner) {
                              toggleQuestionSelect(q.id);
                            } else {
                              onOpenQuestion(q, orderedQuestionIds);
                            }
                          }}
                        >
                          <span className="library-item-title-row">
                            <strong className="library-item-title">
                              {q.title}
                            </strong>
                            {q.needsEditing && (
                              <span className="pill-badge is-warn">
                                待补答案
                              </span>
                            )}
                            {majorDue ? (
                              <span className="pill-badge is-accent">
                                答案已更新
                              </span>
                            ) : due ? (
                              <span className="pill-badge is-accent">
                                待复习
                              </span>
                            ) : null}
                          </span>
                          <span className="library-item-meta">
                            {showPath && displayPath && (
                              <span
                                className="library-item-path"
                                title={q.folderPath}
                              >
                                {displayPath}
                              </span>
                            )}
                            {q.tags.slice(0, 3).map((tag) => (
                              <span key={tag} className="library-item-tag">
                                #{tag}
                              </span>
                            ))}
                            <span className="muted">
                              {q.fsrs?.due
                                ? relativeDue(String(q.fsrs.due))
                                : q.answer.trim()
                                  ? "新题"
                                  : "尚未作答"}
                            </span>
                          </span>
                        </button>
                        {!selectMode && (
                          <div className="library-item-actions">
                            <button
                              type="button"
                              className={`icon-button ${q.favorite ? "is-favorited" : ""}`}
                              aria-label={q.favorite ? "取消收藏" : "收藏"}
                              onClick={() => onFavorite(q)}
                            >
                              <Star
                                size={15}
                                fill={q.favorite ? "currentColor" : "none"}
                              />
                            </button>
                            {q.answer.trim() ? (
                              <button
                                type="button"
                                className="icon-button"
                                aria-label="练习本题"
                                title="练习本题"
                                onClick={() => onPractice(q)}
                              >
                                <Play size={14} />
                              </button>
                            ) : q.isOwner ? (
                              <button
                                type="button"
                                className="icon-button"
                                aria-label="AI 补全答案"
                                title="AI 补全答案"
                                onClick={() => onGenerateAnswer(q)}
                              >
                                <Sparkles size={14} />
                              </button>
                            ) : null}
                            <ActionMenu label={`「${q.title}」的更多操作`}>
                              {showPath && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    onSelectFolder(q.deckId, q.groupId);
                                  }}
                                >
                                  <FolderOpen size={14} /> 打开所在文件夹
                                </button>
                              )}
                              {q.isOwner && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    onOpenMoveDialog({
                                      questionIds: [q.id],
                                      label: q.title,
                                      initialTargetId: q.deckId,
                                    })
                                  }
                                >
                                  <FolderInput size={14} /> 移动到文件夹…
                                </button>
                              )}
                              {q.isOwner && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    void mutate("/api/questions", {
                                      action: "archive",
                                      id: q.id,
                                      archived: !q.archived,
                                    })
                                  }
                                >
                                  <Archive size={14} />{" "}
                                  {q.archived ? "取消归档" : "归档"}
                                </button>
                              )}
                              {q.isOwner && (
                                <button
                                  type="button"
                                  className="danger-text"
                                  onClick={() => onDeleteQuestion(q)}
                                >
                                  <Trash2 size={14} /> 移入回收站
                                </button>
                              )}
                            </ActionMenu>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                // Empty state only if there are no child folders/subs either (or during search / quick view)
                (quickView ||
                  isSearching ||
                  (currentChildFolders.length === 0 &&
                    currentPlacedSubs.length === 0 &&
                    currentSubChildGroups.length === 0)) && (
                  <div className="empty-state-card">
                    <FolderOpen size={28} />
                    <h3>
                      {isSearching
                        ? "当前范围没有匹配的资料"
                        : quickView
                          ? `「${QUICK_VIEW_TITLES[quickView]}」目前为空`
                          : "这个文件夹还是空的"}
                    </h3>
                    <p className="muted small">
                      {isSearching && !searchGlobal && activeDeck
                        ? "可点击上方「在全部资料中搜索」查看其他文件夹中的内容。"
                        : quickView === "recent"
                          ? "打开任意资料后，会按浏览顺序自动记录在这里。"
                          : !quickView && !isSubscriptionView
                            ? "可使用上方按钮新建文件夹、新建资料或导入本地文件。"
                            : ""}
                    </p>
                  </div>
                )
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
