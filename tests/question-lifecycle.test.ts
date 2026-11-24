import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Workspace } from "../src/lib/types";
import { TRASH_RETENTION_MS } from "../src/lib/question-trash";

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
const schema = await import("../src/db/schema");
const workspace = await import("../src/app/api/workspace/route");
const decks = await import("../src/app/api/decks/route");
const questions = await import("../src/app/api/questions/route");
const preview = await import("../src/app/api/import/preview/route");
const commit = await import("../src/app/api/import/commit/route");
const trash = await import("../src/app/api/questions/trash/route");
const reviews = await import("../src/app/api/reviews/route");
const source = await import("../src/app/api/questions/source/route");
const exporter = await import("../src/app/api/export/route");
const { accessibleQuestion } = await import("../src/server/workspace");
const { cleanupExpiredQuestions } =
  await import("../src/server/question-lifecycle");
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
  const account = {
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
async function add(
  account: Account,
  title: string,
  deckId: string | null = account.deckId,
) {
  const r = await preview.POST(
    request(account, "/api/import/preview", {
      batchId: randomUUID(),
      deckId,
      inputType: "qa",
      method: "rules",
      raw: `## ${title}\r\n  不应改变的原答案  \r\n`,
    }),
  );
  assert.equal(r.status, 200, await r.clone().text());
  const parsed = await r.json();
  const saved = await commit.POST(
    request(account, "/api/import/commit", {
      batchId: parsed.batchId,
      questions: parsed.questions,
    }),
  );
  assert.equal(saved.status, 200);
  const q = (await state(account)).questions.find(
    (q) => q.title === title && q.deckId === deckId,
  );
  assert.ok(q);
  return q;
}
before(async () => {
  alice = await register("lifecycle-alice");
  bob = await register("lifecycle-bob");
});

test("deleting a category preserves every question, including identical copies, notes and review history", async () => {
  const q = await add(alice, "分类与题目应独立？");
  assert.equal(
    (
      await questions.POST(
        request(alice, "/api/questions", {
          action: "note",
          id: q.id,
          note: "保留我的理解",
          expectedVersion: 0,
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await reviews.POST(
        request(alice, "/api/reviews", {
          questionId: q.id,
          questionRevision: 1,
          eventId: randomUUID(),
          expectedVersion: 0,
          rating: 3,
          answer: "保留我的作答",
        }),
      )
    ).status,
    200,
  );
  const created = await (
    await decks.POST(
      request(alice, "/api/decks", { action: "create", title: "第二个分类" }),
    )
  ).json();
  assert.equal(
    (
      await questions.POST(
        request(alice, "/api/questions", {
          action: "copy",
          id: q.id,
          deckId: created.deck.id,
        }),
      )
    ).status,
    200,
  );
  const before = await state(alice);
  for (const deckId of [alice.deckId, created.deck.id])
    assert.equal(
      (
        await decks.POST(
          request(alice, "/api/decks", { action: "delete", deckId }),
        )
      ).status,
      200,
    );
  const current = await state(alice);
  assert.equal(current.decks.length, 0);
  assert.equal(current.questions.length, 2);
  assert.ok(
    current.questions.every(
      (q) => q.deckId === null && q.deckTitle === "未分类",
    ),
  );
  const retained = current.questions.find((item) => item.id === q.id)!;
  assert.equal(retained.note, "保留我的理解");
  assert.deepEqual(
    retained.fsrs,
    before.questions.find((item) => item.id === q.id)!.fsrs,
  );
  assert.equal(current.recentReviews[0].answer, "保留我的作答");
  assert.deepEqual(
    await (await trash.GET(request(alice, "/api/questions/trash"))).json(),
    [],
  );
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
  assert.equal(
    (
      await questions.POST(
        request(alice, "/api/questions", {
          action: "edit",
          id: q.id,
          expectedRevision: 1,
          title: q.title,
          answer: q.answer + "补充。",
          tags: [],
        }),
      )
    ).status,
    200,
  );
  const unfiled = await add(alice, "没有题库也能导入？", null);
  assert.equal(unfiled.deckId, null);
});

test("question trash restores study state; deleting its category keeps the original expiration", async () => {
  const anonymous = await trash.GET(
    new Request("http://localhost:3000/api/questions/trash"),
  );
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("Cache-Control")!, /private.*no-store/);
  const category = (
    await (
      await decks.POST(
        request(alice, "/api/decks", {
          action: "create",
          title: "等待移除的分类",
        }),
      )
    ).json()
  ).deck.id;
  const q = await add(alice, "删除的是题目？", category);
  assert.equal(
    (
      await questions.POST(
        request(alice, "/api/questions", {
          action: "note",
          id: q.id,
          note: "恢复后仍在",
          expectedVersion: 0,
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await questions.POST(
        request(bob, "/api/questions", { action: "delete", id: q.id }),
      )
    ).status,
    404,
  );
  const removed = await questions.POST(
    request(alice, "/api/questions", { action: "delete", id: q.id }),
  );
  assert.equal(removed.status, 200);
  const expiresAt = (await removed.json()).expiresAt;
  assert.ok(!(await state(alice)).questions.some((item) => item.id === q.id));
  assert.equal(
    (
      await source.GET(
        request(alice, `/api/questions/source?questionId=${q.id}`),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await questions.POST(
        request(alice, "/api/questions", {
          action: "edit",
          id: q.id,
          expectedRevision: 1,
          title: q.title,
          answer: "意外覆盖",
          tags: [],
        }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await decks.POST(
        request(alice, "/api/decks", { action: "delete", deckId: category }),
      )
    ).status,
    200,
  );
  const rows = await (
    await trash.GET(request(alice, "/api/questions/trash"))
  ).json();
  assert.equal(
    rows.find((item: { id: string }) => item.id === q.id).expiresAt,
    expiresAt,
  );
  assert.equal(
    rows.find((item: { id: string }) => item.id === q.id).deckId,
    null,
  );
  assert.deepEqual(
    await (await trash.GET(request(bob, "/api/questions/trash"))).json(),
    [],
  );
  assert.equal(
    (
      await questions.POST(
        request(bob, "/api/questions", { action: "restore", id: q.id }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await questions.POST(
        request(alice, "/api/questions", { action: "restore", id: q.id }),
      )
    ).status,
    200,
  );
  const restored = (await state(alice)).questions.find(
    (item) => item.id === q.id,
  )!;
  assert.equal(restored.deckId, null);
  assert.equal(restored.note, "恢复后仍在");
  assert.equal(restored.answer, q.answer);
  const target = (
    await (
      await decks.POST(
        request(alice, "/api/decks", { action: "create", title: "重新分类" }),
      )
    ).json()
  ).deck.id;
  assert.equal(
    (
      await questions.POST(
        request(alice, "/api/questions", {
          action: "move",
          id: q.id,
          deckId: bob.deckId,
        }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await questions.POST(
        request(alice, "/api/questions", {
          action: "move",
          id: q.id,
          deckId: target,
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (await state(alice)).questions.find((item) => item.id === q.id)!.deckId,
    target,
  );
  assert.equal(
    (
      await questions.POST(
        request(alice, "/api/questions", {
          action: "move",
          id: q.id,
          deckId: null,
        }),
      )
    ).status,
    200,
  );
});

test("30-day expiry clears the author's private data while subscribers keep their released snapshot and notes", async () => {
  const category = (
    await (
      await decks.POST(
        request(alice, "/api/decks", {
          action: "create",
          title: "已发布的题目",
        }),
      )
    ).json()
  ).deck.id;
  const q = await add(alice, "发布快照与回收站隔离？", category);
  assert.equal(
    (
      await decks.POST(
        request(alice, "/api/decks", {
          action: "publish",
          deckId: category,
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
        request(bob, "/api/decks", { action: "subscribe", deckId: category }),
      )
    ).status,
    200,
  );
  for (const [account, note] of [
    [alice, "作者私密笔记"],
    [bob, "订阅者自己的笔记"],
  ] as const) {
    assert.equal(
      (
        await questions.POST(
          request(account, "/api/questions", {
            action: "note",
            id: q.id,
            note,
            expectedVersion: 0,
          }),
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await reviews.POST(
          request(account, "/api/reviews", {
            questionId: q.id,
            questionRevision: 1,
            eventId: randomUUID(),
            expectedVersion: 0,
            rating: 3,
            answer: note,
          }),
        )
      ).status,
      200,
    );
  }
  const db = await getDb();
  const chatId = randomUUID();
  await db.insert(schema.conversations).values({
    id: chatId,
    userId: alice.id,
    questionId: q.id,
    questionTitle: q.title,
    answerSnapshot: q.answer,
    questionRevision: 1,
  });
  await db.insert(schema.messages).values({
    id: randomUUID(),
    conversationId: chatId,
    role: "assistant",
    content: "仅作者的聊天",
  });
  assert.equal(
    (
      await questions.POST(
        request(alice, "/api/questions", { action: "delete", id: q.id }),
      )
    ).status,
    200,
  );
  const deletedAt = new Date("2026-01-01T12:00:00.000Z");
  await db
    .update(schema.questions)
    .set({ deletedAt })
    .where(eq(schema.questions.id, q.id));
  assert.equal(
    (
      await questions.POST(
        request(alice, "/api/questions", { action: "restore", id: q.id }),
      )
    ).status,
    410,
    "expiry rejects restoration even before the background purge",
  );
  assert.equal(
    await cleanupExpiredQuestions({
      userId: bob.id,
      now: new Date(deletedAt.getTime() + TRASH_RETENTION_MS),
    }),
    0,
  );
  assert.equal(
    await cleanupExpiredQuestions({
      userId: alice.id,
      now: new Date(deletedAt.getTime() + TRASH_RETENTION_MS - 1),
    }),
    0,
  );
  assert.equal(
    await cleanupExpiredQuestions({
      userId: alice.id,
      now: new Date(deletedAt.getTime() + TRASH_RETENTION_MS),
    }),
    1,
  );
  assert.equal(
    await cleanupExpiredQuestions({
      userId: alice.id,
      now: new Date(deletedAt.getTime() + TRASH_RETENTION_MS + 1),
    }),
    0,
  );
  const [scrubbed] = await db
    .select()
    .from(schema.questions)
    .where(eq(schema.questions.id, q.id));
  assert.equal(scrubbed.answer, "");
  assert.equal(scrubbed.title, "");
  assert.equal(scrubbed.sourceText, "");
  assert.equal(scrubbed.importId, null);
  assert.ok(scrubbed.purgedAt);
  assert.equal(
    (
      await questions.POST(
        request(alice, "/api/questions", { action: "restore", id: q.id }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, chatId))
    ).length,
    0,
  );
  assert.equal(
    (
      await db
        .select()
        .from(schema.studyCards)
        .where(
          and(
            eq(schema.studyCards.userId, alice.id),
            eq(schema.studyCards.questionId, q.id),
          ),
        )
    ).length,
    0,
  );
  const subscribed = await state(bob),
    retained = subscribed.questions.find((item) => item.id === q.id)!;
  assert.equal(retained.answer, q.answer);
  assert.equal(retained.note, "订阅者自己的笔记");
  assert.ok(retained.fsrs);
  assert.equal((await accessibleQuestion(bob.id, q.id)).answer, q.answer);
  const exported = await (
    await exporter.GET(request(alice, "/api/export"))
  ).json();
  assert.ok(!JSON.stringify(exported).includes("作者私密笔记"));
  assert.equal(
    (
      await decks.POST(
        request(alice, "/api/decks", {
          action: "publish",
          deckId: category,
          expectedVersion: 1,
          visibility: "public",
        }),
      )
    ).status,
    200,
  );
  // Bob remains pinned on v1 until opting into v2; once applied, the removed question leaves his view while studyCards stay intact.
  assert.ok((await state(bob)).questions.some((item) => item.id === q.id));
  assert.equal(
    (
      await decks.POST(
        request(bob, "/api/decks", {
          action: "applyUpdate",
          deckId: category,
        }),
      )
    ).status,
    200,
  );
  assert.ok(!(await state(bob)).questions.some((item) => item.id === q.id));
  assert.equal(
    (
      await db
        .select()
        .from(schema.studyCards)
        .where(
          and(
            eq(schema.studyCards.userId, bob.id),
            eq(schema.studyCards.questionId, q.id),
          ),
        )
    )[0].note,
    "订阅者自己的笔记",
  );
});

test("restore with a duplicate preserves both identities; concurrent category deletion and restore lose no question", async () => {
  const category = (
    await (
      await decks.POST(
        request(alice, "/api/decks", { action: "create", title: "并发恢复" }),
      )
    ).json()
  ).deck.id;
  const q = await add(alice, "相同内容也应保留两个题目？", category);
  assert.equal(
    (
      await questions.POST(
        request(alice, "/api/questions", { action: "delete", id: q.id }),
      )
    ).status,
    200,
  );
  const replacement = await add(alice, q.title, category);
  assert.notEqual(replacement.id, q.id);
  assert.equal(
    (
      await questions.POST(
        request(alice, "/api/questions", { action: "restore", id: q.id }),
      )
    ).status,
    200,
  );
  assert.equal(
    (await state(alice)).questions.find((item) => item.id === q.id)!.deckId,
    null,
  );
  assert.equal(
    (
      await questions.POST(
        request(alice, "/api/questions", {
          action: "delete",
          id: replacement.id,
        }),
      )
    ).status,
    200,
  );
  const results = await Promise.all([
    questions.POST(
      request(alice, "/api/questions", {
        action: "restore",
        id: replacement.id,
      }),
    ),
    decks.POST(
      request(alice, "/api/decks", { action: "delete", deckId: category }),
    ),
  ]);
  assert.ok(results.every((r) => r.status === 200));
  const rows = (await state(alice)).questions.filter(
    (item) => item.id === q.id || item.id === replacement.id,
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.every((item) => item.deckId === null));
});

test("moving a published question keeps each subscription's answer and review identity consistent", async () => {
  const oldDeck = (
    await (
      await decks.POST(
        request(alice, "/api/decks", { action: "create", title: "原发布分类" }),
      )
    ).json()
  ).deck.id;
  const newDeck = (
    await (
      await decks.POST(
        request(alice, "/api/decks", { action: "create", title: "新发布分类" }),
      )
    ).json()
  ).deck.id;
  const q = await add(alice, "跨发布题库移动？", oldDeck);
  assert.equal(
    (
      await decks.POST(
        request(alice, "/api/decks", {
          action: "publish",
          deckId: oldDeck,
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
        request(bob, "/api/decks", { action: "subscribe", deckId: oldDeck }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await questions.POST(
        request(alice, "/api/questions", {
          action: "move",
          id: q.id,
          deckId: newDeck,
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await questions.POST(
        request(alice, "/api/questions", {
          action: "edit",
          id: q.id,
          expectedRevision: 1,
          title: q.title,
          answer: "新分类的第二版答案",
          tags: [],
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await decks.POST(
        request(alice, "/api/decks", {
          action: "publish",
          deckId: newDeck,
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
        request(bob, "/api/decks", { action: "subscribe", deckId: newDeck }),
      )
    ).status,
    200,
  );
  const subscribed = await state(bob);
  const old = subscribed.questions.find((item) => item.deckId === oldDeck)!;
  const fresh = subscribed.questions.find((item) => item.deckId === newDeck)!;
  assert.notEqual(old.id, fresh.id);
  assert.equal(old.answer, q.answer);
  assert.equal(fresh.answer, "新分类的第二版答案");
  for (const item of [old, fresh]) {
    assert.equal(
      (await accessibleQuestion(bob.id, item.id)).answer,
      item.answer,
    );
    assert.equal(
      (
        await reviews.POST(
          request(bob, "/api/reviews", {
            questionId: item.id,
            questionRevision: item.revision,
            eventId: randomUUID(),
            expectedVersion: 0,
            rating: 3,
          }),
        )
      ).status,
      200,
    );
  }
  assert.equal(
    (await state(alice)).questions.filter((item) => item.title === q.title)
      .length,
    1,
  );
  assert.equal(
    (
      await decks.POST(
        request(alice, "/api/decks", {
          action: "publish",
          deckId: newDeck,
          expectedVersion: 1,
          visibility: "public",
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (await state(bob)).questions.find((item) => item.deckId === newDeck)!.id,
    fresh.id,
  );
});

after(async () => {
  const state = globalThis as unknown as {
    interviewDatabase?: Promise<{ close: () => Promise<void> }>;
  };
  await (await state.interviewDatabase)?.close();
});
