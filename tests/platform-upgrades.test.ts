import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import { sql } from "drizzle-orm";
import type { Conversation, Workspace } from "../src/lib/types";

Object.assign(process.env, { NODE_ENV: "test" });
process.env.LOCAL_DATABASE_PATH = ":memory:";
delete process.env.DATABASE_URL;
delete process.env.PGHOST;
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.KEY_ENCRYPTION_SECRET = randomBytes(32).toString("hex");
process.env.BETTER_AUTH_URL = "http://localhost:3000";

const { getAuth } = await import("../src/server/auth");
const { getDb } = await import("../src/db");
const { isReasoningModel } = await import("../src/server/ai");
const { readChatEdits } = await import("../src/server/chat-edits");
const workspaceRoute = await import("../src/app/api/workspace/route");
const deckRoute = await import("../src/app/api/decks/route");
const questionRoute = await import("../src/app/api/questions/route");
const catalogRoute = await import("../src/app/api/catalog/route");
const settingsRoute = await import("../src/app/api/settings/route");
const chatRoute = await import("../src/app/api/chat/route");

type UserContext = { cookie: string; id: string };
let registerIpSeq = 0;

async function register(name: string): Promise<UserContext> {
  const auth = await getAuth();
  const response = await auth.handler(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
        "x-forwarded-for": `198.51.100.${++registerIpSeq}`,
      },
      body: JSON.stringify({
        name,
        email: `${name}@upgrade.test`,
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
      .map((v) => v.split(";")[0])
      .join("; "),
  };
}

function makeRequest(user: UserContext, path: string, data?: unknown) {
  return new Request(`http://localhost:3000${path}`, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      cookie: user.cookie,
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
}

async function readSse(response: Response) {
  const raw = await response.text();
  const events: { event: string; data: Record<string, unknown> }[] = [];
  for (const block of raw.split("\n\n")) {
    const event = block.match(/^event: (.+)$/m)?.[1];
    const json = block.match(/^data: (.+)$/m)?.[1];
    if (event && json) {
      events.push({ event, data: JSON.parse(json) });
    }
  }
  return events;
}

const publicAddress = { address: "93.184.216.34", family: 4 };

after(() => {
  mock.restoreAll();
});

test("migration 0009 indexes, nullability, workspace sourceText omission, and catalog SQL count", async () => {
  const alice = await register("alice-idx");
  const db = await getDb();

  const indexResult = await db.execute(
    sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
  );
  const indexes = new Set(
    indexResult.rows.map((r) => String((r as { indexname: string }).indexname)),
  );
  for (const required of [
    "question_import_idx",
    "release_questions_gin_idx",
    "import_user_time_idx",
    "conversation_user_scope_idx",
    "chat_message_conv_time_idx",
  ]) {
    assert.ok(indexes.has(required), `Missing index ${required}`);
  }

  const createdDeckRes = await deckRoute.POST(
    makeRequest(alice, "/api/decks", {
      action: "create",
      title: "Redis 深入",
      description: "持久化与高可用",
    }),
  );
  assert.equal(createdDeckRes.status, 200);
  const {
    deck: { id: deckId },
  } = (await createdDeckRes.json()) as { deck: { id: string } };

  const q1Res = await questionRoute.POST(
    makeRequest(alice, "/api/questions", {
      action: "create",
      deckId,
      title: "Redis RDB 与 AOF 持久化区别",
      answer: "RDB 是定时全量快照，AOF 追加写命令日志。",
      tags: ["Redis"],
    }),
  );
  assert.equal(q1Res.status, 200);
  const { id: q1Id } = (await q1Res.json()) as { id: string };

  const q2Res = await questionRoute.POST(
    makeRequest(alice, "/api/questions", {
      action: "create",
      deckId,
      title: "Redis 缓存穿透如何解决",
      answer: "布隆过滤器 + 空值缓存。",
      tags: ["Redis"],
    }),
  );
  assert.equal(q2Res.status, 200);
  const { id: q2Id } = (await q2Res.json()) as { id: string };

  await questionRoute.POST(
    makeRequest(alice, "/api/questions", {
      action: "archive",
      id: q2Id,
      archived: true,
    }),
  );

  const pubRes = await deckRoute.POST(
    makeRequest(alice, "/api/decks", {
      action: "publish",
      deckId,
      expectedVersion: 0,
      visibility: "public",
    }),
  );
  assert.equal(pubRes.status, 200);

  const wsRes = await workspaceRoute.GET(makeRequest(alice, "/api/workspace"));
  assert.equal(wsRes.status, 200);
  const ws = (await wsRes.json()) as Workspace;
  const wsQuestion = ws.questions.find((q) => q.id === q1Id);
  assert.ok(wsQuestion);
  assert.equal("sourceText" in wsQuestion, false);

  const catRes = await catalogRoute.GET(makeRequest(alice, "/api/catalog"));
  assert.equal(catRes.status, 200);
  const cat = (await catRes.json()) as Array<{ id: string; count: number }>;
  const entry = cat.find((item) => item.id === deckId);
  assert.ok(entry);
  assert.equal(entry.count, 1);
});

test("readChatEdits handles fenced Markdown blocks around <shiyi-edits>", () => {
  const edit = readChatEdits(
    '```xml\n<shiyi-edits>{"question":{"title":"Redis RDB vs AOF 核心对比"}}</shiyi-edits>\n```',
    {
      question: {
        id: "q-1",
        title: "旧标题",
        answer: "旧答案",
        tags: [],
        revision: 1,
      },
    },
  );
  assert.ok(edit);
  assert.equal(edit.length, 1);
  assert.equal(edit[0].target, "question");
});

test("isReasoningModel & SSE reasoning_content streaming + token budget scaling", async () => {
  assert.equal(isReasoningModel("deepseek-reasoner"), true);
  assert.equal(isReasoningModel("deepseek-ai/DeepSeek-R1"), true);
  assert.equal(isReasoningModel("qwq-32b"), true);
  assert.equal(isReasoningModel("o3-mini"), true);
  assert.equal(isReasoningModel("deepseek-chat"), false);
  assert.equal(isReasoningModel("openai/gpt-5"), false);

  const user = await register("reasoner-user");
  const deckRes = await deckRoute.POST(
    makeRequest(user, "/api/decks", {
      action: "create",
      title: "后端原理",
      description: "原理复习",
    }),
  );
  const {
    deck: { id: deckId },
  } = (await deckRes.json()) as { deck: { id: string } };
  const qRes = await questionRoute.POST(
    makeRequest(user, "/api/questions", {
      action: "create",
      deckId,
      title: "MVCC 如何实现可重复读",
      answer: "通过 ReadView 与 undo log 版本链。",
      tags: ["MySQL"],
    }),
  );
  const { id: questionId } = (await qRes.json()) as { id: string };

  const saveRes = await settingsRoute.POST(
    makeRequest(user, "/api/settings", {
      action: "saveConnection",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-reasoner",
      key: "sk-test-reasoner-key-123456",
    }),
  );
  assert.equal(saveRes.status, 200);

  const recordedBodies: Array<Record<string, unknown>> = [];
  const resolver = mock.method(dns, "lookup", async () => [publicAddress]);
  const fetcher = mock.method(
    globalThis,
    "fetch",
    async (_url: URL | string | Request, init?: RequestInit) => {
      recordedBodies.push(JSON.parse(String(init?.body ?? "{}")));
      const ssePayload = [
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "先分析 ReadView 创建时机。" } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "可重复读只在事务首次 SELECT 时生成一次 ReadView。" }, finish_reason: "stop" }] })}`,
        "data: [DONE]",
        "",
      ].join("\n\n");
      return new Response(ssePayload, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  );

  try {
    const response = await chatRoute.POST(
      makeRequest(user, "/api/chat", {
        questionId,
        message: "为什么不会幻读",
      }),
    );
    assert.equal(response.status, 200);
    const events = await readSse(response);
    assert.equal(events.some((e) => e.event === "meta"), true);
    assert.equal(
      events.some(
        (e) =>
          e.event === "reasoning" &&
          String(e.data.text).includes("ReadView 创建时机"),
      ),
      true,
    );
    assert.equal(
      events.some(
        (e) =>
          e.event === "delta" &&
          String(e.data.text).includes("生成一次 ReadView"),
      ),
      true,
    );
    assert.equal(events.some((e) => e.event === "done"), true);
    assert.ok(Number(recordedBodies[0]?.max_tokens) >= 8000);
  } finally {
    fetcher.mock.restore();
    resolver.mock.restore();
  }
});

test("multi-scope workspace & deck AI tools, user isolation, and 400 tool fallback", async () => {
  const alice = await register("alice-scope");
  const bob = await register("bob-scope");

  const aliceDeckRes = await deckRoute.POST(
    makeRequest(alice, "/api/decks", {
      action: "create",
      title: "Redis 核心",
      description: "缓存与持久化",
    }),
  );
  const {
    deck: { id: aliceDeckId },
  } = (await aliceDeckRes.json()) as { deck: { id: string } };
  const q1Res = await questionRoute.POST(
    makeRequest(alice, "/api/questions", {
      action: "create",
      deckId: aliceDeckId,
      title: "Redis 持久化机制",
      answer: "RDB 和 AOF",
      tags: ["Redis"],
    }),
  );
  const { id: aliceQ1 } = (await q1Res.json()) as { id: string };
  await questionRoute.POST(
    makeRequest(alice, "/api/questions", {
      action: "create",
      deckId: aliceDeckId,
      title: "Redis RDB AOF 持久化机制对比",
      answer: "详细对比快照与日志。",
      tags: ["Redis"],
    }),
  );

  const bobDeckRes = await deckRoute.POST(
    makeRequest(bob, "/api/decks", {
      action: "create",
      title: "Bob 私密题单",
      description: "不应泄漏",
    }),
  );
  const {
    deck: { id: bobDeckId },
  } = (await bobDeckRes.json()) as { deck: { id: string } };
  await questionRoute.POST(
    makeRequest(bob, "/api/questions", {
      action: "create",
      deckId: bobDeckId,
      title: "Bob 机密题目",
      answer: "Secret Bob Answer",
      tags: ["Secret"],
    }),
  );

  await settingsRoute.POST(
    makeRequest(alice, "/api/settings", {
      action: "saveConnection",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      key: "sk-test-alice-key-123456",
    }),
  );
  await settingsRoute.POST(
    makeRequest(bob, "/api/settings", {
      action: "saveConnection",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      key: "sk-test-bob-key-123456",
    }),
  );

  const isolatedDeckRead = await chatRoute.GET(
    makeRequest(bob, `/api/chat?scope=deck&deckId=${aliceDeckId}`),
  );
  assert.equal(isolatedDeckRead.status, 404);

  let toolRound = 0;
  const toolOutputsObserved: string[] = [];
  const resolver = mock.method(dns, "lookup", async () => [publicAddress]);
  const fetcher = mock.method(
    globalThis,
    "fetch",
    async (_url: URL | string | Request, init?: RequestInit) => {
      const reqBody = JSON.parse(String(init?.body ?? "{}"));
      toolRound += 1;
      if (toolRound === 1) {
        assert.ok(Array.isArray(reqBody.tools) && reqBody.tools.length === 4);
        return Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "search_questions",
                      arguments: JSON.stringify({ query: "Redis" }),
                    },
                  },
                  {
                    id: "call_2",
                    type: "function",
                    function: {
                      name: "find_duplicate_questions",
                      arguments: JSON.stringify({ threshold: 0.4 }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      toolOutputsObserved.push(JSON.stringify(reqBody.messages));
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: "已检索到你题库中 2 道 Redis 持久化相关题目，建议合并重复要点。",
            },
          },
        ],
      });
    },
  );

  try {
    const res = await chatRoute.POST(
      makeRequest(alice, "/api/chat", {
        scope: "workspace",
        message: "帮我排查 Redis 相关的重复题目",
      }),
    );
    assert.equal(res.status, 200);
    const events = await readSse(res);
    assert.equal(events.some((e) => e.event === "tool"), true);
    const refEvent = events.find((e) => e.event === "references");
    assert.ok(refEvent);
    const refs = refEvent.data.refs as Array<{ id: string; title: string }>;
    assert.equal(refs.some((r) => r.id === aliceQ1), true);
    assert.equal(
      toolOutputsObserved.join("\n").includes("Bob 机密题目"),
      false,
    );

    const threadsRes = await chatRoute.GET(
      makeRequest(alice, "/api/chat?scope=workspace"),
    );
    assert.equal(threadsRes.status, 200);
    const threads = (await threadsRes.json()) as Conversation[];
    assert.equal(threads.length, 1);
    assert.equal(threads[0].questionId, null);
    assert.equal(threads[0].scope, "workspace");
    assert.equal(threads[0].messages.length, 2);
  } finally {
    fetcher.mock.restore();
    resolver.mock.restore();
  }

  let fallbackCall = 0;
  const fallbackBodies: Array<Record<string, unknown>> = [];
  const resolver2 = mock.method(dns, "lookup", async () => [publicAddress]);
  const fetcher2 = mock.method(
    globalThis,
    "fetch",
    async (_url: URL | string | Request, init?: RequestInit) => {
      const reqBody = JSON.parse(String(init?.body ?? "{}"));
      fallbackBodies.push(reqBody);
      fallbackCall += 1;
      if (fallbackCall === 1) {
        return new Response("tools unsupported", { status: 400 });
      }
      const ssePayload = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "当前「Redis 核心」题库共有 2 道有效题目。" }, finish_reason: "stop" }] })}`,
        "data: [DONE]",
        "",
      ].join("\n\n");
      return new Response(ssePayload, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  );

  try {
    const res = await chatRoute.POST(
      makeRequest(alice, "/api/chat", {
        scope: "deck",
        deckId: aliceDeckId,
        message: "总结当前题库情况",
      }),
    );
    assert.equal(res.status, 200);
    const events = await readSse(res);
    assert.equal(
      events.some(
        (e) => e.event === "delta" && String(e.data.text).includes("2 道有效题目"),
      ),
      true,
    );
    const fallbackPrompt = JSON.stringify(fallbackBodies[1]?.messages ?? []);
    assert.equal(fallbackPrompt.includes("Redis 核心"), true);
    assert.equal(fallbackPrompt.includes("Bob 机密题目"), false);

    const deckThreadsRes = await chatRoute.GET(
      makeRequest(alice, `/api/chat?scope=deck&deckId=${aliceDeckId}`),
    );
    assert.equal(deckThreadsRes.status, 200);
    const deckThreads = (await deckThreadsRes.json()) as Conversation[];
    assert.equal(deckThreads.length, 1);
    assert.equal(deckThreads[0].scope, "deck");
    assert.equal(deckThreads[0].deckId, aliceDeckId);
  } finally {
    fetcher2.mock.restore();
    resolver2.mock.restore();
  }
});
