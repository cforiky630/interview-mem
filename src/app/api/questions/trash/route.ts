import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { questions } from "@/db/schema";
import { route } from "@/server/api";
import { cleanupExpiredQuestions } from "@/server/question-lifecycle";
import { TRASH_RETENTION_MS, questionExpiresAt } from "@/lib/question-trash";
import {
  formatOwnedFolderPath,
  loadActiveOwnedFolders,
} from "@/server/folders";
import { ROOT_FOLDER_LABEL } from "@/lib/folders";

export const GET = route(async (_request, user) => {
  await cleanupExpiredQuestions({ userId: user.id });
  const db = await getDb();
  const [rows, activeFolders] = await Promise.all([
    db
      .select({
        id: questions.id,
        title: questions.title,
        deckId: questions.deckId,
        deletedAt: questions.deletedAt,
      })
      .from(questions)
      .where(
        and(
          eq(questions.ownerId, user.id),
          gt(questions.deletedAt, new Date(Date.now() - TRASH_RETENTION_MS)),
          isNull(questions.purgedAt),
        ),
      )
      .orderBy(desc(questions.deletedAt)),
    loadActiveOwnedFolders(db, user.id),
  ]);
  const folderById = new Map(activeFolders.map((f) => [f.id, f]));
  return Response.json(
    rows.map((q) => {
      const folder = q.deckId ? folderById.get(q.deckId) : undefined;
      return {
        id: q.id,
        title: q.title,
        deckId: folder ? q.deckId : null,
        deckTitle: folder?.title ?? ROOT_FOLDER_LABEL,
        folderPath: formatOwnedFolderPath(folderById, folder ? q.deckId : null),
        deletedAt: q.deletedAt!.toISOString(),
        expiresAt: questionExpiresAt(q.deletedAt!).toISOString(),
      };
    }),
  );
});
