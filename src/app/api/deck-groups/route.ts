import { NextResponse } from "next/server";
import { z } from "zod";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { deckGroups, decks, questions } from "@/db/schema";
import { body, route } from "@/server/api";
import { deckGroupFields } from "@/server/content-fields";
import { AppError } from "@/server/errors";
import { deckIdSchema } from "@/server/resource-ids";
import { nextDeckGroupPosition } from "@/server/workspace";

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    deckId: deckIdSchema,
    ...deckGroupFields,
  }),
  z.object({
    action: z.literal("edit"),
    id: z.string().uuid(),
    ...deckGroupFields,
  }),
  z.object({
    action: z.literal("delete"),
    id: z.string().uuid(),
  }),
  z.object({
    action: z.literal("reorder"),
    deckId: deckIdSchema,
    orderedIds: z
      .array(z.string().uuid())
      .min(1)
      .max(200)
      .refine((ids) => new Set(ids).size === ids.length, "分组标识重复。"),
  }),
  z.object({
    action: z.literal("renameCategory"),
    deckId: deckIdSchema,
    from: z.string().trim().min(1, "请指定要重命名的分类。").max(40),
    to: z.string().trim().max(40),
  }),
]);

export const GET = route(async (request, user) => {
  const url = new URL(request.url);
  const rawDeckId = url.searchParams.get("deckId");
  const deckId = rawDeckId ? deckIdSchema.parse(rawDeckId) : null;
  const db = await getDb();
  const rows = await db
    .select({ group: deckGroups })
    .from(deckGroups)
    .innerJoin(decks, eq(deckGroups.deckId, decks.id))
    .where(
      and(
        eq(deckGroups.ownerId, user.id),
        eq(decks.ownerId, user.id),
        isNull(decks.deletedAt),
        deckId ? eq(deckGroups.deckId, deckId) : undefined,
      ),
    )
    .orderBy(
      asc(deckGroups.position),
      asc(deckGroups.createdAt),
      asc(deckGroups.id),
    );
  return NextResponse.json(
    rows.map(({ group: g }) => ({
      id: g.id,
      deckId: g.deckId,
      title: g.title,
      category: g.category,
      description: g.description,
      position: g.position,
      createdAt: g.createdAt.toISOString(),
      updatedAt: g.updatedAt.toISOString(),
    })),
  );
});

