import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("independent question migration restores old hidden questions without modifying source or study state", async () => {
  const db = new PGlite();
  const raw = "\uFEFF# 原文\r\n  答案  \r\n";
  try {
    await db.exec(
      "CREATE TABLE users (id text PRIMARY KEY); INSERT INTO users VALUES ('owner'); CREATE TABLE decks (id text PRIMARY KEY, owner_id text, deleted_at timestamptz); INSERT INTO decks VALUES ('active','owner',NULL),('removed','owner',NOW()); CREATE TABLE imports (id text PRIMARY KEY, deck_id text NOT NULL REFERENCES decks(id)); CREATE TABLE questions (id text PRIMARY KEY, deck_id text NOT NULL REFERENCES decks(id), answer text, content_hash text); CREATE UNIQUE INDEX question_hash_idx ON questions (deck_id,content_hash); CREATE TABLE study_cards (question_id text, note text, version integer); INSERT INTO study_cards VALUES ('hidden','我的理解',4)",
    );
    await db.query(
      "INSERT INTO questions VALUES ('visible','active',$1,'same'),('hidden','removed',$1,'same')",
      [raw],
    );
    await db.exec(
      await readFile("drizzle/0006_question_lifecycle.sql", "utf8"),
    );
    const rows = await db.query<{
      id: string;
      owner_id: string;
      deck_id: string | null;
      hex: string;
      deleted_at: Date | null;
    }>(
      "SELECT id,owner_id,deck_id,encode(convert_to(answer,'UTF8'),'hex') AS hex,deleted_at FROM questions ORDER BY id",
    );
    assert.deepEqual(rows.rows, [
      {
        id: "hidden",
        owner_id: "owner",
        deck_id: null,
        hex: Buffer.from(raw).toString("hex"),
        deleted_at: null,
      },
      {
        id: "visible",
        owner_id: "owner",
        deck_id: "active",
        hex: Buffer.from(raw).toString("hex"),
        deleted_at: null,
      },
    ]);
    assert.deepEqual((await db.query("SELECT * FROM study_cards")).rows, [
      { question_id: "hidden", note: "我的理解", version: 4 },
    ]);
  } finally {
    await db.close();
  }
});

test("study workflow migration preserves source bytes and custom goals while reducing the old default", async () => {
  const db = new PGlite();
  const raw = "\uFEFF# 原文\r\n  原有答案  \r\n";
  try {
    await db.exec(
      "CREATE TABLE preferences (user_id text PRIMARY KEY, daily_goal integer DEFAULT 20); CREATE TABLE decks (id text PRIMARY KEY); CREATE TABLE imports (id text PRIMARY KEY, raw text); CREATE TABLE questions (id text PRIMARY KEY); INSERT INTO preferences VALUES ('default',20),('custom',7)",
    );
    await db.query("INSERT INTO imports VALUES ('original',$1)", [raw]);
    await db.exec(await readFile("drizzle/0005_study_workflow.sql", "utf8"));
    const goals = await db.query<{
      user_id: string;
      daily_goal: number;
      daily_new_limit: number;
    }>(
      "SELECT user_id,daily_goal,daily_new_limit FROM preferences ORDER BY user_id",
    );
    assert.deepEqual(goals.rows, [
      { user_id: "custom", daily_goal: 7, daily_new_limit: 3 },
      { user_id: "default", daily_goal: 5, daily_new_limit: 3 },
    ]);
    const original = await db.query<{ hex: string }>(
      "SELECT encode(convert_to(raw,'UTF8'),'hex') AS hex FROM imports",
    );
    assert.equal(original.rows[0].hex, Buffer.from(raw).toString("hex"));
  } finally {
    await db.close();
  }
});

test("import migration: existing raw input survives and defaults to question-and-answer mode", async () => {
  const db = new PGlite();
  const raw = "\uFEFF# 原题\r\n\r\n  原有答案  \r\n";
  try {
    await db.exec(
      "CREATE TABLE imports (id text PRIMARY KEY, raw text NOT NULL)",
    );
    await db.query("INSERT INTO imports VALUES ($1,$2)", ["legacy", raw]);
    await db.exec(
      await readFile("drizzle/0004_question_only_import.sql", "utf8"),
    );
    const result = await db.query<{ raw_hex: string; input_type: string }>(
      "SELECT encode(convert_to(raw,'UTF8'),'hex') AS raw_hex,input_type FROM imports WHERE id='legacy'",
    );
    // Inspect stored bytes: the driver's text decoder itself strips a leading BOM.
    assert.deepEqual(result.rows[0], {
      raw_hex: Buffer.from(raw).toString("hex"),
      input_type: "qa",
    });
  } finally {
    await db.close();
  }
});

test("AI migration: existing DeepSeek configuration retains its encrypted key and selected model", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "CREATE TABLE ai_credentials (user_id text PRIMARY KEY, provider text DEFAULT 'deepseek', model text, encrypted_key text); INSERT INTO ai_credentials VALUES ('legacy-user','deepseek','my-selected-model','opaque-existing-ciphertext');",
    );
    await db.exec(
      await readFile("drizzle/0003_glamorous_aaron_stack.sql", "utf8"),
    );
    const result = await db.query<{
      provider: string;
      base_url: string;
      model: string;
      encrypted_key: string;
    }>(
      "SELECT provider,base_url,model,encrypted_key FROM ai_credentials WHERE user_id='legacy-user'",
    );
    assert.deepEqual(result.rows[0], {
      provider: "openai-compatible",
      base_url: "https://api.deepseek.com",
      model: "my-selected-model",
      encrypted_key: "opaque-existing-ciphertext",
    });
  } finally {
    await db.close();
  }
});
