import type {
  CatalogDeckPreview,
  FolderConflictStrategy,
  QuestionAnnotationColor,
  RichCatalogResponse,
} from "./types";

export class RequestError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public details?: Record<string, unknown>,
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
    onResponseHeaders?: (headers: Headers) => void;
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
        throw new RequestError(
          "服务器返回格式异常，请稍后重试。",
          response.status,
        );
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
      result?.details && typeof result.details === "object"
        ? (result.details as Record<string, unknown>)
        : undefined,
    );
  }
  if (!result) {
    throw new RequestError("服务器返回为空，请稍后重试。", response.status);
  }
  options.onResponseHeaders?.(response.headers);
  return result as T;
}

export type MutateOptions = {
  throwOnCodes?: string[];
};

export type WorkspaceMutate = (
  url: string,
  data: unknown,
  options?: MutateOptions,
) => Promise<Record<string, unknown> | null>;

export type DuplicateMoveStrategy = "check" | "keepBoth" | "skip";

export async function createFolder(
  mutate: WorkspaceMutate,
  input: {
    title: string;
    parentId?: string | null;
    description?: string;
    color?: string;
  },
) {
  return mutate("/api/decks", {
    action: "create",
    title: input.title,
    parentId: input.parentId ?? null,
    description: input.description ?? "",
    color: input.color ?? "sage",
  });
}

export async function editFolder(
  mutate: WorkspaceMutate,
  input: {
    deckId: string;
    title: string;
    description: string;
    color?: string;
    expected: {
      title: string;
      description: string;
      color?: string;
    };
  },
) {
  return mutate("/api/decks", {
    action: "edit",
    deckId: input.deckId,
    title: input.title,
    description: input.description,
    ...(input.color ? { color: input.color } : {}),
    expected: input.expected,
  });
}

export async function moveFolder(
  mutate: WorkspaceMutate,
  input: {
    folderId: string;
    targetParentId: string | null;
    conflictStrategy?: FolderConflictStrategy;
  },
  options?: MutateOptions,
) {
  return mutate(
    "/api/decks",
    {
      action: "moveFolder",
      folderId: input.folderId,
      targetParentId: input.targetParentId,
      conflictStrategy: input.conflictStrategy ?? "abort",
    },
    options,
  );
}

export async function groupIntoNewFolder(
  mutate: WorkspaceMutate,
  input: {
    parentId: string | null;
    title: string;
    description?: string;
    color?: string;
    folderIds?: string[];
    questionIds?: string[];
    subscriptionDeckIds?: string[];
    conflictStrategy?: FolderConflictStrategy;
  },
  options?: MutateOptions,
) {
  return mutate(
    "/api/decks",
    {
      action: "groupIntoNew",
      parentId: input.parentId,
      title: input.title,
      description: input.description ?? "",
      color: input.color ?? "sage",
      folderIds: input.folderIds ?? [],
      questionIds: input.questionIds ?? [],
      subscriptionDeckIds: input.subscriptionDeckIds ?? [],
      conflictStrategy: input.conflictStrategy ?? "abort",
    },
    options,
  );
}

export async function dissolveFolder(
  mutate: WorkspaceMutate,
  folderId: string,
  conflictStrategy: FolderConflictStrategy = "abort",
  options?: MutateOptions,
) {
  return mutate(
    "/api/decks",
    {
      action: "dissolve",
      folderId,
      conflictStrategy,
    },
    options,
  );
}

export async function deleteFolderToTrash(
  mutate: WorkspaceMutate,
  deckId: string,
) {
  return mutate("/api/decks", {
    action: "delete",
    deckId,
    mode: "trash",
  });
}

export async function placeSubscriptionInFolder(
  mutate: WorkspaceMutate,
  deckId: string,
  folderId: string | null,
) {
  return mutate("/api/decks", {
    action: "placeSubscription",
    deckId,
    folderId,
  });
}

export async function moveQuestionToFolder(
  mutate: WorkspaceMutate,
  id: string,
  deckId: string | null,
  duplicateStrategy: DuplicateMoveStrategy = "check",
  options?: MutateOptions,
) {
  return mutate(
    "/api/questions",
    {
      action: "move",
      id,
      deckId,
      duplicateStrategy,
    },
    options,
  );
}

export async function batchMoveQuestionsToFolder(
  mutate: WorkspaceMutate,
  ids: string[],
  deckId: string | null,
  duplicateStrategy: DuplicateMoveStrategy = "check",
  options?: MutateOptions,
) {
  return mutate(
    "/api/questions",
    {
      action: "batch",
      ids,
      operation: "move",
      deckId,
      duplicateStrategy,
    },
    options,
  );
}

