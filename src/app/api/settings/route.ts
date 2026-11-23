import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { credentials, preferences } from "@/db/schema";
import { body, route } from "@/server/api";
import { encryptKey } from "@/server/crypto";
import {
  aiCredential,
  providerModels,
  providerRequest,
  acquireAi,
} from "@/server/ai";
import { ensureWorkspace } from "@/server/workspace";
import { AppError } from "@/server/errors";
import { AI_PROTOCOL, DEFAULT_AI, normalizeAiBaseUrl } from "@/lib/ai-config";
import { assertAiHostname } from "@/server/ai-transport";

const keySchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .regex(/^[^\s\x00-\x1f\x7f]+$/, "API Key 格式不正确。");
const modelSchema = z
  .string()
  .trim()
  .min(1, "请填写模型名。")
  .max(160)
  .regex(/^[^\s\x00-\x1f\x7f]+$/, "模型名格式不正确。");
const baseUrlSchema = z
  .string()
  .max(2048)
  .transform((value, context) => {
    try {
      const baseUrl = normalizeAiBaseUrl(value);
      assertAiHostname(new URL(baseUrl).hostname);
      return baseUrl;
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Base URL 无效。",
      });
      return z.NEVER;
    }
  });
const connectionFields = {
  baseUrl: baseUrlSchema,
  model: modelSchema,
  key: keySchema.optional(),
};

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("saveKey"),
    key: keySchema,
    baseUrl: baseUrlSchema.default(DEFAULT_AI.baseUrl),
    model: modelSchema.default("deepseek-chat"),
  }),
  z.object({ action: z.literal("saveConnection"), ...connectionFields }),
  z.object({ action: z.literal("testConnection"), ...connectionFields }),
  z.object({
    action: z.literal("listModels"),
    baseUrl: baseUrlSchema,
    key: keySchema.optional(),
  }),
  z.object({ action: z.literal("deleteKey") }),
  z.object({ action: z.literal("testKey") }),
  z.object({
    action: z.literal("model"),
    model: modelSchema,
  }),
  z.object({
    action: z.literal("preferences"),
    dailyGoal: z.number().int().min(1).max(200),
    dailyNewLimit: z.number().int().min(0).max(50).optional(),
    theme: z.enum(["light", "dark"]),
    timeZone: z
      .string()
      .max(60)
      .refine((value) => {
        if (/^[+-]\d/.test(value)) return false;
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "时区无效。"),
  }),
]);
export const POST = route(async (request, user) => {
  const data = await body(request, schema, 10_000);
  await ensureWorkspace(user.id);
  const db = await getDb();
  if (
    data.action === "saveKey" ||
    data.action === "saveConnection" ||
    data.action === "testConnection"
  ) {
    const [existing] = await db
      .select()
      .from(credentials)
      .where(eq(credentials.userId, user.id));
    if (
      !data.key &&
      (!existing || normalizeAiBaseUrl(existing.baseUrl) !== data.baseUrl)
    )
      throw new AppError(400, "请填写此服务的 API Key。", "KEY_REQUIRED");
    if (data.action === "testConnection") {
      const release = acquireAi(user.id);
      try {
        const saved = !data.key
          ? await aiCredential(user.id, data.baseUrl)
          : null;
        const response = await providerRequest(
          {
            baseUrl: data.baseUrl,
            model: data.model,
            key: data.key ?? saved!.key,
          },
          [{ role: "user", content: "Reply OK." }],
          false,
          request.signal,
          64,
        );
        let result;
        try {
          result = await response.json();
        } catch {
          throw new AppError(502, "接口未返回有效的 Chat Completions 响应。");
        }
        if (result?.choices?.[0]?.message?.role !== "assistant")
          throw new AppError(502, "接口未返回有效的 Chat Completions 响应。");
      } finally {
        release();
      }
      return NextResponse.json({ ok: true });
    }
    const value = {
      userId: user.id,
      encryptedKey: data.key
        ? encryptKey(data.key, user.id)
        : existing!.encryptedKey,
      keyHint: data.key
        ? data.key.length > 4
          ? data.key.slice(-4)
          : ""
        : existing!.keyHint,
      provider: AI_PROTOCOL,
      baseUrl: data.baseUrl,
      model: data.model,
      updatedAt: new Date(),
    };
    await db
      .insert(credentials)
      .values(value)
      .onConflictDoUpdate({ target: credentials.userId, set: value });
  }
  if (data.action === "deleteKey")
    await db.delete(credentials).where(eq(credentials.userId, user.id));
  if (data.action === "listModels") {
    const [existing] = await db
      .select()
      .from(credentials)
      .where(eq(credentials.userId, user.id));
    if (
      !data.key &&
      (!existing || normalizeAiBaseUrl(existing.baseUrl) !== data.baseUrl)
    )
      throw new AppError(400, "请填写此服务的 API Key。", "KEY_REQUIRED");
    const saved = !data.key
      ? await aiCredential(user.id, data.baseUrl)
      : null;
    const release = acquireAi(user.id);
    try {
      const models = await providerModels(
        {
          baseUrl: data.baseUrl,
          key: data.key ?? saved!.key,
        },
        request.signal,
      );
      return NextResponse.json({ ok: true, models });
    } finally {
      release();
    }
  }
  if (data.action === "model") {
    const changed = await db
      .update(credentials)
      .set({ model: data.model, updatedAt: new Date() })
      .where(eq(credentials.userId, user.id))
      .returning({ userId: credentials.userId });
    if (!changed.length) throw new AppError(400, "请先配置 API Key。");
  }
  if (data.action === "preferences")
    await db
      .update(preferences)
      .set({
        dailyGoal: data.dailyGoal,
        ...(data.dailyNewLimit === undefined
          ? {}
          : { dailyNewLimit: data.dailyNewLimit }),
        theme: data.theme,
        timeZone: data.timeZone,
      })
      .where(eq(preferences.userId, user.id));
  if (data.action === "testKey") {
    const release = acquireAi(user.id);
    try {
      const credential = await aiCredential(user.id);
      const response = await providerRequest(
        credential,
        [{ role: "user", content: "请只回复 OK。" }],
        false,
        request.signal,
        64,
      );
      await response.body?.cancel();
    } finally {
      release();
    }
  }
  return NextResponse.json({ ok: true });
}, true);
