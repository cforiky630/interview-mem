import { NextResponse } from "next/server";
import { z } from "zod";
import { body, route } from "@/server/api";
import {
  MAX_CONCEPTS,
  MAX_CONCEPT_ALIASES,
  MAX_CONCEPT_ALIAS_LENGTH,
  MAX_CONCEPT_DEFINITION_LENGTH,
  MAX_CONCEPT_GROUP_LENGTH,
  MAX_CONCEPT_TERM_LENGTH,
} from "@/lib/concepts";
import { MAX_FOLDER_TITLE_LENGTH } from "@/lib/folders";
import {
  createConcept,
  createConceptFolder,
  deleteConcept,
  deleteConceptFolder,
  dissolveConceptFolder,
  editConcept,
  editConceptFolder,
  groupIntoNewConceptFolder,
  importConceptsFromAnnotations,
  listConcepts,
  moveConceptFolder,
  moveConceptsToFolder,
  moveConceptsToGroup,
  renameConceptGroup,
} from "@/server/concepts";

export const runtime = "nodejs";

const colorSchema = z.enum(["accent", "amber", "sky", "rose"]);
const folderColorSchema = z.enum(["sage", "blue", "sand", "rose"]);
const conflictStrategySchema = z.enum(["abort", "merge", "keepBoth"]);
const conceptIdSchema = z.string().trim().min(1, "缺少概念标识。").max(120);
const folderIdSchema = z.string().trim().min(1, "缺少文件夹标识。").max(120);
const folderTitleSchema = z
  .string()
  .trim()
  .min(1, "请输入文件夹名称。")
  .max(MAX_FOLDER_TITLE_LENGTH, `文件夹名称最多 ${MAX_FOLDER_TITLE_LENGTH} 个字符。`);

const termSchema = z
  .string()
  .trim()
  .min(1, "请输入概念名称。")
  .max(MAX_CONCEPT_TERM_LENGTH, `概念名称最多 ${MAX_CONCEPT_TERM_LENGTH} 字。`);
const definitionSchema = z
  .string()
  .trim()
  .min(1, "请输入概念释义。")
  .max(
    MAX_CONCEPT_DEFINITION_LENGTH,
    `概念释义最多 ${MAX_CONCEPT_DEFINITION_LENGTH} 字。`,
  );
const groupNameSchema = z
  .string()
  .trim()
  .max(MAX_CONCEPT_GROUP_LENGTH, `分组名称最多 ${MAX_CONCEPT_GROUP_LENGTH} 字。`);
const aliasesSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1, "别名不能为空。")
      .max(MAX_CONCEPT_ALIAS_LENGTH, `单个别名最多 ${MAX_CONCEPT_ALIAS_LENGTH} 字。`),
  )
  .max(MAX_CONCEPT_ALIASES, `最多添加 ${MAX_CONCEPT_ALIASES} 个别名。`);

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    term: termSchema,
    definition: definitionSchema,
    aliases: aliasesSchema.optional().default([]),
    folderId: folderIdSchema.nullable().optional(),
    groupName: groupNameSchema.optional(),
    color: colorSchema.optional().default("accent"),
    sourceQuestionId: z.string().uuid().nullable().optional().default(null),
  }),
  z.object({
    action: z.literal("edit"),
    id: conceptIdSchema,
    term: termSchema.optional(),
    definition: definitionSchema.optional(),
    aliases: aliasesSchema.optional(),
    folderId: folderIdSchema.nullable().optional(),
    groupName: groupNameSchema.optional(),
    color: colorSchema.optional(),
  }),
  z.object({
    action: z.literal("delete"),
    id: conceptIdSchema,
  }),
  z.object({
    action: z.literal("moveConcepts"),
    ids: z.array(conceptIdSchema).min(1).max(MAX_CONCEPTS),
    folderId: folderIdSchema.nullable(),
  }),
  z.object({
    action: z.literal("createFolder"),
    parentId: folderIdSchema.nullable().optional().default(null),
    title: folderTitleSchema,
    color: folderColorSchema.optional().default("sage"),
  }),
  z.object({
    action: z.literal("editFolder"),
    id: folderIdSchema,
    title: folderTitleSchema,
    color: folderColorSchema.optional(),
  }),
  z.object({
    action: z.literal("moveFolder"),
    folderId: folderIdSchema,
    targetParentId: folderIdSchema.nullable(),
    conflictStrategy: conflictStrategySchema.optional().default("abort"),
  }),
  z.object({
    action: z.literal("groupIntoNewFolder"),
    parentId: folderIdSchema.nullable().optional().default(null),
    title: folderTitleSchema,
    color: folderColorSchema.optional().default("sage"),
    folderIds: z.array(folderIdSchema).max(200).optional().default([]),
    conceptIds: z.array(conceptIdSchema).max(MAX_CONCEPTS).optional().default([]),
    conflictStrategy: conflictStrategySchema.optional().default("abort"),
  }),
  z.object({
    action: z.literal("dissolveFolder"),
    folderId: folderIdSchema,
    conflictStrategy: conflictStrategySchema.optional().default("abort"),
  }),
  z.object({
    action: z.literal("deleteFolder"),
    folderId: folderIdSchema,
  }),
  z.object({
    action: z.literal("renameGroup"),
    fromGroup: z
      .string()
      .trim()
      .min(1, "请指定要重命名的分组。")
      .max(MAX_CONCEPT_GROUP_LENGTH),
    toGroup: groupNameSchema,
  }),
  z.object({
    action: z.literal("moveGroup"),
    ids: z.array(conceptIdSchema).min(1).max(MAX_CONCEPTS),
    groupName: groupNameSchema,
  }),
  z.object({
    action: z.literal("importFromAnnotations"),
    items: z
      .array(
        z.object({
          questionId: z.string().uuid(),
          annotationId: z.string().trim().min(1).max(120),
        }),
      )
      .max(MAX_CONCEPTS)
      .optional(),
    folderId: folderIdSchema.nullable().optional(),
    groupName: groupNameSchema.optional(),
  }),
]);

