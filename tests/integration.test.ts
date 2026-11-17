import { after, test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import dns from "node:dns/promises";

Object.assign(process.env, { NODE_ENV: "test" });
process.env.LOCAL_DATABASE_PATH = ":memory:";
delete process.env.DATABASE_URL;
delete process.env.PGHOST;
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.KEY_ENCRYPTION_SECRET = randomBytes(32).toString("hex");
process.env.BETTER_AUTH_URL = "http://localhost:3000";

const { getAuth } = await import("../src/server/auth");
const { getDb } = await import("../src/db");
const { credentials, reviewEvents } = await import("../src/db/schema");
const workspace = await import("../src/app/api/workspace/route");
const importer = await import("../src/app/api/import/route");
const deckRoute = await import("../src/app/api/decks/route");
const questionRoute = await import("../src/app/api/questions/route");
const reviewRoute = await import("../src/app/api/reviews/route");
const settings = await import("../src/app/api/settings/route");
const chat = await import("../src/app/api/chat/route");
const aiAnswer = await import("../src/app/api/questions/answer/route");
const exporter = await import("../src/app/api/export/route");
type UserContext = { cookie: string; id: string };
async function register(name: string): Promise<UserContext> {
  const auth = await getAuth();
  const response = await auth.handler(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        name,
        email: `${name}@example.test`,
        password: "a-test-password-12345",
      }),
    }),
  );
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return {
    id: result.user.id,
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; "),
  };
}
function request(
  user: UserContext,
  url: string,
  data?: unknown,
  origin = "http://localhost:3000",
) {
  return new Request(`http://localhost:3000${url}`, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      cookie: user.cookie,
      origin,
      "content-type": "application/json",
    },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
}
async function snapshot(user: UserContext) {
  const response = await workspace.GET(request(user, "/api/workspace"));
  assert.equal(response.status, 200);
  return response.json();
}
let alice: UserContext;
let bob: UserContext;
let deckId: string;
let questionId: string;

