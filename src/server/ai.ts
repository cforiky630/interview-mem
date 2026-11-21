import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { credentials } from "@/db/schema";
import { decryptKey } from "./crypto";
import { AppError } from "./errors";
import { normalizeAiBaseUrl } from "@/lib/ai-config";
import { aiFetch } from "./ai-transport";

export type ProviderToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
export type ProviderMessage =
  | {
      role: "system" | "user" | "assistant";
      content: string | null;
      tool_calls?: ProviderToolCall[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      name?: string;
      content: string;
    };
export type ProviderTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};
export type AiConnection = { baseUrl: string; model: string; key: string };

export function isReasoningModel(model: string) {
  const base = model.split("/").at(-1)?.trim().toLowerCase() ?? "";
  return /(?:^deepseek-reasoner$|(?:^|[-_])r1(?:[-_.]|$)|(?:^|[-_])qwq(?:[-_.]|$)|^o[134](?:[-_.]|$))/i.test(
    base,
  );
}
export async function aiCredential(userId: string, expectedBaseUrl?: string) {
  const db = await getDb();
  const [credential] = await db
    .select()
    .from(credentials)
    .where(eq(credentials.userId, userId));
  if (!credential)
    throw new AppError(400, "请先在设置中填写自己的 API Key。", "KEY_REQUIRED");
  if (
    expectedBaseUrl &&
    normalizeAiBaseUrl(credential.baseUrl) !==
      normalizeAiBaseUrl(expectedBaseUrl)
  )
    throw new AppError(400, "请填写此服务的 API Key。", "KEY_REQUIRED");
  try {
    return {
      model: credential.model,
      baseUrl: credential.baseUrl,
      key: decryptKey(credential.encryptedKey, userId),
    };
  } catch {
    throw new AppError(
      503,
      "密钥暂时无法解密，请检查服务器配置或重新保存密钥。",
    );
  }
}
export function providerError(status: number) {
  if (status === 401 || status === 403)
    return new AppError(
      400,
      "API Key 无效或无权访问该模型，请在设置中检查。",
      "PROVIDER_AUTH",
    );
  if (status === 402)
    return new AppError(400, "模型服务余额不足，请检查你的模型服务账号。");
  if (status === 429)
    return new AppError(429, "模型服务请求过于频繁，请稍后再试。");
  if (status === 404)
    return new AppError(400, "模型或接口不存在，请检查 Base URL 和模型名。");
  if (status === 400 || status === 422)
    return new AppError(400, "模型不支持当前请求，请检查模型名和接口配置。");
  return new AppError(502, "模型服务暂时不可用，请稍后重试。");
}
export async function providerRequest(
  connection: AiConnection,
  messages: ProviderMessage[],
  stream: boolean,
  signal?: AbortSignal,
  maxTokensOrOptions:
    | number
    | {
        maxTokens?: number;
        tools?: ProviderTool[];
        toolChoice?: "auto" | "none";
        timeoutMs?: number;
      } = 3000,
) {
  const options =
    typeof maxTokensOrOptions === "number"
      ? { maxTokens: maxTokensOrOptions }
      : maxTokensOrOptions;
  const reasoning = isReasoningModel(connection.model);
  const rawMax = options.maxTokens ?? 3000;
  const maxTokens = reasoning
    ? rawMax <= 64
      ? 256
      : Math.max(rawMax, 8000)
    : rawMax;
  const timeoutMs = options.timeoutMs ?? (reasoning ? 120_000 : 60_000);
  const url = new URL(
    `${normalizeAiBaseUrl(connection.baseUrl)}/chat/completions`,
  );
  const modernTokens =
    url.hostname === "api.openai.com" ||
    /^(?:o[1-9](?:-|$)|gpt-(?:[5-9]|\d{2,})(?:[.-]|$))/i.test(
      connection.model.split("/").at(-1) ?? "",
    );
  let response: Response;
  try {
    response = await aiFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: connection.model,
        messages,
        stream,
        [modernTokens ? "max_completion_tokens" : "max_tokens"]: maxTokens,
        ...(options.tools?.length
          ? {
              tools: options.tools,
              tool_choice: options.toolChoice ?? "auto",
            }
          : {}),
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (signal?.aborted) throw new AppError(499, "请求已取消。");
    throw new AppError(502, "无法连接模型服务，请检查地址与网络。");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw providerError(response.status);
  }
  return response;
}

/** Query the configured OpenAI-compatible endpoint for available model IDs. */
export async function providerModels(
  connection: { baseUrl: string; key: string },
  signal?: AbortSignal,
): Promise<string[]> {
  const base = normalizeAiBaseUrl(connection.baseUrl);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${connection.key}`,
    Accept: "application/json",
  };
  const candidates = [
    `${base}/models`,
    ...(base.endsWith("/v1") ? [] : [`${base}/v1/models`]),
  ];
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(12_000)])
    : AbortSignal.timeout(12_000);
  let lastStatus = 0;
  for (const rawUrl of candidates) {
    let response: Response;
    try {
      response = await aiFetch(new URL(rawUrl), {
        method: "GET",
        headers,
        signal: requestSignal,
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (signal?.aborted) throw new AppError(499, "请求已取消。");
      if (requestSignal.aborted)
        throw new AppError(504, "获取模型列表超时，请检查接口地址与网络。");
      throw new AppError(502, "无法连接模型服务，请检查地址与网络。");
    }
    if (
      response.status === 404 &&
      rawUrl !== candidates[candidates.length - 1]
    ) {
      await response.body?.cancel();
      lastStatus = 404;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      lastStatus = response.status;
      throw providerError(response.status);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AppError(502, "接口未返回有效的模型列表。");
    }
    const record = payload as {
      data?: Array<{ id?: string; name?: string } | string>;
      models?: Array<{ id?: string; name?: string } | string>;
    };
    const rawList = Array.isArray(record?.data)
      ? record.data
      : Array.isArray(record?.models)
        ? record.models
        : [];
    return Array.from(
      new Set(
        rawList
          .map((item) => {
            if (typeof item === "string") return item.trim();
            if (item && typeof item === "object") {
              return String(item.id ?? item.name ?? "").trim();
            }
            return "";
          })
          .filter(Boolean),
      ),
    );
  }
  throw providerError(lastStatus || 404);
}

// Bound concurrent paid calls for a user; release in finally on every success/failure path.
const state = globalThis as unknown as {
  interviewAiCalls?: Map<string, number>;
};
export function acquireAi(userId: string) {
  state.interviewAiCalls ??= new Map();
  const active = state.interviewAiCalls.get(userId) ?? 0;
  if (active >= 2) throw new AppError(429, "已有 AI 请求正在处理，请稍候。");
  state.interviewAiCalls.set(userId, active + 1);
  let released = false;
  return () => {
    if (!released) {
      released = true;
      const count = (state.interviewAiCalls!.get(userId) ?? 1) - 1;
      if (count <= 0) state.interviewAiCalls!.delete(userId);
      else state.interviewAiCalls!.set(userId, count);
    }
  };
}
