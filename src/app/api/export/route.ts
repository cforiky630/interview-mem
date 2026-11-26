import { route } from "@/server/api";
import { getWorkspace } from "@/server/workspace";
import { getDb } from "@/db";
import {
  conversations,
  messages,
  imports,
  preferences,
  releases,
  reviewEvents,
  questions,
  studyCards,
  subscriptions,
} from "@/db/schema";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  cleanupExpiredQuestions,
  cleanupOrphanedImportPreviews,
} from "@/server/question-lifecycle";
import { TRASH_RETENTION_MS, questionExpiresAt } from "@/lib/question-trash";
export const runtime = "nodejs";
export const GET = route(async (_request, user) => {
  await cleanupExpiredQuestions({ userId: user.id });
  await cleanupOrphanedImportPreviews({ userId: user.id });
  const workspace = await getWorkspace(user);
  const db = await getDb();
  const ownedDeckIds = workspace.decks
    .filter((d) => d.isOwner)
    .map((d) => d.id);
  const [
    threads,
    rawImports,
    logs,
    sourceRows,
    prefRows,
    ownReleases,
    subRows,
    trashRows,
    studyCardRows,
  ] = await Promise.all([
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
        importId: questions.importId,
      })
      .from(questions)
      .where(
        and(
          eq(questions.ownerId, user.id),
          isNull(questions.deletedAt),
          isNull(questions.purgedAt),
        ),
      ),
    db.select().from(preferences).where(eq(preferences.userId, user.id)),
    ownedDeckIds.length
      ? db
          .select()
          .from(releases)
          .where(inArray(releases.deckId, ownedDeckIds))
      : Promise.resolve([]),
    db.select().from(subscriptions).where(eq(subscriptions.userId, user.id)),
    db
      .select()
      .from(questions)
      .where(
        and(
          eq(questions.ownerId, user.id),
          gt(questions.deletedAt, new Date(Date.now() - TRASH_RETENTION_MS)),
          isNull(questions.purgedAt),
        ),
      ),
    db.select().from(studyCards).where(eq(studyCards.userId, user.id)),
  ]);
  const sourceMap = new Map(
    sourceRows.map((row) => [
      row.id,
      { sourceText: row.sourceText, importId: row.importId },
    ]),
  );
  const referencedImportIds = new Set<string>();
  for (const row of sourceRows) {
    if (row.importId) referencedImportIds.add(row.importId);
  }
  for (const row of trashRows) {
    if (row.importId) referencedImportIds.add(row.importId);
  }
  const exportedImports = rawImports
    .filter(
      ({ record }) =>
        record.status === "complete" || referencedImportIds.has(record.id),
    )
    .map(({ record, rawJson }) => ({
      ...record,
      raw: JSON.parse(rawJson),
    }));
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
  const pref = prefRows[0];
  const exported = {
    format: "shiyi-backup",
    version: 3,
    exportedAt: new Date().toISOString(),
    user: workspace.user,
    preferences: {
      dailyGoal: pref?.dailyGoal ?? workspace.settings.dailyGoal,
      dailyNewLimit: pref?.dailyNewLimit ?? workspace.settings.dailyNewLimit,
      theme: pref?.theme ?? workspace.settings.theme,
      timeZone: pref?.timeZone ?? workspace.settings.timeZone,
    },
    decks: workspace.decks,
    releases: ownReleases,
    subscriptions: subRows,
    followedAuthors: workspace.followedAuthors ?? [],
    conceptFolders: workspace.conceptFolders,
    concepts: workspace.concepts,
    questions: workspace.questions.map((q) => {
      if (!q.isOwner) return q;
      const source = sourceMap.get(q.id);
      return {
        ...q,
        sourceText: source?.sourceText ?? "",
        importId: source?.importId ?? null,
      };
    }),
    trash: trashRows.map((q) => ({
      ...q,
      expiresAt: questionExpiresAt(q.deletedAt!).toISOString(),
    })),
    personalStudyState: studyCardRows,
    reviews: logs,
    imports: exportedImports,
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
