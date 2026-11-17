import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import { eq } from "drizzle-orm";
import type { Workspace, Conversation } from "../src/lib/types";

Object.assign(process.env, {
  NODE_ENV: "test",
  LOCAL_DATABASE_PATH: ":memory:",
  BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  KEY_ENCRYPTION_SECRET: randomBytes(32).toString("hex"),
});
delete process.env.DATABASE_URL;
delete process.env.PGHOST;
delete process.env.BETTER_AUTH_TRUSTED_ORIGINS;

const { getAuth } = await import("../src/server/auth");
const { getDb } = await import("../src/db");
const { credentials } = await import("../src/db/schema");
const { decryptKey } = await import("../src/server/crypto");
const workspace = await import("../src/app/api/workspace/route");
const importer = await import("../src/app/api/import/route");
const decks = await import("../src/app/api/decks/route");
const questions = await import("../src/app/api/questions/route");
const reviews = await import("../src/app/api/reviews/route");
const settings = await import("../src/app/api/settings/route");
const chat = await import("../src/app/api/chat/route");
const exporter = await import("../src/app/api/export/route");
const catalog = await import("../src/app/api/catalog/route");
const authRoute = await import("../src/app/api/auth/[...all]/route");

type Account = {
  id: string;
  cookie: string;
  deckId: string;
  questionId: string;
  batchId: string;
  name: string;
};
function request(
  account: Pick<Account, "cookie">,
  url: string,
  data?: unknown,
  expectedUser?: string,
) {
  return new Request(`http://localhost:3000${url}`, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      cookie: account.cookie,
      origin: "http://localhost:3000",
      "Content-Type": "application/json",
      ...(expectedUser ? { "X-Workspace-User": expectedUser } : {}),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}
async function snapshot(account: Pick<Account, "cookie">): Promise<Workspace> {
  const response = await workspace.GET(request(account, "/api/workspace"));
  assert.equal(response.status, 200);
  return response.json();
}
async function createAccount(name: string): Promise<Account> {
  const response = await (
    await getAuth()
  ).handler(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        email: `${name}@example.test`,
        password: "isolation-test-password",
      }),
    }),
  );
  assert.equal(response.status, 200);
  const { user } = await response.json();
  const cookie = response.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
  const initial = await snapshot({ cookie });
  const account = {
    id: user.id,
    cookie,
    name,
    deckId: initial.decks[0].id,
    questionId: "",
    batchId: randomUUID(),
  };
  const imported = await importer.POST(
    request(account, "/api/import", {
      deckId: account.deckId,
      batchId: account.batchId,
      raw: `## ${name} private question\n${name} PRIVATE_SOURCE_SENTINEL`,
    }),
  );
  assert.equal(imported.status, 200);
  account.questionId = (await snapshot(account)).questions[0].id;
  return account;
}
let alice: Account;
let bob: Account;
let sharedId: string;

test("isolation: every protected endpoint rejects anonymous requests and disables response caching", async () => {
  alice = await createAccount("isolation-alice");
  bob = await createAccount("isolation-bob");
  for (const [url, handler] of [
    ["/api/workspace", workspace.GET],
    ["/api/export", exporter.GET],
    ["/api/catalog", catalog.GET],
    ["/api/chat", chat.GET],
    ["/api/reviews", reviews.GET],
  ] as const) {
    const response = await handler(request({ cookie: "" }, url));
    assert.equal(response.status, 401, url);
    assert.match(response.headers.get("Cache-Control")!, /private.*no-store/);
    assert.match(response.headers.get("Vary")!, /Cookie/);
  }
  for (const [url, handler] of [
    ["/api/workspace", workspace.POST],
    ["/api/questions", questions.POST],
    ["/api/decks", decks.POST],
    ["/api/settings", settings.POST],
    ["/api/import", importer.POST],
    ["/api/reviews", reviews.POST],
    ["/api/chat", chat.POST],
  ] as const) {
    assert.equal(
      (await handler(request({ cookie: "" }, url, {}))).status,
      401,
      url,
    );
  }
  const authenticated = await workspace.GET(request(alice, "/api/workspace"));
  assert.match(
    authenticated.headers.get("Cache-Control")!,
    /private.*no-store/,
  );
  const session = await authRoute.GET(request(alice, "/api/auth/get-session"));
  assert.match(session.headers.get("Cache-Control")!, /private.*no-store/);
  assert.equal((await session.json()).user.id, alice.id);
});

