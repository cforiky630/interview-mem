import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { decks, questions } from "@/db/schema";
import { route } from "@/server/api";
import { cleanupExpiredQuestions } from "@/server/question-lifecycle";
import { TRASH_RETENTION_MS, questionExpiresAt } from "@/lib/question-trash";
export const GET = route(async (_request, user) => {
  await cleanupExpiredQuestions({ userId: user.id });
  const rows = await (
    await getDb()
  )
    .select({
      id: questions.id,
      title: questions.title,
      deckId: questions.deckId,
      deckTitle: decks.title,
      deletedAt: questions.deletedAt,
    })
    .from(questions)
    .leftJoin(decks, eq(questions.deckId, decks.id))
    .where(
      and(
        eq(questions.ownerId, user.id),
        gt(questions.deletedAt, new Date(Date.now() - TRASH_RETENTION_MS)),
        isNull(questions.purgedAt),
      ),
    )
    .orderBy(desc(questions.deletedAt));
  return Response.json(
    rows.map((q) => ({
      ...q,
      deckTitle: q.deckTitle ?? "未分类",
      deletedAt: q.deletedAt!.toISOString(),
      expiresAt: questionExpiresAt(q.deletedAt!).toISOString(),
    })),
  );
});