test("multiuser workflow: auth, raw import, deduplication and private data isolation", async () => {
  alice = await register("alice");
  bob = await register("bob");
  const unauth = await workspace.GET(
    new Request("http://localhost:3000/api/workspace"),
  );
  assert.equal(unauth.status, 401);
  const initial = await snapshot(alice);
  deckId = initial.decks[0].id;
  const raw =
    "## 什么是闭包？\n函数与词法环境的组合。\n\n## 什么是事件循环？\n协调任务执行。";
  const batchId = randomUUID();
  const payload = { batchId, deckId, raw };
  const first = await importer.POST(request(alice, "/api/import", payload));
  assert.equal(first.status, 200);
  assert.equal((await first.json()).added, 2);
  const retry = await importer.POST(request(alice, "/api/import", payload));
  assert.equal(retry.status, 200);
  const duplicate = await importer.POST(
    request(alice, "/api/import", { ...payload, batchId: randomUUID() }),
  );
  assert.equal((await duplicate.json()).duplicates, 2);
  const a = await snapshot(alice);
  questionId = a.questions[0].id;
  assert.equal(a.questions.length, 2);
  assert.equal((await snapshot(bob)).questions.length, 0);
  const forbidden = await questionRoute.POST(
    request(bob, "/api/questions", {
      action: "favorite",
      id: questionId,
      favorite: true,
    }),
  );
  assert.equal(forbidden.status, 404);
  const csrf = await deckRoute.POST(
    request(
      alice,
      "/api/decks",
      { action: "create", title: "forbidden" },
      "https://evil.example",
    ),
  );
  assert.equal(csrf.status, 403);
});
test("subscriptions: only published revisions propagate; notes and study state stay personal", async () => {
  let response = await deckRoute.POST(
    request(alice, "/api/decks", {
      action: "publish",
      deckId,
      expectedVersion: 0,
      visibility: "public",
      summary: "初版",
    }),
  );
  assert.equal(response.status, 200);
  response = await deckRoute.POST(
    request(bob, "/api/decks", { action: "subscribe", deckId }),
  );
  assert.equal(response.status, 200);
  let b = await snapshot(bob);
  assert.equal(b.questions.length, 2);
  response = await questionRoute.POST(
    request(bob, "/api/questions", {
      action: "note",
      id: questionId,
      note: "我的独立理解",
      expectedVersion: 0,
    }),
  );
  assert.equal(response.status, 200);
  response = await reviewRoute.POST(
    request(bob, "/api/reviews", {
      questionId,
      questionRevision: 1,
      eventId: randomUUID(),
      expectedVersion: 0,
      rating: 3,
    }),
  );
  assert.equal(response.status, 200);
  const before = (await snapshot(bob)).questions.find(
    (q: { id: string }) => q.id === questionId,
  );
  response = await questionRoute.POST(
    request(alice, "/api/questions", {
      action: "edit",
      id: questionId,
      expectedRevision: 1,
      title: "什么是闭包？",
      answer: "已经修正的答案。",
      tags: ["更新"],
      major: true,
    }),
  );
  assert.equal(response.status, 200);
  b = await snapshot(bob);
  assert.equal(
    b.questions.find((q: { id: string }) => q.id === questionId).revision,
    1,
    "unpublished edits must stay private",
  );
  response = await deckRoute.POST(
    request(alice, "/api/decks", {
      action: "publish",
      deckId,
      expectedVersion: 1,
      visibility: "public",
      summary: "修正答案",
    }),
  );
  assert.equal(response.status, 200);
  const after = (await snapshot(bob)).questions.find(
    (q: { id: string }) => q.id === questionId,
  );
  assert.equal(after.revision, 2);
  assert.equal(after.note, "我的独立理解");
  assert.deepEqual(after.fsrs, before.fsrs);
  assert.equal(after.majorRevision, 2);
  assert.equal(
    (await snapshot(alice)).questions.find(
      (q: { id: string }) => q.id === questionId,
    ).note,
    "",
  );
  const editOther = await questionRoute.POST(
    request(bob, "/api/questions", {
      action: "edit",
      id: questionId,
      expectedRevision: 2,
      title: "越权",
      answer: "x",
      tags: [],
    }),
  );
  assert.equal(editOther.status, 403);
});
test("concurrency: a review event is idempotent, stale grading and notes return conflicts", async () => {
  const q = (await snapshot(alice)).questions.find(
    (q: { id: string }) => q.id === questionId,
  );
  const payload = {
    questionId,
    questionRevision: q.revision,
    eventId: randomUUID(),
    expectedVersion: q.studyVersion,
    rating: 3,
  };
  let response = await reviewRoute.POST(
    request(alice, "/api/reviews", payload),
  );
  assert.equal(response.status, 200);
  response = await reviewRoute.POST(request(alice, "/api/reviews", payload));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).duplicate, true);
  response = await reviewRoute.POST(
    request(alice, "/api/reviews", { ...payload, eventId: randomUUID() }),
  );
  assert.equal(response.status, 409);
  const state = await snapshot(alice);
  assert.equal(state.stats.totalReviews, 1);
  response = await questionRoute.POST(
    request(bob, "/api/questions", {
      action: "note",
      id: questionId,
      note: "旧页面写入",
      expectedVersion: 0,
    }),
  );
  assert.equal(response.status, 409);
});
test("BYOK: encrypted per-user keys, mocked stream, quote snapshots and safe export", async () => {
  const fakeKey = "sk-test-key-never-sent-to-a-real-provider";
  let response = await settings.POST(
    request(alice, "/api/settings", {
      action: "saveKey",
      key: fakeKey,
      model: "deepseek-chat",
    }),
  );
  assert.equal(response.status, 200);
  const db = await getDb();
  const [stored] = await db
    .select()
    .from(credentials)
    .where(eq(credentials.userId, alice.id));
  assert.ok(!stored.encryptedKey.includes(fakeKey));
  assert.equal((await snapshot(bob)).settings.hasKey, false);
  const dnsMock = mock.method(dns, "lookup", async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(url), "https://api.deepseek.com/chat/completions");
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        `Bearer ${fakeKey}`,
      );
      const data = JSON.parse(String(init?.body));
      assert.ok(data.messages[0].content.includes("引用句子"));
      return new Response(
        'data: {"choices":[{"delta":{"content":"这是"}}]}\n\ndata: {"choices":[{"delta":{"content":"解释。"}}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  );
  try {
    response = await chat.POST(
      request(alice, "/api/chat", {
        questionId,
        quote: "引用句子",
        message: "为什么？",
      }),
    );
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes("event: done"));
  } finally {
    fetchMock.mock.restore();
    dnsMock.mock.restore();
  }
  response = await chat.GET(
    request(alice, `/api/chat?questionId=${questionId}`),
  );
  const threads = await response.json();
  assert.equal(threads[0].quote, "引用句子");
  assert.equal(threads[0].questionRevision, 2);
  assert.equal(threads[0].messages.length, 2);
  response = await chat.GET(request(bob, `/api/chat?questionId=${questionId}`));
  assert.deepEqual(await response.json(), []);
  response = await exporter.GET(request(alice, "/api/export"));
  const exported = await response.text();
  assert.ok(exported.includes("shiyi-backup"));
  assert.ok(!exported.includes(fakeKey));
  assert.ok(!exported.includes("encryptedKey"));
});
test("OpenAI-compatible connections: encrypted configuration, endpoint-bound keys, draft testing, chat and AI import", async () => {
  const baseUrl = "https://gateway.example.com/api/v1";
  const key = "fake-custom-gateway-key";
  let response = await settings.POST(
    request(alice, "/api/settings", {
      action: "saveConnection",
      baseUrl: `${baseUrl}/chat/completions/`,
      model: "vendor/model-a",
      key,
    }),
  );
  assert.equal(response.status, 200);
  const db = await getDb();
  const [saved] = await db
    .select()
    .from(credentials)
    .where(eq(credentials.userId, alice.id));
  assert.equal(saved.baseUrl, baseUrl);
  assert.equal(saved.provider, "openai-compatible");
  assert.ok(!saved.encryptedKey.includes(key));
  const state = await snapshot(alice);
  assert.equal(state.settings.baseUrl, baseUrl);
  assert.ok(!JSON.stringify(state).includes(key));
  assert.equal((await snapshot(bob)).settings.hasKey, false);
  for (const action of ["saveConnection", "testConnection"]) {
    response = await settings.POST(
      request(alice, "/api/settings", {
        action,
        baseUrl: "https://other.example.com/v1",
        model: "vendor/model-b",
      }),
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "KEY_REQUIRED");
  }
  response = await settings.POST(
    request(bob, "/api/settings", {
      action: "saveConnection",
      baseUrl,
      model: "vendor/model-a",
    }),
  );
  assert.equal(response.status, 400);
  response = await settings.POST(
    request(alice, "/api/settings", {
      action: "saveConnection",
      baseUrl: `${baseUrl}/`,
      model: "vendor/model-b",
    }),
  );
  assert.equal(response.status, 200);
  const [updated] = await db
    .select()
    .from(credentials)
    .where(eq(credentials.userId, alice.id));
  assert.equal(updated.encryptedKey, saved.encryptedKey);
  for (const value of [
    "http://example.com/v1",
    "https://127.0.0.1/v1",
    "https://[::1]/v1",
    "https://localhost/v1",
    "https://example.com/v1?key=secret",
  ]) {
    response = await settings.POST(
      request(alice, "/api/settings", {
        action: "saveConnection",
        baseUrl: value,
        model: "model",
        key,
      }),
    );
    assert.equal(response.status, 400);
  }
  const dnsMock = mock.method(dns, "lookup", async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  const called: string[] = [];
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      called.push(String(url));
      const payload = JSON.parse(String(init?.body));
      if (String(url).startsWith("https://draft.example.com/")) {
        assert.equal(
          (init?.headers as Record<string, string>).Authorization,
          "Bearer fake-draft-key",
        );
        assert.equal(payload.model, "draft-model");
        return Response.json({
          choices: [{ message: { role: "assistant", content: "OK" } }],
        });
      }
      if (String(url).startsWith("https://invalid.example.com/"))
        return new Response("<html>not an API</html>");
      assert.equal(String(url), `${baseUrl}/chat/completions`);
      assert.equal(payload.model, "vendor/model-b");
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        `Bearer ${key}`,
      );
      if (payload.stream)
        return new Response(
          'data: {"choices":[{"delta":{"content":"自定义接口回答。"}}]}',
        );
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({
                questions: [
                  {
                    title: "兼容接口整理的题目？",
                    answer: "整理结果。",
                    tags: [],
                  },
                ],
              }),
            },
          },
        ],
      });
    },
  );
  try {
    response = await settings.POST(
      request(alice, "/api/settings", {
        action: "testConnection",
        baseUrl: "https://draft.example.com/v1",
        model: "draft-model",
        key: "fake-draft-key",
      }),
    );
    assert.equal(response.status, 200);
    assert.equal((await snapshot(alice)).settings.baseUrl, baseUrl);
    assert.equal((await snapshot(alice)).settings.model, "vendor/model-b");
    response = await chat.POST(
      request(alice, "/api/chat", {
        questionId,
        message: "通过新的兼容接口解释。",
        quote: "引用",
      }),
    );
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes("event: done"));
    response = await importer.POST(
      request(alice, "/api/import", {
        batchId: randomUUID(),
        deckId,
        raw: "原始面试资料保留。",
        mode: "ai",
      }),
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).added, 1);
    assert.ok(
      (await snapshot(alice)).questions.some(
        (q: { title: string }) => q.title === "兼容接口整理的题目？",
      ),
    );
    response = await settings.POST(
      request(alice, "/api/settings", {
        action: "testConnection",
        baseUrl: "https://invalid.example.com/v1",
        model: "draft-model",
        key: "fake-draft-key",
      }),
    );
    assert.equal(response.status, 502);
    assert.equal((await snapshot(alice)).settings.baseUrl, baseUrl);
    assert.equal(called.length, 4);
  } finally {
    fetchMock.mock.restore();
    dnsMock.mock.restore();
  }
});

