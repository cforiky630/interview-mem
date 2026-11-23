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
