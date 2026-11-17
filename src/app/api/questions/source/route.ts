import { eq, and, sql } from "drizzle-orm";
import { z } from "zod";
import { route } from "@/server/api";
import { accessibleQuestion } from "@/server/workspace";
import { getDb } from "@/db";
import { imports, questions } from "@/db/schema";
import { AppError } from "@/server/errors";
export const GET = route(async (request, user) => {
  const id = z
    .string()
    .uuid()
    .parse(new URL(request.url).searchParams.get("questionId"));
  if (!(await accessibleQuestion(user.id, id)).isOwner)
    throw new AppError(403, "导入原文仅题目所有者可见。");
  const db = await getDb();
  const [q] = await db
    .select({
      importId: questions.importId,
      source: sql<string>`to_json(${questions.sourceText})::text`,
    })
    .from(questions)
    .where(eq(questions.id, id));
  if (q.importId) {
    const [source] = await db
      .select({
        raw: sql<string>`to_json(${imports.raw})::text`,
        name: imports.sourceName,
        sha256: imports.sourceHash,
      })
      .from(imports)
      .where(and(eq(imports.id, q.importId), eq(imports.userId, user.id)));
    if (source)
      return Response.json({
        raw: JSON.parse(source.raw),
        name: source.name,
        sha256: source.sha256,
      });
  }
  return Response.json({ raw: JSON.parse(q.source) });
});
