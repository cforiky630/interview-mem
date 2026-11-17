import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import { eq } from "drizzle-orm";
import { splitBySourceBoundaries } from "../src/lib/import-preview";
import { parseQuestions } from "../src/lib/importer";
import type { ImportPreview } from "../src/lib/import-preview";
import type { Workspace } from "../src/lib/types";

Object.assign(process.env, {
  NODE_ENV: "test",
  LOCAL_DATABASE_PATH: ":memory:",
  BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  KEY_ENCRYPTION_SECRET: randomBytes(32).toString("hex"),
});
delete process.env.DATABASE_URL;
delete process.env.PGHOST;
const { getAuth } = await import("../src/server/auth");
const { getDb } = await import("../src/db");
const { imports } = await import("../src/db/schema");
const workspace = await import("../src/app/api/workspace/route");
const preview = await import("../src/app/api/import/preview/route");
const commit = await import("../src/app/api/import/commit/route");
const source = await import("../src/app/api/questions/source/route");
const decks = await import("../src/app/api/decks/route");
const questions = await import("../src/app/api/questions/route");
const reviews = await import("../src/app/api/reviews/route");
const settings = await import("../src/app/api/settings/route");
const catalog = await import("../src/app/api/catalog/route");
const exporter = await import("../src/app/api/export/route");
const trash = await import("../src/app/api/questions/trash/route");
type Account = { id: string; cookie: string; deckId: string };

test("automatic preview preserves answer whitespace and never truncates a long question", () => {
  const raw =
    "\uFEFF\r\n## 题目一？\r\n\r\n  答案：保留行首、行尾与换行。  \r\n```js\r\n## 代码不是新题\r\n```\r\n## 题目二？\r\n第二段  \r\n";
  const parsed = parseQuestions(raw, "qa", { preserveSource: true });
  assert.equal(parsed.length, 2);
  assert.equal(
    parsed[0].answer,
    "\r\n  答案：保留行首、行尾与换行。  \r\n```js\r\n## 代码不是新题\r\n```\r\n",
  );
  assert.equal(parsed[1].answer, "第二段  \r\n");
  const title = "很长的题目".repeat(60);
  assert.equal(
    parseQuestions(`## ${title}\n答案`, "qa", { preserveSource: true })[0]
      .title,
    title,
  );
  assert.deepEqual(
    parseQuestions("\r\n无标题问题\r\n  答案  \r\n", "qa", {
      preserveSource: true,
    })[0].answer,
    "  答案  \r\n",
  );
});
function request(account: Account, path: string, data?: unknown) {
  return new Request(`http://localhost:3000${path}`, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      cookie: account.cookie,
      origin: "http://localhost:3000",
      "content-type": "application/json",
      "x-workspace-user": account.id,
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}
async function state(account: Account): Promise<Workspace> {
  return (await workspace.GET(request(account, "/api/workspace"))).json();
}
async function register(name: string): Promise<Account> {
  const response = await (
    await getAuth()
  ).handler(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name,
        email: `${name}@example.test`,
        password: randomUUID(),
      }),
    }),
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  const account = {
    id: result.user.id as string,
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; "),
    deckId: "",
  };
  account.deckId = (await state(account)).decks[0].id;
  return account;
}

test("AI boundaries retain source bytes, nested headings and code; invalid boundaries never become cards", () => {
  const raw =
    "\uFEFF# 资料\r\n## 问题一\r\n  原答案  \r\n```ts\r\n## 代码里的标题\r\n```\r\n## 问题二\r\n下一段\r\n";
  const boundaries = [
    { title: "问题一", startLine: 2, answerStartLine: 3 },
    { title: "问题二", startLine: 7, answerStartLine: 8 },
  ];
  const parsed = splitBySourceBoundaries(raw, boundaries, false);
  assert.equal(
    parsed[0].answer,
    "  原答案  \r\n```ts\r\n## 代码里的标题\r\n```\r\n",
  );
  assert.equal(parsed[1].answer, "下一段\r\n");
  assert.equal(
    parsed.map((q) => q.sourceText).join(""),
    raw.slice(raw.indexOf("## 问题一")),
  );
  assert.ok(
    splitBySourceBoundaries(raw, boundaries, true).every(
      (q) => q.answer === "",
    ),
  );
  for (const bad of [
    [{ title: "bad", startLine: 5, answerStartLine: 6 }],
    [{ title: "bad", startLine: 2, answerStartLine: 99 }],
    [{ title: "bad", startLine: 99, answerStartLine: null }],
    [...boundaries].reverse(),
  ])
    assert.throws(() => splitBySourceBoundaries(raw, bad, false));
});