test("isolation: guessed private question, deck, import and review IDs cannot read or mutate another account", async () => {
  const before = await snapshot(alice);
  for (const payload of [
    { action: "favorite", favorite: true },
    { action: "note", note: "intrusion", expectedVersion: 0 },
    { action: "archive", archived: true, expectedRevision: 1 },
    {
      action: "edit",
      title: "intrusion",
      answer: "intrusion",
      tags: [],
      major: false,
      expectedRevision: 1,
    },
    { action: "copy", deckId: bob.deckId },
  ]) {
    const response = await questions.POST(
      request(bob, "/api/questions", {
        ...payload,
        id: alice.questionId,
        userId: alice.id,
      }),
    );
    assert.equal(response.status, 404, payload.action);
    assert.ok(!(await response.text()).includes("PRIVATE_SOURCE_SENTINEL"));
  }
  for (const payload of [
    { action: "publish", expectedVersion: 0, visibility: "public" },
    { action: "subscribe" },
    { action: "acknowledge", version: 0 },
  ]) {
    assert.equal(
      (
        await decks.POST(
          request(bob, "/api/decks", { ...payload, deckId: alice.deckId }),
        )
      ).status,
      404,
      payload.action,
    );
  }
  assert.equal(
    (
      await importer.POST(
        request(bob, "/api/import", {
          deckId: alice.deckId,
          batchId: randomUUID(),
          raw: "foreign import",
        }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await importer.POST(
        request(bob, "/api/import", {
          deckId: bob.deckId,
          batchId: alice.batchId,
          raw: "foreign batch collision",
        }),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await reviews.GET(
        request(bob, `/api/reviews?questionId=${alice.questionId}`),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await reviews.POST(
        request(bob, "/api/reviews", {
          questionId: alice.questionId,
          questionRevision: 1,
          eventId: randomUUID(),
          expectedVersion: 0,
          rating: 3,
        }),
      )
    ).status,
    404,
  );
  assert.equal(
    (await chat.GET(request(bob, `/api/chat?questionId=${alice.questionId}`)))
      .status,
    404,
  );
  assert.equal(
    (
      await chat.POST(
        request(bob, "/api/chat", {
          questionId: alice.questionId,
          message: "intrusion",
        }),
      )
    ).status,
    404,
  );
  assert.deepEqual(
    await (
      await catalog.GET(request(bob, `/api/catalog?id=${alice.deckId}`))
    ).json(),
    [],
  );
  assert.deepEqual((await snapshot(alice)).questions, before.questions);
});

test("isolation: stale browser identity cannot write under the newly signed-in account; supplied user IDs are ignored", async () => {
  const before = await snapshot(bob);
  for (const [url, handler, payload] of [
    ["/api/settings", settings.POST, { action: "deleteKey" }],
    [
      "/api/questions",
      questions.POST,
      {
        action: "note",
        id: bob.questionId,
        note: "old-account-draft",
        expectedVersion: 0,
      },
    ],
  ] as const) {
    const response = await handler(request(bob, url, payload, alice.id));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "ACCOUNT_CHANGED");
  }
  assert.equal(
    (await exporter.GET(request(bob, "/api/export", undefined, alice.id)))
      .status,
    409,
  );
  assert.deepEqual((await snapshot(bob)).questions, before.questions);
  const changed = await settings.POST(
    request(alice, "/api/settings", {
      action: "preferences",
      userId: bob.id,
      dailyGoal: 23,
      theme: "dark",
      timeZone: "Asia/Shanghai",
    }),
  );
  assert.equal(changed.status, 200);
  assert.equal((await snapshot(alice)).settings.dailyGoal, 23);
  assert.equal(
    (await snapshot(bob)).settings.dailyGoal,
    before.settings.dailyGoal,
  );
});

test("isolation: subscriptions expose only released content; notes, favorites and attempts stay with their author", async () => {
  const created = await decks.POST(
    request(alice, "/api/decks", { action: "create", title: "Shared content" }),
  );
  sharedId = (await created.json()).deck.id;
  await importer.POST(
    request(alice, "/api/import", {
      deckId: sharedId,
      batchId: randomUUID(),
      raw: "## Shared question\nPublished reference answer.",
    }),
  );
  assert.equal(
    (
      await decks.POST(
        request(alice, "/api/decks", {
          action: "publish",
          deckId: sharedId,
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
        request(bob, "/api/decks", { action: "subscribe", deckId: sharedId }),
      )
    ).status,
    200,
  );
  const q = (await snapshot(bob)).questions.find(
    (item) => item.deckId === sharedId,
  )!;
  assert.equal(
    (
      await questions.POST(
        request(bob, "/api/questions", {
          action: "note",
          id: q.id,
          note: "BOB_PRIVATE_NOTE",
          expectedVersion: 0,
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await questions.POST(
        request(bob, "/api/questions", {
          action: "favorite",
          id: q.id,
          favorite: true,
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await reviews.POST(
        request(bob, "/api/reviews", {
          questionId: q.id,
          questionRevision: 1,
          eventId: randomUUID(),
          expectedVersion: 0,
          rating: 3,
          answer: "BOB_PRIVATE_ATTEMPT",
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await questions.POST(
        request(bob, "/api/questions", {
          action: "copy",
          id: q.id,
          deckId: alice.deckId,
        }),
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
          title: q.title,
          answer: "ALICE_UNPUBLISHED_DRAFT",
          tags: [],
          major: false,
          expectedRevision: 1,
        }),
      )
    ).status,
    200,
  );
  const a = await snapshot(alice);
  const b = await snapshot(bob);
  const original = a.questions.find((item) => item.id === q.id)!;
  assert.equal(original.note, "");
  assert.equal(original.favorite, false);
  assert.equal(original.fsrs, null);
  assert.equal(a.stats.totalReviews, 0);
  assert.equal(b.stats.totalReviews, 1);
  assert.equal(
    b.questions.find((item) => item.id === q.id)!.answer,
    "Published reference answer.",
  );
  assert.ok(!JSON.stringify(a).includes("BOB_PRIVATE_"));
  assert.ok(!JSON.stringify(b).includes("ALICE_UNPUBLISHED_DRAFT"));
});

test("isolation: simultaneous AI chats and imports use each user's own endpoint, model and key", async () => {
  const connections = new Map([
    [
      alice.id,
      {
        baseUrl: "https://alice-gateway.example/v1",
        model: "alice-model",
        key: "sk-alice-private-test-key",
      },
    ],
    [
      bob.id,
      {
        baseUrl: "https://bob-gateway.example/v1",
        model: "bob-model",
        key: "sk-bob-private-test-key",
      },
    ],
  ]);
  for (const account of [alice, bob]) {
    assert.equal(
      (
        await settings.POST(
          request(account, "/api/settings", {
            action: "saveConnection",
            ...connections.get(account.id),
          }),
        )
      ).status,
      200,
    );
    const row = (
      await (
        await getDb()
      )
        .select()
        .from(credentials)
        .where(eq(credentials.userId, account.id))
    )[0];
    assert.equal(
      decryptKey(row.encryptedKey, account.id),
      connections.get(account.id)!.key,
    );
    assert.throws(() =>
      decryptKey(row.encryptedKey, account.id === alice.id ? bob.id : alice.id),
    );
  }
  const dnsMock = mock.method(dns, "lookup", async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  const calls: string[] = [];
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      const account = String(url).includes("alice-gateway") ? alice : bob;
      const connection = connections.get(account.id)!;
      assert.equal(String(url), `${connection.baseUrl}/chat/completions`);
      assert.equal(
        (init!.headers as Record<string, string>).Authorization,
        `Bearer ${connection.key}`,
      );
      assert.equal(payload.model, connection.model);
      assert.ok(
        !JSON.stringify(payload).includes(
          account.id === alice.id ? "BOB_" : "ALICE_",
        ),
      );
      calls.push(account.id);
      if (payload.stream)
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: `${account.name} PRIVATE_AI_REPLY` } }] })}\n\ndata: [DONE]\n\n`,
        );
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({
                questions: [
                  {
                    title: `${account.name} AI import`,
                    answer: `${account.name} AI_IMPORT_PRIVATE`,
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
    await Promise.all(
      [alice, bob].map(async (account) => {
        const response = await chat.POST(
          request(account, "/api/chat", {
            questionId: account.questionId,
            message: `${account.name} private prompt`,
            quote: `${account.name} PRIVATE_QUOTE`,
          }),
        );
        assert.equal(response.status, 200);
        assert.match(
          response.headers.get("Cache-Control")!,
          /private.*no-store/,
        );
        assert.ok((await response.text()).includes("event: done"));
      }),
    );
    await Promise.all(
      [alice, bob].map(async (account) => {
        const response = await importer.POST(
          request(account, "/api/import", {
            deckId: account.deckId,
            batchId: randomUUID(),
            raw: `${account.name} AI_INPUT_PRIVATE`,
            mode: "ai",
          }),
        );
        assert.equal(response.status, 200);
      }),
    );
    // Even a subscriber sharing the same question cannot reuse the author's thread.
    const shared = (await snapshot(alice)).questions.find(
      (q) => q.deckId === sharedId,
    )!;
    const response = await chat.POST(
      request(alice, "/api/chat", {
        questionId: shared.id,
        message: "ALICE_SHARED_PRIVATE_PROMPT",
      }),
    );
    await response.text();
    const threads: Conversation[] = await (
      await chat.GET(request(alice, `/api/chat?questionId=${shared.id}`))
    ).json();
    assert.deepEqual(
      await (
        await chat.GET(request(bob, `/api/chat?questionId=${shared.id}`))
      ).json(),
      [],
    );
    assert.equal(
      (
        await chat.POST(
          request(bob, "/api/chat", {
            questionId: shared.id,
            conversationId: threads[0].id,
            message: "intrusion",
          }),
        )
      ).status,
      404,
    );
    assert.equal(
      calls.length,
      5,
      "unauthorized calls must not reach a provider",
    );
    await settings.POST(
      request(alice, "/api/settings", { action: "deleteKey", userId: bob.id }),
    );
    assert.equal((await snapshot(alice)).settings.hasKey, false);
    assert.equal((await snapshot(bob)).settings.model, "bob-model");
    const own = await chat.POST(
      request(bob, "/api/chat", {
        questionId: bob.questionId,
        message: "still works",
      }),
    );
    assert.equal(own.status, 200);
    await own.text();
  } finally {
    fetchMock.mock.restore();
    dnsMock.mock.restore();
  }
});

test("isolation: exports contain only the caller's private data and never credentials, including short API keys", async () => {
  const a = await (await exporter.GET(request(alice, "/api/export"))).text();
  const b = await (await exporter.GET(request(bob, "/api/export"))).text();
  assert.ok(a.includes("isolation-alice PRIVATE_SOURCE_SENTINEL"));
  assert.ok(
    b.includes("BOB_PRIVATE_NOTE") && b.includes("BOB_PRIVATE_ATTEMPT"),
  );
  for (const forbidden of [
    "isolation-bob PRIVATE_",
    "BOB_PRIVATE_",
    "isolation-bob AI_INPUT_PRIVATE",
    "bob-private-test-key",
    "encryptedKey",
  ])
    assert.ok(!a.includes(forbidden), forbidden);
  for (const forbidden of [
    "isolation-alice PRIVATE_",
    "ALICE_UNPUBLISHED_DRAFT",
    "ALICE_SHARED_PRIVATE_PROMPT",
    "isolation-alice AI_INPUT_PRIVATE",
    "alice-private-test-key",
    "encryptedKey",
  ])
    assert.ok(!b.includes(forbidden), forbidden);
  const key = "xy";
  await settings.POST(
    request(alice, "/api/settings", {
      action: "saveConnection",
      baseUrl: "https://short-key.example/v1",
      model: "test",
      key,
    }),
  );
  const saved = (await snapshot(alice)).settings;
  assert.equal(saved.hasKey, true);
  assert.equal(saved.keyHint, "");
});

after(async () => {
  const state = globalThis as unknown as {
    interviewDatabase?: Promise<{ close: () => Promise<void> }>;
  };
  await (await state.interviewDatabase)?.close();
});