export async function mergeDuplicateQuestionsApi(
  mutate: WorkspaceMutate,
  input: {
    primaryId: string;
    duplicateIds: string[];
    appendNotes?: boolean;
    keepStrongerFsrs?: boolean;
    mergeTags?: boolean;
  },
) {
  return mutate("/api/questions", {
    action: "mergeDuplicates",
    primaryId: input.primaryId,
    duplicateIds: input.duplicateIds,
    appendNotes: input.appendNotes ?? true,
    keepStrongerFsrs: input.keepStrongerFsrs ?? true,
    mergeTags: input.mergeTags ?? true,
  });
}

export type BatchPublishItemInput = {
  deckId: string;
  expectedVersion: number;
  visibility?: "public" | "unlisted";
  summary?: string;
  skipUnchanged?: boolean;
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
  folderId: string | null = null,
) {
  return mutate("/api/decks", {
    action: "batchSubscribe",
    deckIds,
    folderId,
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
  return api<RichCatalogResponse>(
    `/api/catalog?${params.toString()}`,
    undefined,
    {
      userId: options.userId,
      signal: options.signal,
    },
  );
}

export async function fetchCatalogDeckPreview(
  deckId: string,
  options: { userId?: string; signal?: AbortSignal } = {},
): Promise<CatalogDeckPreview> {
  const params = new URLSearchParams({ id: deckId, preview: "1" });
  return api<CatalogDeckPreview>(
    `/api/catalog?${params.toString()}`,
    undefined,
    {
      userId: options.userId,
      signal: options.signal,
    },
  );
}

export async function followAuthor(
  mutate: WorkspaceMutate,
  input: {
    authorId: string;
    autoSubscribeNew?: boolean;
    subscribeAll?: boolean;
    folderId?: string | null;
  },
) {
  return mutate("/api/authors", {
    action: "follow",
    authorId: input.authorId,
    autoSubscribeNew: input.autoSubscribeNew ?? false,
    subscribeAll: input.subscribeAll ?? false,
    folderId: input.folderId ?? null,
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
  folderId: string | null = null,
) {
  return mutate("/api/authors", {
    action: "subscribeAll",
    authorId,
    folderId,
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
    saveAsConcept?: boolean;
    conceptFolderId?: string | null;
    conceptGroup?: string;
    aliases?: string[];
    updateExistingConcept?: boolean;
  },
  options?: MutateOptions,
) {
  return mutate(
    "/api/questions",
    {
      action: "addAnnotation",
      id: input.id,
      quote: input.quote ?? "",
      comment: input.comment,
      color: input.color ?? "accent",
      ...(input.saveAsConcept !== undefined
        ? { saveAsConcept: input.saveAsConcept }
        : {}),
      ...(input.conceptFolderId !== undefined
        ? { conceptFolderId: input.conceptFolderId }
        : {}),
      ...(input.conceptGroup !== undefined
        ? { conceptGroup: input.conceptGroup }
        : {}),
      ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
      ...(input.updateExistingConcept !== undefined
        ? { updateExistingConcept: input.updateExistingConcept }
        : {}),
    },
    options,
  );
}

export async function editQuestionAnnotation(
  mutate: WorkspaceMutate,
  input: {
    id: string;
    annotationId: string;
    comment: string;
    color?: QuestionAnnotationColor;
    syncConcept?: boolean;
  },
  options?: MutateOptions,
) {
  return mutate(
    "/api/questions",
    {
      action: "editAnnotation",
      id: input.id,
      annotationId: input.annotationId,
      comment: input.comment,
      ...(input.color ? { color: input.color } : {}),
      ...(input.syncConcept !== undefined
        ? { syncConcept: input.syncConcept }
        : {}),
    },
    options,
  );
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

export async function createConcept(
  mutate: WorkspaceMutate,
  input: {
    term: string;
    definition: string;
    aliases?: string[];
    folderId?: string | null;
    groupName?: string;
    color?: QuestionAnnotationColor;
    sourceQuestionId?: string | null;
  },
  options?: MutateOptions,
) {
  return mutate(
    "/api/concepts",
    {
      action: "create",
      term: input.term,
      definition: input.definition,
      aliases: input.aliases ?? [],
      ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
      ...(input.groupName !== undefined ? { groupName: input.groupName } : {}),
      color: input.color ?? "accent",
      ...(input.sourceQuestionId !== undefined
        ? { sourceQuestionId: input.sourceQuestionId }
        : {}),
    },
    options,
  );
}

export async function editConcept(
  mutate: WorkspaceMutate,
  input: {
    id: string;
    term?: string;
    definition?: string;
    aliases?: string[];
    folderId?: string | null;
    groupName?: string;
    color?: QuestionAnnotationColor;
  },
  options?: MutateOptions,
) {
  return mutate(
    "/api/concepts",
    {
      action: "edit",
      id: input.id,
      ...(input.term !== undefined ? { term: input.term } : {}),
      ...(input.definition !== undefined
        ? { definition: input.definition }
        : {}),
      ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
      ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
      ...(input.groupName !== undefined ? { groupName: input.groupName } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
    },
    options,
  );
}

export async function deleteConcept(mutate: WorkspaceMutate, id: string) {
  return mutate("/api/concepts", {
    action: "delete",
    id,
  });
}

export async function moveConceptsToFolder(
  mutate: WorkspaceMutate,
  ids: string[],
  folderId: string | null,
) {
  return mutate("/api/concepts", {
    action: "moveConcepts",
    ids,
    folderId,
  });
}

export async function createConceptFolder(
  mutate: WorkspaceMutate,
  input: {
    title: string;
    parentId?: string | null;
    color?: string;
  },
  options?: MutateOptions,
) {
  return mutate(
    "/api/concepts",
    {
      action: "createFolder",
      title: input.title,
      parentId: input.parentId ?? null,
      color: input.color ?? "sage",
    },
    options,
  );
}

export async function editConceptFolder(
  mutate: WorkspaceMutate,
  input: {
    id: string;
    title: string;
    color?: string;
  },
  options?: MutateOptions,
) {
  return mutate(
    "/api/concepts",
    {
      action: "editFolder",
      id: input.id,
      title: input.title,
      ...(input.color ? { color: input.color } : {}),
    },
    options,
  );
}

export async function moveConceptFolder(
  mutate: WorkspaceMutate,
  input: {
    folderId: string;
    targetParentId: string | null;
    conflictStrategy?: FolderConflictStrategy;
  },
  options?: MutateOptions,
) {
  return mutate(
    "/api/concepts",
    {
      action: "moveFolder",
      folderId: input.folderId,
      targetParentId: input.targetParentId,
      conflictStrategy: input.conflictStrategy ?? "abort",
    },
    options,
  );
}

export async function groupIntoNewConceptFolder(
  mutate: WorkspaceMutate,
  input: {
    parentId: string | null;
    title: string;
    color?: string;
    folderIds?: string[];
    conceptIds?: string[];
    conflictStrategy?: FolderConflictStrategy;
  },
  options?: MutateOptions,
) {
  return mutate(
    "/api/concepts",
    {
      action: "groupIntoNewFolder",
      parentId: input.parentId,
      title: input.title,
      color: input.color ?? "sage",
      folderIds: input.folderIds ?? [],
      conceptIds: input.conceptIds ?? [],
      conflictStrategy: input.conflictStrategy ?? "abort",
    },
    options,
  );
}

export async function dissolveConceptFolder(
  mutate: WorkspaceMutate,
  folderId: string,
  conflictStrategy: FolderConflictStrategy = "abort",
  options?: MutateOptions,
) {
  return mutate(
    "/api/concepts",
    {
      action: "dissolveFolder",
      folderId,
      conflictStrategy,
    },
    options,
  );
}

export async function deleteConceptFolder(
  mutate: WorkspaceMutate,
  folderId: string,
) {
  return mutate("/api/concepts", {
    action: "deleteFolder",
    folderId,
  });
}

export async function renameConceptGroup(
  mutate: WorkspaceMutate,
  fromGroup: string,
  toGroup: string,
) {
  return mutate("/api/concepts", {
    action: "renameGroup",
    fromGroup,
    toGroup,
  });
}

export async function moveConceptsToGroup(
  mutate: WorkspaceMutate,
  ids: string[],
  groupName: string,
) {
  return mutate("/api/concepts", {
    action: "moveGroup",
    ids,
    groupName,
  });
}

export async function importConceptsFromAnnotations(
  mutate: WorkspaceMutate,
  input?: {
    items?: { questionId: string; annotationId: string }[];
    folderId?: string | null;
    groupName?: string;
  },
) {
  return mutate("/api/concepts", {
    action: "importFromAnnotations",
    ...(input?.items ? { items: input.items } : {}),
    ...(input?.folderId !== undefined ? { folderId: input.folderId } : {}),
    ...(input?.groupName !== undefined ? { groupName: input.groupName } : {}),
  });
}

export async function discardImportPreviewBatches(
  batchIds: string[],
  userId?: string,
) {
  const uniqueIds = [...new Set(batchIds.filter(Boolean))];
  if (!uniqueIds.length) return { deleted: 0 };
  let deleted = 0;
  for (let i = 0; i < uniqueIds.length; i += 100) {
    const res = await api<{ deleted: number }>(
      "/api/import/preview",
      { batchIds: uniqueIds.slice(i, i + 100) },
      { method: "DELETE", userId, keepalive: true },
    );
    deleted += res.deleted;
  }
  return { deleted };
}