test("import preview, explicit commit, retries, provenance and trash preserve private study data", async () => {
  const alice = await register("workflow-alice"),
    bob = await register("workflow-bob");
  const before = await state(alice);
  assert.equal(before.settings.dailyGoal, 5);
  assert.equal(before.settings.dailyNewLimit, 3);
  const raw =
    "\uFEFF## 保持原文？\r\n  这段答案的空格不应丢失。  \r\n\r\n## 第二道题？\r\n第二个答案。\r\n";
  const batchId = randomUUID();
  const body = {
    batchId,
    deckId: alice.deckId,
    raw,
    inputType: "qa",
    method: "whole",
    sourceName: "原文.md",
  };
  const parsedResponse = await preview.POST(
    request(alice, "/api/import/preview", body),
  );
  assert.equal(parsedResponse.status, 200);
  const parsed = (await parsedResponse.json()) as ImportPreview;
  assert.equal(parsed.questions[0].answer, raw);
  assert.equal(
    (await state(alice)).questions.length,
    0,
    "preview must not insert questions",
  );
  assert.deepEqual(
    await (
      await preview.POST(request(alice, "/api/import/preview", body))
    ).json(),
    parsed,
  );
  assert.equal(
    (
      await commit.POST(
        request(bob, "/api/import/commit", {
          batchId,
          questions: parsed.questions,
        }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await preview.POST(
        request(bob, "/api/import/preview", { ...body, deckId: bob.deckId }),
      )
    ).status,
    409,
  );
  const reviewed = {
    batchId,
    questions: parsed.questions.map((q) => ({ ...q, title: "确认后的标题" })),
  };
  const saved = await Promise.all([
    commit.POST(request(alice, "/api/import/commit", reviewed)),
    commit.POST(request(alice, "/api/import/commit", reviewed)),
  ]);
  for (const r of saved) {
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { added: 1, duplicates: 0 });
  }
  let current = await state(alice);
  assert.equal(current.questions.length, 1);
  const question = current.questions[0];
  // Text decoding by PGlite can strip a leading BOM; the provenance endpoint uses JSON to retain it.
  const original = await source.GET(
    request(alice, `/api/questions/source?questionId=${question.id}`),
  );
  assert.equal(original.status, 200);
  assert.deepEqual(await original.json(), {
    raw,
    name: "原文.md",
    sha256: createHash("sha256").update(raw).digest("hex"),
  });
  assert.equal(
    (
      await source.GET(
        request(bob, `/api/questions/source?questionId=${question.id}`),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await commit.POST(
        request(alice, "/api/import/commit", {
          ...reviewed,
          questions: reviewed.questions.map((q) => ({
            ...q,
            answer: "不同提交",
          })),
        }),
      )
    ).status,
    409,
  );
  const note = await questions.POST(
    request(alice, "/api/questions", {
      action: "note",
      id: question.id,
      note: "自己的理解",
      expectedVersion: 0,
    }),
  );
  assert.equal(note.status, 200);
  for (let i = 0; i < 2; i++) {
    current = await state(alice);
    const response = await reviews.POST(
      request(alice, "/api/reviews", {
        questionId: question.id,
        questionRevision: 1,
        eventId: randomUUID(),
        expectedVersion: current.questions[0].studyVersion,
        rating: 3,
      }),
    );
    assert.equal(response.status, 200);
  }
  current = await state(alice);
  assert.equal(
    current.stats.reviewedToday,
    1,
    "repeat grading counts once toward the daily question goal",
  );
  assert.equal(current.stats.newLearnedToday, 1);
  assert.equal(current.stats.totalReviews, 2);
  assert.equal(
    (
      await decks.POST(
        request(alice, "/api/decks", {
          action: "publish",
          deckId: alice.deckId,
          expectedVersion: 0,
          visibility: "public",
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await decks.POST(
        request(bob, "/api/decks", {
          action: "subscribe",
          deckId: alice.deckId,
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await source.GET(
        request(bob, `/api/questions/source?questionId=${question.id}`),
      )
    ).status,
    403,
    "published answers never expose the private import batch",
  );
  assert.equal(
    (
      await decks.POST(
        request(bob, "/api/decks", { action: "delete", deckId: alice.deckId }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await decks.POST(
        request(alice, "/api/decks", {
          action: "delete",
          deckId: alice.deckId,
        }),
      )
    ).status,
    200,
  );
  assert.equal((await state(alice)).questions.length, 1);
  assert.equal((await state(alice)).questions[0].deckId, null);
  assert.equal(
    (
      await questions.POST(
        request(alice, "/api/questions", {
          action: "archive",
          id: question.id,
          archived: false,
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await preview.POST(
        request(alice, "/api/import/preview", {
          ...body,
          batchId: randomUUID(),
        }),
      )
    ).status,
    404,
  );
  assert.equal(
    (await (await catalog.GET(request(bob, "/api/catalog"))).json()).some(
      (d: { id: string }) => d.id === alice.deckId,
    ),
    false,
  );
  const subscribed = await state(bob);
  assert.equal(
    subscribed.questions.find((q) => q.id === question.id)?.note,
    "",
  );
  assert.equal(
    subscribed.decks.find((d) => d.id === alice.deckId)?.sourceDeleted,
    true,
  );
  assert.equal(
    (await (await decks.GET(request(alice, "/api/decks"))).json()).length,
    0,
  );
  const deleted = await questions.POST(
    request(alice, "/api/questions", { action: "delete", id: question.id }),
  );
  assert.equal(deleted.status, 200);
  const deadline = (await deleted.json()).expiresAt;
  assert.equal(
    (
      await (
        await questions.POST(
          request(alice, "/api/questions", {
            action: "delete",
            id: question.id,
          }),
        )
      ).json()
    ).expiresAt,
    deadline,
  );
  assert.equal((await state(alice)).questions.length, 0);
  assert.equal(
    (await (await trash.GET(request(bob, "/api/questions/trash"))).json())
      .length,
    0,
  );
  assert.equal(
    (await (await trash.GET(request(alice, "/api/questions/trash"))).json())[0]
      .id,
    question.id,
  );
  const exported = await (
    await exporter.GET(request(alice, "/api/export"))
  ).json();
  assert.equal(exported.imports[0].raw, raw);
  assert.equal(exported.trash[0].id, question.id);
  assert.equal(exported.personalStudyState[0].note, "自己的理解");
  assert.equal(
    (
      await questions.POST(
        request(bob, "/api/questions", { action: "restore", id: question.id }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await questions.POST(
        request(alice, "/api/questions", {
          action: "restore",
          id: question.id,
        }),
      )
    ).status,
    200,
  );
  assert.equal((await state(alice)).questions[0].note, "自己的理解");
  assert.equal(
    (
      await decks.POST(
        request(alice, "/api/decks", {
          action: "restore",
          deckId: alice.deckId,
        }),
      )
    ).status,
    400,
  );
});

test("AI parsing uses the caller's connection, copies original answers and rejects invalid or truncated output", async () => {
  const account = await register("ai-boundaries");
  assert.equal(
    (
      await settings.POST(
        request(account, "/api/settings", {
          action: "saveConnection",
          baseUrl: "https://parse.example/v1",
          model: "boundary-model",
          key: "fake-boundary-key",
        }),
      )
    ).status,
    200,
  );
  const dnsMock = mock.method(dns, "lookup", async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  let content = JSON.stringify({
      questions: [{ title: "原来的问题", startLine: 1, answerStartLine: 2 }],
    }),
    finish = "stop",
    calls = 0;
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (url: unknown, init?: RequestInit) => {
      assert.equal(String(url), "https://parse.example/v1/chat/completions");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer fake-boundary-key",
      );
      assert.equal(JSON.parse(init!.body as string).model, "boundary-model");
      calls++;
      return Response.json({
        choices: [{ message: { content }, finish_reason: finish }],
      });
    },
  );
  try {
    const raw =
      "原来的问题\r\n  精确答案  \r\n```js\r\nconst a = 1;\r\n```\r\n";
    const payload = {
      batchId: randomUUID(),
      deckId: account.deckId,
      raw,
      inputType: "qa",
      method: "ai",
    };
    const response = await preview.POST(
      request(account, "/api/import/preview", payload),
    );
    assert.equal(response.status, 200);
    const parsed = (await response.json()) as ImportPreview;
    assert.equal(parsed.questions[0].answer, raw.slice(raw.indexOf("\n") + 1));
    assert.equal((await state(account)).questions.length, 0);
    const qOnly = await preview.POST(
      request(account, "/api/import/preview", {
        ...payload,
        batchId: randomUUID(),
        inputType: "questions",
      }),
    );
    assert.equal((await qOnly.json()).questions[0].answer, "");
    for (const invalid of [
      "not-json",
      JSON.stringify({
        questions: [{ title: "bad", startLine: 4, answerStartLine: 5 }],
      }),
    ]) {
      content = invalid;
      const id = randomUUID();
      assert.equal(
        (
          await preview.POST(
            request(account, "/api/import/preview", {
              ...payload,
              batchId: id,
            }),
          )
        ).status,
        502,
      );
      assert.equal(
        (
          await commit.POST(
            request(account, "/api/import/commit", {
              batchId: id,
              questions: parsed.questions,
            }),
          )
        ).status,
        409,
      );
      const db = await getDb();
      assert.equal(
        (await db.select().from(imports).where(eq(imports.id, id)))[0].status,
        "failed",
      );
    }
    content = JSON.stringify({
      questions: [{ title: "valid", startLine: 1, answerStartLine: 2 }],
    });
    finish = "length";
    assert.equal(
      (
        await preview.POST(
          request(account, "/api/import/preview", {
            ...payload,
            batchId: randomUUID(),
          }),
        )
      ).status,
      502,
    );
    assert.equal((await state(account)).questions.length, 0);
    assert.equal(calls, 5);
  } finally {
    fetchMock.mock.restore();
    dnsMock.mock.restore();
  }
});

after(async () => {
  const state = globalThis as unknown as {
    interviewDatabase?: Promise<{ close: () => Promise<void> }>;
  };
  await (await state.interviewDatabase)?.close();
});