test("statistics: counts cover full history while the recent list stays bounded", async () => {
  const db = await getDb();
  const state = await snapshot(alice);
  const card = state.questions.find(
    (q: { id: string }) => q.id === questionId,
  ).fsrs;
  await db.insert(reviewEvents).values(
    Array.from({ length: 36 }, () => ({
      id: randomUUID(),
      userId: alice.id,
      questionId,
      questionRevision: 2,
      rating: 3,
      before: card,
      after: card,
      createdAt: new Date(Date.now() - 86400_000),
    })),
  );
  const updated = await snapshot(alice);
  assert.equal(updated.stats.totalReviews, 37);
  assert.equal(updated.recentReviews.length, 30);
  assert.equal(updated.stats.retention, 100);
  assert.equal(
    updated.activity.reduce(
      (total: number, row: { count: number }) => total + row.count,
      0,
    ),
    37,
  );
});

test("subscriptions: publishing removal of the final questions preserves notes and idempotent history", async () => {
  const state = await snapshot(alice);
  for (const q of state.questions.filter(
    (q: { deckId: string }) => q.deckId === deckId,
  )) {
    const response = await questionRoute.POST(
      request(alice, "/api/questions", {
        action: "archive",
        id: q.id,
        archived: true,
      }),
    );
    assert.equal(response.status, 200);
  }
  const published = await deckRoute.POST(
    request(alice, "/api/decks", {
      action: "publish",
      deckId,
      expectedVersion: 2,
      visibility: "public",
      summary: "归档旧题",
    }),
  );
  assert.equal(published.status, 200);
  const subscribed = await snapshot(bob);
  assert.ok(
    subscribed.questions.every((q: { archived: boolean }) => q.archived),
  );
  assert.equal(
    subscribed.questions.find((q: { id: string }) => q.id === questionId).note,
    "我的独立理解",
  );
  const db = await getDb();
  const [event] = await db
    .select()
    .from(reviewEvents)
    .where(eq(reviewEvents.userId, bob.id));
  const replay = await reviewRoute.POST(
    request(bob, "/api/reviews", {
      questionId,
      eventId: event.id,
      expectedVersion: 0,
      questionRevision: event.questionRevision,
      rating: event.rating,
    }),
  );
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).duplicate, true);
  assert.equal((await snapshot(bob)).stats.totalReviews, 1);
});

