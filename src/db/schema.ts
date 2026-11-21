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
} from "drizzle-orm/pg-core";
import type {
  ContentValidation,
  ContentValidationView,
} from "@/lib/content-validation";
import type { ImportPreviewItem } from "@/lib/import-preview";
import type { ChatEdit } from "@/lib/types";
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
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    color: text("color").notNull().default("sage"),
    visibility: text("visibility").notNull().default("private"),
    publishedVersion: integer("published_version").notNull().default(0),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...dates(),
  },
  (t) => [index("deck_owner_idx").on(t.ownerId)],
);
export const questions = pgTable(
  "questions",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id),
    deckId: text("deck_id").references(() => decks.id),
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
    index("question_trash_expiry_idx")
      .on(t.deletedAt)
      .where(sql`${t.deletedAt} is not null and ${t.purgedAt} is null`),
    uniqueIndex("question_hash_idx")
      .on(t.deckId, t.contentHash)
      .where(sql`${t.deletedAt} is null`),
  ],
);
export type PublishedQuestion = {
  id: string;
  sourceQuestionId?: string;
  deckId: string | null;
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
    questions: jsonb("questions").$type<PublishedQuestion[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.deckId, t.version] })],
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
    seenVersion: integer("seen_version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.deckId] })],
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
export const imports = pgTable("imports", {
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
  }>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    questionId: text("question_id")
      .notNull()
      .references(() => questions.id),
    quote: text("quote").notNull().default(""),
    attempt: text("attempt").notNull().default(""),
    questionTitle: text("question_title").notNull(),
    answerSnapshot: text("answer_snapshot").notNull(),
    questionRevision: integer("question_revision").notNull(),
    ...dates(),
  },
  (t) => [index("conversation_user_question_idx").on(t.userId, t.questionId)],
);
export const messages = pgTable("chat_messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  edits: jsonb("edits").$type<ChatEdit[]>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
