import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import dns from "node:dns/promises";
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
const { conversations, messages } = await import("../src/db/schema");
const { applyCorrectionAt } = await import("../src/lib/ai-proofread");
const { userInitials } = await import("../src/lib/user-display");
const { reviewInsight, schedule } = await import("../src/server/scheduler");
const { executeWorkspaceTool } = await import("../src/server/ai-tools");
const healthRoute = await import("../src/app/api/health/route");
const workspaceRoute = await import("../src/app/api/workspace/route");
const exportRoute = await import("../src/app/api/export/route");
const deckRoute = await import("../src/app/api/decks/route");
const questionRoute = await import("../src/app/api/questions/route");
const settingsRoute = await import("../src/app/api/settings/route");
const chatRoute = await import("../src/app/api/chat/route");

type UserContext = { cookie: string; id: string };
let ipSeq = 0;

async function register(name: string): Promise<UserContext> {
  const auth = await getAuth();
  const response = await auth.handler(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
        "x-forwarded-for": `198.51.101.${++ipSeq}`,
      },
      body: JSON.stringify({
        name,
        email: `${name}@firstprinciples.test`,
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
  for (const block of raw.replace(/\r\n?/g, "\n").split("\n\n")) {
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

test("health readiness covers 0010, export retains sourceText while workspace omits it, unfiled edit deduplicates and normalizes tags, and timeZone rejects offsets", async () => {
  const alice = await register("fp-core");
  const healthRes = await healthRoute.GET();
  assert.equal(healthRes.status, 200);
  assert.deepEqual(await healthRes.json(), { status: "ok" });

  // Reject POSIX numeric offsets, accept valid IANA zones
  const badTz = await settingsRoute.POST(
    makeRequest(alice, "/api/settings", {
      action: "preferences",
      dailyGoal: 5,
      dailyNewLimit: 3,
      theme: "light",
      timeZone: "+08:00",
    }),
  );
  assert.equal(badTz.status, 400);

  const okTz = await settingsRoute.POST(
    makeRequest(alice, "/api/settings", {
      action: "preferences",
      dailyGoal: 5,
      dailyNewLimit: 3,
      theme: "dark",
      timeZone: "Asia/Shanghai",
    }),
  );
  assert.equal(okTz.status, 200);

  // Unfiled duplicates & tag normalization on edit
  const q1Res = await questionRoute.POST(
    makeRequest(alice, "/api/questions", {
      action: "create",
      deckId: null,
      title: "什么是事件循环",
      answer: "MacroTask 与 MicroTask 交替调度",
      tags: ["#JavaScript"],
    }),
  );
  assert.equal(q1Res.status, 200);
  const { id: q1Id } = (await q1Res.json()) as { id: string };

  const q2Res = await questionRoute.POST(
    makeRequest(alice, "/api/questions", {
      action: "create",
      deckId: null,
      title: "另一道未分类题",
      answer: "初始答案",
      tags: [],
    }),
  );
  assert.equal(q2Res.status, 200);
  const { id: q2Id } = (await q2Res.json()) as { id: string };

  const dupEditRes = await questionRoute.POST(
    makeRequest(alice, "/api/questions", {
      action: "edit",
      id: q2Id,
      expectedRevision: 1,
      title: "什么是事件循环",
      answer: "MacroTask 与 MicroTask 交替调度",
      tags: ["#JS"],
    }),
  );
  assert.equal(dupEditRes.status, 200);
  const dupEditBody = (await dupEditRes.json()) as {
    duplicates?: Array<{ id: string }>;
  };
  assert.ok(dupEditBody.duplicates?.some((d) => d.id === q1Id));

  const normEditRes = await questionRoute.POST(
    makeRequest(alice, "/api/questions", {
      action: "edit",
      id: q1Id,
      expectedRevision: 1,
      title: "什么是事件循环",
      answer: "MacroTask 与 MicroTask 交替调度。",
      tags: ["#JS", "JS", "  #Frontend  "],
    }),
  );
  assert.equal(normEditRes.status, 200);

  const wsRes = await workspaceRoute.GET(makeRequest(alice, "/api/workspace"));
  assert.equal(wsRes.status, 200);
  const ws = (await wsRes.json()) as Workspace;
  const wsQ1 = ws.questions.find((q) => q.id === q1Id);
  assert.ok(wsQ1);
  assert.deepEqual(wsQ1.tags, ["JS", "Frontend"]);
  assert.equal("sourceText" in wsQ1, false);

  const exportRes = await exportRoute.GET(makeRequest(alice, "/api/export"));
  assert.equal(exportRes.status, 200);
  const exported = (await exportRes.json()) as {
    questions: Array<{ id: string; sourceText?: string }>;
  };
  const expQ1 = exported.questions.find((q) => q.id === q1Id);
  assert.ok(expQ1);
  assert.equal(typeof expQ1.sourceText, "string");
});

test("scheduler keeps Learning Again lapses at 0 and shifts forgettingCurve by elapsed days since last_review", async () => {
  const t0 = new Date("2026-11-01T08:00:00Z");
  const learningAgain = await schedule(null, 1, t0);
  assert.equal(learningAgain.lapses, 0);

  // Graduate card with Good, then check forgettingCurve 14 days later
  const reviewCard = await schedule(null, 4, t0);
  const t14 = new Date(t0.getTime() + 14 * 86400_000);
  const insightLater = await reviewInsight(reviewCard, t14);
  assert.ok(insightLater.curve.length > 0);
  assert.equal(insightLater.curve[0].day, 0);
  assert.ok(
    insightLater.curve[0].retention < 100,
    `Expected retention at +14d to be < 100, got ${insightLater.curve[0].retention}`,
  );
  assert.ok(
    insightLater.curve[0].retention >= insightLater.curve.at(-1)!.retention,
  );
});

test("question chat parses live fenced <shiyi-edits>, cleans failed user turns, and persists reasoning metadata in GET /api/chat", async () => {
  const alice = await register("fp-qchat");
  const deckRes = await deckRoute.POST(
    makeRequest(alice, "/api/decks", {
      action: "create",
      title: "网络协议",
      description: "TCP 与 HTTP",
    }),
  );
  const {
    deck: { id: deckId },
  } = (await deckRes.json()) as { deck: { id: string } };
  const qRes = await questionRoute.POST(
    makeRequest(alice, "/api/questions", {
      action: "create",
      deckId,
      title: "TCP 三次握手过程",
      answer: "SYN -> SYN+ACK -> ACK",
      tags: ["网络"],
    }),
  );
  const { id: questionId } = (await qRes.json()) as { id: string };

  await settingsRoute.POST(
    makeRequest(alice, "/api/settings", {
      action: "saveConnection",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-reasoner",
      key: "sk-test-qchat-123456",
    }),
  );

  // 1) Upstream 401 failure must NOT leave orphaned conversation or user message
  const resolver = mock.method(dns, "lookup", async () => [publicAddress]);
  const failFetcher = mock.method(globalThis, "fetch", async () => {
    return new Response("Unauthorized", { status: 401 });
  });
  try {
    const errRes = await chatRoute.POST(
      makeRequest(alice, "/api/chat", {
        questionId,
        message: "这条失败消息不应该留在历史里",
      }),
    );
    assert.equal(errRes.status, 400);
  } finally {
    failFetcher.mock.restore();
    resolver.mock.restore();
  }

  const db = await getDb();
  assert.equal((await db.select().from(conversations)).length, 0);
  assert.equal((await db.select().from(messages)).length, 0);

  // 2) Live fenced <shiyi-edits> + reasoning_content persistence
  const resolver2 = mock.method(dns, "lookup", async () => [publicAddress]);
  const fencedFetcher = mock.method(globalThis, "fetch", async () => {
    const fencedJson =
      '```xml\n<shiyi-edits>{"question":{"title":"TCP 三次握手与状态变迁"}}</shiyi-edits>\n```';
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "用户希望优化标题表述。" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "```xml\n" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: fencedJson.slice(7, 30) } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: fencedJson.slice(30) }, finish_reason: "stop" }] })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    return new Response(chunks, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  });

  try {
    const okRes = await chatRoute.POST(
      makeRequest(alice, "/api/chat", {
        questionId,
        message: "帮我优化题目名称",
      }),
    );
    assert.equal(okRes.status, 200);
    const events = await readSse(okRes);
    const deltas = events
      .filter((e) => e.event === "delta")
      .map((e) => String(e.data.text))
      .join("");
    assert.equal(deltas.includes("<shiyi-edits>"), false);
    assert.equal(deltas.includes("已拟好修改建议"), true);

    const threadsRes = await chatRoute.GET(
      makeRequest(alice, `/api/chat?scope=question&questionId=${questionId}`),
    );
    assert.equal(threadsRes.status, 200);
    const threads = (await threadsRes.json()) as Conversation[];
    assert.equal(threads.length, 1);
    const assistant = threads[0].messages.find((m) => m.role === "assistant")!;
    assert.ok(assistant.edits?.length === 1);
    assert.equal(
      assistant.edits?.[0].target === "question" &&
        assistant.edits[0].fields.title,
      "TCP 三次握手与状态变迁",
    );
    assert.equal(assistant.reasoning, "用户希望优化标题表述。");
  } finally {
    fencedFetcher.mock.restore();
    resolver2.mock.restore();
  }
});