test("verbatim library import: private ownership, byte preservation, deduplication and stale audit handling", async () => {
  const { importLibrary } = await import("../src/server/import-library");
  const { contentHash } = await import("../src/server/crypto");
  const { createHash } = await import("node:crypto");
  const raw =
    "---\r\ntags:\r\n  - RAG\r\n---\r\n# 整篇原题\r\n\r\n## 答案小标题\r\n保留空白  \r\n\r\n> [!question] 面试追问\r\n> Q：关联问题？\r\n";
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const document = {
    path: "RAG/verbatim-test.md",
    kind: "question" as const,
    title: "整篇原题",
    raw,
    sha256,
    tags: ["RAG"],
    validation: {
      checkedAt: "2026-11-14",
      sourcePath: "RAG/verbatim-test.md",
      sourceSha256: sha256,
      reviewedHash: contentHash("整篇原题", raw),
      summary: "内容校验独立于答案。",
      findings: [],
    },
  };
  const first = await importLibrary(alice.id, [document]);
  assert.equal(first.added, 1);
  const id = first.imported[0].questionId;
  let state = await snapshot(alice);
  let q = state.questions.find((item: { id: string }) => item.id === id);
  assert.equal(q.answer, raw);
  assert.equal(q.validation.current, true);
  assert.equal(
    state.decks.find((deck: { id: string }) => deck.id === q.deckId).visibility,
    "private",
  );
  assert.ok(
    !(await snapshot(bob)).questions.some(
      (item: { id: string }) => item.id === id,
    ),
  );
  let response = await questionRoute.POST(
    request(alice, "/api/questions", {
      action: "note",
      id,
      note: "我的笔记",
      expectedVersion: 0,
    }),
  );
  assert.equal(response.status, 200);
  response = await reviewRoute.POST(
    request(alice, "/api/reviews", {
      questionId: id,
      questionRevision: 1,
      eventId: randomUUID(),
      expectedVersion: 0,
      rating: 3,
    }),
  );
  assert.equal(response.status, 200);
  const before = (await snapshot(alice)).questions.find(
    (item: { id: string }) => item.id === id,
  );
  const retry = await importLibrary(alice.id, [document]);
  assert.equal(retry.added, 0);
  assert.equal(retry.duplicates, 1);
  q = (await snapshot(alice)).questions.find(
    (item: { id: string }) => item.id === id,
  );
  assert.equal(q.answer, raw);
  assert.equal(q.note, "我的笔记");
  assert.deepEqual(q.fsrs, before.fsrs);
  await assert.rejects(
    importLibrary(alice.id, [{ ...document, raw: raw + "新内容" }]),
    /已有条目与当前源文件不同/,
  );
  response = await questionRoute.POST(
    request(alice, "/api/questions", {
      action: "edit",
      id,
      expectedRevision: 1,
      title: "整篇原题",
      answer: raw + "用户自行编辑",
      tags: ["RAG"],
    }),
  );
  assert.equal(response.status, 200);
  state = await snapshot(alice);
  q = state.questions.find((item: { id: string }) => item.id === id);
  assert.equal(q.validation.current, false);
});

