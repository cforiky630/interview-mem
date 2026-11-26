import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  primaryKey,
  index,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type {
  ContentValidation,
  ContentValidationView,
} from "@/lib/content-validation";
import type { ImportPreviewItem } from "@/lib/import-preview";
import type {
  ChatEdit,
  ChatMessageMeta,
  QuestionAnnotation,
  QuestionAnnotationColor,
} from "@/lib/types";
import { sql } from "drizzle-orm";

const dates = () => ({
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const user = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  ...dates(),
});
export const session = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    ...dates(),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);
export const account = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    ...dates(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);
export const verification = pgTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ...dates(),
});
export const preferences = pgTable("preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  dailyGoal: integer("daily_goal").notNull().default(5),
  dailyNewLimit: integer("daily_new_limit").notNull().default(3),
  theme: text("theme").notNull().default("light"),
  timeZone: text("time_zone").notNull().default("Asia/Shanghai"),
  onboarded: boolean("onboarded").notNull().default(false),
});
export const credentials = pgTable("ai_credentials", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("openai-compatible"),
  baseUrl: text("base_url").notNull().default("https://api.deepseek.com"),
  model: text("model").notNull().default("deepseek-chat"),
  encryptedKey: text("encrypted_key").notNull(),
  keyHint: text("key_hint").notNull(),
  ...dates(),
});
export const decks = pgTable(
  "decks",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id),
    parentId: text("parent_id").references((): AnyPgColumn => decks.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    color: text("color").notNull().default("sage"),
    visibility: text("visibility").notNull().default("private"),
    publishedVersion: integer("published_version").notNull().default(0),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...dates(),
  },
  (t) => [
    index("deck_owner_idx").on(t.ownerId),
    index("deck_owner_parent_idx")
      .on(t.ownerId, t.parentId)
      .where(sql`${t.deletedAt} is null`),
    uniqueIndex("deck_sibling_title_uniq")
      .on(
        t.ownerId,
        sql`(coalesce(${t.parentId}, ''))`,
        sql`(lower(btrim(${t.title})))`,
      )
      .where(sql`${t.deletedAt} is null`),
    check(
      "decks_no_self_parent",
      sql`${t.parentId} is null or ${t.parentId} <> ${t.id}`,
    ),
  ],
);
export const questions = pgTable(
  "questions",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id),
    deckId: text("deck_id").references(() => decks.id),
    position: integer("position").notNull().default(0),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    parentId: text("parent_id"),
    title: text("title").notNull(),
    answer: text("answer").notNull(),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    sourceText: text("source_text").notNull().default(""),
    importId: text("import_id").references(() => imports.id),
    validation: jsonb("content_validation").$type<ContentValidation>(),
    contentHash: text("content_hash").notNull(),
    revision: integer("revision").notNull().default(1),
    needsEditing: boolean("needs_editing").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    majorRevision: integer("major_revision").notNull().default(0),
    ...dates(),
  },
  (t) => [
    index("question_deck_idx").on(t.deckId),
    index("question_owner_idx").on(t.ownerId, t.deletedAt),
    index("question_owner_hash_idx")
      .on(t.ownerId, t.contentHash)
      .where(sql`${t.deletedAt} is null`),
    index("question_import_idx")
      .on(t.importId)
      .where(sql`${t.importId} is not null`),
    index("question_trash_expiry_idx")
      .on(t.deletedAt)
      .where(sql`${t.deletedAt} is not null and ${t.purgedAt} is null`),
  ],
);
export type PublishedDeckGroup = {
  id: string;
  parentId?: string | null;
  title: string;
  category?: string;
  description: string;
  position?: number;
};
export type PublishedQuestion = {
  id: string;
  sourceQuestionId?: string;
  deckId: string | null;
  groupId?: string | null;
  position?: number;
  parentId: string | null;
  title: string;
  answer: string;
  tags: string[];
  revision: number;
  majorRevision: number;
  needsEditing: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  validation?: ContentValidationView | null;
};
export const releases = pgTable(
  "deck_releases",
  {
    deckId: text("deck_id")
      .notNull()
      .references(() => decks.id),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    summary: text("summary").notNull().default(""),
    groups: jsonb("groups").$type<PublishedDeckGroup[]>().notNull().default([]),
    questions: jsonb("questions").$type<PublishedQuestion[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.deckId, t.version] }),
    index("release_questions_gin_idx").using(
      "gin",
      sql`${t.questions} jsonb_path_ops`,
    ),
  ],
);
export const subscriptions = pgTable(
  "subscriptions",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    deckId: text("deck_id")
      .notNull()
      .references(() => decks.id),
    folderId: text("folder_id").references(() => decks.id, {
      onDelete: "set null",
    }),
    seenVersion: integer("seen_version").notNull().default(0),
    dismissedVersion: integer("dismissed_version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.deckId] }),
    index("subscription_deck_idx").on(t.deckId),
    index("subscription_user_folder_idx").on(t.userId, t.folderId),
  ],
);
export const authorSubscriptions = pgTable(
  "author_subscriptions",
  {
    followerId: text("follower_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    autoSubscribeNew: boolean("auto_subscribe_new").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.followerId, t.authorId] }),
    index("author_sub_author_idx").on(t.authorId),
    check(
      "author_subscriptions_no_self_follow",
      sql`${t.followerId} <> ${t.authorId}`,
    ),
  ],
);
export const studyCards = pgTable(
  "study_cards",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    questionId: text("question_id")
      .notNull()
      .references(() => questions.id),
    fsrs: jsonb("fsrs").$type<Record<string, unknown>>(),
    version: integer("version").notNull().default(0),
    reviewedRevision: integer("reviewed_revision").notNull().default(0),
    favorite: boolean("favorite").notNull().default(false),
    note: text("note").notNull().default(""),
    noteVersion: integer("note_version").notNull().default(0),
    annotations: jsonb("annotations")
      .$type<QuestionAnnotation[]>()
      .notNull()
      .default([]),
    annotationsVersion: integer("annotations_version").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.questionId] })],
);
export const reviewEvents = pgTable(
  "review_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    questionId: text("question_id")
      .notNull()
      .references(() => questions.id),
    questionTitle: text("question_title"),
    questionAnswer: text("question_answer"),
    rating: integer("rating").notNull(),
    answer: text("answer"),
    questionRevision: integer("question_revision").notNull(),
    before: jsonb("before").$type<Record<string, unknown>>(),
    after: jsonb("after").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("review_user_time_idx").on(t.userId, t.createdAt)],
);
export const imports = pgTable(
  "imports",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    deckId: text("deck_id").references(() => decks.id),
    raw: text("raw").notNull(),
    inputType: text("input_type")
      .$type<"qa" | "questions">()
      .notNull()
      .default("qa"),
    method: text("method").notNull().default("rules"),
    sourceName: text("source_name"),
    sourceHash: text("source_hash"),
    preview: jsonb("preview").$type<ImportPreviewItem[]>(),
    commitHash: text("commit_hash"),
    status: text("status").notNull().default("pending"),
    result: jsonb("result").$type<{
      added: number;
      duplicates: number;
      updated?: number;
      createdFolders?: number;
      reusedFolders?: number;
    }>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("import_user_time_idx").on(t.userId, t.createdAt)],
);
export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    scope: text("scope")
      .$type<"question" | "deck" | "workspace">()
      .notNull()
      .default("question"),
    deckId: text("deck_id").references(() => decks.id),
    questionId: text("question_id").references(() => questions.id),
    quote: text("quote").notNull().default(""),
    attempt: text("attempt").notNull().default(""),
    questionTitle: text("question_title").notNull().default(""),
    answerSnapshot: text("answer_snapshot").notNull().default(""),
    questionRevision: integer("question_revision").notNull().default(0),
    ...dates(),
  },
  (t) => [
    index("conversation_user_question_idx").on(t.userId, t.questionId),
    index("conversation_user_scope_idx").on(
      t.userId,
      t.scope,
      t.deckId,
      t.updatedAt,
    ),
  ],
);
export const messages = pgTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    edits: jsonb("edits").$type<ChatEdit[]>(),
    meta: jsonb("meta").$type<ChatMessageMeta>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("chat_message_conv_time_idx").on(t.conversationId, t.createdAt)],
);
export const conceptFolders = pgTable(
  "concept_folders",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    parentId: text("parent_id").references((): AnyPgColumn => conceptFolders.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    color: text("color").notNull().default("sage"),
    ...dates(),
  },
  (t) => [
    index("concept_folder_user_parent_idx").on(t.userId, t.parentId),
    uniqueIndex("concept_folder_sibling_title_uniq").on(
      t.userId,
      sql`(coalesce(${t.parentId}, ''))`,
      sql`(lower(btrim(${t.title})))`,
    ),
    check(
      "concept_folders_no_self_parent",
      sql`${t.parentId} is null or ${t.parentId} <> ${t.id}`,
    ),
  ],
);
export const concepts = pgTable(
  "concepts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    folderId: text("folder_id").references(() => conceptFolders.id, {
      onDelete: "set null",
    }),
    term: text("term").notNull(),
    aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
    normalizedKey: text("normalized_key").notNull(),
    definition: text("definition").notNull(),
    groupName: text("group_name").notNull().default(""),
    color: text("color")
      .$type<QuestionAnnotationColor>()
      .notNull()
      .default("accent"),
    sourceQuestionId: text("source_question_id").references(
      () => questions.id,
      { onDelete: "set null" },
    ),
    ...dates(),
  },
  (t) => [
    index("concept_user_group_idx").on(t.userId, t.groupName),
    index("concept_user_folder_idx").on(t.userId, t.folderId),
    uniqueIndex("concept_user_norm_key_uniq").on(t.userId, t.normalizedKey),
  ],
);
