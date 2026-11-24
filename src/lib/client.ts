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
  options: { userId?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(url, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.userId ? { "X-Workspace-User": options.userId } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    cache: "no-store",
    signal: options.signal,
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