export const GET = route(async (_request, user) => {
  return NextResponse.json(await listConcepts(user.id));
});

export const POST = route(async (request, user) => {
  const data = await body(request, schema);

  if (data.action === "create") {
    const result = await createConcept(user.id, {
      term: data.term,
      definition: data.definition,
      aliases: data.aliases,
      folderId: data.folderId,
      groupName: data.groupName,
      color: data.color,
      sourceQuestionId: data.sourceQuestionId,
    });
    return NextResponse.json({
      ok: true,
      concept: result.concept,
      ...(result.folder ? { folder: result.folder } : {}),
    });
  }

  if (data.action === "edit") {
    const result = await editConcept(user.id, {
      id: data.id,
      term: data.term,
      definition: data.definition,
      aliases: data.aliases,
      folderId: data.folderId,
      groupName: data.groupName,
      color: data.color,
    });
    return NextResponse.json({
      ok: true,
      concept: result.concept,
      ...(result.folder ? { folder: result.folder } : {}),
    });
  }

  if (data.action === "delete") {
    return NextResponse.json(await deleteConcept(user.id, data.id));
  }

  if (data.action === "moveConcepts") {
    return NextResponse.json(
      await moveConceptsToFolder(user.id, data.ids, data.folderId),
    );
  }

  if (data.action === "createFolder") {
    return NextResponse.json(
      await createConceptFolder(user.id, {
        parentId: data.parentId,
        title: data.title,
        color: data.color,
      }),
    );
  }

  if (data.action === "editFolder") {
    return NextResponse.json(
      await editConceptFolder(user.id, {
        id: data.id,
        title: data.title,
        color: data.color,
      }),
    );
  }

  if (data.action === "moveFolder") {
    return NextResponse.json(
      await moveConceptFolder(user.id, {
        folderId: data.folderId,
        targetParentId: data.targetParentId,
        conflictStrategy: data.conflictStrategy,
      }),
    );
  }

  if (data.action === "groupIntoNewFolder") {
    return NextResponse.json(
      await groupIntoNewConceptFolder(user.id, {
        parentId: data.parentId,
        title: data.title,
        color: data.color,
        folderIds: data.folderIds,
        conceptIds: data.conceptIds,
        conflictStrategy: data.conflictStrategy,
      }),
    );
  }

  if (data.action === "dissolveFolder") {
    return NextResponse.json(
      await dissolveConceptFolder(user.id, {
        folderId: data.folderId,
        conflictStrategy: data.conflictStrategy,
      }),
    );
  }

  if (data.action === "deleteFolder") {
    return NextResponse.json(
      await deleteConceptFolder(user.id, data.folderId),
    );
  }

  if (data.action === "renameGroup") {
    return NextResponse.json(
      await renameConceptGroup(user.id, data.fromGroup, data.toGroup),
    );
  }

  if (data.action === "moveGroup") {
    return NextResponse.json(
      await moveConceptsToGroup(user.id, data.ids, data.groupName),
    );
  }

  return NextResponse.json(
    await importConceptsFromAnnotations(user.id, {
      items: data.items,
      folderId: data.folderId,
      groupName: data.groupName,
    }),
  );
}, true);
