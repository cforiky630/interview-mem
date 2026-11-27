import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import {
  conceptFolders,
  concepts,
  conversations,
  decks,
  imports,
  messages,
  preferences,
  questions,
  releases,
  reviewEvents,
  studyCards,
  subscriptions,
  type PublishedDeckGroup,
  type PublishedQuestion,
} from "@/db/schema";
import { mergeQuestionTags } from "@/lib/markdown-source";
import {
  MAX_CONCEPTS,
  MAX_CONCEPT_DEFINITION_LENGTH,
  MAX_CONCEPT_GROUP_LENGTH,
  MAX_CONCEPT_TERM_LENGTH,
  normalizeConceptAliases,
  normalizeConceptKey,
} from "@/lib/concepts";
import {
  MAX_FOLDER_DEPTH,
  normalizeFolderTitleKey,
  resolveUniqueSiblingTitle,
} from "@/lib/folders";
import type {
  ChatEdit,
  ChatMessageMeta,
  QuestionAnnotation,
  QuestionAnnotationColor,
} from "@/lib/types";
import type { ContentValidation } from "@/lib/content-validation";
import { contentHash } from "./crypto";
import { AppError } from "./errors";
import {
  buildServerFolderTree,
  folderDepth,
  loadActiveOwnedFolders,
  lockUserTree,
  sanitizeLegacyFolderTitle,
} from "./folders";

const uuidOrString = z.string().min(1).max(120);

const strictValidationSourceSchema = z.object({
  title: z.string().max(300),
  url: z
    .string()
    .max(2000)
    .refine(
      (value) => /^https?:\/\//i.test(value.trim()),
      "校验来源链接必须使用 http(s) 协议。",
    ),
});

const strictValidationFindingSchema = z.object({
  id: z.string().max(120),
  severity: z.enum(["error", "qualification", "terminology"]),
  line: z.number().int().min(0).max(1_000_000),
  title: z.string().max(500),
  explanation: z.string().max(20_000),
  suggestion: z.string().max(20_000),
  sources: z.array(strictValidationSourceSchema).max(20).optional().default([]),
});

const strictValidationSchema = z.object({
  checkedAt: z.string().max(100),
  sourcePath: z.string().max(512),
  sourceSha256: z.string().max(128),
  reviewedHash: z.string().max(128),
  summary: z.string().max(2000),
  findings: z.array(strictValidationFindingSchema).max(200),
  current: z.boolean().optional(),
});

const annotationBackupSchema = z.object({
  id: uuidOrString,
  quote: z.string().max(1000).optional().default(""),
  comment: z.string().max(4000).optional().default(""),
  color: z.string().max(32).optional().default("accent"),
  conceptId: uuidOrString.nullable().optional(),
  createdAt: z.string().max(100).optional(),
  updatedAt: z.string().max(100).optional(),
});

const releaseGroupBackupSchema = z.object({
  id: uuidOrString,
  parentId: uuidOrString.nullable().optional(),
  title: z.string().max(120),
  category: z.string().max(80).optional(),
  description: z.string().max(2000).optional().default(""),
  position: z.number().int().optional(),
});

const releaseQuestionBackupSchema = z.object({
  id: uuidOrString,
  sourceQuestionId: uuidOrString.optional(),
  deckId: uuidOrString.nullable().optional().default(null),
  groupId: uuidOrString.nullable().optional().default(null),
  position: z.number().int().optional(),
  parentId: uuidOrString.nullable().optional().default(null),
  title: z.string().max(500),
  answer: z.string().max(200_000),
  tags: z.array(z.string().max(60)).max(30).optional().default([]),
  revision: z.number().int().min(1).optional().default(1),
  majorRevision: z.number().int().min(0).optional().default(0),
  needsEditing: z.boolean().optional().default(false),
  archived: z.boolean().optional().default(false),
  createdAt: z.string().max(100).optional(),
  updatedAt: z.string().max(100).optional(),
  validation: strictValidationSchema.nullable().optional(),
});

const chatEditBackupSchema = z.discriminatedUnion("target", [
  z.object({
    target: z.literal("question"),
    id: uuidOrString,
    revision: z.number().int().min(0),
    fields: z.object({
      title: z.string().max(500).optional(),
      answer: z.string().max(200_000).optional(),
      tags: z.array(z.string().max(60)).max(30).optional(),
    }),
  }),
  z.object({
    target: z.literal("deck"),
    id: uuidOrString,
    expected: z.object({
      title: z.string().max(120),
      description: z.string().max(2000),
    }),
    fields: z.object({
      title: z.string().max(120).optional(),
      description: z.string().max(2000).optional(),
    }),
  }),
  z.object({
    target: z.literal("note"),
    id: uuidOrString,
    expectedVersion: z.number().int().min(0),
    fields: z.object({
      note: z.string().max(100_000),
    }),
  }),
]);

const chatMessageMetaBackupSchema = z.object({
  reasoning: z.string().max(200_000).optional(),
  toolSteps: z
    .array(
      z.object({
        name: z.string().max(80),
        label: z.string().max(200),
      }),
    )
    .max(50)
    .optional(),
  references: z
    .array(
      z.object({
        id: uuidOrString,
        title: z.string().max(500),
        deckTitle: z.string().max(120),
      }),
    )
    .max(100)
    .optional(),
});

