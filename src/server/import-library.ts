import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { decks, imports, questions, user } from "@/db/schema";
import type { ContentValidation } from "@/lib/content-validation";
import { contentHash } from "./crypto";
import { ensureWorkspace, nextQuestionBaseMs } from "./workspace";

export type LibraryDocument = {
  path: string;
  kind: "question" | "note" | "index";
  title: string;
  raw: string;
  sha256: string;
  tags: string[];
  validation: ContentValidation | null;
};

function stableId(value: string) {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 128;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Add verbatim documents to a private workspace. Never replace existing answers or study data. */
export async function importLibrary(
  ownerId: string,
  documents: LibraryDocument[],
) {
  const db = await getDb();
  const [owner] = await db
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(eq(user.id, ownerId));
  if (!owner) throw new Error("目标账号不存在。");
  await ensureWorkspace(ownerId);
  return db.transaction(async (tx) => {
    await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, ownerId))
      .for("update");
    const deckIds = {
      question: stableId(`interview-library:${ownerId}:RAG`),
      note: stableId(`interview-library:${ownerId}:notes`),
    };
    for (const group of ["question", "note"] as const) {
      if (!documents.some((d) => d.kind === group)) continue;
      const value = {
        id: deckIds[group],
        ownerId,
        title: group === "question" ? "RAG · 面试题" : "RAG · 复习笔记",
        description:
          group === "question"
            ? "按原文件完整导入，保留追问与原格式；内容校验说明单独展示。"
            : "保留学习笔记原文，内容问题作为独立校验说明。",
        color: group === "question" ? "sage" : "sand",
        visibility: "private",
      };
      await tx.insert(decks).values(value).onConflictDoNothing();
      const [deck] = await tx
        .select()
        .from(decks)
        .where(and(eq(decks.id, value.id), eq(decks.ownerId, ownerId)));
      if (!deck) throw new Error("题库归属不匹配，已停止导入。");
    }
    const baseMs = await nextQuestionBaseMs(tx, ownerId);
    let insertSeq = 0;
    let added = 0;
    let duplicates = 0;
    const imported: {
      sourcePath: string;
      questionId: string;
      sha256: string;
    }[] = [];
    for (const document of documents) {
      const group = document.kind === "note" ? "note" : "question";
      const deckId = deckIds[group];
      if (document.kind !== "index") {
        const id = stableId(`interview-library:${ownerId}:${document.path}`);
        const [existing] = await tx
          .select()
          .from(questions)
          .where(eq(questions.id, id));
        if (existing) {
          if (
            existing.deckId !== deckId ||
            existing.answer !== document.raw ||
            existing.title !== document.title
          ) {
            throw new Error(
              `已有条目与当前源文件不同，已保留现有版本：${document.path}`,
            );
          }
          // Refresh only independent audit metadata. Do not touch formatting, notes, reviews or revisions.
          await tx
            .update(questions)
            .set({ validation: document.validation })
            .where(eq(questions.id, id));
          duplicates++;
        } else {
          const ts = new Date(baseMs + insertSeq++);
          const inserted = await tx
            .insert(questions)
            .values({
              id,
              deckId,
              ownerId,
              title: document.title,
              answer: document.raw,
              sourceText: document.raw,
              tags: document.tags,
              contentHash: contentHash(document.title, document.raw),
              validation: document.validation,
              createdAt: ts,
              updatedAt: ts,
            })
            .onConflictDoNothing()
            .returning({ id: questions.id });
          if (!inserted.length)
            throw new Error(
              `目标题库已存在同内容的其他条目，未覆盖：${document.path}`,
            );
          added++;
        }
        imported.push({
          sourcePath: document.path,
          questionId: id,
          sha256: document.sha256,
        });
      }
      await tx
        .insert(imports)
        .values({
          id: stableId(
            `interview-original:${ownerId}:${document.path}:${document.sha256}`,
          ),
          userId: ownerId,
          deckId,
          raw: document.raw,
          status: "complete",
          result: { added: document.kind === "index" ? 0 : 1, duplicates: 0 },
        })
        .onConflictDoNothing();
    }
    return {
      owner: owner.name,
      added,
      duplicates,
      deckIds,
      imported,
      originals: documents.length,
    };
  });
}
