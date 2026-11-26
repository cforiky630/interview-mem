import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../src/db/schema";
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

const { getDb } = await import("../src/db");
const { getAuth } = await import("../src/server/auth");
const { createUuid } = await import("../src/lib/utils");
const { buildReviewQueue, isQuestionDue } = await import(
  "../src/lib/review-queue"
);
const { cleanupOrphanedImportPreviews } = await import(
  "../src/server/question-lifecycle"
);
const workspaceRoute = await import("../src/app/api/workspace/route");
const decksRoute = await import("../src/app/api/decks/route");
const questionsRoute = await import("../src/app/api/questions/route");
const reviewsRoute = await import("../src/app/api/reviews/route");
const previewRoute = await import("../src/app/api/import/preview/route");
const commitRoute = await import("../src/app/api/import/commit/route");
const questionSourceRoute = await import("../src/app/api/questions/source/route");
const exportRoute = await import("../src/app/api/export/route");
const restoreRoute = await import("../src/app/api/backup/restore/route");
const settingsRoute = await import("../src/app/api/settings/route");
const chatRoute = await import("../src/app/api/chat/route");
const { executeWorkspaceTool } = await import("../src/server/ai-tools");

type Account = { id: string; cookie: string; deckId: string };
let alice: Account;
let bob: Account;
let charlie: Account;
let ipCounter = 10;

