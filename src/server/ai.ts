import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { credentials } from "@/db/schema";
import { decryptKey } from "./crypto";
import { AppError } from "./errors";
import { normalizeAiBaseUrl } from "@/lib/ai-config";
import { aiFetch } from "./ai-transport";

export type ProviderMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};
export type AiConnection = { baseUrl: string; model: string; key: string };
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
  maxTokens = 3000,
) {
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
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
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