export const POST = route(async (request, user) => {
  const data = await body(request, schema);
  const db = await getDb();

  if (data.action === "create") {
    const group = await db.transaction(async (tx) => {
      const [deck] = await tx
        .select({ id: decks.id })
        .from(decks)
        .where(
          and(
            eq(decks.id, data.deckId),
            eq(decks.ownerId, user.id),
            isNull(decks.deletedAt),
          ),
        )
        .for("update");
      if (!deck) throw new AppError(404, "题库不存在或没有编辑权限。");
      const position = await nextDeckGroupPosition(tx, deck.id);
      const now = new Date();
      const [inserted] = await tx
        .insert(deckGroups)
        .values({
          id: crypto.randomUUID(),
          deckId: deck.id,
          ownerId: user.id,
          title: data.title,
          category: data.category,
          description: data.description,
          position,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await tx
        .update(decks)
        .set({ updatedAt: now })
        .where(eq(decks.id, deck.id));
      return inserted;
    });
    return NextResponse.json({
      group: {
        id: group.id,
        deckId: group.deckId,
        title: group.title,
        category: group.category,
        description: group.description,
        position: group.position,
        createdAt: group.createdAt.toISOString(),
        updatedAt: group.updatedAt.toISOString(),
      },
    });
  }

  if (data.action === "edit") {
    const [existing] = await db
      .select({ id: deckGroups.id, deckId: deckGroups.deckId })
      .from(deckGroups)
      .where(and(eq(deckGroups.id, data.id), eq(deckGroups.ownerId, user.id)));
    if (!existing) throw new AppError(404, "分组不存在或没有编辑权限。");
    const group = await db.transaction(async (tx) => {
      const [deck] = await tx
        .select({ id: decks.id })
        .from(decks)
        .where(
          and(
            eq(decks.id, existing.deckId),
            eq(decks.ownerId, user.id),
            isNull(decks.deletedAt),
          ),
        )
        .for("update");
      if (!deck) throw new AppError(404, "所属题库已删除。");
      const [locked] = await tx
        .select()
        .from(deckGroups)
        .where(
          and(eq(deckGroups.id, data.id), eq(deckGroups.ownerId, user.id)),
        )
        .for("update");
      if (!locked) throw new AppError(404, "分组不存在或已删除。");
      const now = new Date();
      const [updated] = await tx
        .update(deckGroups)
        .set({
          title: data.title,
          category: data.category,
          description: data.description,
          updatedAt: now,
        })
        .where(eq(deckGroups.id, locked.id))
        .returning();
      await tx
        .update(decks)
        .set({ updatedAt: now })
        .where(eq(decks.id, deck.id));
      return updated;
    });
    return NextResponse.json({
      group: {
        id: group.id,
        deckId: group.deckId,
        title: group.title,
        category: group.category,
        description: group.description,
        position: group.position,
        createdAt: group.createdAt.toISOString(),
        updatedAt: group.updatedAt.toISOString(),
      },
    });
  }

  if (data.action === "delete") {
    const [existing] = await db
      .select({ id: deckGroups.id, deckId: deckGroups.deckId })
      .from(deckGroups)
      .where(and(eq(deckGroups.id, data.id), eq(deckGroups.ownerId, user.id)));
    if (!existing) throw new AppError(404, "分组不存在或没有管理权限。");
    const result = await db.transaction(async (tx) => {
      await tx
        .select({ id: decks.id })
        .from(decks)
        .where(and(eq(decks.id, existing.deckId), eq(decks.ownerId, user.id)))
        .for("update");
      const [lockedGroup] = await tx
        .select({ id: deckGroups.id, deckId: deckGroups.deckId })
        .from(deckGroups)
        .where(
          and(eq(deckGroups.id, data.id), eq(deckGroups.ownerId, user.id)),
        )
        .for("update");
      if (!lockedGroup) throw new AppError(404, "分组不存在或已删除。");
      // Lock all active questions in this deck in deterministic ID order to avoid deadlocks and
      // safely detach questions whose contentHash would collide with ungrouped questions.
      const members = await tx
        .select({
          id: questions.id,
          contentHash: questions.contentHash,
          deletedAt: questions.deletedAt,
        })
        .from(questions)
        .where(
          and(
            eq(questions.ownerId, user.id),
            eq(questions.deckId, lockedGroup.deckId),
            eq(questions.groupId, lockedGroup.id),
          ),
        )
        .orderBy(asc(questions.id))
        .for("update");
      const now = new Date();
      if (members.length) {
        const ungroupedActive = await tx
          .select({ contentHash: questions.contentHash })
          .from(questions)
          .where(
            and(
              eq(questions.ownerId, user.id),
              eq(questions.deckId, lockedGroup.deckId),
              isNull(questions.groupId),
              isNull(questions.deletedAt),
            ),
          );
        const ungroupedHashes = new Set(
          ungroupedActive.map((row) => row.contentHash),
        );
        const toUngroup: string[] = [];
        const toUnfiled: string[] = [];
        for (const m of members) {
          if (m.deletedAt) {
            toUngroup.push(m.id);
          } else if (ungroupedHashes.has(m.contentHash)) {
            // Preserve identical questions without violating (deck_id, '', content_hash) unique index.
            toUnfiled.push(m.id);
          } else {
            ungroupedHashes.add(m.contentHash);
            toUngroup.push(m.id);
          }
        }
        if (toUngroup.length) {
          await tx
            .update(questions)
            .set({ groupId: null, updatedAt: now })
            .where(inArray(questions.id, toUngroup));
        }
        if (toUnfiled.length) {
          await tx
            .update(questions)
            .set({ deckId: null, groupId: null, updatedAt: now })
            .where(inArray(questions.id, toUnfiled));
        }
      }
      await tx.delete(deckGroups).where(eq(deckGroups.id, lockedGroup.id));
      await tx
        .update(decks)
        .set({ updatedAt: now })
        .where(eq(decks.id, lockedGroup.deckId));
      return { ok: true, detached: members.length };
    });
    return NextResponse.json(result);
  }

  if (data.action === "reorder") {
    await db.transaction(async (tx) => {
      const [deck] = await tx
        .select({ id: decks.id })
        .from(decks)
        .where(
          and(
            eq(decks.id, data.deckId),
            eq(decks.ownerId, user.id),
            isNull(decks.deletedAt),
          ),
        )
        .for("update");
      if (!deck) throw new AppError(404, "题库不存在或没有编辑权限。");
      const allGroups = await tx
        .select({
          id: deckGroups.id,
          position: deckGroups.position,
          createdAt: deckGroups.createdAt,
        })
        .from(deckGroups)
        .where(
          and(eq(deckGroups.deckId, deck.id), eq(deckGroups.ownerId, user.id)),
        )
        .orderBy(asc(deckGroups.id))
        .for("update");
      const byId = new Map(allGroups.map((g) => [g.id, g]));
      if (data.orderedIds.some((id) => !byId.has(id))) {
        throw new AppError(404, "部分分组不存在或不属于当前题库。");
      }
      const specified = new Set(data.orderedIds);
      const remainder = allGroups
        .filter((g) => !specified.has(g.id))
        .sort(
          (a, b) =>
            a.position - b.position ||
            a.createdAt.getTime() - b.createdAt.getTime() ||
            a.id.localeCompare(b.id),
        )
        .map((g) => g.id);
      const finalOrder = [...data.orderedIds, ...remainder];
      const now = new Date();
      for (let i = 0; i < finalOrder.length; i++) {
        await tx
          .update(deckGroups)
          .set({ position: i, updatedAt: now })
          .where(eq(deckGroups.id, finalOrder[i]));
      }
      await tx
        .update(decks)
        .set({ updatedAt: now })
        .where(eq(decks.id, deck.id));
    });
    return NextResponse.json({ ok: true });
  }

  // action === "renameCategory"
  const updated = await db.transaction(async (tx) => {
    const [deck] = await tx
      .select({ id: decks.id })
      .from(decks)
      .where(
        and(
          eq(decks.id, data.deckId),
          eq(decks.ownerId, user.id),
          isNull(decks.deletedAt),
        ),
      )
      .for("update");
    if (!deck) throw new AppError(404, "题库不存在或没有编辑权限。");
    const now = new Date();
    const rows = await tx
      .update(deckGroups)
      .set({ category: data.to, updatedAt: now })
      .where(
        and(
          eq(deckGroups.deckId, deck.id),
          eq(deckGroups.ownerId, user.id),
          eq(deckGroups.category, data.from),
        ),
      )
      .returning({ id: deckGroups.id });
    if (rows.length) {
      await tx
        .update(decks)
        .set({ updatedAt: now })
        .where(eq(decks.id, deck.id));
    }
    return rows.length;
  });
  return NextResponse.json({ ok: true, updated });
}, true);