function req(
  account: Account | null,
  urlPath: string,
  body?: unknown,
  method?: string,
  extraHeaders: Record<string, string> = {},
) {
  return new Request(`http://localhost:3000${urlPath}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      origin: "http://localhost:3000",
      ...(account
        ? { cookie: account.cookie, "x-workspace-user": account.id }
        : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...extraHeaders,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function getWs(account: Account): Promise<Workspace> {
  const res = await workspaceRoute.GET(req(account, "/api/workspace"));
  assert.equal(res.status, 200);
  return res.json();
}

async function register(name: string): Promise<Account> {
  const res = await (
    await getAuth()
  ).handler(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
        "x-forwarded-for": `198.51.105.${++ipCounter}`,
      },
      body: JSON.stringify({
        name,
        email: `${name}@audit.test`,
        password: randomUUID(),
      }),
    }),
  );
  assert.equal(res.status, 200);
  const json = await res.json();
  const account: Account = {
    id: json.user.id,
    cookie: res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
    deckId: "",
  };
  account.deckId = (await getWs(account)).decks[0].id;
  return account;
}

before(async () => {
  alice = await register("alice");
  bob = await register("bob");
  charlie = await register("charlie");
});

after(() => {
  mock.restoreAll();
});

test("Fix #1: createUuid produces valid RFC4122 v4 UUIDs even when crypto.randomUUID is unavailable", () => {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const normal = createUuid();
  assert.match(normal, uuidRegex);

  const original = globalThis.crypto.randomUUID;
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: undefined,
    configurable: true,
  });
  try {
    const fallback1 = createUuid();
    const fallback2 = createUuid();
    assert.match(fallback1, uuidRegex);
    assert.match(fallback2, uuidRegex);
    assert.notEqual(fallback1, fallback2);
  } finally {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: original,
      configurable: true,
    });
  }
});

test("Fix #2: subscriber single-question AI chat uses pinned release deck title and never leaks unpublished draft deck title", async () => {
  const createDeckRes = await decksRoute.POST(
    req(alice, "/api/decks", {
      action: "create",
      title: "公开版本标题 A",
      description: "已发布描述",
    }),
  );
  assert.equal(createDeckRes.status, 200);
  const {
    deck: { id: deckId },
  } = (await createDeckRes.json()) as { deck: { id: string } };

  const addQRes = await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "create",
      deckId,
      title: "什么是缓存雪崩？",
      answer: "大量 key 同时过期导致数据库压力骤增。",
      tags: ["Redis"],
    }),
  );
  assert.equal(addQRes.status, 200);
  const { id: qId } = (await addQRes.json()) as { id: string };

  const pubRes = await decksRoute.POST(
    req(alice, "/api/decks", {
      action: "publish",
      deckId,
      expectedVersion: 0,
      visibility: "public",
      summary: "v1",
    }),
  );
  assert.equal(pubRes.status, 200);

  // Bob subscribes to v1 ("公开版本标题 A")
  const subRes = await decksRoute.POST(
    req(bob, "/api/decks", { action: "subscribe", deckId }),
  );
  assert.equal(subRes.status, 200);

  // Alice renames her draft deck without publishing
  const renameRes = await decksRoute.POST(
    req(alice, "/api/decks", {
      action: "edit",
      deckId,
      expected: { title: "公开版本标题 A", description: "已发布描述" },
      title: "绝密未发布草稿标题 B",
      description: "草稿描述",
    }),
  );
  assert.equal(renameRes.status, 200);

  // Bob configures an AI endpoint and initiates single-question chat
  const setModelRes = await settingsRoute.POST(
    req(bob, "/api/settings", {
      action: "saveKey",
      baseUrl: "https://llm.audit.example/v1",
      model: "audit-chat-model",
      key: "sk-audit-key-12345678",
    }),
  );
  assert.equal(setModelRes.status, 200);

  const resolver = mock.method(dns, "lookup", async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  const capturedSystemPrompts: string[] = [];
  const fetcher = mock.method(
    globalThis,
    "fetch",
    async (_url: URL | string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      const sys = payload.messages.find((m) => m.role === "system")?.content ?? "";
      capturedSystemPrompts.push(sys);
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "好的，我来解释。" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  );

  try {
    const chatRes = await chatRoute.POST(
      req(bob, "/api/chat", {
        scope: "question",
        questionId: qId,
        message: "请解释一下",
      }),
    );
    assert.equal(chatRes.status, 200);
    await chatRes.text();
    assert.equal(capturedSystemPrompts.length, 1);
    assert.ok(capturedSystemPrompts[0].includes("公开版本标题 A"));
    assert.ok(!capturedSystemPrompts[0].includes("绝密未发布草稿标题 B"));
  } finally {
    resolver.mock.restore();
    fetcher.mock.restore();
  }
});

test("Fix #3, #5, #6: unified due count with major revisions, review snapshots across renames, local review payload, and ETag/304", async () => {
  // Fresh migration check for 0014
  const fresh = new PGlite();
  await migrate(drizzle(fresh, { schema }), {
    migrationsFolder: path.resolve("drizzle"),
  });
  const cols = await fresh.query<{ column_name: string }>(
    `select column_name from information_schema.columns where table_name = 'review_events'`,
  );
  assert.ok(cols.rows.some((r) => r.column_name === "question_title"));
  assert.ok(cols.rows.some((r) => r.column_name === "question_answer"));
  await fresh.close();

  const createQ = await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "create",
      deckId: alice.deckId,
      title: "缓存穿透是什么？",
      answer: "查询不存在的数据绕过缓存。",
      tags: ["Redis"],
    }),
  );
  assert.equal(createQ.status, 200);
  const { id: qId } = (await createQ.json()) as { id: string };

  // Review once with rating=4 ("Easy" -> due days in the future)
  const evId = randomUUID();
  const revRes = await reviewsRoute.POST(
    req(alice, "/api/reviews", {
      questionId: qId,
      eventId: evId,
      expectedVersion: 0,
      questionRevision: 1,
      rating: 4,
      answer: "我当时的回答：布隆过滤器",
    }),
  );
  assert.equal(revRes.status, 200);
  const revBody = (await revRes.json()) as {
    studyVersion: number;
    reviewedRevision: number;
    isFirstLearn: boolean;
    questionTitle: string;
    questionAnswer: string;
    questionRevision: number;
  };
  assert.equal(revBody.studyVersion, 1);
  assert.equal(revBody.reviewedRevision, 1);
  assert.equal(revBody.isFirstLearn, true);
  assert.equal(revBody.questionTitle, "缓存穿透是什么？");
  assert.equal(revBody.questionAnswer, "查询不存在的数据绕过缓存。");

  // ETag + 304 check
  const wsRes1 = await workspaceRoute.GET(req(alice, "/api/workspace"));
  assert.equal(wsRes1.status, 200);
  const etag1 = wsRes1.headers.get("etag");
  assert.ok(etag1);
  const ws304 = await workspaceRoute.GET(
    req(alice, "/api/workspace", undefined, "GET", { "If-None-Match": etag1 }),
  );
  assert.equal(ws304.status, 304);

  // Alice performs a major revision and renames the title
  const editRes = await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "edit",
      id: qId,
      expectedRevision: 1,
      title: "缓存击穿是什么？",
      answer: "热点 key 过期瞬间大量并发请求打穿到数据库。",
      tags: ["Redis"],
      major: true,
    }),
  );
  assert.equal(editRes.status, 200);
  const editBody = (await editRes.json()) as {
    revision: number;
    majorRevision: number;
  };
  assert.equal(editBody.revision, 2);
  assert.equal(editBody.majorRevision, 2);

  // Workspace ETag must change and return 200, NOT 304
  const wsRes2 = await workspaceRoute.GET(
    req(alice, "/api/workspace", undefined, "GET", { "If-None-Match": etag1 }),
  );
  assert.equal(wsRes2.status, 200);
  const etag2 = wsRes2.headers.get("etag");
  assert.ok(etag2 && etag2 !== etag1);
  const ws2 = (await wsRes2.json()) as Workspace;

  // Fix #3: major revision card must appear in stats.due, deck.due, and buildReviewQueue
  const aliceDeck = ws2.decks.find((d) => d.id === alice.deckId)!;
  assert.ok(aliceDeck.due >= 1);
  assert.ok(ws2.stats.due >= 1);
  const targetView = ws2.questions.find((q) => q.id === qId)!;
  assert.equal(isQuestionDue(targetView), true);
  const built = buildReviewQueue(ws2.questions, {
    dailyNewLimit: ws2.settings.dailyNewLimit,
    newLearnedToday: ws2.stats.newLearnedToday,
  });
  assert.ok(built.queue.some((q) => q.id === qId));

  // Fix #6: recentReviews retains historical title & reference answer snapshot despite rename
  const pastReview = ws2.recentReviews.find((r) => r.id === evId)!;
  assert.equal(pastReview.title, "缓存穿透是什么？");
  assert.equal(pastReview.questionAnswer, "查询不存在的数据绕过缓存。");
  assert.equal(pastReview.answer, "我当时的回答：布隆过滤器");
});

test("Fix #4: DELETE /api/import/preview removes uncommitted previews and TTL cleanup purges expired orphan imports", async () => {
  const db = await getDb();
  const draftBatchId = randomUUID();
  const committedBatchId = randomUUID();

  // Create uncommitted preview
  const p1 = await previewRoute.POST(
    req(alice, "/api/import/preview", {
      batchId: draftBatchId,
      deckId: alice.deckId,
      inputType: "qa",
      method: "rules",
      raw: "# 绝密草稿题目\n\n不能留在服务器上的内容",
    }),
  );
  assert.equal(p1.status, 200);

  // Create committed preview
  const p2 = await previewRoute.POST(
    req(alice, "/api/import/preview", {
      batchId: committedBatchId,
      deckId: alice.deckId,
      inputType: "qa",
      method: "rules",
      raw: "# 正式入库题目\n\n正式入库答案",
    }),
  );
  assert.equal(p2.status, 200);
  const p2Json = (await p2.json()) as {
    questions: Array<{ key: string; title: string; answer: string; tags: string[] }>;
  };
  const c2 = await commitRoute.POST(
    req(alice, "/api/import/commit", {
      batchId: committedBatchId,
      questions: p2Json.questions,
    }),
  );
  assert.equal(c2.status, 200);

  // Delete both via DELETE /api/import/preview: only uncommitted draftBatchId should be deleted
  const delRes = await previewRoute.DELETE(
    req(
      alice,
      "/api/import/preview",
      { batchIds: [draftBatchId, committedBatchId] },
      "DELETE",
    ),
  );
  assert.equal(delRes.status, 200);
  assert.deepEqual(await delRes.json(), { deleted: 1 });

  const remainingDraft = await db
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.id, draftBatchId));
  assert.equal(remainingDraft.length, 0);

  const remainingCommitted = await db
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.id, committedBatchId));
  assert.equal(remainingCommitted.length, 1);

  // Test expired orphan cleanup (>24h old failed/draft import)
  const expiredOrphanId = randomUUID();
  await db.insert(schema.imports).values({
    id: expiredOrphanId,
    userId: alice.id,
    deckId: alice.deckId,
    raw: "过期未入库内容",
    status: "failed",
    createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
  });
  const swept = await cleanupOrphanedImportPreviews({ userId: alice.id });
  assert.ok(swept >= 1);
  const afterSweepOrphan = await db
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.id, expiredOrphanId));
  assert.equal(afterSweepOrphan.length, 0);
});

test("Fix #7: concurrent subscription applyUpdate never regresses seenVersion", async () => {
  const createRes = await decksRoute.POST(
    req(alice, "/api/decks", { action: "create", title: "并发版本题库" }),
  );
  assert.equal(createRes.status, 200);
  const {
    deck: { id: deckId },
  } = (await createRes.json()) as { deck: { id: string } };
  await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "create",
      deckId,
      title: "并发题 v1",
      answer: "答案 v1",
    }),
  );
  const p1 = await decksRoute.POST(
    req(alice, "/api/decks", {
      action: "publish",
      deckId,
      expectedVersion: 0,
      visibility: "public",
      summary: "v1",
    }),
  );
  assert.equal(p1.status, 200);
  const sub = await decksRoute.POST(
    req(bob, "/api/decks", { action: "subscribe", deckId }),
  );
  assert.equal(sub.status, 200);

  // Publish v2 and v3
  await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "create",
      deckId,
      title: "并发题 v2",
      answer: "答案 v2",
    }),
  );
  const p2 = await decksRoute.POST(
    req(alice, "/api/decks", {
      action: "publish",
      deckId,
      expectedVersion: 1,
      visibility: "public",
      summary: "v2",
    }),
  );
  assert.equal(p2.status, 200);
  await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "create",
      deckId,
      title: "并发题 v3",
      answer: "答案 v3",
    }),
  );
  const p3 = await decksRoute.POST(
    req(alice, "/api/decks", {
      action: "publish",
      deckId,
      expectedVersion: 2,
      visibility: "public",
      summary: "v3",
    }),
  );
  assert.equal(p3.status, 200);

  // Simulate two devices concurrently updating from v1 -> v2 and v1 -> v3
  const [r2, r3] = await Promise.all([
    decksRoute.POST(
      req(bob, "/api/decks", {
        action: "applyUpdate",
        deckId,
        targetVersion: 2,
      }),
    ),
    decksRoute.POST(
      req(bob, "/api/decks", {
        action: "applyUpdate",
        deckId,
        targetVersion: 3,
      }),
    ),
  ]);
  assert.ok(r2.status === 200 || r2.status === 400);
  assert.equal(r3.status, 200);

  // Even a subsequent lagging v2 applyUpdate must NOT regress seenVersion below 3
  const lagging = await decksRoute.POST(
    req(bob, "/api/decks", {
      action: "applyUpdate",
      deckId,
      targetVersion: 2,
    }),
  );
  // Either rejected with 400 ("版本号无效") or monotonic at 3
  if (lagging.status === 200) {
    const body = (await lagging.json()) as { syncedVersion: number };
    assert.equal(body.syncedVersion, 3);
  }
  const wsBob = await getWs(bob);
  const subDeck = wsBob.decks.find((d) => d.id === deckId)!;
  assert.equal(subDeck.seenVersion, 3);
});

test("Fix #8: JSON backup v3 exports complete data without secrets and merge-restores idempotently across accounts", async () => {
  const exportRes = await exportRoute.GET(req(alice, "/api/export"));
  assert.equal(exportRes.status, 200);
  const backup = (await exportRes.json()) as Record<string, unknown> & {
    format: string;
    version: number;
    preferences: { dailyGoal: number; dailyNewLimit: number };
    decks: Array<{ id: string; parentId?: string | null; title: string }>;
    releases: unknown[];
    questions: Array<{ id: string; title: string }>;
    reviews: Array<{ id: string }>;
  };

  assert.equal(backup.format, "shiyi-backup");
  assert.equal(backup.version, 3);
  assert.ok(backup.preferences && typeof backup.preferences.dailyGoal === "number");
  assert.ok(Array.isArray(backup.releases));
  assert.ok(backup.releases.length >= 1);
  assert.ok(!JSON.stringify(backup).includes("sk-audit-key"));

  // Charlie (a brand new user) restores Alice's backup via merge restore
  const restore1 = await restoreRoute.POST(
    req(charlie, "/api/backup/restore", backup),
  );
  assert.equal(restore1.status, 200);
  const r1Json = (await restore1.json()) as {
    ok: boolean;
    restored: {
      decks: number;
      questions: number;
      releases: number;
      reviews: number;
    };
  };
  assert.equal(r1Json.ok, true);
  assert.ok(r1Json.restored.decks >= 1);
  assert.ok(r1Json.restored.questions >= 1);
  assert.ok(r1Json.restored.reviews >= 1);

  const charlieWs = await getWs(charlie);
  assert.ok(
    charlieWs.questions.some((q) => q.title === "缓存击穿是什么？"),
  );
  assert.ok(
    charlieWs.recentReviews.some((r) => r.title === "缓存穿透是什么？"),
  );

  // Second merge restore must be idempotent (0 duplicates / preserves existing data)
  const restore2 = await restoreRoute.POST(
    req(charlie, "/api/backup/restore", backup),
  );
  assert.equal(restore2.status, 200);
  const r2Json = (await restore2.json()) as {
    restored: { decks: number; questions: number; reviews: number };
  };
  assert.equal(r2Json.restored.decks, 0);
  assert.equal(r2Json.restored.questions, 0);
  assert.equal(r2Json.restored.reviews, 0);

  // Alice's original data remains completely untouched despite ID collisions during Charlie's restore
  const aliceWs = await getWs(alice);
  assert.ok(aliceWs.questions.some((q) => q.title === "缓存击穿是什么？"));
});

test("Round2 #1: cross-deck published alias question survives backup + restore and can be reviewed by new subscriber", async () => {
  const author1 = await register("cross_author1");
  const author2 = await register("cross_author2");
  const subUser = await register("cross_sub");

  const dARes = await decksRoute.POST(
    req(author1, "/api/decks", { action: "create", title: "原题库 A" }),
  );
  assert.equal(dARes.status, 200);
  const deckA = ((await dARes.json()) as { deck: { id: string } }).deck.id;

  const dBRes = await decksRoute.POST(
    req(author1, "/api/decks", { action: "create", title: "新题库 B" }),
  );
  assert.equal(dBRes.status, 200);
  const deckB = ((await dBRes.json()) as { deck: { id: string } }).deck.id;

  const qRes = await questionsRoute.POST(
    req(author1, "/api/questions", {
      action: "create",
      deckId: deckA,
      title: "跨库发布与迁移测试题",
      answer: "在 B 库应以独立发布 ID 出现并可正常复习。",
    }),
  );
  assert.equal(qRes.status, 200);
  const qId = ((await qRes.json()) as { id: string }).id;

  const pubA = await decksRoute.POST(
    req(author1, "/api/decks", {
      action: "publish",
      deckId: deckA,
      expectedVersion: 0,
      visibility: "public",
      summary: "A v1",
    }),
  );
  assert.equal(pubA.status, 200);

  const mv = await questionsRoute.POST(
    req(author1, "/api/questions", {
      action: "move",
      id: qId,
      deckId: deckB,
    }),
  );
  assert.equal(mv.status, 200);

  const pubB = await decksRoute.POST(
    req(author1, "/api/decks", {
      action: "publish",
      deckId: deckB,
      expectedVersion: 0,
      visibility: "public",
      summary: "B v1",
    }),
  );
  assert.equal(pubB.status, 200);

  const exportRes = await exportRoute.GET(req(author1, "/api/export"));
  assert.equal(exportRes.status, 200);
  const backup = (await exportRes.json()) as {
    decks: Array<{ id: string; title: string }>;
    releases: Array<{
      deckId: string;
      questions: Array<{ id: string; sourceQuestionId?: string }>;
    }>;
  };
  const relB = backup.releases.find((r) => r.deckId === deckB)!;
  assert.ok(relB);
  const aliasId = relB.questions[0].id;
  assert.notEqual(aliasId, qId);
  assert.equal(relB.questions[0].sourceQuestionId, qId);

  // Restore into author2 (collision remap generates fresh alias ID not yet in questions table)
  const restoreRes = await restoreRoute.POST(
    req(author2, "/api/backup/restore", backup),
  );
  assert.equal(restoreRes.status, 200);

  const author2Ws = await getWs(author2);
  const restoredDeckB = author2Ws.decks.find((d) => d.title === "新题库 B")!;
  assert.ok(restoredDeckB);

  // New subscriber subscribes to author2's restored Deck B and reviews the migrated alias question
  const subRes = await decksRoute.POST(
    req(subUser, "/api/decks", { action: "subscribe", deckId: restoredDeckB.id }),
  );
  assert.equal(subRes.status, 200);
  const subWs = await getWs(subUser);
  const subQ = subWs.questions.find((q) => q.deckId === restoredDeckB.id)!;
  assert.ok(subQ);
  assert.notEqual(subQ.id, aliasId);

  const insightRes = await reviewsRoute.GET(
    req(subUser, `/api/reviews?questionId=${subQ.id}`),
  );
  assert.equal(insightRes.status, 200);

  const gradeRes = await reviewsRoute.POST(
    req(subUser, "/api/reviews", {
      questionId: subQ.id,
      eventId: randomUUID(),
      expectedVersion: 0,
      questionRevision: subQ.revision,
      rating: 3,
      answer: "订阅者作答",
    }),
  );
  assert.equal(gradeRes.status, 200);

  // Also test fresh uncollided release alias restoration (empty-DB simulation)
  const freshOwner = await register("cross_author3");
  const freshSub = await register("cross_sub3");
  const freshDeckBId = randomUUID();
  const freshQId = randomUUID();
  const freshAliasId = randomUUID();
  const remappedBackup = {
    ...backup,
    decks: backup.decks
      .filter((d) => d.id === deckB)
      .map((d) => ({ ...d, id: freshDeckBId })),
    questions: [
      {
        id: freshQId,
        deckId: freshDeckBId,
        groupId: null,
        title: "空库迁移跨库发布题",
        answer: "直接重建 aliasId",
        tags: [],
        revision: 1,
        majorRevision: 0,
        needsEditing: false,
        archived: false,
        isOwner: true,
      },
    ],
    releases: [
      {
        ...relB,
        deckId: freshDeckBId,
        questions: [
          {
            ...relB.questions[0],
            id: freshAliasId,
            sourceQuestionId: freshQId,
            deckId: freshDeckBId,
          },
        ],
      },
    ],
    deckGroups: [],
    trash: [],
    personalStudyState: [],
    reviews: [],
    imports: [],
    conversations: [],
  };
  const emptyRestore = await restoreRoute.POST(
    req(freshOwner, "/api/backup/restore", remappedBackup),
  );
  assert.equal(emptyRestore.status, 200);
  const db = await getDb();
  const [aliasRow] = await db
    .select()
    .from(schema.questions)
    .where(eq(schema.questions.id, freshAliasId));
  assert.ok(aliasRow && aliasRow.ownerId === freshOwner.id);

  assert.equal(
    (
      await decksRoute.POST(
        req(freshSub, "/api/decks", { action: "subscribe", deckId: freshDeckBId }),
      )
    ).status,
    200,
  );
  const freshInsight = await reviewsRoute.GET(
    req(freshSub, `/api/reviews?questionId=${freshAliasId}`),
  );
  assert.equal(freshInsight.status, 200);
});

test("Round2 #2: JSON backup and restore preserve importId, full multi-question Markdown, and sourceName", async () => {
  const srcUser = await register("src_import_user");
  const dstUser = await register("dst_import_user");
  const batchId = randomUUID();
  const fullMarkdown = [
    "# 导入原文测试题一",
    "",
    "第一题完整参考答案。",
    "",
    "# 导入原文测试题二",
    "",
    "第二题完整参考答案。",
  ].join("\n");

  const prevRes = await previewRoute.POST(
    req(srcUser, "/api/import/preview", {
      batchId,
      deckId: srcUser.deckId,
      inputType: "qa",
      method: "rules",
      raw: fullMarkdown,
      sourceName: "面试复盘/redis-notes.md",
    }),
  );
  assert.equal(prevRes.status, 200);
  const prevJson = (await prevRes.json()) as {
    questions: Array<{ key: string; title: string; answer: string; tags: string[] }>;
  };
  assert.equal(prevJson.questions.length, 2);

  const commitRes = await commitRoute.POST(
    req(srcUser, "/api/import/commit", {
      batchId,
      questions: prevJson.questions,
    }),
  );
  assert.equal(commitRes.status, 200);

  const exportRes = await exportRoute.GET(req(srcUser, "/api/export"));
  assert.equal(exportRes.status, 200);
  const backup = (await exportRes.json()) as {
    questions: Array<{ id: string; title: string; importId?: string | null }>;
  };
  const exportedQ1 = backup.questions.find(
    (q) => q.title === "导入原文测试题一",
  )!;
  assert.equal(exportedQ1.importId, batchId);

  const restoreRes = await restoreRoute.POST(
    req(dstUser, "/api/backup/restore", backup),
  );
  assert.equal(restoreRes.status, 200);

  const dstWs = await getWs(dstUser);
  const restoredQ1 = dstWs.questions.find(
    (q) => q.title === "导入原文测试题一",
  )!;
  assert.ok(restoredQ1);

  const sourceRes = await questionSourceRoute.GET(
    req(dstUser, `/api/questions/source?questionId=${restoredQ1.id}`),
  );
  assert.equal(sourceRes.status, 200);
  const sourceJson = (await sourceRes.json()) as {
    raw: string;
    name?: string;
  };
  assert.equal(sourceJson.raw, fullMarkdown);
  assert.equal(sourceJson.name, "面试复盘/redis-notes.md");
});

test("Round2 #3: DELETE /api/import/preview accepts >20 batches aligned with 50-file import limit", async () => {
  const sources = Array.from({ length: 25 }, (_, i) => ({
    batchId: randomUUID(),
    raw: `# 批量文件 ${i + 1}\n\n正文内容 ${i + 1}`,
    sourceName: `batch-${i + 1}.md`,
  }));
  const prevRes = await previewRoute.POST(
    req(alice, "/api/import/preview", {
      deckId: alice.deckId,
      inputType: "qa",
      method: "rules",
      sources,
    }),
  );
  assert.equal(prevRes.status, 200);

  const batchIds = sources.map((s) => s.batchId);
  const delRes = await previewRoute.DELETE(
    req(alice, "/api/import/preview", { batchIds }, "DELETE"),
  );
  assert.equal(delRes.status, 200);
  assert.deepEqual(await delRes.json(), { deleted: 25 });
});