test("written reviews: preserve private attempts, enforce idempotency and keep source answers intact", async () => {
  const title = "写出你对稳定标识的理解？";
  const imported = await importer.POST(
    request(alice, "/api/import", {
      deckId,
      batchId: randomUUID(),
      raw: `## ${title}\n参考答案保持不变。`,
    }),
  );
  assert.equal(imported.status, 200);
  const q = (await snapshot(alice)).questions.find(
    (item: { title: string }) => item.title === title,
  );
  const answer = "我的回答：稳定 ID 连接历史。\n保留我的换行。";
  const payload = {
    questionId: q.id,
    questionRevision: q.revision,
    expectedVersion: q.studyVersion,
    eventId: randomUUID(),
    rating: 3,
    answer,
  };
  let response = await reviewRoute.POST(
    request(alice, "/api/reviews", payload),
  );
  assert.equal(response.status, 200);
  const db = await getDb();
  const [stored] = await db
    .select()
    .from(reviewEvents)
    .where(eq(reviewEvents.id, payload.eventId));
  assert.equal(stored.answer, answer);
  assert.equal(
    (await snapshot(alice)).questions.find(
      (item: { id: string }) => item.id === q.id,
    ).answer,
    q.answer,
  );
  assert.equal(
    (await snapshot(alice)).recentReviews.find(
      (event: { id: string }) => event.id === payload.eventId,
    ).answer,
    answer,
  );
  assert.ok(!JSON.stringify(await snapshot(bob)).includes(answer));
  response = await reviewRoute.POST(request(alice, "/api/reviews", payload));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).duplicate, true);
  response = await reviewRoute.POST(
    request(alice, "/api/reviews", { ...payload, answer: "改成另一个答案" }),
  );
  assert.equal(response.status, 409);
  response = await reviewRoute.POST(request(bob, "/api/reviews", payload));
  assert.equal(response.status, 409);
  response = await reviewRoute.POST(
    request(alice, "/api/reviews", {
      ...payload,
      eventId: randomUUID(),
      answer: "x".repeat(20001),
    }),
  );
  assert.equal(response.status, 400);
});