test("scoped AI tools isolate decks, emit deckTitle not UUID, handle unknown tools, keep reasoning_content & tool_choice: none on forced final round, and persist metadata", async () => {
  const alice = await register("fp-scope");

  const d1Res = await deckRoute.POST(
    makeRequest(alice, "/api/decks", {
      action: "create",
      title: "公开目标题单",
      description: "测试题单",
    }),
  );
  const {
    deck: { id: deck1Id },
  } = (await d1Res.json()) as { deck: { id: string } };

  const d2Res = await deckRoute.POST(
    makeRequest(alice, "/api/decks", {
      action: "create",
      title: "其他私有题单不应泄漏",
      description: "隔离子库",
    }),
  );
  await d2Res.json();

  const qRes = await questionRoute.POST(
    makeRequest(alice, "/api/questions", {
      action: "create",
      deckId: deck1Id,
      title: "什么是浏览器重排与重绘",
      answer: "几何属性变化触发重排，外观属性触发重绘。",
      tags: ["浏览器"],
    }),
  );
  const { id: q1Id } = (await qRes.json()) as { id: string };

  // Direct tool invariants: deck overview isolation, get_question_detail deckTitle, unknown tool
  const overviewTool = await executeWorkspaceTool(
    alice.id,
    "deck",
    deck1Id,
    "list_workspace_overview",
    "{}",
  );
  const overviewOut = overviewTool.output as {
    decks: Array<{ title: string }>;
  };
  assert.equal(
    overviewOut.decks.some((d) => d.title === "其他私有题单不应泄漏"),
    false,
  );

  const detailTool = await executeWorkspaceTool(
    alice.id,
    "workspace",
    null,
    "get_question_detail",
    JSON.stringify({ questionId: q1Id }),
  );
  assert.equal(detailTool.refs[0]?.deckTitle, "公开目标题单");

  const unknownTool = await executeWorkspaceTool(
    alice.id,
    "workspace",
    null,
    "delete_everything",
    "{}",
  );
  assert.equal(unknownTool.refs.length, 0);
  assert.ok(String((unknownTool.output as { error: string }).error).includes("Unknown tool"));

  // Multi-round loop hitting MAX_TOOL_ROUNDS = 4: verifies reasoning_content preserved + toolChoice: "none" on forced final streamed call + metadata persisted in GET
  await settingsRoute.POST(
    makeRequest(alice, "/api/settings", {
      action: "saveConnection",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-reasoner",
      key: "sk-test-scope-123456",
    }),
  );

  let callCount = 0;
  const recordedPayloads: Array<Record<string, unknown>> = [];
  const resolver = mock.method(dns, "lookup", async () => [publicAddress]);
  const fetcher = mock.method(
    globalThis,
    "fetch",
    async (_url: URL | string | Request, init?: RequestInit) => {
      const reqBody = JSON.parse(String(init?.body ?? "{}"));
      recordedPayloads.push(reqBody);
      callCount += 1;
      if (callCount <= 4) {
        return Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                reasoning_content: `第${callCount}轮推理思考`,
                tool_calls: [
                  {
                    id: `call_round_${callCount}`,
                    type: "function",
                    function: {
                      name: "get_question_detail",
                      arguments: JSON.stringify({ questionId: q1Id }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      // Forced final streamed round (callCount === 5)
      const ssePayload = [
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "最终汇总思考" } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "已整理「什么是浏览器重排与重绘」的考点要点。" }, finish_reason: "stop" }] })}`,
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
        deckId: deck1Id,
        message: "深入梳理浏览器题目细节",
      }),
    );
    assert.equal(res.status, 200);
    const events = await readSse(res);
    assert.equal(events.some((e) => e.event === "done"), true);
    assert.equal(callCount, 5);

    // Round 2 request must preserve assistant.reasoning_content from Round 1
    const round2Messages = recordedPayloads[1].messages as Array<{
      role: string;
      reasoning_content?: string;
    }>;
    assert.equal(
      round2Messages.some(
        (m) =>
          m.role === "assistant" && m.reasoning_content === "第1轮推理思考",
      ),
      true,
    );

    // Forced final round must include tools + tool_choice: "none"
    assert.ok(Array.isArray(recordedPayloads[4].tools));
    assert.equal(recordedPayloads[4].tool_choice, "none");

    // GET /api/chat?scope=deck restores persisted toolSteps, references, and reasoning
    const threadsRes = await chatRoute.GET(
      makeRequest(alice, `/api/chat?scope=deck&deckId=${deck1Id}`),
    );
    assert.equal(threadsRes.status, 200);
    const threads = (await threadsRes.json()) as Conversation[];
    assert.equal(threads.length, 1);
    const assistant = threads[0].messages.find((m) => m.role === "assistant")!;
    assert.ok(assistant.toolSteps?.length === 4);
    assert.equal(assistant.references?.[0]?.deckTitle, "公开目标题单");
    assert.ok(assistant.reasoning?.includes("第1轮推理思考"));
    assert.ok(assistant.reasoning?.includes("最终汇总思考"));
  } finally {
    fetcher.mock.restore();
    resolver.mock.restore();
  }
});

test("ai-proofread applyCorrectionAt reverts the second occurrence of a repeated token without corrupting the first", () => {
  const originalText = "Promise resolved first, then Promsie settled later.";
  const idx = originalText.indexOf("Promsie");
  const applied = applyCorrectionAt(originalText, idx, "Promsie", "Promise");
  assert.equal(applied, "Promise resolved first, then Promise settled later.");
  const reverted = applyCorrectionAt(applied, idx, "Promise", "Promsie");
  assert.equal(reverted, originalText);
});

test("userInitials extracts compact 1-2 character avatar labels consistently", () => {
  assert.equal(userInitials("cq c"), "CC");
  assert.equal(userInitials("  alice   smith  "), "AS");
  assert.equal(userInitials("bob"), "BO");
  assert.equal(userInitials("张三丰"), "张");
  assert.equal(userInitials("   "), "U");
});
