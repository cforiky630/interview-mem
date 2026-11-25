import type {
  CatalogDeckPreview,
  QuestionAnnotationColor,
  RichCatalogResponse,
} from "./types";

export class RequestError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
export async function api<T = Record<string, unknown>>(
  url: string,
  data?: unknown,
  options: {
    userId?: string;
    signal?: AbortSignal;
    method?: "GET" | "POST" | "DELETE";
    keepalive?: boolean;
  } = {},
): Promise<T> {
  const method = options.method ?? (data === undefined ? "GET" : "POST");
  const response = await fetch(url, {
    method,
    headers: {
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.userId ? { "X-Workspace-User": options.userId } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    cache: "no-store",
    signal: options.signal,
    keepalive: options.keepalive,
  });
  const rawText = await response.text();
  let result: Record<string, unknown> | null = null;
  if (rawText.trim()) {
    try {
      const parsed = JSON.parse(rawText);
      if (parsed && typeof parsed === "object") {
        result = parsed as Record<string, unknown>;
      }
    } catch {
      if (response.ok) {
        throw new RequestError("服务器返回格式异常，请稍后重试。", response.status);
      }
    }
  }
  if (!response.ok) {
    throw new RequestError(
      typeof result?.error === "string" && result.error
        ? result.error
        : response.status >= 500
          ? "服务暂时不可用，请稍后重试。"
          : "请求失败，请重试。",
      response.status,
      typeof result?.code === "string" ? result.code : undefined,
    );
  }
  if (!result) {
    throw new RequestError("服务器返回为空，请稍后重试。", response.status);
  }
  return result as T;
}

export type WorkspaceMutate = (
  url: string,
  data: unknown,
) => Promise<Record<string, unknown> | null>;

export type ImportGroupTarget =
  | { mode: "existing"; groupId: string }
  | { mode: "create"; title: string; category?: string; description?: string };

export async function createDeckGroup(
  mutate: WorkspaceMutate,
  input: {
    deckId: string;
    title: string;
    category?: string;
    description?: string;
  },
) {
  return mutate("/api/deck-groups", {
    action: "create",
    deckId: input.deckId,
    title: input.title,
    category: input.category ?? "",
    description: input.description ?? "",
  });
}

export async function editDeckGroup(
  mutate: WorkspaceMutate,
  input: {
    id: string;
    title: string;
    category?: string;
    description?: string;
  },
) {
  return mutate("/api/deck-groups", {
    action: "edit",
    id: input.id,
    title: input.title,
    category: input.category ?? "",
    description: input.description ?? "",
  });
}

export async function deleteDeckGroup(mutate: WorkspaceMutate, id: string) {
  return mutate("/api/deck-groups", { action: "delete", id });
}

export async function reorderDeckGroups(
  mutate: WorkspaceMutate,
  deckId: string,
  orderedIds: string[],
) {
  return mutate("/api/deck-groups", {
    action: "reorder",
    deckId,
    orderedIds,
  });
}

export async function renameDeckCategory(
  mutate: WorkspaceMutate,
  deckId: string,
  from: string,
  to: string,
) {
  return mutate("/api/deck-groups", {
    action: "renameCategory",
    deckId,
    from,
    to,
  });
}

export async function setSubscriptionDeckGroup(
  mutate: WorkspaceMutate,
  deckId: string,
  groupName: string,
) {
  return mutate("/api/decks", {
    action: "setSubscriptionGroup",
    deckId,
    groupName,
  });
}

export async function renameDeckGroupName(
  mutate: WorkspaceMutate,
  from: string,
  to: string,
) {
  return mutate("/api/decks", {
    action: "renameDeckGroup",
    from,
    to,
  });
}

export async function moveQuestionToSlot(
  mutate: WorkspaceMutate,
  id: string,
  deckId: string | null,
  groupId: string | null = null,
) {
  return mutate("/api/questions", {
    action: "move",
    id,
    deckId,
    groupId: deckId ? groupId : null,
  });
}

export async function batchMoveQuestionsToSlot(
  mutate: WorkspaceMutate,
  ids: string[],
  deckId: string | null,
  groupId: string | null = null,
) {
  return mutate("/api/questions", {
    action: "batch",
    ids,
    operation: "move",
    deckId,
    groupId: deckId ? groupId : null,
  });
}

export type BatchPublishItemInput = {
  deckId: string;
  expectedVersion: number;
  visibility?: "public" | "unlisted";
  summary?: string;
};

export async function batchPublishDecks(
  mutate: WorkspaceMutate,
  input: {
    items: BatchPublishItemInput[];
    defaultVisibility?: "public" | "unlisted";
    defaultSummary?: string;
    skipUnchanged?: boolean;
  },
) {
  return mutate("/api/decks", {
    action: "batchPublish",
    items: input.items,
    defaultVisibility: input.defaultVisibility ?? "public",
    defaultSummary: input.defaultSummary ?? "",
    skipUnchanged: input.skipUnchanged ?? false,
  });
}

export async function unpublishDeck(mutate: WorkspaceMutate, deckId: string) {
  return mutate("/api/decks", { action: "unpublish", deckId });
}

export async function applyDeckUpdate(
  mutate: WorkspaceMutate,
  deckId: string,
  targetVersion?: number,
) {
  return mutate("/api/decks", {
    action: "applyUpdate",
    deckId,
    ...(targetVersion !== undefined ? { targetVersion } : {}),
  });
}

export async function dismissDeckUpdate(
  mutate: WorkspaceMutate,
  deckId: string,
  version: number,
) {
  return mutate("/api/decks", {
    action: "dismissUpdate",
    deckId,
    version,
  });
}

export async function applyAllDeckUpdates(
  mutate: WorkspaceMutate,
  deckIds?: string[],
) {
  return mutate("/api/decks", {
    action: "applyAllUpdates",
    ...(deckIds?.length ? { deckIds } : {}),
  });
}

export async function batchSubscribeDecks(
  mutate: WorkspaceMutate,
  deckIds: string[],
  groupName = "",
) {
  return mutate("/api/decks", {
    action: "batchSubscribe",
    deckIds,
    ...(groupName.trim() ? { groupName: groupName.trim() } : {}),
  });
}

export async function batchUnsubscribeDecks(
  mutate: WorkspaceMutate,
  deckIds: string[],
) {
  return mutate("/api/decks", {
    action: "batchUnsubscribe",
    deckIds,
  });
}

export async function fetchRichCatalog(
  options: {
    userId?: string;
    signal?: AbortSignal;
    sharedDeckId?: string | null;
    authorId?: string | null;
  } = {},
): Promise<RichCatalogResponse> {
  const params = new URLSearchParams({ mode: "rich" });
  if (options.sharedDeckId) params.set("id", options.sharedDeckId);
  if (options.authorId) params.set("author", options.authorId);
  return api<RichCatalogResponse>(`/api/catalog?${params.toString()}`, undefined, {
    userId: options.userId,
    signal: options.signal,
  });
}

export async function fetchCatalogDeckPreview(
  deckId: string,
  options: { userId?: string; signal?: AbortSignal } = {},
): Promise<CatalogDeckPreview> {
  const params = new URLSearchParams({ id: deckId, preview: "1" });
  return api<CatalogDeckPreview>(`/api/catalog?${params.toString()}`, undefined, {
    userId: options.userId,
    signal: options.signal,
  });
}

export async function followAuthor(
  mutate: WorkspaceMutate,
  input: {
    authorId: string;
    autoSubscribeNew?: boolean;
    subscribeAll?: boolean;
    groupName?: string;
  },
) {
  return mutate("/api/authors", {
    action: "follow",
    authorId: input.authorId,
    autoSubscribeNew: input.autoSubscribeNew ?? false,
    subscribeAll: input.subscribeAll ?? false,
    ...(input.groupName?.trim() ? { groupName: input.groupName.trim() } : {}),
  });
}

export async function unfollowAuthor(
  mutate: WorkspaceMutate,
  authorId: string,
  unsubscribeDecks = false,
) {
  return mutate("/api/authors", {
    action: "unfollow",
    authorId,
    unsubscribeDecks,
  });
}

export async function subscribeAllByAuthor(
  mutate: WorkspaceMutate,
  authorId: string,
  groupName = "",
) {
  return mutate("/api/authors", {
    action: "subscribeAll",
    authorId,
    ...(groupName.trim() ? { groupName: groupName.trim() } : {}),
  });
}

export async function setAuthorAutoSubscribe(
  mutate: WorkspaceMutate,
  authorId: string,
  autoSubscribeNew: boolean,
) {
  return mutate("/api/authors", {
    action: "setAutoSubscribe",
    authorId,
    autoSubscribeNew,
  });
}

export async function addQuestionAnnotation(
  mutate: WorkspaceMutate,
  input: {
    id: string;
    quote?: string;
    comment: string;
    color?: QuestionAnnotationColor;
  },
) {
  return mutate("/api/questions", {
    action: "addAnnotation",
    id: input.id,
    quote: input.quote ?? "",
    comment: input.comment,
    color: input.color ?? "accent",
  });
}

export async function editQuestionAnnotation(
  mutate: WorkspaceMutate,
  input: {
    id: string;
    annotationId: string;
    comment: string;
    color?: QuestionAnnotationColor;
  },
) {
  return mutate("/api/questions", {
    action: "editAnnotation",
    id: input.id,
    annotationId: input.annotationId,
    comment: input.comment,
    ...(input.color ? { color: input.color } : {}),
  });
}

export async function deleteQuestionAnnotation(
  mutate: WorkspaceMutate,
  input: {
    id: string;
    annotationId: string;
  },
) {
  return mutate("/api/questions", {
    action: "deleteAnnotation",
    id: input.id,
    annotationId: input.annotationId,
  });
}

export async function discardImportPreviewBatches(
  batchIds: string[],
  userId?: string,
) {
  const uniqueIds = [...new Set(batchIds.filter(Boolean))];
  if (!uniqueIds.length) return { deleted: 0 };
  return api<{ deleted: number }>(
    "/api/import/preview",
    { batchIds: uniqueIds },
    { method: "DELETE", userId, keepalive: true },
  );
}
