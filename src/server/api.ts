import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { getAuth } from "./auth";
import { AppError } from "./errors";
import { applicationOrigins } from "./config.mjs";

const SESSION_ABSOLUTE_MAX_MS = 30 * 24 * 60 * 60 * 1000;

export type Identity = { id: string; name: string; email: string };
export async function identity(request: Request): Promise<Identity> {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new AppError(401, "请先登录。", "UNAUTHENTICATED");
  const createdMs = new Date(session.session.createdAt).getTime();
  if (
    Number.isFinite(createdMs) &&
    Date.now() - createdMs > SESSION_ABSOLUTE_MAX_MS
  ) {
    throw new AppError(401, "登录会话已超时，请重新登录。", "SESSION_EXPIRED");
  }
  const expectedUser = request.headers.get("X-Workspace-User");
  if (expectedUser && expectedUser !== session.user.id)
    throw new AppError(
      409,
      "账号已切换，请刷新页面后重试。",
      "ACCOUNT_CHANGED",
    );
  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
  };
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const allowedOrigins = applicationOrigins();
  if (!origin || !allowedOrigins.includes(origin))
    throw new AppError(
      403,
      "请求来源无效，请从应用页面操作。",
      "INVALID_ORIGIN",
    );
}
export async function body<T>(
  request: Request,
  schema: ZodType<T>,
  limit = 400_000,
): Promise<T> {
  if (Number(request.headers.get("content-length") ?? 0) > limit)
    throw new AppError(413, "内容过长，请分批导入。");
  const reader = request.body?.getReader();
  if (!reader) throw new AppError(400, "缺少请求内容。");
  let length = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel();
      throw new AppError(413, "内容过长，请分批导入。");
    }
    chunks.push(value);
  }
  let data: unknown;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError(400, "请求格式不正确。");
  }
  return schema.parse(data);
}
export function failure(error: unknown) {
  if (error instanceof AppError)
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        ...(error.details ? { details: error.details } : {}),
      },
      { status: error.status },
    );
  if (error instanceof ZodError)
    return NextResponse.json(
      { error: error.issues[0]?.message ?? "输入不正确。", code: "VALIDATION" },
      { status: 400 },
    );
  // Do not log request payloads, provider responses or credentials.
  console.error(
    "Request failed:",
    error instanceof Error ? error.name : "UnknownError",
  );
  return NextResponse.json(
    { error: "操作未完成，请稍后再试。", code: "INTERNAL" },
    { status: 500 },
  );
}
export function privateResponse(response: Response) {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  const vary = new Set(
    (response.headers.get("Vary") ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  );
  vary.add("Cookie");
  vary.add("Origin");
  response.headers.set("Vary", [...vary].join(", "));
  return response;
}
export function route(
  handler: (request: Request, user: Identity) => Promise<Response>,
  mutate = false,
) {
  return async (request: Request) => {
    try {
      if (mutate) checkOrigin(request);
      return privateResponse(await handler(request, await identity(request)));
    } catch (error) {
      return privateResponse(failure(error));
    }
  };
}
