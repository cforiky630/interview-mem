import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../src/db/schema";
import type {
  CatalogDeck,
  CatalogDeckPreview,
  RichCatalogResponse,
  Workspace,
} from "../src/lib/types";
import {
  computeUnpublishedDiff,
  diffReleaseVersions,
  formatDiffSummary,
} from "../src/lib/subscriptions";

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
const healthRoute = await import("../src/app/api/health/route");
const workspaceRoute = await import("../src/app/api/workspace/route");
const decksRoute = await import("../src/app/api/decks/route");
const deckGroupsRoute = await import("../src/app/api/deck-groups/route");
const questionsRoute = await import("../src/app/api/questions/route");
const reviewsRoute = await import("../src/app/api/reviews/route");
const authorsRoute = await import("../src/app/api/authors/route");
const catalogRoute = await import("../src/app/api/catalog/route");
const exportRoute = await import("../src/app/api/export/route");
const { executeWorkspaceTool } = await import("../src/server/ai-tools");

type Account = { id: string; cookie: string; deckId: string };
let alice: Account;
let bob: Account;
let charlie: Account;

function req(
  account: Account | null,
  urlPath: string,
  body?: unknown,
  origin = "http://localhost:3000",
) {
  return new Request(`http://localhost:3000${urlPath}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(account ? { cookie: account.cookie, "x-workspace-user": account.id } : {}),
      ...(origin ? { origin } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function state(account: Account): Promise<Workspace> {
  const res = await workspaceRoute.GET(req(account, "/api/workspace"));
  assert.equal(res.status, 200);
  return res.json();
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
        email: `${name}@subs.test`,
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
  // Verify health check passes on brand-new 0-row DB before any user exists.
  const h = await healthRoute.GET();
  assert.equal(h.status, 200);
  assert.deepEqual(await h.json(), { status: "ok" });

  alice = await register("sub-alice");
  bob = await register("sub-bob");
  charlie = await register("sub-charlie");
});

test("pure diff helpers accurately compare release versions and unpublished live changes", () => {
  const baseQ = {
    id: "q1",
    groupId: "g1",
    position: 0,
    title: "闭包是什么？",
    answer: "词法作用域引用",
    tags: ["JS"],
    revision: 1,
    majorRevision: 0,
    archived: false,
  };
  const pinned = {
    version: 1,
    title: "前端基础",
    description: "v1",
    groups: [{ id: "g1", title: "一面", category: "字节", description: "", position: 0 }],
    questions: [
      baseQ,
      { ...baseQ, id: "q2", title: "事件循环", position: 1 },
    ],
  };
  const latest = {
    version: 2,
    title: "前端基础（更新）",
    description: "v1",
    summary: "新增 1 题，修正 1 题，移除 1 题",
    createdAt: "2026-04-01T00:00:00.000Z",
    groups: [{ id: "g1", title: "一面", category: "字节跳动", description: "", position: 0 }],
    questions: [
      { ...baseQ, revision: 2, answer: "更完整的闭包解释" },
      { ...baseQ, id: "q2", title: "事件循环", position: 1, archived: true },
      { ...baseQ, id: "q3", title: "Promise 原理", position: 2 },
    ],
  };

  const diff = diffReleaseVersions(pinned, latest);
  assert.equal(diff.fromVersion, 1);
  assert.equal(diff.toVersion, 2);
  assert.equal(diff.added, 1);
  assert.equal(diff.updated, 1);
  assert.equal(diff.removed, 1);
  assert.equal(diff.groupsChanged, true);
  assert.equal(diff.titleChanged, true);
  assert.equal(formatDiffSummary(diff), "+1 新增 · ~1 修改 · -1 移除");

  // Author unpublished diff handles moved-question alias via sourceQuestionId.
  const aliasRelease = {
    version: 1,
    title: "前端基础",
    description: "v1",
    groups: [],
    questions: [{ ...baseQ, id: "alias-q1", sourceQuestionId: "q1", groupId: null }],
  };
  const syncedCheck = computeUnpublishedDiff(
    {
      title: "前端基础",
      description: "v1",
      groups: [],
      questions: [{ ...baseQ, groupId: null }],
    },
    aliasRelease,
  );
  assert.equal(syncedCheck.publishStatus, "synced");
  assert.equal(syncedCheck.unpublishedDiff, null);

  const dirtyCheck = computeUnpublishedDiff(
    {
      title: "前端基础",
      description: "v1",
      groups: [],
      questions: [
        { ...baseQ, groupId: null, answer: "改了答案", revision: 2 },
        { ...baseQ, id: "q-new", groupId: null, title: "新题" },
      ],
    },
    aliasRelease,
  );
  assert.equal(dirtyCheck.publishStatus, "changes");
  assert.deepEqual(dirtyCheck.unpublishedDiff, {
    added: 1,
    updated: 1,
    removed: 0,
    metaChanged: false,
    groupsChanged: false,
  });
});

test("migration 0012 applies cleanly on fresh DB and upgrades 0011 DB with legacy seen_version=0 backfill", async () => {
  // Fresh empty DB
  const fresh = new PGlite();
  await migrate(drizzle(fresh, { schema }), {
    migrationsFolder: path.resolve("drizzle"),
  });
  await fresh.close();

  // Upgrade from 0000..0011 with legacy seen_version = 0
  const upgraded = new PGlite();
  const journal = JSON.parse(
    await readFile(path.resolve("drizzle/meta/_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };
  for (const entry of journal.entries) {
    if (entry.idx > 11) break;
    const raw = await readFile(
      path.resolve("drizzle", `${entry.tag}.sql`),
      "utf8",
    );
    for (const stmt of raw
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean)) {
      await upgraded.exec(stmt);
    }
  }
  await upgraded.exec(`
    INSERT INTO users (id, name, email) VALUES ('u1', 'A', 'a@u.t'), ('u2', 'B', 'b@u.t');
    INSERT INTO decks (id, owner_id, title, visibility, published_version) VALUES ('d1', 'u1', 'Deck1', 'public', 3);
    INSERT INTO subscriptions (user_id, deck_id, seen_version) VALUES ('u2', 'd1', 0);
  `);
  const mig12 = await readFile(
    path.resolve("drizzle/0012_subscriptions.sql"),
    "utf8",
  );
  for (const stmt of mig12
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean)) {
    await upgraded.exec(stmt);
  }
  const sub = (
    await upgraded.query(
      `SELECT seen_version, dismissed_version FROM subscriptions WHERE user_id = 'u2'`,
    )
  ).rows[0] as { seen_version: number; dismissed_version: number };
  assert.equal(sub.seen_version, 3);
  assert.equal(sub.dismissed_version, 0);

  // DB CHECK blocks self-follow
  await assert.rejects(() =>
    upgraded.exec(
      `INSERT INTO author_subscriptions (follower_id, author_id) VALUES ('u1', 'u1')`,
    ),
  );
  await upgraded.close();
});

test("batch publish, dirty diff detection, unpublish, version-pinned opt-in updates, author follow, auto-subscribe, and rich catalog", async () => {
  // 1. Alice creates two decks with questions and a group; third deck stays empty.
  const { deck: deckA } = await (
    await decksRoute.POST(
      req(alice, "/api/decks", {
        action: "create",
        title: "MySQL 深度解析",
        description: "索引、事务与锁",
        color: "blue",
      }),
    )
  ).json();
  const { deck: deckB } = await (
    await decksRoute.POST(
      req(alice, "/api/decks", {
        action: "create",
        title: "Redis 实战",
        description: "持久化与集群",
        color: "rose",
      }),
    )
  ).json();
  const { deck: emptyDeck } = await (
    await decksRoute.POST(
      req(alice, "/api/decks", {
        action: "create",
        title: "空草稿",
        color: "sand",
      }),
    )
  ).json();

  const { group: groupA } = await (
    await deckGroupsRoute.POST(
      req(alice, "/api/deck-groups", {
        action: "create",
        deckId: deckA.id,
        category: "字节跳动",
        title: "后端一面",
      }),
    )
  ).json();
  const { id: qA1 } = await (
    await questionsRoute.POST(
      req(alice, "/api/questions", {
        action: "create",
        deckId: deckA.id,
        groupId: groupA.id,
        title: "InnoDB MVCC 原理是什么？",
        answer: "ReadView + Undo Log 版本链",
        tags: ["MySQL", "事务"],
      }),
    )
  ).json();
  const { id: qB1 } = await (
    await questionsRoute.POST(
      req(alice, "/api/questions", {
        action: "create",
        deckId: deckB.id,
        title: "Redis RDB 和 AOF 的区别？",
        answer: "快照 vs 追加日志",
        tags: ["Redis"],
      }),
    )
  ).json();
  assert.ok(qB1);

  // Before publishing: publishStatus is "unpublished".
  let aliceWs = await state(alice);
  assert.equal(
    aliceWs.decks.find((d) => d.id === deckA.id)?.publishStatus,
    "unpublished",
  );

  // Batch publish rejects empty deck for first publish (400) and foreign deck (404).
  assert.equal(
    (
      await decksRoute.POST(
        req(alice, "/api/decks", {
          action: "batchPublish",
          items: [{ deckId: emptyDeck.id, expectedVersion: 0 }],
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await decksRoute.POST(
        req(bob, "/api/decks", {
          action: "batchPublish",
          items: [{ deckId: deckA.id, expectedVersion: 0 }],
        }),
      )
    ).status,
    404,
  );

  // Batch publish both deckA and deckB in one atomic transaction!
  const batchPubRes = await decksRoute.POST(
    req(alice, "/api/decks", {
      action: "batchPublish",
      items: [
        { deckId: deckA.id, expectedVersion: 0 },
        { deckId: deckB.id, expectedVersion: 0 },
      ],
      defaultVisibility: "public",
      defaultSummary: "首批整理发布",
    }),
  );
  assert.equal(batchPubRes.status, 200);
  const batchPubJson = await batchPubRes.json();
  assert.equal(batchPubJson.publishedCount, 2);
  assert.equal(batchPubJson.skippedCount, 0);

  aliceWs = await state(alice);
  assert.equal(
    aliceWs.decks.find((d) => d.id === deckA.id)?.publishStatus,
    "synced",
  );
  assert.equal(
    aliceWs.decks.find((d) => d.id === deckB.id)?.publishStatus,
    "synced",
  );

  // 2. Rich catalog + deck preview + author follow + batch subscribe.
  // Default GET /api/catalog returns backward-compatible CatalogDeck[] with enriched metadata.
  const defaultCatRes = await catalogRoute.GET(req(bob, "/api/catalog"));
  assert.equal(defaultCatRes.status, 200);
  const defaultCat = (await defaultCatRes.json()) as CatalogDeck[];
  assert.ok(Array.isArray(defaultCat));
  const catDeckA = defaultCat.find((d) => d.id === deckA.id)!;
  assert.equal(catDeckA.ownerId, alice.id);
  assert.equal(catDeckA.groupCount, 1);
  assert.deepEqual([...catDeckA.tags].sort(), ["MySQL", "事务"].sort());

  // Deck preview works before subscribing.
  const prevRes = await catalogRoute.GET(
    req(bob, `/api/catalog?id=${encodeURIComponent(deckA.id)}&preview=1`),
  );
  assert.equal(prevRes.status, 200);
  const previewData = (await prevRes.json()) as CatalogDeckPreview;
  assert.equal(previewData.groups.length, 1);
  assert.equal(previewData.groups[0].title, "后端一面");
  assert.equal(previewData.sampleQuestions.length, 1);
  assert.equal(previewData.sampleQuestions[0].hasAnswer, true);

  // Self-follow rejected with 400; anonymous rejected with 401; wrong origin rejected with 403.
  assert.equal(
    (
      await authorsRoute.POST(
        req(alice, "/api/authors", { action: "follow", authorId: alice.id }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await authorsRoute.POST(
        req(null, "/api/authors", { action: "follow", authorId: alice.id }),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await authorsRoute.POST(
        req(
          bob,
          "/api/authors",
          { action: "follow", authorId: alice.id },
          "https://evil.example",
        ),
      )
    ).status,
    403,
  );

  // Bob follows Alice with autoSubscribeNew=true and subscribeAll=true (assigning deck group "大神题库").
  const followRes = await authorsRoute.POST(
    req(bob, "/api/authors", {
      action: "follow",
      authorId: alice.id,
      autoSubscribeNew: true,
      subscribeAll: true,
      groupName: "大神题库",
    }),
  );
  assert.equal(followRes.status, 200);
  const followJson = await followRes.json();
  assert.equal(followJson.followed, true);
  assert.equal(followJson.subscribedDecks, 2);

  // Charlie uses batchSubscribe directly for deckA + deckB.
  const batchSubRes = await decksRoute.POST(
    req(charlie, "/api/decks", {
      action: "batchSubscribe",
      deckIds: [deckA.id, deckB.id],
      groupName: "精选",
    }),
  );
  assert.equal(batchSubRes.status, 200);
  assert.equal((await batchSubRes.json()).subscribed, 2);

  // Rich catalog returns both decks & aggregated author stats (followerCount=1, subscriberCount=4 total across 2 decks).
  const richRes = await catalogRoute.GET(
    req(bob, `/api/catalog?mode=rich&author=${encodeURIComponent(alice.id)}`),
  );
  assert.equal(richRes.status, 200);
  const richData = (await richRes.json()) as RichCatalogResponse;
  assert.ok(richData.focusedAuthor);
  assert.equal(richData.focusedAuthor.id, alice.id);
  assert.equal(richData.focusedAuthor.followerCount, 1);
  assert.equal(richData.focusedAuthor.deckCount, 2);
  assert.equal(richData.focusedAuthor.followed, true);
  assert.equal(richData.focusedAuthor.autoSubscribeNew, true);

  // 3. Auto-subscribe-new invariant:
  // Brand-new PUBLIC deck auto-subscribes Bob; brand-new UNLISTED deck does NOT!
  const { deck: deckPublicNew } = await (
    await decksRoute.POST(
      req(alice, "/api/decks", { action: "create", title: "Go 并发编程" }),
    )
  ).json();
  await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "create",
      deckId: deckPublicNew.id,
      title: "GMP 调度原理？",
      answer: "G/M/P 工作窃取",
    }),
  );
  const { deck: deckUnlistedNew } = await (
    await decksRoute.POST(
      req(alice, "/api/decks", { action: "create", title: "私密链接面经" }),
    )
  ).json();
  await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "create",
      deckId: deckUnlistedNew.id,
      title: "内部题目？",
      answer: "仅链接可见",
    }),
  );

  assert.equal(
    (
      await decksRoute.POST(
        req(alice, "/api/decks", {
          action: "batchPublish",
          items: [
            { deckId: deckPublicNew.id, expectedVersion: 0, visibility: "public" },
            {
              deckId: deckUnlistedNew.id,
              expectedVersion: 0,
              visibility: "unlisted",
            },
          ],
        }),
      )
    ).status,
    200,
  );
  let bobWs = await state(bob);
  assert.ok(
    bobWs.decks.some((d) => d.id === deckPublicNew.id),
    "autoSubscribeNew follower must receive new public deck",
  );
  assert.equal(
    bobWs.decks.some((d) => d.id === deckUnlistedNew.id),
    false,
    "autoSubscribeNew must NEVER auto-subscribe unlisted decks",
  );

  // 4. Bob adds personal note & FSRS review on qA1 (v1), then Alice edits qA1 + adds qA2 + publishes v2!
  assert.equal(
    (
      await questionsRoute.POST(
        req(bob, "/api/questions", {
          action: "note",
          id: qA1,
          note: "我的 MVCC 笔记",
          expectedVersion: 0,
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await questionsRoute.POST(
        req(bob, "/api/questions", {
          action: "favorite",
          id: qA1,
          favorite: true,
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await reviewsRoute.POST(
        req(bob, "/api/reviews", {
          questionId: qA1,
          eventId: randomUUID(),
          expectedVersion: 0,
          questionRevision: 1,
          rating: 3,
        }),
      )
    ).status,
    200,
  );

  // Alice edits qA1 and adds qA2 in deckA; deckB remains untouched.
  assert.equal(
    (
      await questionsRoute.POST(
        req(alice, "/api/questions", {
          action: "edit",
          id: qA1,
          expectedRevision: 1,
          title: "InnoDB MVCC 原理是什么？",
          answer: "ReadView + Undo Log + 隐藏列 trx_id / roll_pointer",
          tags: ["MySQL", "事务"],
          major: true,
        }),
      )
    ).status,
    200,
  );
  await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "create",
      deckId: deckA.id,
      groupId: groupA.id,
      title: "间隙锁和临键锁的区别？",
      answer: "左开右开 vs 左开右闭",
      tags: ["MySQL"],
    }),
  );

  // Verify Alice sees exact dirty publish state on deckA and synced on deckB.
  aliceWs = await state(alice);
  const aliceDeckA = aliceWs.decks.find((d) => d.id === deckA.id)!;
  assert.equal(aliceDeckA.publishStatus, "changes");
  assert.deepEqual(aliceDeckA.unpublishedDiff, {
    added: 1,
    updated: 1,
    removed: 0,
    metaChanged: false,
    groupsChanged: false,
  });

  // Batch publish deckA + deckB with skipUnchanged=true: deckA bumps to v2, deckB is skipped at v1!
  const batchUpdateRes = await decksRoute.POST(
    req(alice, "/api/decks", {
      action: "batchPublish",
      items: [
        { deckId: deckA.id, expectedVersion: 1 },
        { deckId: deckB.id, expectedVersion: 1 },
      ],
      defaultVisibility: "public",
      defaultSummary: "补充锁机制与 MVCC 细节",
      skipUnchanged: true,
    }),
  );
  assert.equal(batchUpdateRes.status, 200);
  const batchUpdateJson = await batchUpdateRes.json();
  assert.equal(batchUpdateJson.publishedCount, 1);
  assert.equal(batchUpdateJson.skippedCount, 1);

  // 5. Bob stays PINNED on v1 (in workspace, review API, AND AI tools) until opting in!
  bobWs = await state(bob);
  const bobDeckA = bobWs.decks.find((d) => d.id === deckA.id)!;
  assert.equal(bobDeckA.syncedVersion, 1);
  assert.equal(bobDeckA.publishedVersion, 2);
  assert.equal(bobDeckA.count, 1);
  assert.ok(bobDeckA.pendingUpdate);
  assert.equal(bobDeckA.pendingUpdate.fromVersion, 1);
  assert.equal(bobDeckA.pendingUpdate.toVersion, 2);
  assert.equal(bobDeckA.pendingUpdate.added, 1);
  assert.equal(bobDeckA.pendingUpdate.updated, 1);
  assert.equal(bobDeckA.pendingUpdate.summary, "补充锁机制与 MVCC 细节");

  // Bob's scoped AI search sees ONLY v1 questions while pinned to v1!
  const aiSearchV1 = await executeWorkspaceTool(
    bob.id,
    "deck",
    deckA.id,
    "search_questions",
    JSON.stringify({ query: "间隙锁" }),
  );
  assert.equal(
    (aiSearchV1.output as { matches: unknown[] }).matches.length,
    0,
    "AI tools must respect subscriber pinned release version",
  );

  // Bob can still submit a review on v1 (revision 1) without hitting 409!
  assert.equal(
    (
      await reviewsRoute.POST(
        req(bob, "/api/reviews", {
          questionId: qA1,
          eventId: randomUUID(),
          expectedVersion: 1,
          questionRevision: 1,
          rating: 4,
        }),
      )
    ).status,
    200,
  );
  const bobCardBeforeUpdate = (await state(bob)).questions.find(
    (q) => q.id === qA1,
  )!;

  // Bob clicks "暂不更新" (dismissUpdate): dismissedVersion=2, syncedVersion stays 1!
  const dismissRes = await decksRoute.POST(
    req(bob, "/api/decks", {
      action: "dismissUpdate",
      deckId: deckA.id,
      version: 2,
    }),
  );
  assert.equal(dismissRes.status, 200);
  bobWs = await state(bob);
  assert.equal(
    bobWs.decks.find((d) => d.id === deckA.id)?.dismissedVersion,
    2,
  );
  assert.equal(bobWs.decks.find((d) => d.id === deckA.id)?.syncedVersion, 1);

  // Bob clicks "立即更新" (applyUpdate): upgrades to v2 while preserving note, favorite & FSRS!
  const applyRes = await decksRoute.POST(
    req(bob, "/api/decks", { action: "applyUpdate", deckId: deckA.id }),
  );
  assert.equal(applyRes.status, 200);
  assert.equal((await applyRes.json()).syncedVersion, 2);

  bobWs = await state(bob);
  const bobDeckAAfter = bobWs.decks.find((d) => d.id === deckA.id)!;
  assert.equal(bobDeckAAfter.syncedVersion, 2);
  assert.equal(bobDeckAAfter.dismissedVersion, 0);
  assert.equal(bobDeckAAfter.pendingUpdate, null);
  assert.equal(bobDeckAAfter.count, 2);
  const bobCardAfterUpdate = bobWs.questions.find((q) => q.id === qA1)!;
  assert.equal(bobCardAfterUpdate.revision, 2);
  assert.equal(bobCardAfterUpdate.note, "我的 MVCC 笔记");
  assert.equal(bobCardAfterUpdate.favorite, true);
  assert.deepEqual(bobCardAfterUpdate.fsrs, bobCardBeforeUpdate.fsrs);

  // Charlie uses applyAllUpdates to batch-update all outdated subscriptions!
  const applyAllRes = await decksRoute.POST(
    req(charlie, "/api/decks", { action: "applyAllUpdates" }),
  );
  assert.equal(applyAllRes.status, 200);
  assert.equal((await applyAllRes.json()).updated, 1);
  assert.equal(
    (await state(charlie)).decks.find((d) => d.id === deckA.id)?.syncedVersion,
    2,
  );

  // 6. Export includes followedAuthors.
  const expJson = await (
    await exportRoute.GET(req(bob, "/api/export"))
  ).json();
  assert.equal(expJson.followedAuthors.length, 1);
  assert.equal(expJson.followedAuthors[0].authorId, alice.id);

  // 7. Unpublish hides deckB from catalog & blocks new subscriptions while preserving Bob's existing subscription!
  assert.equal(
    (
      await decksRoute.POST(
        req(alice, "/api/decks", { action: "unpublish", deckId: deckB.id }),
      )
    ).status,
    200,
  );
  const catAfterUnpub = (await (
    await catalogRoute.GET(req(charlie, "/api/catalog"))
  ).json()) as CatalogDeck[];
  assert.equal(
    catAfterUnpub.some((d) => d.id === deckB.id),
    false,
  );
  // Preview of unpublished (private) deck is denied to non-owners (404).
  assert.equal(
    (
      await catalogRoute.GET(
        req(charlie, `/api/catalog?id=${encodeURIComponent(deckB.id)}&preview=1`),
      )
    ).status,
    404,
  );
  // Bob's existing subscription to deckB stays intact!
  assert.ok((await state(bob)).decks.some((d) => d.id === deckB.id));

  // 8. Unfollow (default keeps decks) + batchUnsubscribe + setAutoSubscribe 404 after unfollow.
  assert.equal(
    (
      await authorsRoute.POST(
        req(bob, "/api/authors", { action: "unfollow", authorId: alice.id }),
      )
    ).status,
    200,
  );
  bobWs = await state(bob);
  assert.equal(bobWs.followedAuthors?.length, 0);
  assert.ok(bobWs.decks.some((d) => d.id === deckA.id));
  assert.equal(
    (
      await authorsRoute.POST(
        req(bob, "/api/authors", {
          action: "setAutoSubscribe",
          authorId: alice.id,
          autoSubscribeNew: false,
        }),
      )
    ).status,
    404,
  );

  const batchUnsubRes = await decksRoute.POST(
    req(charlie, "/api/decks", {
      action: "batchUnsubscribe",
      deckIds: [deckA.id, deckB.id],
    }),
  );
  assert.equal(batchUnsubRes.status, 200);
  assert.equal((await batchUnsubRes.json()).removed, 2);
});

after(async () => {
  const dbState = globalThis as unknown as {
    interviewDatabase?: Promise<{ close: () => Promise<void> }>;
  };
  await (await dbState.interviewDatabase)?.close();
});