let emptyQuestions: { id: string; title: string }[];
let bobEmptyId: string;
test("question-only import: store missing answers, deduplicate answered titles and retain input kind on retries", async () => {
  const raw = "什么是乐观锁？\n1. 如何避免死锁？\n- 解释比较并交换。";
  const batchId = randomUUID();
  const payload = { deckId, batchId, raw, inputType: "questions" };
  let response = await importer.POST(request(alice, "/api/import", payload));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).added, 3);
  assert.equal(
    (await importer.POST(request(alice, "/api/import", payload))).status,
    200,
  );
  assert.equal(
    (
      await importer.POST(
        request(alice, "/api/import", { ...payload, inputType: "qa" }),
      )
    ).status,
    409,
  );
  const state = await snapshot(alice);
  emptyQuestions = state.questions.filter((q: { title: string }) =>
    ["什么是乐观锁？", "如何避免死锁？", "解释比较并交换。"].includes(q.title),
  );
  assert.equal(emptyQuestions.length, 3);
  for (const q of emptyQuestions) {
    const stored = state.questions.find(
      (item: { id: string }) => item.id === q.id,
    );
    assert.equal(stored.answer, "");
    assert.equal(stored.needsEditing, true);
    assert.equal(stored.fsrs, null);
  }
  await importer.POST(
    request(alice, "/api/import", {
      deckId,
      batchId: randomUUID(),
      raw: "## 已经有完整答案的题目\n已有参考答案。",
    }),
  );
  response = await importer.POST(
    request(alice, "/api/import", {
      deckId,
      batchId: randomUUID(),
      raw: "已经有完整答案的题目\n什么是乐观锁？",
      inputType: "questions",
    }),
  );
  assert.deepEqual(await response.json(), { added: 0, duplicates: 2 });
  assert.equal(
    (await snapshot(alice)).questions.find(
      (q: { title: string }) => q.title === "已经有完整答案的题目",
    ).answer,
    "已有参考答案。",
  );
  const exported = await (
    await exporter.GET(request(alice, "/api/export"))
  ).json();
  const receipt = exported.imports.find(
    (item: { id: string }) => item.id === batchId,
  );
  assert.equal(receipt.inputType, "questions");
  assert.equal(receipt.raw, raw);
  response = await importer.POST(
    request(alice, "/api/import", {
      deckId,
      batchId: randomUUID(),
      raw: "长".repeat(201),
      inputType: "questions",
    }),
  );
  assert.equal(response.status, 400);
  response = await importer.POST(
    request(alice, "/api/import", {
      deckId,
      batchId: randomUUID(),
      raw: "题目",
      inputType: "questions",
      mode: "ai",
    }),
  );
  assert.equal(response.status, 400);
});