test("Round2 #4: swapping favorite from A to B with same count invalidates workspace ETag", async () => {
  const favUser = await register("fav_etag_user");
  const q1 = (
    (await (
      await questionsRoute.POST(
        req(favUser, "/api/questions", {
          action: "create",
          deckId: favUser.deckId,
          title: "收藏切换题 A",
          answer: "答案 A",
        }),
      )
    ).json()) as { id: string }
  ).id;
  const q2 = (
    (await (
      await questionsRoute.POST(
        req(favUser, "/api/questions", {
          action: "create",
          deckId: favUser.deckId,
          title: "收藏切换题 B",
          answer: "答案 B",
        }),
      )
    ).json()) as { id: string }
  ).id;

  assert.equal(
    (
      await questionsRoute.POST(
        req(favUser, "/api/questions", {
          action: "favorite",
          id: q1,
          favorite: true,
        }),
      )
    ).status,
    200,
  );
  const ws1Res = await workspaceRoute.GET(req(favUser, "/api/workspace"));
  const etag1 = ws1Res.headers.get("etag");
  assert.ok(etag1);

  await questionsRoute.POST(
    req(favUser, "/api/questions", {
      action: "favorite",
      id: q1,
      favorite: false,
    }),
  );
  await questionsRoute.POST(
    req(favUser, "/api/questions", {
      action: "favorite",
      id: q2,
      favorite: true,
    }),
  );

  const ws2Res = await workspaceRoute.GET(
    req(favUser, "/api/workspace", undefined, "GET", { "If-None-Match": etag1 }),
  );
  assert.equal(ws2Res.status, 200);
  assert.notEqual(ws2Res.headers.get("etag"), etag1);
  const ws2 = (await ws2Res.json()) as Workspace;
  assert.equal(ws2.questions.find((q) => q.id === q1)?.favorite, false);
  assert.equal(ws2.questions.find((q) => q.id === q2)?.favorite, true);
});

