import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

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