test("AI answer drafts: per-user providers generate without saving; explicit save fills the inbox item", async () => {
  const bobDeck = (await snapshot(bob)).decks.find(
    (d: { isOwner: boolean }) => d.isOwner,
  ).id;
  await importer.POST(
    request(bob, "/api/import", {
      deckId: bobDeck,
      batchId: randomUUID(),
      raw: "Bob 的私有并发问题",
      inputType: "questions",
    }),
  );
  bobEmptyId = (await snapshot(bob)).questions.find(
    (q: { title: string }) => q.title === "Bob 的私有并发问题",
  ).id;
  const connections = new Map([
    [
      alice.id,
      {
        baseUrl: "https://alice-answer.example/v1",
        model: "alice-answer-model",
        key: "fake-alice-answer-key",
      },
    ],
    [
      bob.id,
      {
        baseUrl: "https://bob-answer.example/v1",
        model: "bob-answer-model",
        key: "fake-bob-answer-key",
      },
    ],
  ]);
  for (const owner of [alice, bob])
    assert.equal(
      (
        await settings.POST(
          request(owner, "/api/settings", {
            action: "saveConnection",
            ...connections.get(owner.id),
          }),
        )
      ).status,
      200,
    );
  const dnsMock = mock.method(dns, "lookup", async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  const calls: string[] = [];
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      const owner = String(url).includes("alice-answer") ? alice : bob;
      const connection = connections.get(owner.id)!;
      const payload = JSON.parse(String(init?.body));
      assert.equal(String(url), `${connection.baseUrl}/chat/completions`);
      assert.equal(payload.stream, false);
      assert.equal(payload.model, connection.model);
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        `Bearer ${connection.key}`,
      );
      assert.ok(
        !JSON.stringify(payload).includes(
          owner.id === alice.id ? "Bob 的私有" : "什么是乐观锁",
        ),
      );
      calls.push(owner.id);
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: `## 核心回答\n${owner.id === alice.id ? "Alice" : "Bob"} 生成的参考答案。`,
            },
            finish_reason: "stop",
          },
        ],
      });
    },
  );
  try {
    const q = emptyQuestions[0];
    const results = await Promise.all([
      aiAnswer.POST(
        request(alice, "/api/questions/answer", {
          questionId: q.id,
          expectedRevision: 1,
          instructions: "用 Java 举例",
        }),
      ),
      aiAnswer.POST(
        request(bob, "/api/questions/answer", {
          questionId: bobEmptyId,
          expectedRevision: 1,
        }),
      ),
    ]);
    for (const result of results) {
      assert.equal(result.status, 200);
      assert.match(result.headers.get("Cache-Control")!, /private.*no-store/);
    }
    const draft = await results[0].json();
    assert.equal(draft.questionRevision, 1);
    assert.ok(draft.answer.includes("Alice"));
    await results[1].json();
    let current = (await snapshot(alice)).questions.find(
      (item: { id: string }) => item.id === q.id,
    );
    assert.equal(
      current.answer,
      "",
      "generation must never write the reference answer",
    );
    assert.equal(current.needsEditing, true);
    const saved = await questionRoute.POST(
      request(alice, "/api/questions", {
        action: "edit",
        id: q.id,
        expectedRevision: 1,
        title: q.title,
        answer: draft.answer,
        tags: [],
        major: false,
      }),
    );
    assert.equal(saved.status, 200);
    current = (await snapshot(alice)).questions.find(
      (item: { id: string }) => item.id === q.id,
    );
    assert.equal(current.answer, draft.answer);
    assert.equal(current.needsEditing, false);
    assert.equal(current.revision, 2);
    assert.ok(
      !(await snapshot(bob)).questions.some((item: { answer: string }) =>
        item.answer.includes("Alice 生成"),
      ),
    );
    const existing = await aiAnswer.POST(
      request(alice, "/api/questions/answer", {
        questionId: q.id,
        expectedRevision: 2,
      }),
    );
    assert.equal(existing.status, 409);
    assert.equal((await existing.json()).code, "ANSWER_EXISTS");
    assert.equal(calls.length, 2);
    const second = emptyQuestions[1];
    const beforeEdit = await aiAnswer.POST(
      request(alice, "/api/questions/answer", {
        questionId: second.id,
        expectedRevision: 1,
      }),
    );
    const oldDraft = await beforeEdit.json();
    await questionRoute.POST(
      request(alice, "/api/questions", {
        action: "edit",
        id: second.id,
        expectedRevision: 1,
        title: second.title + "（已修改）",
        answer: "",
        tags: [],
        major: false,
      }),
    );
    const conflict = await questionRoute.POST(
      request(alice, "/api/questions", {
        action: "edit",
        id: second.id,
        expectedRevision: 1,
        title: second.title,
        answer: oldDraft.answer,
        tags: [],
        major: false,
      }),
    );
    assert.equal(conflict.status, 409);
    assert.equal(
      (await snapshot(alice)).questions.find(
        (item: { id: string }) => item.id === second.id,
      ).answer,
      "",
    );
  } finally {
    fetchMock.mock.restore();
    dnsMock.mock.restore();
  }
});