test("Round2 #5: replaying an earlier review event returns consistent current FSRS card and version", async () => {
  const retryUser = await register("review_retry_user");
  const qId = (
    (await (
      await questionsRoute.POST(
        req(retryUser, "/api/questions", {
          action: "create",
          deckId: retryUser.deckId,
          title: "幂等重放一致性题",
          answer: "答案",
        }),
      )
    ).json()) as { id: string }
  ).id;

  const ev1 = randomUUID();
  const r1 = await reviewsRoute.POST(
    req(retryUser, "/api/reviews", {
      questionId: qId,
      eventId: ev1,
      expectedVersion: 0,
      questionRevision: 1,
      rating: 3,
      answer: "作答一",
    }),
  );
  assert.equal(r1.status, 200);
  const b1 = (await r1.json()) as {
    studyVersion: number;
    card: { reps: number };
  };
  assert.equal(b1.studyVersion, 1);
  assert.equal(b1.card.reps, 1);

  const ev2 = randomUUID();
  const r2 = await reviewsRoute.POST(
    req(retryUser, "/api/reviews", {
      questionId: qId,
      eventId: ev2,
      expectedVersion: 1,
      questionRevision: 1,
      rating: 4,
      answer: "作答二",
    }),
  );
  assert.equal(r2.status, 200);
  const b2 = (await r2.json()) as {
    studyVersion: number;
    card: { reps: number; due: string };
  };
  assert.equal(b2.studyVersion, 2);
  assert.equal(b2.card.reps, 2);

  // Replay older event ev1: card must match current studyVersion=2 state
  const replayRes = await reviewsRoute.POST(
    req(retryUser, "/api/reviews", {
      questionId: qId,
      eventId: ev1,
      expectedVersion: 0,
      questionRevision: 1,
      rating: 3,
      answer: "作答一",
    }),
  );
  assert.equal(replayRes.status, 200);
  const replayBody = (await replayRes.json()) as {
    duplicate: boolean;
    studyVersion: number;
    card: { reps: number; due: string };
  };
  assert.equal(replayBody.duplicate, true);
  assert.equal(replayBody.studyVersion, 2);
  assert.equal(replayBody.card.reps, 2);
  assert.equal(replayBody.card.due, b2.card.due);
});

