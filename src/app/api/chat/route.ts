import { NextResponse } from "next/server";
import { z } from "zod";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { conversations, messages } from "@/db/schema";
import { body, route } from "@/server/api";
import { accessibleQuestion } from "@/server/workspace";
import { deckIdSchema } from "@/server/resource-ids";
import { assertDeckChatAccess } from "@/server/ai-tools";
import { chatBodySchema, chatScopeParamSchema } from "@/server/chat-stream";
import { handleQuestionChat } from "@/server/chat-question";
import { handleScopedChat } from "@/server/chat-scoped";

export const runtime = "nodejs";

export const GET = route(async (request, user) => {
  const url = new URL(request.url);
  const scope = chatScopeParamSchema.parse(
    url.searchParams.get("scope") ?? "question",
  );
  const db = await getDb();
  let threads: (typeof conversations.$inferSelect)[];

  if (scope === "question") {
    const questionId = z
      .string()
      .uuid()
      .parse(url.searchParams.get("questionId"));
    await accessibleQuestion(user.id, questionId);
    threads = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.userId, user.id),
          eq(conversations.scope, "question"),
          eq(conversations.questionId, questionId),
        ),
      )
      .orderBy(desc(conversations.updatedAt))
      .limit(30);
  } else if (scope === "deck") {
    const deckId = deckIdSchema.parse(url.searchParams.get("deckId"));
    await assertDeckChatAccess(user.id, deckId);
    threads = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.userId, user.id),
          eq(conversations.scope, "deck"),
          eq(conversations.deckId, deckId),
        ),
      )
      .orderBy(desc(conversations.updatedAt))
      .limit(30);
  } else {
    threads = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.userId, user.id),
          eq(conversations.scope, "workspace"),
        ),
      )
      .orderBy(desc(conversations.updatedAt))
      .limit(30);
  }

  const allMessages = threads.length
    ? await db
        .select()
        .from(messages)
        .where(
          inArray(
            messages.conversationId,
            threads.map((t) => t.id),
          ),
        )
        .orderBy(asc(messages.createdAt))
    : [];
  return NextResponse.json(
    threads.map((t) => ({
      ...t,
      messages: allMessages
        .filter((m) => m.conversationId === t.id)
        .map(({ meta, ...rest }) => ({
          ...rest,
          ...(meta?.reasoning ? { reasoning: meta.reasoning } : {}),
          ...(meta?.toolSteps?.length ? { toolSteps: meta.toolSteps } : {}),
          ...(meta?.references?.length ? { references: meta.references } : {}),
        })),
    })),
  );
});

export const POST = route(async (request, user) => {
  const data = await body(request, chatBodySchema, 40_000);
  if (data.scope === "question") {
    return await handleQuestionChat(request, user, data);
  }
  return await handleScopedChat(request, user, data);
}, true);
