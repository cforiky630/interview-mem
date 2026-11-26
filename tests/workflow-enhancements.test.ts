import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import type { Workspace } from "../src/lib/types";
import {
  buildSearchFromRoute,
  extractSubscribeParam,
  parseRouteFromSearch,
} from "../src/lib/navigation";
import { readChatEdits } from "../src/server/chat-edits";

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
const workspace = await import("../src/app/api/workspace/route");
const decks = await import("../src/app/api/decks/route");
const questions = await import("../src/app/api/questions/route");
const trash = await import("../src/app/api/questions/trash/route");
const settings = await import("../src/app/api/settings/route");
const chat = await import("../src/app/api/chat/route");

type Account = { id: string; cookie: string; deckId: string };
let alice: Account, bob: Account;

function request(account: Account, path: string, body?: unknown) {
  return new Request(`http://localhost:3000${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie: account.cookie,
      origin: "http://localhost:3000",
      "content-type": "application/json",
      "x-workspace-user": account.id,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function state(account: Account): Promise<Workspace> {
  return (await workspace.GET(request(account, "/api/workspace"))).json();
}

async function register(name: string): Promise<Account> {
  const r = await (
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
  assert.equal(r.status, 200);
  const result = await r.json();
  const account: Account = {
    id: result.user.id,
    cookie: r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
    deckId: "",
  };
  account.deckId = (await state(account)).decks[0].id;
  return account;
}

before(async () => {
  alice = await register(`alice-wf-${randomUUID().slice(0, 6)}`);
  bob = await register(`bob-wf-${randomUUID().slice(0, 6)}`);
});

test("navigation: parseRouteFromSearch and buildSearchFromRoute round-trip cleanly", () => {
  assert.equal(buildSearchFromRoute({ view: "today" }), "");
  assert.deepEqual(parseRouteFromSearch(""), { view: "today" });
  assert.deepEqual(parseRouteFromSearch("?view=unknown"), { view: "today" });

  const libSearch = buildSearchFromRoute({ view: "library", deckId: "deck-1" });
  assert.equal(libSearch, "?view=library&deck=deck-1");
  assert.deepEqual(parseRouteFromSearch(libSearch), {
    view: "library",
    deckId: "deck-1",
  });

  const unfiledSearch = buildSearchFromRoute({ view: "library", deckId: null });
  assert.equal(unfiledSearch, "?view=library&deck=unfiled");
  assert.deepEqual(parseRouteFromSearch(unfiledSearch), {
    view: "library",
    deckId: null,
  });

  const qSearch = buildSearchFromRoute({
    view: "question",
    questionId: "q-9",
    originView: "favorites",
  });
  assert.deepEqual(parseRouteFromSearch(qSearch), {
    view: "question",
    questionId: "q-9",
    originView: "favorites",
  });

  assert.deepEqual(parseRouteFromSearch("?view=question"), { view: "library" });
  assert.deepEqual(parseRouteFromSearch("?view=review", true), { view: "review" });
  assert.deepEqual(parseRouteFromSearch("?view=review", false), { view: "review" });

  const groupedSearch = buildSearchFromRoute({
    view: "library",
    deckId: "deck-1",
    groupId: "grp-1",
    category: "字节跳动",
  });
  assert.equal(
    groupedSearch,
    `?view=library&deck=deck-1&group=grp-1&cat=${encodeURIComponent("字节跳动")}`,
  );
  assert.deepEqual(parseRouteFromSearch(groupedSearch), {
    view: "library",
    deckId: "deck-1",
    groupId: "grp-1",
    category: "字节跳动",
  });
  assert.deepEqual(
    parseRouteFromSearch("?view=library&deck=unfiled&group=grp-1&cat=字节跳动"),
    { view: "library", deckId: null },
  );

  assert.equal(extractSubscribeParam("?subscribe=shared-123"), "shared-123");
  assert.equal(parseRouteFromSearch("?view=library&deck=undefined").deckId, undefined);
});

test("decks edit updates color with optimistic lock and stays backward-compatible", async () => {
  const created = await (
    await decks.POST(
      request(alice, "/api/decks", {
        action: "create",
        title: "系统设计",
        description: "初始简介",
        color: "sage",
      }),
    )
  ).json();
  const deckId = created.deck.id as string;

  const updated = await decks.POST(
    request(alice, "/api/decks", {
      action: "edit",
      deckId,
      expected: { title: "系统设计", description: "初始简介", color: "sage" },
      title: "高并发架构",
      description: "更新后的简介",
      color: "blue",
    }),
  );
  assert.equal(updated.status, 200);

  const staleColor = await decks.POST(
    request(alice, "/api/decks", {
      action: "edit",
      deckId,
      expected: { title: "高并发架构", description: "更新后的简介", color: "sage" },
      title: "再次更新",
      description: "更新后的简介",
      color: "rose",
    }),
  );
  assert.equal(staleColor.status, 409);

  // Backward compatible omit-color payload still succeeds.
  const withoutColor = await decks.POST(
    request(alice, "/api/decks", {
      action: "edit",
      deckId,
      expected: { title: "高并发架构", description: "更新后的简介" },
      title: "高并发与稳定性",
      description: "兼容旧客户端",
    }),
  );
  assert.equal(withoutColor.status, 200);

  const foreignEdit = await decks.POST(
    request(bob, "/api/decks", {
      action: "edit",
      deckId,
      expected: { title: "高并发与稳定性", description: "兼容旧客户端", color: "blue" },
      title: "越权修改",
      description: "",
      color: "rose",
    }),
  );
  assert.equal(foreignEdit.status, 404);

  const finalDeck = (await state(alice)).decks.find((d) => d.id === deckId)!;
  assert.equal(finalDeck.title, "高并发与稳定性");
  assert.equal(finalDeck.color, "blue");
});

test("questions create supports single question entry, tag normalization, inbox mode, and ownership checks", async () => {
  const created = await questions.POST(
    request(alice, "/api/questions", {
      action: "create",
      deckId: alice.deckId,
      title: "Redis 持久化 RDB 和 AOF 区别",
      answer: "## 结论\nRDB 紧凑快照，AOF 追加日志。",
      tags: ["#Redis", "持久化", "Redis"],
    }),
  );
  assert.equal(created.status, 200);
  const { id } = await created.json();

  const blankAnswer = await questions.POST(
    request(alice, "/api/questions", {
      action: "create",
      deckId: null,
      title: "手写并发限流器",
      answer: "",
      tags: ["算法"],
    }),
  );
  assert.equal(blankAnswer.status, 200);
  const { id: blankId } = await blankAnswer.json();

  const dup = await questions.POST(
    request(alice, "/api/questions", {
      action: "create",
      deckId: alice.deckId,
      title: "Redis 持久化 RDB 和 AOF 区别",
      answer: "## 结论\nRDB 紧凑快照，AOF 追加日志。",
      tags: ["Redis"],
    }),
  );
  assert.equal(dup.status, 200);
  const dupBody = (await dup.json()) as {
    id: string;
    duplicates?: Array<{ id: string }>;
  };
  assert.notEqual(dupBody.id, id);
  assert.ok(dupBody.duplicates?.some((d) => d.id === id));

  const foreignDeck = await questions.POST(
    request(bob, "/api/questions", {
      action: "create",
      deckId: alice.deckId,
      title: "越权建题",
      answer: "测试",
      tags: [],
    }),
  );
  assert.equal(foreignDeck.status, 404);

  const ws = await state(alice);
  const fullQ = ws.questions.find((q) => q.id === id)!;
  const blankQ = ws.questions.find((q) => q.id === blankId)!;
  assert.deepEqual(fullQ.tags, ["Redis", "持久化"]);
  assert.equal(fullQ.needsEditing, false);
  assert.equal(blankQ.deckId, null);
  assert.equal(blankQ.needsEditing, true);
});

test("questions batch executes move with duplicate skipping, archive/unarchive, delete, and strict owner isolation", async () => {
  const targetDeck = (
    await (
      await decks.POST(
        request(alice, "/api/decks", {
          action: "create",
          title: "目标题库",
          description: "",
          color: "sand",
        }),
      )
    ).json()
  ).deck.id as string;

  const q1 = (
    await (
      await questions.POST(
        request(alice, "/api/questions", {
          action: "create",
          deckId: alice.deckId,
          title: "批量测试一",
          answer: "答案一",
          tags: [],
        }),
      )
    ).json()
  ).id as string;
  const q2 = (
    await (
      await questions.POST(
        request(alice, "/api/questions", {
          action: "create",
          deckId: alice.deckId,
          title: "批量测试二",
          answer: "答案二",
          tags: [],
        }),
      )
    ).json()
  ).id as string;

  // Seed duplicate of q2 inside targetDeck so batch move skips q2 and moves q1 cleanly.
  await questions.POST(
    request(alice, "/api/questions", {
      action: "create",
      deckId: targetDeck,
      title: "批量测试二",
      answer: "答案二",
      tags: [],
    }),
  );

  const bobQ = (
    await (
      await questions.POST(
        request(bob, "/api/questions", {
          action: "create",
          deckId: bob.deckId,
          title: "Bob 私有题",
          answer: "Bob 答案",
          tags: [],
        }),
      )
    ).json()
  ).id as string;

  // Mixed foreign IDs must reject the entire batch cleanly.
  const crossUser = await questions.POST(
    request(alice, "/api/questions", {
      action: "batch",
      ids: [q1, bobQ],
      operation: "archive",
    }),
  );
  assert.equal(crossUser.status, 404);
  assert.equal(
    (await state(alice)).questions.find((q) => q.id === q1)!.archived,
    false,
  );

  // Default batch move checks for duplicates in target folder without silently skipping.
  const conflictRes = await questions.POST(
    request(alice, "/api/questions", {
      action: "batch",
      ids: [q1, q2],
      operation: "move",
      deckId: targetDeck,
    }),
  );
  assert.equal(conflictRes.status, 409);
  const conflictBody = (await conflictRes.json()) as {
    code: string;
    details?: { conflicts?: Array<{ sourceId: string }> };
  };
  assert.equal(conflictBody.code, "DUPLICATE_IN_TARGET");
  assert.equal(conflictBody.details?.conflicts?.[0]?.sourceId, q2);

  // Explicit duplicateStrategy: "skip" moves non-conflicting cards and skips duplicates.
  const moveResult = await (
    await questions.POST(
      request(alice, "/api/questions", {
        action: "batch",
        ids: [q1, q2],
        operation: "move",
        deckId: targetDeck,
        duplicateStrategy: "skip",
      }),
    )
  ).json();
  assert.equal(moveResult.ok, true);
  assert.equal(moveResult.updated, 1);
  assert.equal(moveResult.skipped, 1);
  assert.deepEqual(moveResult.movedIds, [q1]);
  assert.equal(typeof moveResult.updatedAt, "string");

  let ws = await state(alice);
  assert.equal(ws.questions.find((q) => q.id === q1)!.deckId, targetDeck);
  assert.equal(ws.questions.find((q) => q.id === q2)!.deckId, alice.deckId);

  const archiveRes = await questions.POST(
    request(alice, "/api/questions", {
      action: "batch",
      ids: [q1, q2],
      operation: "archive",
    }),
  );
  assert.equal(archiveRes.status, 200);
  ws = await state(alice);
  assert.equal(ws.questions.find((q) => q.id === q1)!.archived, true);
  assert.equal(ws.questions.find((q) => q.id === q2)!.archived, true);

  const unarchiveRes = await questions.POST(
    request(alice, "/api/questions", {
      action: "batch",
      ids: [q1, q2],
      operation: "unarchive",
    }),
  );
  assert.equal(unarchiveRes.status, 200);
  ws = await state(alice);
  assert.equal(ws.questions.find((q) => q.id === q1)!.archived, false);

  const deleteRes = await (
    await questions.POST(
      request(alice, "/api/questions", {
        action: "batch",
        ids: [q1, q2],
        operation: "delete",
      }),
    )
  ).json();
  assert.equal(deleteRes.updated, 2);

  const trashItems = await (
    await trash.GET(request(alice, "/api/questions/trash"))
  ).json();
  const trashedIds = new Set(trashItems.map((t: { id: string }) => t.id));
  assert.ok(trashedIds.has(q1) && trashedIds.has(q2));
});

test("chat accepts optional written attempt for streaming critique and suppresses edit markup", async () => {
  const qRes = await (
    await questions.POST(
      request(alice, "/api/questions", {
        action: "create",
        deckId: alice.deckId,
        title: "HTTP 幂等性与重试安全",
        answer: "GET/PUT/DELETE 语义幂等，POST 非幂等；网络重试需幂等键。",
        tags: ["HTTP"],
      }),
    )
  ).json();
  const questionId = qRes.id as string;

  const dnsMock = mock.method(
    dns,
    "lookup",
    async () => [{ address: "93.184.216.34", family: 4 }],
  );
  let capturedSystemPrompt = "";
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/chat/completions")) {
        const body = JSON.parse(String(init?.body));
        capturedSystemPrompt = body.messages?.[0]?.content ?? "";
        return new Response(
          'data: {"choices":[{"delta":{"content":"答对要点：提到了 PUT 幂等。"}}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(
        JSON.stringify({ data: [{ id: "deepseek-chat" }] }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );
  try {
    const saveAi = await settings.POST(
      request(alice, "/api/settings", {
        action: "saveKey",
        model: "deepseek-chat",
        key: "sk-test-critique-123456",
      }),
    );
    assert.equal(saveAi.status, 200);

    const tooLong = await chat.POST(
      request(alice, "/api/chat", {
        questionId,
        message: "点评",
        attempt: "a".repeat(12_001),
      }),
    );
    assert.equal(tooLong.status, 400);

    const response = await chat.POST(
      request(alice, "/api/chat", {
        questionId,
        message: "请点评我的作答。",
        attempt: "PUT 和 DELETE 是幂等的，POST 不是，重试要带幂等 key。",
      }),
    );
    assert.equal(response.status, 200);
    const streamText = await response.text();
    assert.match(streamText, /答对要点/);
    assert.match(streamText, /event: done/);
    assert.ok(capturedSystemPrompt.includes("<用户默写作答>PUT 和 DELETE 是幂等的"));
    assert.ok(!capturedSystemPrompt.includes("shiyi-edits"));
  } finally {
    fetchMock.mock.restore();
    dnsMock.mock.restore();
  }
});

test("conversations persist attempt into Turn-2 prompt with note edit proposals and version locking", async () => {
  const qRes = await (
    await questions.POST(
      request(alice, "/api/questions", {
        action: "create",
        deckId: alice.deckId,
        title: "MySQL 主从同步延迟怎么排查",
        answer: "检查 Seconds_Behind_Master、并行复制线程、大事务与磁盘 IO。",
        tags: ["MySQL"],
      }),
    )
  ).json();
  const questionId = qRes.id as string;

  const dnsMock = mock.method(
    dns,
    "lookup",
    async () => [{ address: "93.184.216.34", family: 4 }],
  );
  const capturedPrompts: string[] = [];
  let turn = 0;
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/chat/completions")) {
        const payload = JSON.parse(String(init?.body));
        capturedPrompts.push(String(payload.messages?.[0]?.content ?? ""));
        turn += 1;
        const text =
          turn === 1
            ? "答对要点：提到了主从延迟；遗漏点：缺少大事务与并行复制分析。"
            : '<shiyi-edits>{"note":{"note":"补充要点：排查大事务、开启 MTS 并行复制。"}}</shiyi-edits>';
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(
        JSON.stringify({ data: [{ id: "deepseek-chat" }] }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  try {
    const turn1 = await chat.POST(
      request(alice, "/api/chat", {
        questionId,
        message: "请点评我的默写作答。",
        attempt: "我会先看主从状态，但具体参数记不清了。",
      }),
    );
    assert.equal(turn1.status, 200);
    const turn1Stream = await turn1.text();
    const metaMatch = turn1Stream.match(
      /event: meta\ndata: (\{[^\n]+\})/,
    );
    assert.ok(metaMatch, "expected meta SSE event");
    const { conversationId } = JSON.parse(metaMatch[1]) as {
      conversationId: string;
    };
    assert.ok(!capturedPrompts[0].includes("shiyi-edits"));

    const afterTurn1 = await (
      await chat.GET(request(alice, `/api/chat?questionId=${questionId}`))
    ).json();
    assert.equal(afterTurn1.length, 1);
    assert.equal(
      afterTurn1[0].attempt,
      "我会先看主从状态，但具体参数记不清了。",
    );

    const turn2 = await chat.POST(
      request(alice, "/api/chat", {
        questionId,
        conversationId,
        message: "把刚才漏掉的点写进我的个人笔记。",
      }),
    );
    assert.equal(turn2.status, 200);
    await turn2.text();

    assert.ok(
      capturedPrompts[1].includes(
        "<用户默写作答>我会先看主从状态，但具体参数记不清了。</用户默写作答>",
      ),
    );
    assert.ok(capturedPrompts[1].includes("<shiyi-edits>"));
    assert.ok(capturedPrompts[1].includes('"note"'));

    const afterTurn2 = await (
      await chat.GET(request(alice, `/api/chat?questionId=${questionId}`))
    ).json();
    const lastMessage = afterTurn2[0].messages.at(-1);
    assert.equal(lastMessage.edits?.length, 1);
    assert.deepEqual(lastMessage.edits[0], {
      target: "note",
      id: questionId,
      expectedVersion: 0,
      fields: { note: "补充要点：排查大事务、开启 MTS 并行复制。" },
    });

    const applyOk = await questions.POST(
      request(alice, "/api/questions", {
        action: "note",
        id: questionId,
        note: lastMessage.edits[0].fields.note,
        expectedVersion: lastMessage.edits[0].expectedVersion,
      }),
    );
    assert.equal(applyOk.status, 200);
    assert.equal((await applyOk.json()).version, 1);

    const applyStale = await questions.POST(
      request(alice, "/api/questions", {
        action: "note",
        id: questionId,
        note: "overwrite attempt",
        expectedVersion: 0,
      }),
    );
    assert.equal(applyStale.status, 409);

    const baseCtx = {
      question: {
        id: questionId,
        title: "t",
        answer: "a",
        tags: [],
        revision: 1,
      },
      note: { content: "same", version: 2 },
    };
    assert.deepEqual(
      readChatEdits('<shiyi-edits>{"note":{"note":"same"}}</shiyi-edits>', baseCtx),
      [],
    );
    assert.equal(
      readChatEdits('<shiyi-edits>{"note":{"note":"next"}}</shiyi-edits>', {
        question: baseCtx.question,
      }),
      null,
    );
    assert.equal(
      readChatEdits('<shiyi-edits>{"note":{"note":"next"}}</shiyi-edits>', {
        question: baseCtx.question,
        note: { content: "x".repeat(30_001), version: 1 },
      }),
      null,
    );
  } finally {
    fetchMock.mock.restore();
    dnsMock.mock.restore();
  }
});

test("workspace.questions places newly created and batch-imported questions at the end across multiple decks", async () => {
  const importRoute = await import("../src/app/api/import/route");

  // Ensure alice has two decks: default first deck + a newer second deck
  const secondDeckRes = await decks.POST(
    request(alice, "/api/decks", {
      action: "create",
      title: "第二题库",
      description: "测试排序",
      color: "sand",
    }),
  );
  assert.equal(secondDeckRes.status, 200);
  const { id: secondDeckId } = (await secondDeckRes.json()) as { id: string };

  const inSecond = await questions.POST(
    request(alice, "/api/questions", {
      action: "create",
      deckId: secondDeckId,
      title: "第二题库先创建的问题",
      answer: "答案 A",
      tags: [],
    }),
  );
  assert.equal(inSecond.status, 200);
  const { id: secondDeckQId } = (await inSecond.json()) as { id: string };

  // Create a new question inside alice's FIRST deck: must still land at the END of workspace.questions
  const inFirstLater = await questions.POST(
    request(alice, "/api/questions", {
      action: "create",
      deckId: alice.deckId,
      title: "第一题库后追加的问题",
      answer: "答案 B",
      tags: [],
    }),
  );
  assert.equal(inFirstLater.status, 200);
  const { id: appendedFirstDeckQId } = (await inFirstLater.json()) as { id: string };

  const afterCreate = await state(alice);
  assert.equal(afterCreate.questions.at(-1)?.id, appendedFirstDeckQId);
  const secondIdx = afterCreate.questions.findIndex((q) => q.id === secondDeckQId);
  const firstLaterIdx = afterCreate.questions.findIndex((q) => q.id === appendedFirstDeckQId);
  assert.ok(secondIdx >= 0 && firstLaterIdx > secondIdx);

  // Batch import multiple questions: must preserve input order and sit strictly at the END
  const importRes = await importRoute.POST(
    request(alice, "/api/import", {
      batchId: randomUUID(),
      deckId: alice.deckId,
      inputType: "questions",
      mode: "rules",
      raw: "批量题一：什么是MVCC？\n批量题二：什么是WAL？\n批量题三：什么是B+树？",
    }),
  );
  assert.equal(importRes.status, 200);

  const afterImport = await state(alice);
  const tailTitles = afterImport.questions.slice(-3).map((q) => q.title);
  assert.deepEqual(tailTitles, [
    "批量题一：什么是MVCC？",
    "批量题二：什么是WAL？",
    "批量题三：什么是B+树？",
  ]);
});

after(async () => {
  const globalState = globalThis as unknown as {
    interviewDatabase?: Promise<{ close: () => Promise<void> }>;
  };
  await (await globalState.interviewDatabase)?.close();
});