test("Round2 #6: AI search_questions(due) and list_workspace_overview reflect majorRevision-due questions", async () => {
  const aiDueUser = await register("ai_due_user");
  const qId = (
    (await (
      await questionsRoute.POST(
        req(aiDueUser, "/api/questions", {
          action: "create",
          deckId: aiDueUser.deckId,
          title: "重要修订待重学测试题",
          answer: "初版参考答案",
        }),
      )
    ).json()) as { id: string }
  ).id;

  const r1 = await reviewsRoute.POST(
    req(aiDueUser, "/api/reviews", {
      questionId: qId,
      eventId: randomUUID(),
      expectedVersion: 0,
      questionRevision: 1,
      rating: 4,
      answer: "已掌握初版",
    }),
  );
  assert.equal(r1.status, 200);

  const editRes = await questionsRoute.POST(
    req(aiDueUser, "/api/questions", {
      action: "edit",
      id: qId,
      expectedRevision: 1,
      title: "重要修订待重学测试题",
      answer: "修订后重点补充内容",
      tags: [],
      major: true,
    }),
  );
  assert.equal(editRes.status, 200);

  const overview = (await executeWorkspaceTool(
    aiDueUser.id,
    "workspace",
    null,
    "list_workspace_overview",
    "{}",
  )) as {
    output: { decks: Array<{ deckId: string | null; due: number }> };
  };
  const deckOverview = overview.output.decks.find(
    (d) => d.deckId === aiDueUser.deckId,
  )!;
  assert.equal(deckOverview.due, 1);

  const searchRes = (await executeWorkspaceTool(
    aiDueUser.id,
    "workspace",
    null,
    "search_questions",
    JSON.stringify({ filter: "due" }),
  )) as {
    output: { matches: Array<{ id: string; needsRelearn?: boolean }> };
  };
  assert.equal(searchRes.output.matches.length, 1);
  assert.equal(searchRes.output.matches[0].id, qId);
  assert.equal(searchRes.output.matches[0].needsRelearn, true);
});