const deckGroupBackupSchema = z
  .object({
    id: uuidOrString,
    deckId: uuidOrString,
    parentId: uuidOrString.nullable().optional().default(null),
    title: z.string().max(120),
    category: z.string().max(80).optional().default(""),
    description: z.string().max(2000).optional().default(""),
    position: z.number().int().optional().default(0),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

const deckBackupSchema = z
  .object({
    id: uuidOrString,
    parentId: uuidOrString.nullable().optional().default(null),
    title: z.string().max(120),
    description: z.string().max(2000).optional().default(""),
    groupName: z.string().max(80).optional().default(""),
    groups: z.array(deckGroupBackupSchema).max(200).optional().default([]),
    color: z.string().max(32).optional().default("sage"),
    visibility: z.string().max(32).optional().default("private"),
    isOwner: z.boolean().optional().default(true),
    publishedVersion: z.number().int().min(0).optional().default(0),
    seenVersion: z.number().int().min(0).optional().default(0),
    syncedVersion: z.number().int().min(0).optional(),
    dismissedVersion: z.number().int().min(0).optional().default(0),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

const questionBackupSchema = z
  .object({
    id: uuidOrString,
    deckId: uuidOrString.nullable().optional().default(null),
    groupId: uuidOrString.nullable().optional().default(null),
    position: z.number().int().optional().default(0),
    parentId: uuidOrString.nullable().optional().default(null),
    title: z.string().max(500),
    answer: z.string().max(200_000).optional().default(""),
    tags: z.array(z.string().max(60)).max(30).optional().default([]),
    sourceText: z.string().max(200_000).optional().default(""),
    importId: uuidOrString.nullable().optional().default(null),
    validation: strictValidationSchema.nullable().optional(),
    revision: z.number().int().min(1).optional().default(1),
    majorRevision: z.number().int().min(0).optional().default(0),
    needsEditing: z.boolean().optional().default(false),
    archived: z.boolean().optional().default(false),
    isOwner: z.boolean().optional().default(true),
    note: z.string().max(100_000).optional(),
    noteVersion: z.number().int().min(0).optional(),
    annotations: z.array(annotationBackupSchema).max(100).optional(),
    annotationsVersion: z.number().int().min(0).optional(),
    favorite: z.boolean().optional(),
    fsrs: z.record(z.string(), z.unknown()).nullable().optional(),
    studyVersion: z.number().int().min(0).optional(),
    reviewedRevision: z.number().int().min(0).optional(),
    deletedAt: z.string().nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

const studyCardBackupSchema = z
  .object({
    questionId: uuidOrString,
    fsrs: z.record(z.string(), z.unknown()).nullable().optional().default(null),
    version: z.number().int().min(0).optional().default(0),
    reviewedRevision: z.number().int().min(0).optional().default(0),
    favorite: z.boolean().optional().default(false),
    note: z.string().max(100_000).optional().default(""),
    noteVersion: z.number().int().min(0).optional().default(0),
    annotations: z.array(annotationBackupSchema).max(100).optional().default([]),
    annotationsVersion: z.number().int().min(0).optional().default(0),
    updatedAt: z.string().optional(),
  })
  .passthrough();

const reviewBackupSchema = z
  .object({
    id: uuidOrString,
    questionId: uuidOrString,
    questionTitle: z.string().max(500).nullable().optional(),
    questionAnswer: z.string().max(200_000).nullable().optional(),
    rating: z.number().int().min(1).max(4),
    answer: z.string().max(50_000).nullable().optional().default(null),
    questionRevision: z.number().int().min(1).optional().default(1),
    before: z.record(z.string(), z.unknown()).nullable().optional().default(null),
    after: z.record(z.string(), z.unknown()),
    createdAt: z.string().optional(),
  })
  .passthrough();

const importBackupSchema = z
  .object({
    id: uuidOrString,
    deckId: uuidOrString.nullable().optional().default(null),
    raw: z.string().max(500_000),
    inputType: z.enum(["qa", "questions"]).optional().default("qa"),
    method: z.string().max(32).optional().default("rules"),
    sourceName: z.string().max(512).nullable().optional().default(null),
    sourceHash: z.string().max(128).nullable().optional().default(null),
    preview: z.unknown().nullable().optional(),
    commitHash: z.string().max(128).nullable().optional().default(null),
    status: z.string().max(32).optional().default("complete"),
    result: z
      .object({
        added: z.number().int(),
        duplicates: z.number().int(),
        updated: z.number().int().optional(),
        createdFolders: z.number().int().optional(),
        reusedFolders: z.number().int().optional(),
      })
      .nullable()
      .optional(),
    createdAt: z.string().optional(),
  })
  .passthrough();

const releaseBackupSchema = z
  .object({
    deckId: uuidOrString,
    version: z.number().int().min(1),
    title: z.string().max(120),
    description: z.string().max(2000).optional().default(""),
    summary: z.string().max(1000).optional().default(""),
    groups: z.array(releaseGroupBackupSchema).max(200).optional().default([]),
    questions: z
      .array(releaseQuestionBackupSchema)
      .max(5000)
      .optional()
      .default([]),
    createdAt: z.string().optional(),
  })
  .passthrough();

const subscriptionBackupSchema = z
  .object({
    deckId: uuidOrString,
    folderId: uuidOrString.nullable().optional().default(null),
    groupName: z.string().max(80).optional().default(""),
    seenVersion: z.number().int().min(0).optional().default(0),
    dismissedVersion: z.number().int().min(0).optional().default(0),
    createdAt: z.string().optional(),
  })
  .passthrough();

const messageBackupSchema = z
  .object({
    id: uuidOrString,
    role: z.string().max(32),
    content: z.string().max(200_000),
    edits: z.array(chatEditBackupSchema).max(50).nullable().optional(),
    meta: chatMessageMetaBackupSchema.nullable().optional(),
    createdAt: z.string().optional(),
  })
  .passthrough();

const conversationBackupSchema = z
  .object({
    id: uuidOrString,
    scope: z.enum(["question", "deck", "workspace"]).optional().default("question"),
    deckId: uuidOrString.nullable().optional().default(null),
    questionId: uuidOrString.nullable().optional().default(null),
    quote: z.string().max(20_000).optional().default(""),
    attempt: z.string().max(50_000).optional().default(""),
    questionTitle: z.string().max(500).optional().default(""),
    answerSnapshot: z.string().max(200_000).optional().default(""),
    questionRevision: z.number().int().min(0).optional().default(0),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    messages: z.array(messageBackupSchema).max(1000).optional().default([]),
  })
  .passthrough();

const conceptFolderBackupSchema = z
  .object({
    id: uuidOrString,
    parentId: uuidOrString.nullable().optional().default(null),
    title: z.string().max(120),
    color: z.string().max(32).optional().default("sage"),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

const conceptBackupSchema = z
  .object({
    id: uuidOrString,
    folderId: uuidOrString.nullable().optional().default(null),
    term: z.string().max(MAX_CONCEPT_TERM_LENGTH),
    aliases: z.array(z.string().max(80)).max(20).optional().default([]),
    normalizedKey: z.string().max(240).optional(),
    definition: z.string().max(MAX_CONCEPT_DEFINITION_LENGTH),
    groupName: z.string().max(MAX_CONCEPT_GROUP_LENGTH).optional().default(""),
    color: z.string().max(32).optional().default("accent"),
    sourceQuestionId: uuidOrString.nullable().optional().default(null),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

export const backupRestoreSchema = z
  .object({
    format: z.literal("shiyi-backup"),
    version: z.number().int().min(1).max(4),
    preferences: z
      .object({
        dailyGoal: z.number().int().min(1).max(200).optional(),
        dailyNewLimit: z.number().int().min(0).max(50).optional(),
        theme: z.enum(["light", "dark"]).optional(),
        timeZone: z.string().min(1).max(80).optional(),
      })
      .optional(),
    decks: z.array(deckBackupSchema).max(500).optional().default([]),
    deckGroups: z.array(deckGroupBackupSchema).max(2000).optional().default([]),
    releases: z.array(releaseBackupSchema).max(2000).optional().default([]),
    subscriptions: z
      .array(subscriptionBackupSchema)
      .max(500)
      .optional()
      .default([]),
    conceptFolders: z
      .array(conceptFolderBackupSchema)
      .max(500)
      .optional()
      .default([]),
    concepts: z
      .array(conceptBackupSchema)
      .max(MAX_CONCEPTS)
      .optional()
      .default([]),
    questions: z.array(questionBackupSchema).max(20_000).optional().default([]),
    trash: z.array(questionBackupSchema).max(5000).optional().default([]),
    personalStudyState: z
      .array(studyCardBackupSchema)
      .max(20_000)
      .optional()
      .default([]),
    reviews: z.array(reviewBackupSchema).max(100_000).optional().default([]),
    imports: z.array(importBackupSchema).max(5000).optional().default([]),
    conversations: z
      .array(conversationBackupSchema)
      .max(10_000)
      .optional()
      .default([]),
  })
  .passthrough();

export type BackupPayload = z.infer<typeof backupRestoreSchema>;

const VALID_COLORS = new Set(["sage", "blue", "sand", "rose"]);
const VALID_VISIBILITIES = new Set(["private", "public", "unlisted"]);

function safeDate(value: string | undefined, fallback = new Date()): Date {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function sanitizeColor(value: string): string {
  return VALID_COLORS.has(value) ? value : "sage";
}

function sanitizeVisibility(value: string): string {
  return VALID_VISIBILITIES.has(value) ? value : "private";
}

function sanitizeTimeZone(value: string | undefined): string {
  if (!value || /^[+-]\d/.test(value)) return "Asia/Shanghai";
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return value;
  } catch {
    return "Asia/Shanghai";
  }
}

function sanitizeFsrs(
  raw: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.due !== "string") return null;
  const parsed = Date.parse(raw.due);
  if (Number.isNaN(parsed)) return null;
  return { ...raw, due: new Date(parsed).toISOString() };
}

function deterministicRemapId(
  userId: string,
  namespace: string,
  originalId: string,
): string {
  const bytes = createHash("sha256")
    .update(`shiyi-restore:v1:${userId}:${namespace}:${originalId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const VALID_ANNOTATION_COLORS = new Set<QuestionAnnotationColor>([
  "accent",
  "amber",
  "sky",
  "rose",
]);

function sanitizeAnnotationColor(value: unknown): QuestionAnnotationColor {
  return typeof value === "string" &&
    VALID_ANNOTATION_COLORS.has(value as QuestionAnnotationColor)
    ? (value as QuestionAnnotationColor)
    : "accent";
}

function sanitizeAnnotations(
  raw: unknown[],
  conceptMap?: ReadonlyMap<string, string>,
  validUserConceptIds?: ReadonlySet<string>,
): QuestionAnnotation[] {
  const result: QuestionAnnotation[] = [];
  for (const entry of raw.slice(0, 50)) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.comment !== "string" || !item.comment.trim()) continue;
    const id =
      typeof item.id === "string" && item.id.trim()
        ? item.id.slice(0, 120)
        : crypto.randomUUID();
    const color = sanitizeAnnotationColor(item.color);
    let conceptId: string | undefined;
    if (typeof item.conceptId === "string" && item.conceptId.trim()) {
      const rawCid = item.conceptId.trim().slice(0, 120);
      const mapped = conceptMap?.get(rawCid);
      if (mapped) {
        conceptId = mapped;
      } else if (validUserConceptIds?.has(rawCid)) {
        conceptId = rawCid;
      }
    }
    const nowIso = new Date().toISOString();
    result.push({
      id,
      quote: typeof item.quote === "string" ? item.quote.slice(0, 600) : "",
      comment: item.comment.trim().slice(0, 2000),
      color,
      ...(conceptId ? { conceptId } : {}),
      createdAt:
        typeof item.createdAt === "string" ? item.createdAt : nowIso,
      updatedAt:
        typeof item.updatedAt === "string" ? item.updatedAt : nowIso,
    });
  }
  return result;
}

/**
 * Topologically order folders so parents are always processed before children.
 * Cycles or unknown parents are gracefully detached to root (`parentId = null`).
 */
function topoSortFolders<T extends { id: string; parentId: string | null }>(
  items: readonly T[],
): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const result: T[] = [];
  const state = new Map<string, "visiting" | "done">();

  const visit = (item: T) => {
    const cur = state.get(item.id);
    if (cur === "done" || cur === "visiting") return;
    state.set(item.id, "visiting");
    if (item.parentId && byId.has(item.parentId) && item.parentId !== item.id) {
      const parentState = state.get(item.parentId);
      if (parentState !== "visiting") {
        visit(byId.get(item.parentId)!);
      }
    }
    state.set(item.id, "done");
    result.push(item);
  };

  for (const item of items) visit(item);
  return result;
}

const RESTORE_BATCH_SIZE = 500;
const IN_ARRAY_CHUNK_SIZE = 5000;
const MAX_GLOBAL_RESTORES = 2;

const restoreConcurrencyState = globalThis as unknown as {
  interviewRestoreUsers?: Set<string>;
  interviewRestoreGlobal?: number;
};

function acquireRestore(userId: string) {
  restoreConcurrencyState.interviewRestoreUsers ??= new Set();
  const activeGlobal = restoreConcurrencyState.interviewRestoreGlobal ?? 0;
  if (restoreConcurrencyState.interviewRestoreUsers.has(userId)) {
    throw new AppError(429, "已有备份恢复正在处理，请稍候。");
  }
  if (activeGlobal >= MAX_GLOBAL_RESTORES) {
    throw new AppError(429, "当前系统恢复任务繁忙，请稍候再试。");
  }
  restoreConcurrencyState.interviewRestoreUsers.add(userId);
  restoreConcurrencyState.interviewRestoreGlobal = activeGlobal + 1;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      restoreConcurrencyState.interviewRestoreUsers?.delete(userId);
      restoreConcurrencyState.interviewRestoreGlobal = Math.max(
        0,
        (restoreConcurrencyState.interviewRestoreGlobal ?? 1) - 1,
      );
    }
  };
}

async function queryInChunks<T>(
  ids: readonly string[],
  fetchChunk: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  if (!ids.length) return [];
  if (ids.length <= IN_ARRAY_CHUNK_SIZE) return fetchChunk([...ids]);
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_ARRAY_CHUNK_SIZE) {
    const rows = await fetchChunk(ids.slice(i, i + IN_ARRAY_CHUNK_SIZE));
    out.push(...rows);
  }
  return out;
}

export async function restorePersonalBackup(
  userId: string,
  rawPayload: unknown,
) {
  const parsed = backupRestoreSchema.safeParse(rawPayload);
  if (!parsed.success) {
    throw new AppError(
      400,
      "备份文件格式无效或已损坏，请确认是否为拾忆导出的 JSON 备份。",
    );
  }
  const data = parsed.data;
  const releaseRestore = acquireRestore(userId);
  try {
    const db = await getDb();

    return await db.transaction(async (tx) => {
      await lockUserTree(tx, userId);

    const withRemapped = (ids: string[], namespace: string) => [
      ...new Set([
        ...ids,
        ...ids.map((id) => deterministicRemapId(userId, namespace, id)),
      ]),
    ];

    const groupCandidates = [
      ...data.deckGroups,
      ...data.decks.flatMap((d) => d.groups ?? []),
    ];

    // Collect synthetic IDs that v1/v2 restore might generate for groupName / category folders.
    const syntheticGroupNameIds: string[] = [];
    const syntheticCategoryIds: string[] = [];
    if (data.version <= 2) {
      for (const d of data.decks) {
        const gn = d.groupName.trim();
        if (gn) {
          syntheticGroupNameIds.push(
            deterministicRemapId(
              userId,
              "v2-groupname",
              normalizeFolderTitleKey(gn),
            ),
          );
        }
      }
      for (const s of data.subscriptions) {
        const gn = s.groupName.trim();
        if (gn) {
          syntheticGroupNameIds.push(
            deterministicRemapId(
              userId,
              "v2-groupname",
              normalizeFolderTitleKey(gn),
            ),
          );
        }
      }
      for (const g of groupCandidates) {
        const cat = g.category.trim();
        if (cat) {
          syntheticCategoryIds.push(
            deterministicRemapId(
              userId,
              "v2-cat",
              `${g.deckId}\0${normalizeFolderTitleKey(cat)}`,
            ),
          );
        }
      }
    }

    const allDeckIds = [
      ...new Set([
        ...withRemapped(
          data.decks.map((d) => d.id).filter(Boolean),
          "deck",
        ),
        ...withRemapped(
          groupCandidates.map((g) => g.id).filter(Boolean),
          "group",
        ),
        ...syntheticGroupNameIds,
        ...syntheticCategoryIds,
      ]),
    ];
    const allImportIds = withRemapped(
      data.imports.map((i) => i.id).filter(Boolean),
      "import",
    );
    const allQuestionCandidates = [...data.questions, ...data.trash];
    const releaseQuestionIds = data.releases.flatMap((rel) =>
      rel.questions.map((q) => q.id).filter(Boolean),
    );
    const allQuestionIds = [
      ...new Set([
        ...withRemapped(
          [
            ...allQuestionCandidates.map((q) => q.id).filter(Boolean),
            ...releaseQuestionIds,
          ],
          "question",
        ),
        ...withRemapped(releaseQuestionIds, "release-alias"),
      ]),
    ];
    const allReviewIds = withRemapped(
      data.reviews.map((r) => r.id).filter(Boolean),
      "review",
    );
    const allConvIds = withRemapped(
      data.conversations.map((c) => c.id).filter(Boolean),
      "conv",
    );
    const allMsgIds = withRemapped(
      data.conversations
        .flatMap((c) => c.messages.map((m) => m.id))
        .filter(Boolean),
      "msg",
    );
    const allConceptIds = withRemapped(
      data.concepts.map((c) => c.id).filter(Boolean),
      "concept",
    );
    const syntheticConceptGroupIds = data.concepts
      .filter((c) => !c.folderId && c.groupName.trim())
      .map((c) =>
        deterministicRemapId(
          userId,
          "concept-group",
          normalizeFolderTitleKey(sanitizeLegacyFolderTitle(c.groupName)),
        ),
      );
    const allConceptFolderIds = [
      ...new Set([
        ...withRemapped(
          data.conceptFolders.map((f) => f.id).filter(Boolean),
          "concept-folder",
        ),
        ...syntheticConceptGroupIds,
      ]),
    ];

    const [
      existingPrefRows,
      existingUserQuestionAny,
      existingUserReviewAny,
      existingDecks,
      existingSubs,
      existingImports,
      existingQuestions,
      existingStudyCards,
      existingReviews,
      existingConvs,
      existingMsgs,
      currentOwnedFolders,
      existingConceptsByIds,
      currentUserConcepts,
      existingConceptFoldersByIds,
      currentUserConceptFolders,
    ] = await Promise.all([
      tx
        .select({
          userId: preferences.userId,
          dailyGoal: preferences.dailyGoal,
          dailyNewLimit: preferences.dailyNewLimit,
          theme: preferences.theme,
          timeZone: preferences.timeZone,
        })
        .from(preferences)
        .where(eq(preferences.userId, userId)),
      tx
        .select({ id: questions.id })
        .from(questions)
        .where(and(eq(questions.ownerId, userId), isNull(questions.purgedAt)))
        .limit(1),
      tx
        .select({ id: reviewEvents.id })
        .from(reviewEvents)
        .where(eq(reviewEvents.userId, userId))
        .limit(1),
      queryInChunks(allDeckIds, (chunk) =>
        tx
          .select({
            id: decks.id,
            ownerId: decks.ownerId,
            parentId: decks.parentId,
            title: decks.title,
            visibility: decks.visibility,
            publishedVersion: decks.publishedVersion,
            deletedAt: decks.deletedAt,
          })
          .from(decks)
          .where(inArray(decks.id, chunk)),
      ),
      tx
        .select({
          deckId: subscriptions.deckId,
          seenVersion: subscriptions.seenVersion,
        })
        .from(subscriptions)
        .where(eq(subscriptions.userId, userId)),
      queryInChunks(allImportIds, (chunk) =>
        tx
          .select({ id: imports.id, userId: imports.userId })
          .from(imports)
          .where(inArray(imports.id, chunk)),
      ),
      queryInChunks(allQuestionIds, (chunk) =>
        tx
          .select({
            id: questions.id,
            ownerId: questions.ownerId,
            deckId: questions.deckId,
            deletedAt: questions.deletedAt,
            purgedAt: questions.purgedAt,
          })
          .from(questions)
          .where(inArray(questions.id, chunk)),
      ),
      tx
        .select({ questionId: studyCards.questionId })
        .from(studyCards)
        .where(eq(studyCards.userId, userId)),
      queryInChunks(allReviewIds, (chunk) =>
        tx
          .select({ id: reviewEvents.id, userId: reviewEvents.userId })
          .from(reviewEvents)
          .where(inArray(reviewEvents.id, chunk)),
      ),
      queryInChunks(allConvIds, (chunk) =>
        tx
          .select({ id: conversations.id, userId: conversations.userId })
          .from(conversations)
          .where(inArray(conversations.id, chunk)),
      ),
      queryInChunks(allMsgIds, (chunk) =>
        tx
          .select({ id: messages.id })
          .from(messages)
          .where(inArray(messages.id, chunk)),
      ),
      loadActiveOwnedFolders(tx, userId),
      queryInChunks(allConceptIds, (chunk) =>
        tx
          .select({
            id: concepts.id,
            userId: concepts.userId,
            normalizedKey: concepts.normalizedKey,
          })
          .from(concepts)
          .where(inArray(concepts.id, chunk)),
      ),
      tx
        .select({
          id: concepts.id,
          normalizedKey: concepts.normalizedKey,
        })
        .from(concepts)
        .where(eq(concepts.userId, userId)),
      queryInChunks(allConceptFolderIds, (chunk) =>
        tx
          .select({
            id: conceptFolders.id,
            userId: conceptFolders.userId,
            parentId: conceptFolders.parentId,
            title: conceptFolders.title,
          })
          .from(conceptFolders)
          .where(inArray(conceptFolders.id, chunk)),
      ),
      tx
        .select()
        .from(conceptFolders)
        .where(eq(conceptFolders.userId, userId)),
    ]);

    const existingDeckById = new Map(existingDecks.map((d) => [d.id, d]));
    const existingSubSet = new Set(existingSubs.map((s) => s.deckId));
    const existingSubSeenByDeck = new Map(
      existingSubs.map((s) => [s.deckId, s.seenVersion]),
    );
    const validReleaseKeys = new Set(
      data.releases.map((r) => `${r.deckId}:${r.version}`),
    );
    const existingImportById = new Map(existingImports.map((i) => [i.id, i]));
    const existingQuestionById = new Map(
      existingQuestions.map((q) => [q.id, q]),
    );
    const existingStudySet = new Set(
      existingStudyCards.map((c) => c.questionId),
    );
    const existingReviewById = new Map(existingReviews.map((r) => [r.id, r]));
    const existingConvById = new Map(existingConvs.map((c) => [c.id, c]));
    const existingMsgSet = new Set(existingMsgs.map((m) => m.id));
    const existingConceptById = new Map(
      existingConceptsByIds.map((c) => [c.id, c]),
    );
    const existingUserConceptByNormKey = new Map(
      currentUserConcepts.map((c) => [c.normalizedKey, c.id]),
    );
    const validUserConceptIds = new Set(currentUserConcepts.map((c) => c.id));
    const existingConceptFolderById = new Map(
      existingConceptFoldersByIds.map((f) => [f.id, f]),
    );

    let preferencesRestored = false;
    if (data.preferences) {
      const existingPref = existingPrefRows[0];
      const targetPref = {
        dailyGoal: data.preferences.dailyGoal ?? 5,
        dailyNewLimit: data.preferences.dailyNewLimit ?? 3,
        theme: data.preferences.theme ?? "light",
        timeZone: sanitizeTimeZone(data.preferences.timeZone),
      };
      if (!existingPref) {
        const insertedPref = await tx
          .insert(preferences)
          .values({
            userId,
            ...targetPref,
            onboarded: true,
          })
          .onConflictDoNothing()
          .returning({ userId: preferences.userId });
        preferencesRestored = insertedPref.length > 0;
      } else {
        const isSystemDefaultPref =
          existingPref.dailyGoal === 5 &&
          existingPref.dailyNewLimit === 3 &&
          existingPref.theme === "light" &&
          existingPref.timeZone === "Asia/Shanghai";
        const isFreshWorkspace =
          existingSubs.length === 0 &&
          existingUserQuestionAny.length === 0 &&
          existingUserReviewAny.length === 0;
        const differsFromExisting =
          existingPref.dailyGoal !== targetPref.dailyGoal ||
          existingPref.dailyNewLimit !== targetPref.dailyNewLimit ||
          existingPref.theme !== targetPref.theme ||
          existingPref.timeZone !== targetPref.timeZone;
        if (isSystemDefaultPref && isFreshWorkspace && differsFromExisting) {
          const updatedPref = await tx
            .update(preferences)
            .set(targetPref)
            .where(eq(preferences.userId, userId))
            .returning({ userId: preferences.userId });
          preferencesRestored = updatedPref.length > 0;
        }
      }
    }

    // Track active owned folder tree in memory so sibling title uniqueness & max depth <= 8 are always satisfied.
    const tree = buildServerFolderTree(currentOwnedFolders);
    const validOwnedDeckIds = new Set<string>(tree.byId.keys());
    const siblingLowerNames = (parentId: string | null): Set<string> =>
      new Set(
        (tree.children.get(parentId) ?? []).map((f) =>
          normalizeFolderTitleKey(f.title),
        ),
      );
    const registerTreeFolder = (row: typeof decks.$inferSelect) => {
      tree.byId.set(row.id, row);
      const list = tree.children.get(row.parentId ?? null) ?? [];
      list.push(row);
      tree.children.set(row.parentId ?? null, list);
      if (!tree.children.has(row.id)) tree.children.set(row.id, []);
      validOwnedDeckIds.add(row.id);
    };

    const clampParentForDepth = (candidateParentId: string | null): string | null => {
      if (!candidateParentId || !tree.byId.has(candidateParentId)) return null;
      let cursor: string | null = candidateParentId;
      while (cursor && folderDepth(tree, cursor) >= MAX_FOLDER_DEPTH) {
        cursor = tree.byId.get(cursor)?.parentId ?? null;
      }
      return cursor;
    };

    async function ensureSyntheticFolder(
      parentId: string | null,
      rawTitle: string,
      deterministicId: string,
      color = "sage",
    ): Promise<string> {
      const safeParent = clampParentForDepth(parentId);
      const title = sanitizeLegacyFolderTitle(rawTitle);
      const key = normalizeFolderTitleKey(title);
      const existingSibling = (tree.children.get(safeParent) ?? []).find(
        (f) => normalizeFolderTitleKey(f.title) === key,
      );
      if (existingSibling) return existingSibling.id;

      const existingById = existingDeckById.get(deterministicId);
      if (existingById && existingById.ownerId === userId && !existingById.deletedAt) {
        return existingById.id;
      }
      const id = existingById ? crypto.randomUUID() : deterministicId;
      const now = new Date();
      const [inserted] = await tx
        .insert(decks)
        .values({
          id,
          ownerId: userId,
          parentId: safeParent,
          title,
          description: "",
          color: sanitizeColor(color),
          visibility: "private",
          publishedVersion: 0,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      registerTreeFolder(inserted);
      return inserted.id;
    }

    const deckMap = new Map<string, string>();
    const groupMap = new Map<string, string>();
    const materializedSubDeckIds = new Set<string>();
    const newlyInsertedOwnedDeckIds = new Set<string>();
    const accessibleSubDeckIds = new Set<string>();
    let restoredDecks = 0;
    let skippedDecks = 0;

    const subRowByDeck = new Map(
      data.subscriptions.map((s) => [s.deckId, s]),
    );

    // Partition backup decks into accessible subscriptions vs owned/materialized folders.
    const ownedOrMaterializedDecks: z.infer<typeof deckBackupSchema>[] = [];
    const accessibleSubDecks: {
      deck: z.infer<typeof deckBackupSchema>;
      existing: (typeof existingDecks)[number];
    }[] = [];

    for (const deck of data.decks) {
      const existing = existingDeckById.get(deck.id);
      if (!deck.isOwner) {
        const canKeepSubscription =
          Boolean(existing) &&
          !existing!.deletedAt &&
          existing!.ownerId !== userId &&
          (existing!.visibility === "public" || existingSubSet.has(deck.id));
        if (canKeepSubscription && existing) {
          accessibleSubDecks.push({ deck, existing });
          continue;
        }
        materializedSubDeckIds.add(deck.id);
      }
      ownedOrMaterializedDecks.push(deck);
    }

    // For v1/v2 backups, synthesize top-level folders for deck.groupName before inserting decks.
    const groupNameFolderMap = new Map<string, string>();
    if (data.version <= 2) {
      const groupNamesToEnsure: { name: string; color: string }[] = [];
      for (const d of ownedOrMaterializedDecks) {
        if (d.groupName.trim()) {
          groupNamesToEnsure.push({ name: d.groupName.trim(), color: d.color });
        }
      }
      for (const { deck } of accessibleSubDecks) {
        const subBackup = subRowByDeck.get(deck.id);
        const gn = (subBackup?.groupName ?? deck.groupName ?? "").trim();
        if (gn) groupNamesToEnsure.push({ name: gn, color: "sage" });
      }
      for (const { name, color } of groupNamesToEnsure) {
        const key = normalizeFolderTitleKey(name);
        if (groupNameFolderMap.has(key)) continue;
        const detId = deterministicRemapId(userId, "v2-groupname", key);
        const folderId = await ensureSyntheticFolder(null, name, detId, color);
        groupNameFolderMap.set(key, folderId);
      }
    }

    // Restore owned & materialized folders in topological order (parents before children).
    const orderedOwnedDecks = topoSortFolders(ownedOrMaterializedDecks);
    for (const deck of orderedOwnedDecks) {
      const existing = existingDeckById.get(deck.id);
      if (existing && existing.ownerId === userId && !existing.deletedAt) {
        deckMap.set(deck.id, deck.id);
        validOwnedDeckIds.add(deck.id);
        skippedDecks += 1;
        continue;
      }

      let targetDeckId = deck.id;
      if (existing) {
        const remappedId = deterministicRemapId(userId, "deck", deck.id);
        const existingRemapped = existingDeckById.get(remappedId);
        if (
          existingRemapped &&
          existingRemapped.ownerId === userId &&
          !existingRemapped.deletedAt
        ) {
          deckMap.set(deck.id, remappedId);
          validOwnedDeckIds.add(remappedId);
          skippedDecks += 1;
          continue;
        }
        targetDeckId = existingRemapped ? crypto.randomUUID() : remappedId;
      }

      // Determine parentId:
      // - v3 uses deck.parentId mapped through deckMap
      // - v1/v2 uses synthesized top-level folder from deck.groupName if non-empty
      let resolvedParentId: string | null = null;
      if (deck.parentId) {
        const mappedParent = deckMap.get(deck.parentId) ?? deck.parentId;
        if (mappedParent !== targetDeckId && validOwnedDeckIds.has(mappedParent)) {
          resolvedParentId = clampParentForDepth(mappedParent);
        }
      } else if (data.version <= 2 && deck.groupName.trim()) {
        const gnId = groupNameFolderMap.get(
          normalizeFolderTitleKey(deck.groupName),
        );
        if (gnId && gnId !== targetDeckId) {
          resolvedParentId = clampParentForDepth(gnId);
        }
      }

      const rawTitle = sanitizeLegacyFolderTitle(deck.title || "未命名文件夹");
      const safeTitle = resolveUniqueSiblingTitle(
        rawTitle,
        siblingLowerNames(resolvedParentId),
      );

      deckMap.set(deck.id, targetDeckId);
      const isMaterializedSub = materializedSubDeckIds.has(deck.id);
      const requestedVisibility = isMaterializedSub
        ? "private"
        : sanitizeVisibility(deck.visibility);
      const requestedPublishedVersion = isMaterializedSub
        ? 0
        : (deck.publishedVersion ?? 0);
      const hasValidRelease =
        requestedVisibility !== "private" &&
        requestedPublishedVersion > 0 &&
        validReleaseKeys.has(`${deck.id}:${requestedPublishedVersion}`);
      const insertedDeck = await tx
        .insert(decks)
        .values({
          id: targetDeckId,
          ownerId: userId,
          parentId: resolvedParentId,
          title: safeTitle,
          description: (deck.description ?? "").slice(0, 2000),
          color: sanitizeColor(deck.color),
          visibility: hasValidRelease ? requestedVisibility : "private",
          publishedVersion: hasValidRelease ? requestedPublishedVersion : 0,
          createdAt: safeDate(deck.createdAt),
          updatedAt: safeDate(deck.updatedAt),
        })
        .onConflictDoNothing()
        .returning();
      if (insertedDeck.length) {
        registerTreeFolder(insertedDeck[0]);
        restoredDecks += 1;
        if (!isMaterializedSub && hasValidRelease) {
          newlyInsertedOwnedDeckIds.add(targetDeckId);
        }
      } else {
        skippedDecks += 1;
      }
    }

    // Restore accessible subscriptions now that owned folders exist so folderId placement resolves cleanly.
    const subVersionPairs: { deckId: string; version: number }[] = [];
    for (const { deck, existing } of accessibleSubDecks) {
      deckMap.set(deck.id, deck.id);
      accessibleSubDeckIds.add(deck.id);
      const subBackup = subRowByDeck.get(deck.id);
      const latestVersion = existing.publishedVersion;
      if (latestVersion > 0 && !existingSubSet.has(deck.id)) {
        let placementFolderId: string | null = null;
        const candidateFolderRef = subBackup?.folderId ?? deck.parentId ?? null;
        if (candidateFolderRef) {
          const mapped = deckMap.get(candidateFolderRef) ?? candidateFolderRef;
          if (validOwnedDeckIds.has(mapped)) placementFolderId = mapped;
        } else if (data.version <= 2) {
          const gn = (subBackup?.groupName ?? deck.groupName ?? "").trim();
          if (gn) {
            placementFolderId =
              groupNameFolderMap.get(normalizeFolderTitleKey(gn)) ?? null;
          }
        }
        await tx
          .insert(subscriptions)
          .values({
            userId,
            deckId: deck.id,
            folderId: placementFolderId,
            seenVersion: latestVersion,
            dismissedVersion: subBackup?.dismissedVersion ?? 0,
          })
          .onConflictDoNothing();
        existingSubSet.add(deck.id);
        existingSubSeenByDeck.set(deck.id, latestVersion);
        subVersionPairs.push({ deckId: deck.id, version: latestVersion });
        restoredDecks += 1;
      } else {
        const currentSeen = existingSubSeenByDeck.get(deck.id) ?? latestVersion;
        if (currentSeen > 0) {
          subVersionPairs.push({ deckId: deck.id, version: currentSeen });
        }
        skippedDecks += 1;
      }
    }

    const subAllowedQuestionIdsByDeck = new Map<string, Set<string>>();
    if (subVersionPairs.length) {
      const subReleaseRows = await tx
        .select({
          deckId: releases.deckId,
          questions: releases.questions,
        })
        .from(releases)
        .where(
          or(
            ...subVersionPairs.map((p) =>
              and(eq(releases.deckId, p.deckId), eq(releases.version, p.version)),
            ),
          ),
        );
      for (const rel of subReleaseRows) {
        const set = subAllowedQuestionIdsByDeck.get(rel.deckId) ?? new Set();
        for (const rq of rel.questions) {
          if (rq?.id) set.add(rq.id);
        }
        subAllowedQuestionIdsByDeck.set(rel.deckId, set);
      }
    }

    // Convert v1/v2 deckGroups into child folders under their deck (with category subfolders when present).
    const dedupedGroups = new Map<string, z.infer<typeof deckGroupBackupSchema>>();
    for (const g of data.deckGroups) {
      dedupedGroups.set(g.id, g);
    }
    for (const deck of data.decks) {
      for (const g of deck.groups ?? []) {
        if (!dedupedGroups.has(g.id)) {
          dedupedGroups.set(g.id, { ...g, deckId: g.deckId || deck.id });
        }
      }
    }

    let restoredGroups = 0;
    const categorySubfolderCache = new Map<string, string>();
    const orderedGroups = topoSortFolders(Array.from(dedupedGroups.values()));
    for (const grp of orderedGroups) {
      if (accessibleSubDeckIds.has(grp.deckId)) {
        groupMap.set(grp.id, grp.id);
        continue;
      }
      const targetDeckId = deckMap.get(grp.deckId);
      if (!targetDeckId || !validOwnedDeckIds.has(targetDeckId)) continue;

      const existing = existingDeckById.get(grp.id);
      if (existing && existing.ownerId === userId && !existing.deletedAt) {
        groupMap.set(grp.id, grp.id);
        validOwnedDeckIds.add(grp.id);
        continue;
      }

      let targetGroupId = grp.id;
      if (existing) {
        const remappedId = deterministicRemapId(userId, "group", grp.id);
        const existingRemapped = existingDeckById.get(remappedId);
        if (
          existingRemapped &&
          existingRemapped.ownerId === userId &&
          !existingRemapped.deletedAt
        ) {
          groupMap.set(grp.id, remappedId);
          validOwnedDeckIds.add(remappedId);
          continue;
        }
        targetGroupId = existingRemapped ? crypto.randomUUID() : remappedId;
      }

      let groupParentId: string | null = targetDeckId;
      const mappedGroupParent = grp.parentId
        ? (groupMap.get(grp.parentId) ?? deckMap.get(grp.parentId) ?? null)
        : null;
      if (
        mappedGroupParent &&
        mappedGroupParent !== targetGroupId &&
        validOwnedDeckIds.has(mappedGroupParent)
      ) {
        groupParentId = mappedGroupParent;
      } else {
        const cat = grp.category.trim();
        if (cat) {
          const catKey = `${targetDeckId}\0${normalizeFolderTitleKey(cat)}`;
          let catFolderId = categorySubfolderCache.get(catKey);
          if (!catFolderId) {
            const detCatId = deterministicRemapId(
              userId,
              "v2-cat",
              `${grp.deckId}\0${normalizeFolderTitleKey(cat)}`,
            );
            catFolderId = await ensureSyntheticFolder(
              targetDeckId,
              cat,
              detCatId,
              tree.byId.get(targetDeckId)?.color ?? "sage",
            );
            categorySubfolderCache.set(catKey, catFolderId);
          }
          groupParentId = catFolderId;
        }
      }
      groupParentId = clampParentForDepth(groupParentId);

      const rawTitle = sanitizeLegacyFolderTitle(grp.title || "未命名文件夹");
      const safeTitle = resolveUniqueSiblingTitle(
        rawTitle,
        siblingLowerNames(groupParentId),
      );
      groupMap.set(grp.id, targetGroupId);

      const inserted = await tx
        .insert(decks)
        .values({
          id: targetGroupId,
          ownerId: userId,
          parentId: groupParentId,
          title: safeTitle,
          description: (grp.description ?? "").slice(0, 2000),
          color: tree.byId.get(targetDeckId)?.color ?? "sage",
          visibility: "private",
          publishedVersion: 0,
          createdAt: safeDate(grp.createdAt),
          updatedAt: safeDate(grp.updatedAt),
        })
        .onConflictDoNothing()
        .returning();
      if (inserted.length) {
        registerTreeFolder(inserted[0]);
        restoredGroups += 1;
      }
    }

    // Restore committed/referenced imports.
    const importMap = new Map<string, string>();
    const validImportIds = new Set<string>();
    const currentOwnedImports = await tx
      .select({ id: imports.id })
      .from(imports)
      .where(eq(imports.userId, userId));
    for (const imp of currentOwnedImports) {
      validImportIds.add(imp.id);
    }
    const referencedImportIds = new Set(
      allQuestionCandidates
        .map((q) => q.importId)
        .filter((id): id is string => !!id),
    );
    for (const imp of data.imports) {
      if (imp.status !== "complete" && !referencedImportIds.has(imp.id)) {
        continue;
      }
      const existing = existingImportById.get(imp.id);
      if (existing && existing.userId === userId) {
        importMap.set(imp.id, imp.id);
        validImportIds.add(imp.id);
        continue;
      }
      let targetImportId = imp.id;
      if (existing) {
        const remappedId = deterministicRemapId(userId, "import", imp.id);
        const existingRemapped = existingImportById.get(remappedId);
        if (existingRemapped && existingRemapped.userId === userId) {
          importMap.set(imp.id, remappedId);
          validImportIds.add(remappedId);
          continue;
        }
        targetImportId = existingRemapped ? crypto.randomUUID() : remappedId;
      }
      importMap.set(imp.id, targetImportId);
      const mappedDeckId =
        imp.deckId && deckMap.has(imp.deckId) ? deckMap.get(imp.deckId)! : null;
      const inserted = await tx
        .insert(imports)
        .values({
          id: targetImportId,
          userId,
          deckId:
            mappedDeckId && validOwnedDeckIds.has(mappedDeckId)
              ? mappedDeckId
              : null,
          raw: imp.raw,
          inputType: imp.inputType,
          method: imp.method,
          sourceName: imp.sourceName,
          sourceHash: imp.sourceHash,
          preview: null,
          commitHash: imp.commitHash,
          status: imp.status,
          result: imp.result ?? null,
          createdAt: safeDate(imp.createdAt),
        })
        .onConflictDoNothing()
        .returning({ id: imports.id });
      if (inserted.length) {
        validImportIds.add(targetImportId);
      }
    }

    // Restore questions (active + trash).
    const questionMap = new Map<string, string>();
    const validQuestionIds = new Set<string>();
    const currentOwnedQuestions = await tx
      .select({
        id: questions.id,
        deckId: questions.deckId,
        contentHash: questions.contentHash,
        deletedAt: questions.deletedAt,
      })
      .from(questions)
      .where(and(eq(questions.ownerId, userId), isNull(questions.purgedAt)));
    const ownedHashLookup = new Map<string, string>();
    for (const q of currentOwnedQuestions) {
      validQuestionIds.add(q.id);
      if (!q.deletedAt) {
        ownedHashLookup.set(`${q.deckId ?? ""}\0${q.contentHash}`, q.id);
      }
    }

    let restoredQuestions = 0;
    let skippedQuestions = 0;
    const seenQuestions = new Set<string>();
    const pendingQuestions: (typeof questions.$inferInsert)[] = [];

    for (const q of allQuestionCandidates) {
      if (seenQuestions.has(q.id)) continue;
      seenQuestions.add(q.id);

      const isSubAccessible =
        !q.isOwner &&
        q.deckId !== null &&
        accessibleSubDeckIds.has(q.deckId);
      const existing = existingQuestionById.get(q.id);

      if (isSubAccessible) {
        const allowedInRelease = subAllowedQuestionIdsByDeck
          .get(q.deckId!)
          ?.has(q.id);
        if (allowedInRelease && existing && !existing.purgedAt) {
          questionMap.set(q.id, q.id);
          validQuestionIds.add(q.id);
        }
        skippedQuestions += 1;
        continue;
      }

      if (existing && existing.ownerId === userId && !existing.purgedAt) {
        questionMap.set(q.id, q.id);
        validQuestionIds.add(q.id);
        skippedQuestions += 1;
        continue;
      }

      let resolvedCollisionId: string | null = null;
      if (existing) {
        const remappedId = deterministicRemapId(userId, "question", q.id);
        const existingRemapped = existingQuestionById.get(remappedId);
        if (
          existingRemapped &&
          existingRemapped.ownerId === userId &&
          !existingRemapped.purgedAt
        ) {
          questionMap.set(q.id, remappedId);
          validQuestionIds.add(remappedId);
          skippedQuestions += 1;
          continue;
        }
        resolvedCollisionId = existingRemapped
          ? crypto.randomUUID()
          : remappedId;
      }

      // Resolve target folder: for v1/v2 backups with groupId, map directly to the migrated subfolder!
      let targetDeckId: string | null = null;
      if (q.groupId && groupMap.has(q.groupId)) {
        const mappedGrp = groupMap.get(q.groupId)!;
        if (validOwnedDeckIds.has(mappedGrp)) targetDeckId = mappedGrp;
      }
      if (!targetDeckId && q.deckId) {
        const mappedDeckId = deckMap.get(q.deckId) ?? null;
        if (mappedDeckId && validOwnedDeckIds.has(mappedDeckId)) {
          targetDeckId = mappedDeckId;
        }
      }

      const mappedImportId = q.importId
        ? (importMap.get(q.importId) ?? null)
        : null;
      const targetImportId =
        mappedImportId && validImportIds.has(mappedImportId)
          ? mappedImportId
          : null;

      const normalizedTags = mergeQuestionTags([], q.tags ?? []);
      const answer = q.answer ?? "";
      const hash = contentHash(q.title, answer);
      const isTrashed = Boolean(q.deletedAt);

      if (!isTrashed) {
        const dupId = ownedHashLookup.get(`${targetDeckId ?? ""}\0${hash}`);
        if (dupId) {
          questionMap.set(q.id, dupId);
          validQuestionIds.add(dupId);
          skippedQuestions += 1;
          continue;
        }
      }

      const targetQuestionId = resolvedCollisionId ?? q.id;
      questionMap.set(q.id, targetQuestionId);
      validQuestionIds.add(targetQuestionId);
      pendingQuestions.push({
        id: targetQuestionId,
        ownerId: userId,
        deckId: targetDeckId,
        position: q.position ?? 0,
        deletedAt: q.deletedAt ? safeDate(q.deletedAt) : null,
        purgedAt: null,
        parentId: q.parentId ? (questionMap.get(q.parentId) ?? null) : null,
        title: (q.title || "未命名题目").slice(0, 500),
        answer,
        tags: normalizedTags,
        sourceText: q.sourceText ?? "",
        importId: targetImportId,
        validation: (q.validation as ContentValidation | null) ?? null,
        contentHash: hash,
        revision: Math.max(1, q.revision ?? 1),
        needsEditing: q.needsEditing ?? !answer.trim(),
        archived: q.archived ?? false,
        majorRevision: Math.max(0, q.majorRevision ?? 0),
        createdAt: safeDate(q.createdAt),
        updatedAt: safeDate(q.updatedAt),
      });
    }

    for (let i = 0; i < pendingQuestions.length; i += RESTORE_BATCH_SIZE) {
      const chunk = pendingQuestions.slice(i, i + RESTORE_BATCH_SIZE);
      const inserted = await tx
        .insert(questions)
        .values(chunk)
        .onConflictDoNothing()
        .returning({ id: questions.id });
      restoredQuestions += inserted.length;
      skippedQuestions += chunk.length - inserted.length;
    }

    // Restore published release snapshots for newly restored owned folders.
    let restoredReleases = 0;
    const sortedReleases = [...data.releases].sort(
      (a, b) =>
        a.version - b.version ||
        safeDate(a.createdAt).getTime() - safeDate(b.createdAt).getTime(),
    );
    const mapFolderRef = (id: string) =>
      groupMap.get(id) ?? deckMap.get(id) ?? id;
    const pendingAliasPlaceholders: (typeof questions.$inferInsert)[] = [];
    const pendingReleaseRows: (typeof releases.$inferInsert)[] = [];

    for (const rel of sortedReleases) {
      const targetDeckId = deckMap.get(rel.deckId);
      if (!targetDeckId || !newlyInsertedOwnedDeckIds.has(targetDeckId)) {
        continue;
      }
      const mappedGroups: PublishedDeckGroup[] = rel.groups.map((g) => ({
        id: mapFolderRef(g.id),
        title: g.title,
        description: g.description ?? "",
        ...(g.category !== undefined ? { category: g.category } : {}),
        ...(g.position !== undefined ? { position: g.position } : {}),
        ...(g.parentId !== undefined
          ? { parentId: g.parentId ? mapFolderRef(g.parentId) : null }
          : {}),
      }));
      const aliasTs = safeDate(rel.createdAt);
      const aliasIso = aliasTs.toISOString();
      const mappedQuestions: PublishedQuestion[] = [];
      for (const q of rel.questions) {
        let targetId = questionMap.get(q.id);
        if (!targetId) {
          const existing = existingQuestionById.get(q.id);
          if (existing && existing.ownerId === userId) {
            targetId = q.id;
          } else if (!existing) {
            targetId = q.id;
          } else {
            const remappedId = deterministicRemapId(
              userId,
              "release-alias",
              q.id,
            );
            const existingRemapped = existingQuestionById.get(remappedId);
            if (existingRemapped && existingRemapped.ownerId === userId) {
              targetId = remappedId;
            } else {
              targetId = existingRemapped ? crypto.randomUUID() : remappedId;
            }
          }
          const known = existingQuestionById.get(targetId);
          if (!known || known.ownerId !== userId) {
            pendingAliasPlaceholders.push({
              id: targetId,
              ownerId: userId,
              deckId: null,
              title: "",
              answer: "",
              contentHash: `publication:${targetId}`,
              deletedAt: aliasTs,
              purgedAt: aliasTs,
            });
            existingQuestionById.set(targetId, {
              id: targetId,
              ownerId: userId,
              deckId: null,
              deletedAt: aliasTs,
              purgedAt: aliasTs,
            });
          }
          questionMap.set(q.id, targetId);
          validQuestionIds.add(targetId);
        }
        mappedQuestions.push({
          ...q,
          id: targetId,
          createdAt: q.createdAt ?? aliasIso,
          updatedAt: q.updatedAt ?? aliasIso,
          validation: q.validation
            ? { ...q.validation, current: q.validation.current ?? true }
            : q.validation === null
              ? null
              : undefined,
          ...(q.sourceQuestionId
            ? {
                sourceQuestionId:
                  questionMap.get(q.sourceQuestionId) ?? q.sourceQuestionId,
              }
            : {}),
          parentId: q.parentId
            ? (questionMap.get(q.parentId) ?? q.parentId)
            : null,
          deckId: targetDeckId,
          groupId: q.groupId ? mapFolderRef(q.groupId) : null,
        });
      }
      pendingReleaseRows.push({
        deckId: targetDeckId,
        version: rel.version,
        title: rel.title.slice(0, 120),
        description: (rel.description ?? "").slice(0, 2000),
        summary: (rel.summary ?? "").slice(0, 1000),
        groups: mappedGroups,
        questions: mappedQuestions,
        createdAt: aliasTs,
      });
    }

    for (
      let i = 0;
      i < pendingAliasPlaceholders.length;
      i += RESTORE_BATCH_SIZE
    ) {
      await tx
        .insert(questions)
        .values(pendingAliasPlaceholders.slice(i, i + RESTORE_BATCH_SIZE))
        .onConflictDoNothing();
    }
    for (const relRow of pendingReleaseRows) {
      const inserted = await tx
        .insert(releases)
        .values(relRow)
        .onConflictDoNothing()
        .returning({ version: releases.version });
      if (inserted.length) restoredReleases += 1;
    }

    // Merge personal concept folders in topological order (parents before children),
    // enforcing sibling title uniqueness and max depth <= 8.
    const conceptFolderMap = new Map<string, string>();
    const conceptFolderById = new Map<
      string,
      { id: string; parentId: string | null; title: string }
    >();
    const conceptFolderChildren = new Map<
      string | null,
      { id: string; parentId: string | null; title: string }[]
    >();
    const registerConceptFolderNode = (node: {
      id: string;
      parentId: string | null;
      title: string;
    }) => {
      conceptFolderById.set(node.id, node);
      const pid =
        node.parentId &&
        conceptFolderById.has(node.parentId) &&
        node.parentId !== node.id
          ? node.parentId
          : null;
      const list = conceptFolderChildren.get(pid) ?? [];
      list.push(node);
      conceptFolderChildren.set(pid, list);
      if (!conceptFolderChildren.has(node.id)) {
        conceptFolderChildren.set(node.id, []);
      }
    };
    for (const f of currentUserConceptFolders) {
      conceptFolderById.set(f.id, {
        id: f.id,
        parentId: f.parentId ?? null,
        title: f.title,
      });
    }
    for (const f of currentUserConceptFolders) {
      const pid =
        f.parentId && conceptFolderById.has(f.parentId) && f.parentId !== f.id
          ? f.parentId
          : null;
      const list = conceptFolderChildren.get(pid) ?? [];
      list.push({ id: f.id, parentId: pid, title: f.title });
      conceptFolderChildren.set(pid, list);
      if (!conceptFolderChildren.has(f.id)) {
        conceptFolderChildren.set(f.id, []);
      }
    }

    const conceptFolderDepthOf = (folderId: string | null): number => {
      if (!folderId) return 0;
      let d = 0;
      const visited = new Set<string>();
      let cur: string | null = folderId;
      while (cur && !visited.has(cur)) {
        visited.add(cur);
        const n = conceptFolderById.get(cur);
        if (!n) break;
        d += 1;
        cur = n.parentId && conceptFolderById.has(n.parentId) ? n.parentId : null;
      }
      return d;
    };
    const clampConceptParent = (candidate: string | null): string | null => {
      if (!candidate || !conceptFolderById.has(candidate)) return null;
      let cur: string | null = candidate;
      while (cur && conceptFolderDepthOf(cur) >= MAX_FOLDER_DEPTH) {
        cur = conceptFolderById.get(cur)?.parentId ?? null;
      }
      return cur;
    };
    const conceptSiblingLowerKeys = (parentId: string | null): Set<string> =>
      new Set(
        (conceptFolderChildren.get(parentId) ?? []).map((f) =>
          normalizeFolderTitleKey(f.title),
        ),
      );

    let restoredConceptFolders = 0;
    let skippedConceptFolders = 0;

    const orderedConceptFolders = topoSortFolders(data.conceptFolders);
    for (const f of orderedConceptFolders) {
      const existing = existingConceptFolderById.get(f.id);
      if (existing && existing.userId === userId) {
        conceptFolderMap.set(f.id, f.id);
        skippedConceptFolders += 1;
        continue;
      }

      let targetId = f.id;
      if (existing) {
        const remappedId = deterministicRemapId(userId, "concept-folder", f.id);
        const existingRemapped = existingConceptFolderById.get(remappedId);
        if (existingRemapped && existingRemapped.userId === userId) {
          conceptFolderMap.set(f.id, remappedId);
          skippedConceptFolders += 1;
          continue;
        }
        targetId = existingRemapped ? crypto.randomUUID() : remappedId;
      }

      let resolvedParentId: string | null = null;
      if (f.parentId) {
        const mappedParent = conceptFolderMap.get(f.parentId) ?? f.parentId;
        if (
          mappedParent !== targetId &&
          conceptFolderById.has(mappedParent)
        ) {
          resolvedParentId = clampConceptParent(mappedParent);
        }
      }

      const rawTitle = sanitizeLegacyFolderTitle(f.title || "未命名文件夹");
      const safeTitle = resolveUniqueSiblingTitle(
        rawTitle,
        conceptSiblingLowerKeys(resolvedParentId),
      );
      conceptFolderMap.set(f.id, targetId);

      const inserted = await tx
        .insert(conceptFolders)
        .values({
          id: targetId,
          userId,
          parentId: resolvedParentId,
          title: safeTitle,
          color: sanitizeColor(f.color),
          createdAt: safeDate(f.createdAt),
          updatedAt: safeDate(f.updatedAt),
        })
        .onConflictDoNothing()
        .returning();

      if (inserted.length) {
        registerConceptFolderNode({
          id: inserted[0].id,
          parentId: inserted[0].parentId ?? null,
          title: inserted[0].title,
        });
        restoredConceptFolders += 1;
      } else {
        skippedConceptFolders += 1;
      }
    }

    async function ensureLegacyConceptGroupFolder(
      rawGroupName: string,
    ): Promise<string | null> {
      const cleaned = rawGroupName.trim();
      if (!cleaned) return null;
      const safeTitle = sanitizeLegacyFolderTitle(cleaned);
      const key = normalizeFolderTitleKey(safeTitle);
      const existingSibling = (conceptFolderChildren.get(null) ?? []).find(
        (f) => normalizeFolderTitleKey(f.title) === key,
      );
      if (existingSibling) return existingSibling.id;

      const detId = deterministicRemapId(userId, "concept-group", key);
      const existingById = existingConceptFolderById.get(detId);
      if (existingById && existingById.userId === userId) {
        return existingById.id;
      }
      const targetId = existingById ? crypto.randomUUID() : detId;
      const now = new Date();
      const inserted = await tx
        .insert(conceptFolders)
        .values({
          id: targetId,
          userId,
          parentId: null,
          title: safeTitle,
          color: "sage",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted.length) {
        registerConceptFolderNode({
          id: inserted[0].id,
          parentId: null,
          title: inserted[0].title,
        });
        restoredConceptFolders += 1;
        return inserted[0].id;
      }
      return null;
    }

    // Merge personal concepts (never overwrite existing concepts; remap IDs, folderId & sourceQuestionId cleanly).
    const conceptMap = new Map<string, string>();
    let restoredConcepts = 0;
    let skippedConcepts = 0;
    let userConceptCount = currentUserConcepts.length;

    for (const c of data.concepts) {
      const term = c.term.trim().slice(0, MAX_CONCEPT_TERM_LENGTH);
      const definition = c.definition
        .trim()
        .slice(0, MAX_CONCEPT_DEFINITION_LENGTH);
      const normKey = normalizeConceptKey(term);
      if (!term || !definition || !normKey) {
        skippedConcepts += 1;
        continue;
      }

      const existing = existingConceptById.get(c.id);
      if (existing && existing.userId === userId) {
        conceptMap.set(c.id, c.id);
        validUserConceptIds.add(c.id);
        skippedConcepts += 1;
        continue;
      }

      const existingSameKeyId = existingUserConceptByNormKey.get(normKey);
      if (existingSameKeyId) {
        conceptMap.set(c.id, existingSameKeyId);
        validUserConceptIds.add(existingSameKeyId);
        skippedConcepts += 1;
        continue;
      }

      let targetConceptId = c.id;
      if (existing) {
        const remappedId = deterministicRemapId(userId, "concept", c.id);
        const existingRemapped = existingConceptById.get(remappedId);
        if (existingRemapped && existingRemapped.userId === userId) {
          conceptMap.set(c.id, remappedId);
          validUserConceptIds.add(remappedId);
          skippedConcepts += 1;
          continue;
        }
        targetConceptId = existingRemapped ? crypto.randomUUID() : remappedId;
      }

      if (userConceptCount >= MAX_CONCEPTS) {
        skippedConcepts += 1;
        continue;
      }

      let targetFolderId: string | null = null;
      if (c.folderId) {
        const mappedFolderId = conceptFolderMap.get(c.folderId) ?? c.folderId;
        if (conceptFolderById.has(mappedFolderId)) {
          targetFolderId = mappedFolderId;
        }
      }
      if (!targetFolderId && c.groupName.trim()) {
        targetFolderId = await ensureLegacyConceptGroupFolder(c.groupName);
      }
      const targetGroupName = targetFolderId
        ? (conceptFolderById.get(targetFolderId)?.title ?? "")
        : "";

      const mappedSourceQId = c.sourceQuestionId
        ? (questionMap.get(c.sourceQuestionId) ?? null)
        : null;
      const targetSourceQuestionId =
        mappedSourceQId && validQuestionIds.has(mappedSourceQId)
          ? mappedSourceQId
          : null;

      const inserted = await tx
        .insert(concepts)
        .values({
          id: targetConceptId,
          userId,
          folderId: targetFolderId,
          term,
          aliases: normalizeConceptAliases(c.aliases ?? [], term),
          normalizedKey: normKey,
          definition,
          groupName: targetGroupName.slice(0, MAX_CONCEPT_GROUP_LENGTH),
          color: sanitizeAnnotationColor(c.color),
          sourceQuestionId: targetSourceQuestionId,
          createdAt: safeDate(c.createdAt),
          updatedAt: safeDate(c.updatedAt),
        })
        .onConflictDoNothing()
        .returning({ id: concepts.id });

      if (inserted.length) {
        conceptMap.set(c.id, targetConceptId);
        validUserConceptIds.add(targetConceptId);
        existingUserConceptByNormKey.set(normKey, targetConceptId);
        userConceptCount += 1;
        restoredConcepts += 1;
      } else {
        skippedConcepts += 1;
      }
    }

    // Merge personal study cards (never overwrite existing study cards).
    let restoredStudyCards = 0;
    let skippedStudyCards = 0;
    const studyCardInputs = new Map<
      string,
      z.infer<typeof studyCardBackupSchema>
    >();
    for (const card of data.personalStudyState) {
      studyCardInputs.set(card.questionId, card);
    }
    for (const q of data.questions) {
      if (studyCardInputs.has(q.id)) continue;
      if (
        q.fsrs ||
        q.note?.trim() ||
        (q.annotations && q.annotations.length > 0) ||
        q.favorite
      ) {
        studyCardInputs.set(q.id, {
          questionId: q.id,
          fsrs: q.fsrs ?? null,
          version: q.studyVersion ?? 0,
          reviewedRevision: q.reviewedRevision ?? 0,
          favorite: Boolean(q.favorite),
          note: q.note ?? "",
          noteVersion: q.noteVersion ?? 0,
          annotations: q.annotations ?? [],
          annotationsVersion: q.annotationsVersion ?? 0,
        });
      }
    }

    const pendingStudyCards: (typeof studyCards.$inferInsert)[] = [];
    for (const card of studyCardInputs.values()) {
      const targetQuestionId = questionMap.get(card.questionId);
      if (!targetQuestionId || !validQuestionIds.has(targetQuestionId)) {
        skippedStudyCards += 1;
        continue;
      }
      if (existingStudySet.has(targetQuestionId)) {
        skippedStudyCards += 1;
        continue;
      }
      existingStudySet.add(targetQuestionId);
      pendingStudyCards.push({
        userId,
        questionId: targetQuestionId,
        fsrs: sanitizeFsrs(card.fsrs),
        version: card.version ?? 0,
        reviewedRevision: card.reviewedRevision ?? 0,
        favorite: Boolean(card.favorite),
        note: card.note ?? "",
        noteVersion: card.noteVersion ?? 0,
        annotations: sanitizeAnnotations(
          card.annotations ?? [],
          conceptMap,
          validUserConceptIds,
        ),
        annotationsVersion: card.annotationsVersion ?? 0,
        updatedAt: safeDate(card.updatedAt),
      });
    }
    for (let i = 0; i < pendingStudyCards.length; i += RESTORE_BATCH_SIZE) {
      const chunk = pendingStudyCards.slice(i, i + RESTORE_BATCH_SIZE);
      const inserted = await tx
        .insert(studyCards)
        .values(chunk)
        .onConflictDoNothing()
        .returning({ questionId: studyCards.questionId });
      restoredStudyCards += inserted.length;
      skippedStudyCards += chunk.length - inserted.length;
    }

    // Merge review events (preserving snapshots).
    let restoredReviews = 0;
    let skippedReviews = 0;
    const pendingReviews: (typeof reviewEvents.$inferInsert)[] = [];
    const seenReviewIds = new Set<string>();
    for (const rev of data.reviews) {
      const targetQuestionId = questionMap.get(rev.questionId);
      if (!targetQuestionId || !validQuestionIds.has(targetQuestionId)) {
        skippedReviews += 1;
        continue;
      }
      const existing = existingReviewById.get(rev.id);
      if (existing && existing.userId === userId) {
        skippedReviews += 1;
        continue;
      }
      let targetReviewId = rev.id;
      if (existing) {
        const remappedId = deterministicRemapId(userId, "review", rev.id);
        const existingRemapped = existingReviewById.get(remappedId);
        if (existingRemapped && existingRemapped.userId === userId) {
          skippedReviews += 1;
          continue;
        }
        targetReviewId = existingRemapped ? crypto.randomUUID() : remappedId;
      }
      if (seenReviewIds.has(targetReviewId)) {
        skippedReviews += 1;
        continue;
      }
      seenReviewIds.add(targetReviewId);
      pendingReviews.push({
        id: targetReviewId,
        userId,
        questionId: targetQuestionId,
        questionTitle: rev.questionTitle ?? null,
        questionAnswer: rev.questionAnswer ?? null,
        rating: rev.rating,
        answer: rev.answer ?? null,
        questionRevision: rev.questionRevision ?? 1,
        before: rev.before ?? null,
        after: rev.after,
        createdAt: safeDate(rev.createdAt),
      });
    }
    for (let i = 0; i < pendingReviews.length; i += RESTORE_BATCH_SIZE) {
      const chunk = pendingReviews.slice(i, i + RESTORE_BATCH_SIZE);
      const inserted = await tx
        .insert(reviewEvents)
        .values(chunk)
        .onConflictDoNothing()
        .returning({ id: reviewEvents.id });
      restoredReviews += inserted.length;
      skippedReviews += chunk.length - inserted.length;
    }

    // Merge conversations and messages.
    let restoredConversations = 0;
    let skippedConversations = 0;
    const pendingConvs: (typeof conversations.$inferInsert)[] = [];
    const pendingMessagesByConv = new Map<
      string,
      (typeof messages.$inferInsert)[]
    >();
    const seenConvIds = new Set<string>();
    for (const conv of data.conversations) {
      const existing = existingConvById.get(conv.id);
      if (existing && existing.userId === userId) {
        skippedConversations += 1;
        continue;
      }
      let targetConvId = conv.id;
      if (existing) {
        const remappedId = deterministicRemapId(userId, "conv", conv.id);
        const existingRemapped = existingConvById.get(remappedId);
        if (existingRemapped && existingRemapped.userId === userId) {
          skippedConversations += 1;
          continue;
        }
        targetConvId = existingRemapped ? crypto.randomUUID() : remappedId;
      }
      if (seenConvIds.has(targetConvId)) {
        skippedConversations += 1;
        continue;
      }
      const targetDeckId = conv.deckId
        ? (deckMap.get(conv.deckId) ?? null)
        : null;
      const targetQuestionId = conv.questionId
        ? (questionMap.get(conv.questionId) ?? null)
        : null;
      const hasValidQuestion =
        targetQuestionId !== null && validQuestionIds.has(targetQuestionId);
      if (conv.scope === "question" && !hasValidQuestion) {
        skippedConversations += 1;
        continue;
      }
      const hasValidDeck =
        targetDeckId !== null &&
        (validOwnedDeckIds.has(targetDeckId) ||
          accessibleSubDeckIds.has(targetDeckId));
      seenConvIds.add(targetConvId);
      pendingConvs.push({
        id: targetConvId,
        userId,
        scope: conv.scope,
        deckId: hasValidDeck ? targetDeckId : null,
        questionId: hasValidQuestion ? targetQuestionId : null,
        quote: conv.quote ?? "",
        attempt: conv.attempt ?? "",
        questionTitle: conv.questionTitle ?? "",
        answerSnapshot: conv.answerSnapshot ?? "",
        questionRevision: conv.questionRevision ?? 0,
        createdAt: safeDate(conv.createdAt),
        updatedAt: safeDate(conv.updatedAt),
      });
      const convMsgs: (typeof messages.$inferInsert)[] = [];
      for (const msg of conv.messages) {
        let targetMsgId = msg.id;
        if (existingMsgSet.has(msg.id)) {
          const remappedId = deterministicRemapId(userId, "msg", msg.id);
          targetMsgId = existingMsgSet.has(remappedId)
            ? crypto.randomUUID()
            : remappedId;
        }
        existingMsgSet.add(targetMsgId);
        convMsgs.push({
          id: targetMsgId,
          conversationId: targetConvId,
          role: msg.role,
          content: msg.content,
          edits: (msg.edits as ChatEdit[] | null) ?? null,
          meta: (msg.meta as ChatMessageMeta | null) ?? null,
          createdAt: safeDate(msg.createdAt),
        });
      }
      pendingMessagesByConv.set(targetConvId, convMsgs);
    }
    const insertedConvIds = new Set<string>();
    for (let i = 0; i < pendingConvs.length; i += RESTORE_BATCH_SIZE) {
      const chunk = pendingConvs.slice(i, i + RESTORE_BATCH_SIZE);
      const inserted = await tx
        .insert(conversations)
        .values(chunk)
        .onConflictDoNothing()
        .returning({ id: conversations.id });
      for (const row of inserted) insertedConvIds.add(row.id);
      restoredConversations += inserted.length;
      skippedConversations += chunk.length - inserted.length;
    }
    const pendingMsgs: (typeof messages.$inferInsert)[] = [];
    for (const convId of insertedConvIds) {
      const msgs = pendingMessagesByConv.get(convId);
      if (msgs?.length) pendingMsgs.push(...msgs);
    }
    for (let i = 0; i < pendingMsgs.length; i += RESTORE_BATCH_SIZE) {
      await tx
        .insert(messages)
        .values(pendingMsgs.slice(i, i + RESTORE_BATCH_SIZE))
        .onConflictDoNothing();
    }

    return {
      ok: true,
      restored: {
        decks: restoredDecks,
        groups: restoredGroups,
        questions: restoredQuestions,
        releases: restoredReleases,
        conceptFolders: restoredConceptFolders,
        concepts: restoredConcepts,
        studyCards: restoredStudyCards,
        reviews: restoredReviews,
        conversations: restoredConversations,
        preferencesRestored,
      },
      skipped: {
        decks: skippedDecks,
        questions: skippedQuestions,
        conceptFolders: skippedConceptFolders,
        concepts: skippedConcepts,
        studyCards: skippedStudyCards,
        reviews: skippedReviews,
        conversations: skippedConversations,
      },
    };
    });
  } finally {
    releaseRestore();
  }
}
