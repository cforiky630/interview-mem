import { route } from "@/server/api";
import { getWorkspace } from "@/server/workspace";
import { getDb } from "@/db";
import {
  conversations,
  messages,
  imports,
  reviewEvents,
  questions,
  studyCards,
} from "@/db/schema";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { cleanupExpiredQuestions } from "@/server/question-lifecycle";
import { TRASH_RETENTION_MS, questionExpiresAt } from "@/lib/question-trash";
export const GET = route(async (_request, user) => {
  await cleanupExpiredQuestions({ userId: user.id });
  const workspace = await getWorkspace(user);
  const db = await getDb();
  const [threads, rawImports, logs, sourceRows] = await Promise.all([
    db.select().from(conversations).where(eq(conversations.userId, user.id)),
    db
      .select({
        record: imports,
        rawJson: sql<string>`to_json(${imports.raw})::text`,
      })
      .from(imports)
      .where(eq(imports.userId, user.id)),
    db.select().from(reviewEvents).where(eq(reviewEvents.userId, user.id)),
    db
      .select({
        id: questions.id,
        sourceText: questions.sourceText,
      })
      .from(questions)
      .where(
        and(
          eq(questions.ownerId, user.id),
          isNull(questions.deletedAt),
          isNull(questions.purgedAt),
        ),
      ),
  ]);
  const sourceMap = new Map(sourceRows.map((row) => [row.id, row.sourceText]));
  const chat = threads.length
    ? await db
        .select()
        .from(messages)
        .where(
          inArray(
            messages.conversationId,
            threads.map((t) => t.id),
          ),
        )
    : [];
  const exported = {
    format: "shiyi-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    user: workspace.user,
    decks: workspace.decks,
    questions: workspace.questions.map((q) =>
      q.isOwner ? { ...q, sourceText: sourceMap.get(q.id) ?? "" } : q,
    ),
    trash: (
      await db
        .select()
        .from(questions)
        .where(
          and(
            eq(questions.ownerId, user.id),
            gt(questions.deletedAt, new Date(Date.now() - TRASH_RETENTION_MS)),
            isNull(questions.purgedAt),
          ),
        )
    ).map((q) => ({
      ...q,
      expiresAt: questionExpiresAt(q.deletedAt!).toISOString(),
    })),
    personalStudyState: await db
      .select()
      .from(studyCards)
      .where(eq(studyCards.userId, user.id)),
    reviews: logs,
    imports: rawImports.map(({ record, rawJson }) => ({
      ...record,
      raw: JSON.parse(rawJson),
    })),
    conversations: threads.map((t) => ({
      ...t,
      messages: chat.filter((m) => m.conversationId === t.id),
    })),
  };
  return new Response(JSON.stringify(exported, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="shiyi-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
    },
  });
});
