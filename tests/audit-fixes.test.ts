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
const exportRoute = await import("../src/app/api/export/route");
const restoreRoute = await import("../src/app/api/backup/restore/route");
const settingsRoute = await import("../src/app/api/settings/route");
const chatRoute = await import("../src/app/api/chat/route");

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

test("Fix #8: JSON backup v2 exports complete data without secrets and merge-restores idempotently across accounts", async () => {
  const exportRes = await exportRoute.GET(req(alice, "/api/export"));
  assert.equal(exportRes.status, 200);
  const backup = (await exportRes.json()) as Record<string, unknown> & {
    format: string;
    version: number;
    preferences: { dailyGoal: number; dailyNewLimit: number };
    decks: Array<{ id: string; title: string }>;
    deckGroups: unknown[];
    releases: unknown[];
    questions: Array<{ id: string; title: string }>;
    reviews: Array<{ id: string }>;
  };

  assert.equal(backup.format, "shiyi-backup");
  assert.equal(backup.version, 2);
  assert.ok(backup.preferences && typeof backup.preferences.dailyGoal === "number");
  assert.ok(Array.isArray(backup.deckGroups));
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
