import { route } from "@/server/api";
import { getWorkspace } from "@/server/workspace";
import { getDb } from "@/db";
import { conversations, messages, imports, reviewEvents } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
export const GET = route(async (_request, user) => {
  const workspace = await getWorkspace(user);
  const db = await getDb();
  const [threads, rawImports, logs] = await Promise.all([
    db.select().from(conversations).where(eq(conversations.userId, user.id)),
    db.select().from(imports).where(eq(imports.userId, user.id)),
    db.select().from(reviewEvents).where(eq(reviewEvents.userId, user.id)),
  ]);
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
    questions: workspace.questions,
    reviews: logs,
    imports: rawImports,
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
