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
): Promise<T> {
  const response = await fetch(url, {
    method: data === undefined ? "GET" : "POST",
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok)
    throw new RequestError(
      result.error ?? "请求失败，请重试。",
      response.status,
      result.code,
    );
  return result;
}