test("Round2 #7: fresh account that already opened workspace restores backup preferences while customized/non-empty accounts preserve theirs", async () => {
  const prefSrc = await register("pref_src_user");
  assert.equal(
    (
      await settingsRoute.POST(
        req(prefSrc, "/api/settings", {
          action: "preferences",
          dailyGoal: 27,
          dailyNewLimit: 9,
          theme: "dark",
          timeZone: "Asia/Tokyo",
        }),
      )
    ).status,
    200,
  );
  await questionsRoute.POST(
    req(prefSrc, "/api/questions", {
      action: "create",
      deckId: prefSrc.deckId,
      title: "偏好测试源题目",
      answer: "答案",
    }),
  );
  const backupRes = await exportRoute.GET(req(prefSrc, "/api/export"));
  const backup = await backupRes.json();

  // 1. Fresh account (register() already invoked getWs -> ensureWorkspace) restores preferences
  const freshTarget = await register("pref_fresh_target");
  const r1 = await restoreRoute.POST(
    req(freshTarget, "/api/backup/restore", backup),
  );
  assert.equal(r1.status, 200);
  const j1 = (await r1.json()) as {
    restored: { preferencesRestored: boolean };
  };
  assert.equal(j1.restored.preferencesRestored, true);
  const wsFresh = await getWs(freshTarget);
  assert.equal(wsFresh.settings.dailyGoal, 27);
  assert.equal(wsFresh.settings.dailyNewLimit, 9);
  assert.equal(wsFresh.settings.theme, "dark");
  assert.equal(wsFresh.settings.timeZone, "Asia/Tokyo");

  // Re-restoring is idempotent and skips overwriting preferences
  const r2 = await restoreRoute.POST(
    req(freshTarget, "/api/backup/restore", backup),
  );
  assert.equal(r2.status, 200);
  const j2 = (await r2.json()) as {
    restored: { preferencesRestored: boolean };
  };
  assert.equal(j2.restored.preferencesRestored, false);

  // 2. Account with user-customized preferences preserves its own settings
  const customTarget = await register("pref_custom_target");
  await settingsRoute.POST(
    req(customTarget, "/api/settings", {
      action: "preferences",
      dailyGoal: 12,
      dailyNewLimit: 4,
      timeZone: "Asia/Shanghai",
    }),
  );
  const rCustom = await restoreRoute.POST(
    req(customTarget, "/api/backup/restore", backup),
  );
  assert.equal(rCustom.status, 200);
  assert.equal(
    ((await rCustom.json()) as { restored: { preferencesRestored: boolean } })
      .restored.preferencesRestored,
    false,
  );
  assert.equal((await getWs(customTarget)).settings.dailyGoal, 12);

  // 3. Account with existing content even on default preferences preserves them
  const activeTarget = await register("pref_active_target");
  await questionsRoute.POST(
    req(activeTarget, "/api/questions", {
      action: "create",
      deckId: activeTarget.deckId,
      title: "已有学习内容",
      answer: "答案",
    }),
  );
  const rActive = await restoreRoute.POST(
    req(activeTarget, "/api/backup/restore", backup),
  );
  assert.equal(rActive.status, 200);
  assert.equal(
    ((await rActive.json()) as { restored: { preferencesRestored: boolean } })
      .restored.preferencesRestored,
    false,
  );
  assert.equal((await getWs(activeTarget)).settings.dailyGoal, 5);
});