test("AI answer drafts: deny foreign questions, subscribers, stale revisions and unsafe model results", async () => {
  const q = emptyQuestions[2];
  const payload = { questionId: q.id, expectedRevision: 1 };
  assert.equal(
    (
      await aiAnswer.POST(
        new Request("http://localhost:3000/api/questions/answer", {
          method: "POST",
          headers: {
            origin: "http://localhost:3000",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        }),
      )
    ).status,
    401,
  );
  assert.equal(
    (await aiAnswer.POST(request(bob, "/api/questions/answer", payload)))
      .status,
    404,
  );
  assert.equal(
    (
      await aiAnswer.POST(
        request(bob, "/api/questions/answer", {
          questionId,
          expectedRevision: 2,
        }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await aiAnswer.POST(
        request(alice, "/api/questions/answer", {
          ...payload,
          expectedRevision: 2,
        }),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await aiAnswer.POST(
        request(
          alice,
          "/api/questions/answer",
          payload,
          "https://evil.example",
        ),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await aiAnswer.POST(
        request(alice, "/api/questions/answer", {
          ...payload,
          instructions: "x".repeat(1001),
        }),
      )
    ).status,
    400,
  );
  const dnsMock = mock.method(dns, "lookup", async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  const responses = [
    new Response("not JSON"),
    Response.json({
      choices: [{ message: { role: "assistant", content: "" } }],
    }),
    Response.json({
      choices: [
        {
          message: { role: "assistant", content: "partial" },
          finish_reason: "length",
        },
      ],
    }),
    Response.json({
      choices: [{ message: { role: "user", content: "wrong role" } }],
    }),
    new Response("provider-private-debug-value", { status: 401 }),
    Response.json({
      choices: [
        {
          message: { role: "assistant", content: "最终有效草稿。" },
          finish_reason: "stop",
        },
      ],
    }),
  ];
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    responses.shift()!,
  );
  try {
    for (const expected of [502, 502, 502, 502, 400, 200]) {
      const response = await aiAnswer.POST(
        request(alice, "/api/questions/answer", payload),
      );
      assert.equal(response.status, expected);
      const text = await response.text();
      assert.ok(!text.includes("provider-private-debug-value"));
      assert.ok(!text.includes("fake-alice-answer-key"));
    }
    assert.equal(
      responses.length,
      0,
      "errors must release the per-user AI slot",
    );
    assert.equal(
      (await snapshot(alice)).questions.find(
        (item: { id: string }) => item.id === q.id,
      ).answer,
      "",
    );
  } finally {
    fetchMock.mock.restore();
    dnsMock.mock.restore();
  }
});

test("registration: the approved eight-character minimum is enforced", async () => {
  const auth = await getAuth();
  const response = await auth.handler(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.8",
      },
      body: JSON.stringify({
        name: "minimum",
        email: "minimum@example.test",
        password: "valid8pw",
      }),
    }),
  );
  assert.equal(response.status, 200);
  const rejected = await auth.handler(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.9",
      },
      body: JSON.stringify({
        name: "too-short",
        email: "too-short@example.test",
        password: "short7x",
      }),
    }),
  );
  assert.equal(rejected.status, 400);
});

after(async () => {
  const state = globalThis as unknown as {
    interviewDatabase?: Promise<{ close: () => Promise<void> }>;
  };
  await (await state.interviewDatabase)?.close();
});
