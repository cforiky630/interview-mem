import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import dns from "node:dns/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as pgliteDrizzle } from "drizzle-orm/pglite";
import { migrate as pgliteMigrate } from "drizzle-orm/pglite/migrator";
import * as dbSchema from "../src/db/schema";
import type { CatalogDeckPreview, Workspace } from "../src/lib/types";
import {
  computeUnpublishedDiff,
  normalizeReleaseGroups,
} from "../src/lib/subscriptions";
import {
  buildSearchFromRoute,
  extractAuthorParam,
  extractSubscribeParam,
  parseRouteFromSearch,
} from "../src/lib/navigation";
import {
  createFolder,
  deleteFolderToTrash,
  dissolveFolder,
  editFolder,
  groupIntoNewFolder,
  moveFolder,
  placeSubscriptionInFolder,
  type WorkspaceMutate,
} from "../src/lib/client";

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
const workspaceRoute = await import("../src/app/api/workspace/route");
const catalogRoute = await import("../src/app/api/catalog/route");
const decksRoute = await import("../src/app/api/decks/route");
const questionsRoute = await import("../src/app/api/questions/route");
const trashRoute = await import("../src/app/api/questions/trash/route");
const reviewsRoute = await import("../src/app/api/reviews/route");
const authorsRoute = await import("../src/app/api/authors/route");
const previewRoute = await import("../src/app/api/import/preview/route");
const commitRoute = await import("../src/app/api/import/commit/route");
const exportRoute = await import("../src/app/api/export/route");
const restoreRoute = await import("../src/app/api/backup/restore/route");
const chatRoute = await import("../src/app/api/chat/route");
const settingsRoute = await import("../src/app/api/settings/route");
const { executeWorkspaceTool } = await import("../src/server/ai-tools");
const { validateFolderTitle } = await import("../src/lib/folders");
const {
  buildServerFolderTree,
  createFolderInTx,
  deleteFolderToTrashInTx,
  dissolveFolderInTx,
  groupIntoNewFolderInTx,
  moveFolderInTx,
} = await import("../src/server/folders");
const { buildOwnedPublishSubtree } = await import("../src/server/workspace");

type Account = { id: string; cookie: string; deckId: string };
let alice: Account;
let charlie: Account;
let ipCounter = 1;

function req(
  account: Account,
  urlPath: string,
  body?: unknown,
  options?: { method?: string; headers?: Record<string, string> },
) {
  const method = options?.method ?? (body === undefined ? "GET" : "POST");
  return new Request(`http://localhost:3000${urlPath}`, {
    method,
    headers: {
      cookie: account.cookie,
      origin: "http://localhost:3000",
      "x-workspace-user": account.id,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options?.headers ?? {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function getWs(account: Account): Promise<Workspace> {
  const res = await workspaceRoute.GET(req(account, "/api/workspace"));
  assert.equal(res.status, 200);
  return res.json();
}

async function getEtag(account: Account): Promise<string> {
  const res = await workspaceRoute.GET(req(account, "/api/workspace"));
  assert.equal(res.status, 200);
  const etag = res.headers.get("etag");
  assert.ok(etag);
  return etag;
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
        "x-forwarded-for": `198.51.106.${++ipCounter}`,
      },
      body: JSON.stringify({
        name,
        email: `${name}@folder-redesign.test`,
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
  account.deckId = (await getWs(account)).decks[0].id;
  return account;
}

before(async () => {
  alice = await register("fr-alice");
  charlie = await register("fr-charlie");
});

test("migration 0014 -> 0015 -> 0016 upgrades 4-layer data losslessly with zero spurious publish diffs and preserves parentId fork lineage", async () => {
  const pg = new PGlite();
  const journal = JSON.parse(
    await readFile(path.resolve("drizzle/meta/_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };

  const execSqlFile = async (tag: string) => {
    const raw = await readFile(path.resolve("drizzle", `${tag}.sql`), "utf8");
    for (const stmt of raw
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean)) {
      await pg.exec(stmt);
    }
  };

  // Apply migrations 0000..0014
  for (const entry of journal.entries) {
    if (entry.idx > 14) break;
    await execSqlFile(entry.tag);
  }

  // Seed legacy 4-layer data:
  // - Alice has deck_pub ("Redis", group_name="后端", published_version=1) with 2 groups:
  //   g1 (category="字节跳动", title="抖音一面") and g2 (category="", title="综合面"),
  //   plus ungrouped question q_ungrouped, grouped questions q_g1, q_g2, unfiled q_unfiled,
  //   and forked question q_fork (parent_id = q_g1).
  // - Alice also has an unpublished colliding sibling deck_dup ("redis", group_name="后端") to verify published wins the original name.
  // - Bob subscribes to deck_pub with seen_version=1 and group_name="我的订阅", plus study progress & note.
  const qG1 = "11111111-1111-4111-8111-111111111111";
  const qG2 = "22222222-2222-4222-8222-222222222222";
  const qUngrouped = "33333333-3333-4333-8333-333333333333";
  const qUnfiled = "44444444-4444-4444-8444-444444444444";
  const qFork = "55555555-5555-4555-8555-555555555555";
  const g1Id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const g2Id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  const v1Groups = [
    {
      id: g1Id,
      title: "抖音一面",
      category: "字节跳动",
      description: "",
      position: 0,
    },
    {
      id: g2Id,
      title: "综合面",
      category: "",
      description: "",
      position: 1,
    },
  ];
  const v1Questions = [
    {
      id: qG1,
      groupId: g1Id,
      position: 0,
      title: "Redis 跳表原理",
      answer: "多层有序链表",
      tags: ["Redis"],
      revision: 1,
      majorRevision: 0,
      needsEditing: false,
      archived: false,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    },
    {
      id: qG2,
      groupId: g2Id,
      position: 0,
      title: "Redis 持久化",
      answer: "RDB 与 AOF",
      tags: ["Redis"],
      revision: 1,
      majorRevision: 0,
      needsEditing: false,
      archived: false,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    },
    {
      id: qUngrouped,
      groupId: null,
      position: 0,
      title: "Redis 单线程为什么快",
      answer: "内存 + IO 多路复用",
      tags: ["Redis"],
      revision: 1,
      majorRevision: 0,
      needsEditing: false,
      archived: false,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    },
  ];

  await pg.exec(`
    INSERT INTO users (id, name, email) VALUES
      ('u_alice', 'Alice', 'alice@mig.test'),
      ('u_bob', 'Bob', 'bob@mig.test');
    INSERT INTO decks (id, owner_id, title, description, group_name, visibility, published_version) VALUES
      ('deck_pub', 'u_alice', 'Redis', '缓存精讲', '后端', 'public', 1),
      ('deck_dup', 'u_alice', 'redis', '草稿副本', '后端', 'private', 0);
    INSERT INTO deck_groups (id, deck_id, owner_id, title, category, description, position) VALUES
      ('${g1Id}', 'deck_pub', 'u_alice', '抖音一面', '字节跳动', '', 0),
      ('${g2Id}', 'deck_pub', 'u_alice', '综合面', '', '', 1);
    INSERT INTO questions (id, owner_id, deck_id, group_id, parent_id, title, answer, source_text, content_hash, tags) VALUES
      ('${qG1}', 'u_alice', 'deck_pub', '${g1Id}', NULL, 'Redis 跳表原理', '多层有序链表', '多层有序链表', 'h1', '["Redis"]'::jsonb),
      ('${qG2}', 'u_alice', 'deck_pub', '${g2Id}', NULL, 'Redis 持久化', 'RDB 与 AOF', 'RDB 与 AOF', 'h2', '["Redis"]'::jsonb),
      ('${qUngrouped}', 'u_alice', 'deck_pub', NULL, NULL, 'Redis 单线程为什么快', '内存 + IO 多路复用', '内存 + IO 多路复用', 'h3', '["Redis"]'::jsonb),
      ('${qUnfiled}', 'u_alice', NULL, NULL, NULL, '根级零散题', '直接放根目录', '直接放根目录', 'h4', '[]'::jsonb),
      ('${qFork}', 'u_alice', NULL, NULL, '${qG1}', '复刻题保留血缘', '改写答案', '改写答案', 'h5', '[]'::jsonb);
    INSERT INTO subscriptions (user_id, deck_id, seen_version, group_name) VALUES
      ('u_bob', 'deck_pub', 1, '我的订阅');
    INSERT INTO study_cards (user_id, question_id, note, favorite, fsrs) VALUES
      ('u_bob', '${qG1}', 'Bob 的私有笔记', true, '{"due":"2026-04-01T00:00:00Z","reps":2}'::jsonb);
  `);
  await pg.query(
    `INSERT INTO deck_releases (deck_id, version, title, description, summary, groups, questions) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
    [
      "deck_pub",
      1,
      "Redis",
      "缓存精讲",
      "v1",
      JSON.stringify(v1Groups),
      JSON.stringify(v1Questions),
    ],
  );

  // Execute 0015 and 0016
  await execSqlFile("0015_folder_tree");
  await execSqlFile("0016_drop_legacy_groups");

  // 1. Legacy table & columns dropped cleanly
  const legacyTableCheck = await pg.query(
    `SELECT to_regclass('public.deck_groups') AS tbl`,
  );
  assert.equal((legacyTableCheck.rows[0] as { tbl: string | null }).tbl, null);

  // 2. Verify migrated folder hierarchy for Alice
  const aliceDecks = (
    await pg.query(
      `SELECT id, parent_id, title, description, visibility, published_version, color, owner_id, created_at, updated_at, deleted_at FROM decks WHERE owner_id = 'u_alice' AND deleted_at IS NULL`,
    )
  ).rows as Array<{
    id: string;
    parent_id: string | null;
    title: string;
    description: string;
    visibility: string;
    published_version: number;
    color: string;
    owner_id: string;
    created_at: Date;
    updated_at: Date;
    deleted_at: Date | null;
  }>;

  const backendFolder = aliceDecks.find(
    (d) => d.parent_id === null && d.title === "后端",
  );
  assert.ok(backendFolder, "group_name='后端' became top-level folder");

  const pubDeck = aliceDecks.find((d) => d.id === "deck_pub")!;
  assert.equal(pubDeck.parent_id, backendFolder.id);
  assert.equal(pubDeck.title, "Redis", "published deck keeps original title");

  const dupDeck = aliceDecks.find((d) => d.id === "deck_dup")!;
  assert.equal(dupDeck.parent_id, backendFolder.id);
  assert.notEqual(
    dupDeck.title.toLowerCase(),
    "redis",
    "colliding unpublished sibling gets deduplicated title",
  );

  const catFolder = aliceDecks.find(
    (d) => d.parent_id === "deck_pub" && d.title === "字节跳动",
  );
  assert.ok(catFolder, "non-empty category became child folder under deck_pub");

  const g1Folder = aliceDecks.find((d) => d.id === g1Id)!;
  assert.equal(
    g1Folder.parent_id,
    catFolder.id,
    "g1 kept stable ID under category folder",
  );
  const g2Folder = aliceDecks.find((d) => d.id === g2Id)!;
  assert.equal(
    g2Folder.parent_id,
    "deck_pub",
    "empty-category g2 attached directly under deck_pub",
  );

  // 3. Verify questions moved to migrated folders & parent_id fork lineage preserved
  const qsRows = (
    await pg.query(
      `SELECT id, deck_id, parent_id, title, answer, tags, revision, major_revision, needs_editing, archived, position, created_at, updated_at FROM questions WHERE owner_id = 'u_alice'`,
    )
  ).rows as Array<{
    id: string;
    deck_id: string | null;
    parent_id: string | null;
    title: string;
    answer: string;
    tags: string[];
    revision: number;
    major_revision: number;
    needs_editing: boolean;
    archived: boolean;
    position: number;
    created_at: Date;
    updated_at: Date;
  }>;
  const qById = new Map(qsRows.map((q) => [q.id, q]));
  assert.equal(qById.get(qG1)?.deck_id, g1Id);
  assert.equal(qById.get(qG2)?.deck_id, g2Id);
  assert.equal(qById.get(qUngrouped)?.deck_id, "deck_pub");
  assert.equal(qById.get(qUnfiled)?.deck_id, null);
  assert.equal(
    qById.get(qFork)?.parent_id,
    qG1,
    "questions.parent_id fork lineage preserved",
  );

  // 4. Verify Bob's subscription placement & study progress survived
  const bobFolder = (
    await pg.query(
      `SELECT id, title FROM decks WHERE owner_id = 'u_bob' AND parent_id IS NULL AND title = '我的订阅'`,
    )
  ).rows[0] as { id: string; title: string } | undefined;
  assert.ok(bobFolder, "subscriber group_name became personal folder");
  const bobSub = (
    await pg.query(
      `SELECT folder_id, seen_version FROM subscriptions WHERE user_id = 'u_bob' AND deck_id = 'deck_pub'`,
    )
  ).rows[0] as { folder_id: string | null; seen_version: number };
  assert.equal(bobSub.folder_id, bobFolder.id);
  assert.equal(bobSub.seen_version, 1);
  const bobCard = (
    await pg.query(
      `SELECT note, favorite FROM study_cards WHERE user_id = 'u_bob' AND question_id = $1`,
      [qG1],
    )
  ).rows[0] as { note: string; favorite: boolean };
  assert.equal(bobCard.note, "Bob 的私有笔记");
  assert.equal(bobCard.favorite, true);

  // 5. CRITICAL: Migrated synced published deck MUST show ZERO spurious unpublished diffs against legacy v1 snapshot!
  const normalizedFolders = aliceDecks.map((d) => ({
    id: d.id,
    ownerId: d.owner_id,
    parentId: d.parent_id,
    title: d.title,
    description: d.description,
    color: d.color,
    visibility: d.visibility,
    publishedVersion: d.published_version,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    deletedAt: d.deleted_at,
  }));
  const tree = buildServerFolderTree(normalizedFolders);
  const liveSubtree = buildOwnedPublishSubtree(
    tree,
    tree.byId.get("deck_pub")!,
    qsRows
      .filter(
        (q) =>
          q.deck_id &&
          ["deck_pub", catFolder.id, g1Id, g2Id].includes(q.deck_id),
      )
      .map((q) => ({
        id: q.id,
        deckId: q.deck_id,
        parentId: q.parent_id,
        position: q.position,
        title: q.title,
        answer: q.answer,
        tags: q.tags,
        validation: null,
        revision: q.revision,
        majorRevision: q.major_revision,
        needsEditing: q.needs_editing,
        archived: q.archived,
        createdAt: q.created_at,
        updatedAt: q.updated_at,
      })),
  );
  const diffCheck = computeUnpublishedDiff(
    {
      title: pubDeck.title,
      description: pubDeck.description,
      groups: liveSubtree.groups,
      questions: liveSubtree.questions,
    },
    {
      version: 1,
      title: "Redis",
      description: "缓存精讲",
      groups: v1Groups,
      questions: v1Questions,
    },
  );
  assert.equal(
    diffCheck.publishStatus,
    "synced",
    `expected zero spurious changes on migrated synced deck, got diff=${JSON.stringify(diffCheck.unpublishedDiff)}`,
  );
  assert.equal(diffCheck.unpublishedDiff, null);

  // Legacy v1 release snapshot normalizes cleanly to 2-level hierarchy for subscriber browsing
  const normGroups = normalizeReleaseGroups(v1Groups);
  const synthCat = normGroups.find(
    (g) => g.title === "字节跳动" && g.parentId === null,
  );
  assert.ok(synthCat);
  assert.equal(normGroups.find((g) => g.id === g1Id)?.parentId, synthCat.id);
  assert.equal(normGroups.find((g) => g.id === g2Id)?.parentId, null);

  await pg.close();
});

test("folder tree enforces Finder name validation, sibling uniqueness, cycle/depth<=8 guards, 3-way conflict resolution, Redis/Redis dissolve, trash mode, and groupIntoNew", async () => {
  // 1. Finder name validation
  for (const badName of [
    "   ",
    "a/b",
    "a\\b",
    ".",
    "..",
    "hi\u0000there",
    "a".repeat(81),
  ]) {
    const r = await decksRoute.POST(
      req(alice, "/api/decks", { action: "create", title: badName }),
    );
    assert.equal(
      r.status,
      400,
      `expected 400 for invalid title ${JSON.stringify(badName)}`,
    );
  }

  // 2. Case-insensitive sibling uniqueness under same parent, allowed under different parent
  const { deck: boxA } = await (
    await decksRoute.POST(
      req(alice, "/api/decks", { action: "create", title: "TreeBoxA" }),
    )
  ).json();
  const { deck: boxB } = await (
    await decksRoute.POST(
      req(alice, "/api/decks", { action: "create", title: "TreeBoxB" }),
    )
  ).json();

  const { deck: redisA } = await (
    await decksRoute.POST(
      req(alice, "/api/decks", {
        action: "create",
        parentId: boxA.id,
        title: "Redis",
      }),
    )
  ).json();
  const dupSibling = await decksRoute.POST(
    req(alice, "/api/decks", {
      action: "create",
      parentId: boxA.id,
      title: "  redis  ",
    }),
  );
  assert.equal(dupSibling.status, 409);
  assert.equal((await dupSibling.json()).code, "FOLDER_NAME_CONFLICT");

  // Same name under boxB succeeds
  const { deck: redisB } = await (
    await decksRoute.POST(
      req(alice, "/api/decks", {
        action: "create",
        parentId: boxB.id,
        title: "redis",
      }),
    )
  ).json();
  assert.ok(redisB.id);

  // 3. Cycle prevention: self and ancestor-into-descendant
  const { deck: subA } = await (
    await decksRoute.POST(
      req(alice, "/api/decks", {
        action: "create",
        parentId: redisA.id,
        title: "Sub",
      }),
    )
  ).json();
  assert.equal(
    (
      await decksRoute.POST(
        req(alice, "/api/decks", {
          action: "moveFolder",
          folderId: redisA.id,
          targetParentId: redisA.id,
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await decksRoute.POST(
        req(alice, "/api/decks", {
          action: "moveFolder",
          folderId: boxA.id,
          targetParentId: subA.id,
        }),
      )
    ).status,
    400,
  );

  // 4. Max depth 8 enforcement
  let chainParentId: string | null = null;
  const chainIds: string[] = [];
  for (let level = 1; level <= 8; level++) {
    const res = await decksRoute.POST(
      req(alice, "/api/decks", {
        action: "create",
        parentId: chainParentId,
        title: `Depth${level}`,
      }),
    );
    assert.equal(res.status, 200);
    const { deck } = await res.json();
    chainIds.push(deck.id);
    chainParentId = deck.id;
  }
  // Depth 9 create rejected
  assert.equal(
    (
      await decksRoute.POST(
        req(alice, "/api/decks", {
          action: "create",
          parentId: chainIds[7],
          title: "Depth9",
        }),
      )
    ).status,
    400,
  );
  // Moving 2-level subtree (redisA -> subA) into Depth7 (depth 7 + height 2 = 9 > 8) rejected
  assert.equal(
    (
      await decksRoute.POST(
        req(alice, "/api/decks", {
          action: "moveFolder",
          folderId: redisA.id,
          targetParentId: chainIds[6],
        }),
      )
    ).status,
    400,
  );
  // groupIntoNew wrapping Depth1 (subtree height 8 -> 9) rejected
  assert.equal(
    (
      await decksRoute.POST(
        req(alice, "/api/decks", {
          action: "groupIntoNew",
          parentId: null,
          title: "TooDeepWrap",
          folderIds: [chainIds[0]],
        }),
      )
    ).status,
    400,
  );

  // 5. 3-way conflict resolution on moveFolder: abort / keepBoth / recursive merge
  const { deck: subB } = await (
    await decksRoute.POST(
      req(alice, "/api/decks", {
        action: "create",
        parentId: redisB.id,
        title: "sub",
      }),
    )
  ).json();
  const { id: qInSubA } = await (
    await questionsRoute.POST(
      req(alice, "/api/questions", {
        action: "create",
        deckId: subA.id,
        title: "递归合并子题 A",
        answer: "答案 A",
      }),
    )
  ).json();
  const { id: qInSubB } = await (
    await questionsRoute.POST(
      req(alice, "/api/questions", {
        action: "create",
        deckId: subB.id,
        title: "递归合并子题 B",
        answer: "答案 B",
      }),
    )
  ).json();
  assert.ok(qInSubB);

  // abort -> 409 FOLDER_NAME_CONFLICT with conflict details
  const abortMove = await decksRoute.POST(
    req(alice, "/api/decks", {
      action: "moveFolder",
      folderId: redisA.id,
      targetParentId: boxB.id,
      conflictStrategy: "abort",
    }),
  );
  assert.equal(abortMove.status, 409);
  const abortBody = await abortMove.json();
  assert.equal(abortBody.code, "FOLDER_NAME_CONFLICT");
  assert.equal(abortBody.details.conflicts[0].sourceId, redisA.id);
  assert.equal(abortBody.details.conflicts[0].existingId, redisB.id);

  // recursive merge -> redisA merges into redisB AND subA merges into subB!
  const etagBeforeMove = await getEtag(alice);
  const mergeMove = await decksRoute.POST(
    req(alice, "/api/decks", {
      action: "moveFolder",
      folderId: redisA.id,
      targetParentId: boxB.id,
      conflictStrategy: "merge",
    }),
  );
  assert.equal(mergeMove.status, 200);
  assert.notEqual(
    await getEtag(alice),
    etagBeforeMove,
    "ETag changes on folder move/merge",
  );
  let ws = await getWs(alice);
  assert.equal(
    ws.decks.some((d) => d.id === redisA.id),
    false,
  );
  assert.equal(
    ws.decks.some((d) => d.id === subA.id),
    false,
  );
  assert.equal(ws.questions.find((q) => q.id === qInSubA)?.deckId, subB.id);

  // keepBoth -> auto-renames colliding folder to "redis (2)"
  const { deck: keepSrc } = await (
    await decksRoute.POST(
      req(alice, "/api/decks", {
        action: "create",
        parentId: boxA.id,
        title: "Redis",
      }),
    )
  ).json();
  const keepBothRes = await decksRoute.POST(
    req(alice, "/api/decks", {
      action: "moveFolder",
      folderId: keepSrc.id,
      targetParentId: boxB.id,
      conflictStrategy: "keepBoth",
    }),
  );
  assert.equal(keepBothRes.status, 200);
  ws = await getWs(alice);
  assert.equal(ws.decks.find((d) => d.id === keepSrc.id)?.title, "Redis (2)");

  // 6. Edge case: dissolving "SameName / SameName" lifts child cleanly without self-collision!
  const { deck: outerSame } = await (
    await decksRoute.POST(
      req(alice, "/api/decks", { action: "create", title: "SameName" }),
    )
  ).json();
  const { deck: innerSame } = await (
    await decksRoute.POST(
      req(alice, "/api/decks", {
        action: "create",
        parentId: outerSame.id,
        title: "SameName",
      }),
    )
  ).json();
  const { id: qInner } = await (
    await questionsRoute.POST(
      req(alice, "/api/questions", {
        action: "create",
        deckId: innerSame.id,
        title: "嵌套同名文件夹内题目",
        answer: "应无冲突提升",
      }),
    )
  ).json();
  const dissolveSame = await decksRoute.POST(
    req(alice, "/api/decks", {
      action: "dissolve",
      folderId: outerSame.id,
      conflictStrategy: "abort",
    }),
  );
  assert.equal(dissolveSame.status, 200, await dissolveSame.clone().text());
  ws = await getWs(alice);
  const liftedInner = ws.decks.find((d) => d.id === innerSame.id)!;
  assert.equal(liftedInner.parentId, null);
  assert.equal(liftedInner.title, "SameName");
  assert.equal(ws.questions.find((q) => q.id === qInner)?.deckId, innerSame.id);

  // 7. Delete folder (mode: "trash") trashes subtree items with real folderPath & lifts placed subscriptions safely!
  // Publish a Charlie deck and let Alice subscribe to it.
  const { deck: charlieDeck } = await (
    await decksRoute.POST(
      req(charlie, "/api/decks", {
        action: "create",
        title: "Charlie 公开资料",
      }),
    )
  ).json();
  await questionsRoute.POST(
    req(charlie, "/api/questions", {
      action: "create",
      deckId: charlieDeck.id,
      title: "Charlie 题目",
      answer: "Charlie 答案",
    }),
  );
  await decksRoute.POST(
    req(charlie, "/api/decks", {
      action: "publish",
      deckId: charlieDeck.id,
      expectedVersion: 0,
      visibility: "public",
      summary: "v1",
    }),
  );

  const { deck: survivingRoot } = await (
    await decksRoute.POST(
      req(alice, "/api/decks", { action: "create", title: "保留上级目录" }),
    )
  ).json();
  const { deck: trashParent } = await (
    await decksRoute.POST(
      req(alice, "/api/decks", {
        action: "create",
        parentId: survivingRoot.id,
        title: "待删大目录",
      }),
    )
  ).json();
  const { deck: trashChild } = await (
    await decksRoute.POST(
      req(alice, "/api/decks", {
        action: "create",
        parentId: trashParent.id,
        title: "待删子目录",
      }),
    )
  ).json();
  const { id: qTrashSub } = await (
    await questionsRoute.POST(
      req(alice, "/api/questions", {
        action: "create",
        deckId: trashChild.id,
        title: "随目录进回收站",
        answer: "30 天内可恢复",
      }),
    )
  ).json();
  await decksRoute.POST(
    req(alice, "/api/decks", {
      action: "subscribe",
      deckId: charlieDeck.id,
      folderId: trashParent.id,
    }),
  );

  const trashDelRes = await decksRoute.POST(
    req(alice, "/api/decks", {
      action: "delete",
      deckId: trashParent.id,
      mode: "trash",
    }),
  );
  assert.equal(trashDelRes.status, 200);
  const trashList = (await (
    await trashRoute.GET(req(alice, "/api/questions/trash"))
  ).json()) as Array<{ id: string; folderPath?: string }>;
  const trashedEntry = trashList.find((t) => t.id === qTrashSub);
  assert.ok(trashedEntry, "subtree item moved to trash");
  assert.equal(trashedEntry.folderPath, "保留上级目录");

  // Placed subscription lifted to surviving parent (survivingRoot), NOT unsubscribed!
  ws = await getWs(alice);
  assert.equal(
    ws.decks.find((d) => d.id === charlieDeck.id)?.parentId,
    survivingRoot.id,
  );
  // Restoring trashed item restores cleanly into surviving parent folder (survivingRoot)
  const restoredTrashed = await (
    await questionsRoute.POST(
      req(alice, "/api/questions", { action: "restore", id: qTrashSub }),
    )
  ).json();
  assert.equal(restoredTrashed.deckId, survivingRoot.id);

  // Move restored question and subscription to root for groupIntoNew check
  await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "move",
      id: qTrashSub,
      deckId: null,
    }),
  );
  await decksRoute.POST(
    req(alice, "/api/decks", {
      action: "placeSubscription",
      deckId: charlieDeck.id,
      folderId: null,
    }),
  );

  // 8. groupIntoNew atomically groups folder + question + placed subscription into one new folder!
  const { deck: gFolder } = await (
    await decksRoute.POST(
      req(alice, "/api/decks", { action: "create", title: "待归组子目录" }),
    )
  ).json();
  const etagBeforeGroup = await getEtag(alice);
  const groupRes = await decksRoute.POST(
    req(alice, "/api/decks", {
      action: "groupIntoNew",
      parentId: null,
      title: "归组新目录",
      folderIds: [gFolder.id],
      questionIds: [qTrashSub],
      subscriptionDeckIds: [charlieDeck.id],
    }),
  );
  assert.equal(groupRes.status, 200);
  const { folder: groupedFolder } = await groupRes.json();
  assert.notEqual(await getEtag(alice), etagBeforeGroup);
  ws = await getWs(alice);
  assert.equal(
    ws.decks.find((d) => d.id === gFolder.id)?.parentId,
    groupedFolder.id,
  );
  assert.equal(
    ws.questions.find((q) => q.id === qTrashSub)?.deckId,
    groupedFolder.id,
  );
  assert.equal(
    ws.decks.find((d) => d.id === charlieDeck.id)?.parentId,
    groupedFolder.id,
  );
});

test("global soft dedup handles non-blocking notices, blank-stub scoping, explicit move strategies, and reversible mergeDuplicates", async () => {
  const { deck: f1 } = await (
    await decksRoute.POST(
      req(alice, "/api/decks", { action: "create", title: "去重目录A" }),
    )
  ).json();
  const { deck: f2 } = await (
    await decksRoute.POST(
      req(alice, "/api/decks", { action: "create", title: "去重目录B" }),
    )
  ).json();

  // Answered card: cross-folder duplicate returns global soft notice without blocking
  const { id: a1 } = await (
    await questionsRoute.POST(
      req(alice, "/api/questions", {
        action: "create",
        deckId: f1.id,
        title: "全局软去重核心题",
        answer: "非空答案走全局匹配",
        tags: ["基础"],
      }),
    )
  ).json();
  const a2Res = await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "create",
      deckId: f2.id,
      title: "全局软去重核心题",
      answer: "非空答案走全局匹配",
      tags: ["高阶"],
    }),
  );
  assert.equal(a2Res.status, 200);
  const a2Json = (await a2Res.json()) as {
    id: string;
    duplicates?: Array<{ id: string; path: string; scope: string }>;
  };
  assert.equal(a2Json.duplicates?.[0]?.id, a1);
  assert.equal(a2Json.duplicates?.[0]?.path, "去重目录A");
  assert.equal(a2Json.duplicates?.[0]?.scope, "global");

  // Blank-answer stubs only warn inside SAME folder, not across different folders
  await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "create",
      deckId: f1.id,
      title: "空白待补题目",
      answer: "",
    }),
  );
  const blankOtherFolder = await (
    await questionsRoute.POST(
      req(alice, "/api/questions", {
        action: "create",
        deckId: f2.id,
        title: "空白待补题目",
        answer: "",
      }),
    )
  ).json();
  assert.equal(blankOtherFolder.duplicates?.length ?? 0, 0);
  const blankSameFolder = await (
    await questionsRoute.POST(
      req(alice, "/api/questions", {
        action: "create",
        deckId: f1.id,
        title: "空白待补题目",
        answer: "",
      }),
    )
  ).json();
  assert.equal(blankSameFolder.duplicates?.[0]?.scope, "sameFolder");

  // Moving a2 -> f1: default "check" returns 409 DUPLICATE_IN_TARGET; "keepBoth" allows coexistence
  const checkMove = await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "move",
      id: a2Json.id,
      deckId: f1.id,
    }),
  );
  assert.equal(checkMove.status, 409);
  assert.equal((await checkMove.json()).code, "DUPLICATE_IN_TARGET");

  const keepMove = await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "move",
      id: a2Json.id,
      deckId: f1.id,
      duplicateStrategy: "keepBoth",
    }),
  );
  assert.equal(keepMove.status, 200);

  // Add note on a1; add stronger FSRS + note + favorite on a2; then mergeDuplicates into a1
  await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "note",
      id: a1,
      note: "主卡片原有笔记",
      expectedVersion: 0,
    }),
  );
  await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "note",
      id: a2Json.id,
      note: "重复卡片补充思路",
      expectedVersion: 0,
    }),
  );
  await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "favorite",
      id: a2Json.id,
      favorite: true,
    }),
  );
  await reviewsRoute.POST(
    req(alice, "/api/reviews", {
      questionId: a2Json.id,
      eventId: randomUUID(),
      expectedVersion: 0,
      questionRevision: 1,
      rating: 4,
    }),
  );

  const mergeRes = await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "mergeDuplicates",
      primaryId: a1,
      duplicateIds: [a2Json.id],
      appendNotes: true,
      keepStrongerFsrs: true,
      mergeTags: true,
    }),
  );
  assert.equal(mergeRes.status, 200);
  const ws = await getWs(alice);
  const merged = ws.questions.find((q) => q.id === a1)!;
  assert.ok(merged.note.includes("主卡片原有笔记"));
  assert.ok(merged.note.includes("重复卡片补充思路"));
  assert.deepEqual([...merged.tags].sort(), ["基础", "高阶"].sort());
  assert.equal(merged.favorite, true);
  assert.ok(
    merged.fsrs && merged.fsrs.reps >= 1,
    "stronger FSRS progress preserved on primary card",
  );
  // Duplicate card moved to 30-day trash (reversible!)
  assert.equal(
    ws.questions.some((q) => q.id === a2Json.id),
    false,
  );
  const trashItems = (await (
    await trashRoute.GET(req(alice, "/api/questions/trash"))
  ).json()) as Array<{ id: string }>;
  assert.ok(trashItems.some((t) => t.id === a2Json.id));
});

test("local folder import previews global soft dedup, leaves zero empty folders on cancel, supports forceIncludeKeys override, and rejects depth > 8", async () => {
  const { deck: importBase } = await (
    await decksRoute.POST(
      req(alice, "/api/decks", { action: "create", title: "导入测试根" }),
    )
  ).json();
  const { deck: otherFolder } = await (
    await decksRoute.POST(
      req(alice, "/api/decks", { action: "create", title: "已有资料目录" }),
    )
  ).json();
  const { id: existingId } = await (
    await questionsRoute.POST(
      req(alice, "/api/questions", {
        action: "create",
        deckId: otherFolder.id,
        title: "TCP 三次握手为什么不是两次",
        answer: "防止历史失效连接请求造成资源浪费",
      }),
    )
  ).json();

  // Preview 2 local files containing 1 global duplicate + 2 new questions
  const cancelBatchId1 = randomUUID();
  const cancelBatchId2 = randomUUID();
  const prevRes = await previewRoute.POST(
    req(alice, "/api/import/preview", {
      deckId: importBase.id,
      inputType: "qa",
      method: "rules",
      sources: [
        {
          batchId: cancelBatchId1,
          sourceName: "计算机网络/传输层/tcp.md",
          raw: "## TCP 三次握手为什么不是两次\n防止历史失效连接请求造成资源浪费\n\n## TCP 四次挥手 TIME_WAIT 作用\n保证最后一个 ACK 到达并让旧报文消逝\n",
        },
        {
          batchId: cancelBatchId2,
          sourceName: "计算机网络/应用层/http.md",
          raw: "## HTTP/2 多路复用原理\n基于二进制分帧层在单 TCP 连接并发传输多个流\n",
        },
      ],
    }),
  );
  assert.equal(prevRes.status, 200, await prevRes.clone().text());
  const prevData = await prevRes.json();
  const dupItem = prevData.previews[0].questions.find((q: { title: string }) =>
    q.title.includes("三次握手"),
  );
  assert.ok(
    dupItem.duplicateMatches?.some(
      (m: { id: string; path: string }) =>
        m.id === existingId && m.path === "已有资料目录",
    ),
    "preview surfaces global exact duplicate with real folder path",
  );

  // Cancel preview -> zero folders created under importBase!
  const delPrev = await previewRoute.DELETE(
    req(
      alice,
      "/api/import/preview",
      { batchIds: [cancelBatchId1, cancelBatchId2] },
      { method: "DELETE" },
    ),
  );
  assert.equal(delPrev.status, 200);
  let ws = await getWs(alice);
  assert.equal(
    ws.decks.some((d) => d.parentId === importBase.id),
    false,
    "cancelling preview leaves zero empty folders",
  );

  // Re-preview & commit with relativeFolderPath: default skips global duplicate and imports new items atomically
  const commitBatchId1 = randomUUID();
  const commitBatchId2 = randomUUID();
  const prev2 = await (
    await previewRoute.POST(
      req(alice, "/api/import/preview", {
        deckId: importBase.id,
        inputType: "qa",
        method: "rules",
        sources: [
          {
            batchId: commitBatchId1,
            sourceName: "计算机网络/传输层/tcp.md",
            raw: "## TCP 三次握手为什么不是两次\n防止历史失效连接请求造成资源浪费\n\n## TCP 四次挥手 TIME_WAIT 作用\n保证最后一个 ACK 到达并让旧报文消逝\n",
          },
          {
            batchId: commitBatchId2,
            sourceName: "计算机网络/应用层/http.md",
            raw: "## HTTP/2 多路复用原理\n基于二进制分帧层在单 TCP 连接并发传输多个流\n",
          },
        ],
      }),
    )
  ).json();

  // Exceeding depth 8 rejects cleanly with 0 partial folders created
  const tooDeepRes = await commitRoute.POST(
    req(alice, "/api/import/commit", {
      batchId: commitBatchId1,
      targetFolderId: importBase.id,
      relativeFolderPath: ["a", "b", "c", "d", "e", "f", "g", "h"],
      questions: prev2.previews[0].questions,
    }),
  );
  assert.equal(tooDeepRes.status, 400);
  ws = await getWs(alice);
  assert.equal(
    ws.decks.some((d) => d.parentId === importBase.id),
    false,
  );

  // Valid commit creates 计算机网络 -> 传输层 & 应用层 atomically and skips global duplicate by default
  const commitOk = await (
    await commitRoute.POST(
      req(alice, "/api/import/commit", {
        targetFolderId: importBase.id,
        batches: [
          {
            batchId: commitBatchId1,
            relativeFolderPath: ["计算机网络", "传输层"],
            questions: prev2.previews[0].questions,
          },
          {
            batchId: commitBatchId2,
            relativeFolderPath: ["计算机网络", "应用层"],
            questions: prev2.previews[1].questions,
          },
        ],
      }),
    )
  ).json();
  assert.equal(commitOk.added, 2);
  assert.equal(commitOk.duplicates, 1);

  // Override soft dedup via forceIncludeKeys (single-file preview)
  const forceBatchId = randomUUID();
  const prev3 = await (
    await previewRoute.POST(
      req(alice, "/api/import/preview", {
        batchId: forceBatchId,
        deckId: importBase.id,
        inputType: "qa",
        method: "rules",
        sourceName: "计算机网络/传输层/override.md",
        raw: "## TCP 三次握手为什么不是两次\n防止历史失效连接请求造成资源浪费\n",
      }),
    )
  ).json();
  const forceKey = prev3.questions[0].key;
  const forceCommit = await (
    await commitRoute.POST(
      req(alice, "/api/import/commit", {
        batchId: forceBatchId,
        targetFolderId: importBase.id,
        relativeFolderPath: ["计算机网络", "传输层"],
        questions: prev3.questions,
        forceIncludeKeys: [forceKey],
      }),
    )
  ).json();
  assert.equal(forceCommit.added, 1);
  assert.equal(forceCommit.duplicates, 0);
});

test("nested independent publishing isolates aliases, guards autoSubscribeNew/subscribeAll ancestors, excludes placed subscriptions, and preserves AI subscriber privacy", async () => {
  const author = await register("np-author");
  const follower = await register("np-follower");
  const followerNew = await register("np-new");
  const dualSub = await register("np-dual");
  const thirdAuthor = await register("np-third");

  // Third author publishes a public deck that `author` subscribes to and places INSIDE `Backend`
  const { deck: thirdDeck } = await (
    await decksRoute.POST(
      req(thirdAuthor, "/api/decks", {
        action: "create",
        title: "外部订阅资料",
      }),
    )
  ).json();
  await questionsRoute.POST(
    req(thirdAuthor, "/api/questions", {
      action: "create",
      deckId: thirdDeck.id,
      title: "外部作者私有版权题",
      answer: "绝不能被二次发布",
    }),
  );
  await decksRoute.POST(
    req(thirdAuthor, "/api/decks", {
      action: "publish",
      deckId: thirdDeck.id,
      expectedVersion: 0,
      visibility: "public",
      summary: "v1",
    }),
  );

  // Author builds Backend -> Redis -> Cluster
  const { deck: backend } = await (
    await decksRoute.POST(
      req(author, "/api/decks", { action: "create", title: "Backend" }),
    )
  ).json();
  const { deck: redis } = await (
    await decksRoute.POST(
      req(author, "/api/decks", {
        action: "create",
        parentId: backend.id,
        title: "Redis",
      }),
    )
  ).json();
  const { deck: cluster } = await (
    await decksRoute.POST(
      req(author, "/api/decks", {
        action: "create",
        parentId: redis.id,
        title: "Cluster",
      }),
    )
  ).json();

  await questionsRoute.POST(
    req(author, "/api/questions", {
      action: "create",
      deckId: backend.id,
      title: "Backend 总览题",
      answer: "架构总览",
    }),
  );
  const { id: qRedis } = await (
    await questionsRoute.POST(
      req(author, "/api/questions", {
        action: "create",
        deckId: redis.id,
        title: "Redis 内存淘汰策略",
        answer: "allkeys-lru 等 8 种",
      }),
    )
  ).json();
  await questionsRoute.POST(
    req(author, "/api/questions", {
      action: "create",
      deckId: cluster.id,
      title: "Redis Cluster 哈希槽",
      answer: "16384 个槽位",
    }),
  );

  // Author places thirdDeck subscription INSIDE Backend
  await decksRoute.POST(
    req(author, "/api/decks", {
      action: "subscribe",
      deckId: thirdDeck.id,
      folderId: backend.id,
    }),
  );

  // Author publishes Backend (v1)
  const pubBackend = await decksRoute.POST(
    req(author, "/api/decks", {
      action: "publish",
      deckId: backend.id,
      expectedVersion: 0,
      visibility: "public",
      summary: "后端总册 v1",
    }),
  );
  assert.equal(pubBackend.status, 200);

  // Follower follows author with autoSubscribeNew + subscribeAll -> receives Backend ONLY (and NEVER thirdDeck!)
  await authorsRoute.POST(
    req(follower, "/api/authors", {
      action: "follow",
      authorId: author.id,
      autoSubscribeNew: true,
      subscribeAll: true,
    }),
  );
  let followerWs = await getWs(follower);
  assert.equal(
    followerWs.decks.some((d) => d.id === backend.id),
    true,
  );
  assert.equal(
    followerWs.questions.some((q) => q.title === "外部作者私有版权题"),
    false,
    "placed subscriptions must be structurally excluded from personal publish snapshots",
  );
  assert.equal(
    followerWs.questions.filter((q) => q.deckId === backend.id).length,
    3,
  );

  // Author now ALSO independently publishes child folder `Redis` (nested published folder!)
  const pubRedis = await decksRoute.POST(
    req(author, "/api/decks", {
      action: "publish",
      deckId: redis.id,
      expectedVersion: 0,
      visibility: "public",
      summary: "Redis 专题独立发布",
    }),
  );
  assert.equal(pubRedis.status, 200);

  // Ancestor guard on autoSubscribeNew: follower ALREADY subscribes to ancestor Backend -> NOT auto-subscribed to Redis!
  followerWs = await getWs(follower);
  assert.equal(
    followerWs.decks.some((d) => d.id === redis.id),
    false,
    "autoSubscribeNew must skip descendant deck when follower already subscribes to public ancestor",
  );

  // Ancestor guard on follow(subscribeAll: true): brand-new follower only subscribes to top-most Backend, not redundant child Redis!
  await authorsRoute.POST(
    req(followerNew, "/api/authors", {
      action: "follow",
      authorId: author.id,
      subscribeAll: true,
    }),
  );
  const newFollowerWs = await getWs(followerNew);
  assert.equal(
    newFollowerWs.decks.some((d) => d.id === backend.id),
    true,
  );
  assert.equal(
    newFollowerWs.decks.some((d) => d.id === redis.id),
    false,
  );

  // Dual subscriber explicitly subscribes to BOTH Backend and Redis -> publication alias isolates IDs cleanly!
  await decksRoute.POST(
    req(dualSub, "/api/decks", { action: "subscribe", deckId: backend.id }),
  );
  await decksRoute.POST(
    req(dualSub, "/api/decks", { action: "subscribe", deckId: redis.id }),
  );
  const dualWs = await getWs(dualSub);
  const dualFromBackend = dualWs.questions.find(
    (q) => q.deckId === backend.id && q.title === "Redis 内存淘汰策略",
  )!;
  const dualFromRedis = dualWs.questions.find(
    (q) => q.deckId === redis.id && q.title === "Redis 内存淘汰策略",
  )!;
  assert.ok(dualFromBackend && dualFromRedis);
  assert.equal(dualFromBackend.id, qRedis);
  assert.notEqual(
    dualFromRedis.id,
    dualFromBackend.id,
    "nested independent publish must mint distinct alias ID for overlapping question",
  );

  // Subscriber AI privacy boundary + placed subscription inside personal folder AI subtree scope:
  // Author renames Redis -> "未发布绝密草稿目录" and adds draft question WITHOUT publishing v2 of Backend
  await decksRoute.POST(
    req(author, "/api/decks", {
      action: "edit",
      deckId: redis.id,
      expected: { title: "Redis", description: "" },
      title: "未发布绝密草稿目录",
      description: "",
    }),
  );
  await questionsRoute.POST(
    req(author, "/api/questions", {
      action: "create",
      deckId: redis.id,
      title: "未发布绝密草稿题",
      answer: "仅作者可见",
    }),
  );

  // Follower places Backend (pinned at v1) inside personal folder "FollowerRoot" and adds a personal card in a child folder
  const { deck: followerRoot } = await (
    await decksRoute.POST(
      req(follower, "/api/decks", { action: "create", title: "FollowerRoot" }),
    )
  ).json();
  const { deck: followerSub } = await (
    await decksRoute.POST(
      req(follower, "/api/decks", {
        action: "create",
        parentId: followerRoot.id,
        title: "个人子目录",
      }),
    )
  ).json();
  await questionsRoute.POST(
    req(follower, "/api/questions", {
      action: "create",
      deckId: followerSub.id,
      title: "Follower 自建题",
      answer: "个人笔记内容",
    }),
  );
  const etagBeforePlace = await getEtag(follower);
  assert.equal(
    (
      await decksRoute.POST(
        req(follower, "/api/decks", {
          action: "placeSubscription",
          deckId: backend.id,
          folderId: followerRoot.id,
        }),
      )
    ).status,
    200,
  );
  assert.notEqual(
    await getEtag(follower),
    etagBeforePlace,
    "ETag changes when placing subscription in a personal folder",
  );

  // AI subtree search on FollowerRoot sees BOTH owned subtree AND placed subscription at v1 — and NEVER leaks author's live draft!
  const aiOverview = await executeWorkspaceTool(
    follower.id,
    "deck",
    followerRoot.id,
    "list_workspace_overview",
    "{}",
  );
  const overviewStr = JSON.stringify(aiOverview.output);
  assert.ok(overviewStr.includes("FollowerRoot / 个人子目录"));
  assert.ok(overviewStr.includes("FollowerRoot / Backend / Redis"));
  assert.equal(
    overviewStr.includes("未发布绝密草稿目录"),
    false,
    "subscriber AI overview must never leak author's live unpublished folder rename",
  );

  const aiSearch = await executeWorkspaceTool(
    follower.id,
    "deck",
    followerRoot.id,
    "search_questions",
    JSON.stringify({ query: "未发布绝密草稿题" }),
  );
  assert.equal((aiSearch.output as { matches: unknown[] }).matches.length, 0);

  const aiDetail = await executeWorkspaceTool(
    follower.id,
    "deck",
    followerRoot.id,
    "get_question_detail",
    JSON.stringify({ questionId: qRedis }),
  );
  const detailOut = aiDetail.output as { folderPath: string };
  assert.equal(detailOut.folderPath, "FollowerRoot / Backend / Redis");
});

test("backup merge-restore supports legacy v1, v2 (groupName/category/deckGroups synthesis), and v3 (nested parentId + subscription folderId + cycle/depth safety) idempotently", async () => {
  // 1. Restore synthetic v1 backup into a fresh account
  const v1User = await register("bk-v1");
  const v1Payload = {
    format: "shiyi-backup",
    version: 1,
    decks: [
      {
        id: "v1-deck-1",
        title: "V1 老题单",
        description: "老版本",
        color: "blue",
      },
    ],
    questions: [
      {
        id: "10000000-0000-4000-8000-000000000001",
        deckId: "v1-deck-1",
        title: "V1 老题目",
        answer: "V1 老答案",
        tags: ["Legacy"],
      },
    ],
    personalStudyState: [
      {
        questionId: "10000000-0000-4000-8000-000000000001",
        note: "V1 个人笔记",
        favorite: true,
      },
    ],
  };
  const rV1 = await restoreRoute.POST(
    req(v1User, "/api/backup/restore", v1Payload),
  );
  assert.equal(rV1.status, 200);
  const wsV1 = await getWs(v1User);
  const v1Q = wsV1.questions.find((q) => q.title === "V1 老题目")!;
  assert.ok(v1Q);
  assert.equal(v1Q.deckTitle, "V1 老题单");
  assert.equal(v1Q.note, "V1 个人笔记");
  assert.equal(v1Q.favorite, true);

  // 2. Restore synthetic v2 backup (groupName + deckGroups + category) into fresh account and verify idempotency
  const v2User = await register("bk-v2");
  const v2Payload = {
    format: "shiyi-backup",
    version: 2,
    decks: [
      {
        id: "v2-deck-1",
        title: "后端面经",
        description: "",
        groupName: "大厂真题",
        color: "sage",
      },
    ],
    deckGroups: [
      {
        id: "v2-grp-1",
        deckId: "v2-deck-1",
        category: "字节跳动",
        title: "抖音一面",
        description: "",
      },
    ],
    questions: [
      {
        id: "20000000-0000-4000-8000-000000000001",
        deckId: "v2-deck-1",
        groupId: "v2-grp-1",
        title: "V2 分组内题目",
        answer: "应合成四层目录路径",
        tags: ["面经"],
      },
    ],
  };
  const rV2First = await restoreRoute.POST(
    req(v2User, "/api/backup/restore", v2Payload),
  );
  assert.equal(rV2First.status, 200);
  const wsV2 = await getWs(v2User);
  const v2Q = wsV2.questions.find((q) => q.title === "V2 分组内题目")!;
  assert.ok(v2Q);
  assert.equal(v2Q.folderPath, "大厂真题 / 后端面经 / 字节跳动 / 抖音一面");

  const rV2Second = await (
    await restoreRoute.POST(req(v2User, "/api/backup/restore", v2Payload))
  ).json();
  assert.equal(rV2Second.restored.decks, 0);
  assert.equal(rV2Second.restored.questions, 0);

  // 3. Export v3 from a user with nested folders + placed subscription and restore into a fresh user
  const srcUser = await register("bk-v3-src");
  const dstUser = await register("bk-v3-dst");
  const pubOwner = await register("bk-v3-pub");

  const { deck: pubDeck } = await (
    await decksRoute.POST(
      req(pubOwner, "/api/decks", { action: "create", title: "公共题库V3" }),
    )
  ).json();
  await questionsRoute.POST(
    req(pubOwner, "/api/questions", {
      action: "create",
      deckId: pubDeck.id,
      title: "公共题目V3",
      answer: "公共答案",
    }),
  );
  await decksRoute.POST(
    req(pubOwner, "/api/decks", {
      action: "publish",
      deckId: pubDeck.id,
      expectedVersion: 0,
      visibility: "public",
      summary: "v1",
    }),
  );

  const { deck: lvl1 } = await (
    await decksRoute.POST(
      req(srcUser, "/api/decks", { action: "create", title: "学习体系" }),
    )
  ).json();
  const { deck: lvl2 } = await (
    await decksRoute.POST(
      req(srcUser, "/api/decks", {
        action: "create",
        parentId: lvl1.id,
        title: "数据库",
      }),
    )
  ).json();
  await questionsRoute.POST(
    req(srcUser, "/api/questions", {
      action: "create",
      deckId: lvl2.id,
      title: "V3 嵌套题",
      answer: "B+ 树索引",
    }),
  );
  await decksRoute.POST(
    req(srcUser, "/api/decks", {
      action: "subscribe",
      deckId: pubDeck.id,
      folderId: lvl1.id,
    }),
  );

  const v3Export = await (
    await exportRoute.GET(req(srcUser, "/api/export"))
  ).json();
  assert.equal(v3Export.version, 3);
  assert.equal(v3Export.subscriptions[0].folderId, lvl1.id);

  const rV3 = await restoreRoute.POST(
    req(dstUser, "/api/backup/restore", v3Export),
  );
  assert.equal(rV3.status, 200);
  const wsDst = await getWs(dstUser);
  const dstQ = wsDst.questions.find((q) => q.title === "V3 嵌套题")!;
  assert.equal(dstQ.folderPath, "学习体系 / 数据库");
  const dstLvl1 = wsDst.decks.find((d) => d.isOwner && d.title === "学习体系")!;
  const dstSub = wsDst.decks.find((d) => !d.isOwner && d.id === pubDeck.id)!;
  assert.equal(
    dstSub.parentId,
    dstLvl1.id,
    "restored subscription preserves folderId placement",
  );

  // 4. Adversarial cyclic v3 payload is safely clamped without infinite loops or 500s
  const cyclicUser = await register("bk-cyclic");
  const cyclicRes = await restoreRoute.POST(
    req(cyclicUser, "/api/backup/restore", {
      format: "shiyi-backup",
      version: 3,
      decks: [
        { id: "cyc-a", parentId: "cyc-b", title: "环A" },
        { id: "cyc-b", parentId: "cyc-a", title: "环B" },
      ],
      questions: [],
    }),
  );
  assert.equal(cyclicRes.status, 200);
  const wsCyclic = await getWs(cyclicUser);
  assert.ok(wsCyclic.decks.some((d) => d.title === "环A"));
  assert.ok(wsCyclic.decks.some((d) => d.title === "环B"));
});

test("URL routing preserves legacy ?deck=, ?group=, ?subscribe=, ?author= bookmarks and round-trips quick views", () => {
  assert.deepEqual(parseRouteFromSearch("?view=library&deck=d123&group=g456"), {
    view: "library",
    deckId: "d123",
    groupId: "g456",
  });
  assert.deepEqual(parseRouteFromSearch("?view=library&folder=f789"), {
    view: "library",
    deckId: "f789",
  });
  assert.deepEqual(parseRouteFromSearch("?view=library&deck=unfiled"), {
    view: "library",
    deckId: null,
  });
  assert.deepEqual(parseRouteFromSearch("?view=library&quick=duplicates"), {
    view: "library",
    quickView: "duplicates",
  });
  assert.equal(
    buildSearchFromRoute({ view: "library", quickView: "recent" }),
    "?view=library&quick=recent",
  );
  const qFromQuick = parseRouteFromSearch(
    buildSearchFromRoute({
      view: "question",
      questionId: "q-1",
      originView: "library",
      originQuickView: "favorites",
    }),
  );
  assert.deepEqual(qFromQuick, {
    view: "question",
    questionId: "q-1",
    originView: "library",
    originQuickView: "favorites",
  });
  assert.equal(extractSubscribeParam("?subscribe=pub-deck-1"), "pub-deck-1");
  assert.equal(extractAuthorParam("?author=creator-1"), "creator-1");
});

test("review regressions: client helpers match /api/decks schema, dissolve keepBoth with A + A (2), groupIntoNew ancestor+child guard, batchPublish ancestor ordering, lazy import folder creation, legacy slash sanitization, materialized multi-level backup restore, and subscriber chat placement prefix", async () => {
  // 1. Client helpers in src/lib/client.ts MUST serialize exact schemas accepted by /api/decks!
  const clientUser = await register("client-contract");
  const mutateViaRoute: WorkspaceMutate = async (url, payload) => {
    assert.equal(url, "/api/decks");
    const res = await decksRoute.POST(req(clientUser, url, payload));
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw Object.assign(new Error(String(json.error ?? res.status)), {
        status: res.status,
        code: json.code,
        details: json.details,
      });
    }
    return json;
  };
  const created1 = await createFolder(mutateViaRoute, {
    title: "ClientParent",
    color: "blue",
  });
  const f1Id = String(created1!.id);
  const created2 = await createFolder(mutateViaRoute, {
    title: "ClientChild",
    color: "sage",
  });
  const f2Id = String(created2!.id);
  await editFolder(mutateViaRoute, {
    deckId: f1Id,
    title: "ClientParentRenamed",
    description: "已更新简介",
    color: "sand",
    expected: { title: "ClientParent", description: "", color: "blue" },
  });
  await moveFolder(mutateViaRoute, {
    folderId: f2Id,
    targetParentId: f1Id,
    conflictStrategy: "abort",
  });
  await dissolveFolder(mutateViaRoute, f1Id, "abort");
  const wsAfterClient = await getWs(clientUser);
  assert.equal(
    wsAfterClient.decks.find((d) => d.id === f2Id)?.parentId,
    null,
    "dissolved parent lifted ClientChild cleanly via client helpers",
  );
  await deleteFolderToTrash(mutateViaRoute, f2Id);
  const wsAfterTrash = await getWs(clientUser);
  assert.equal(
    wsAfterTrash.decks.some((d) => d.id === f2Id),
    false,
  );

  // Also test groupIntoNewFolder and placeSubscriptionInFolder client helpers
  const { deck: grpSrc } = await (
    await decksRoute.POST(
      req(clientUser, "/api/decks", { action: "create", title: "SubToWrap" }),
    )
  ).json();
  const grouped = await groupIntoNewFolder(mutateViaRoute, {
    parentId: null,
    title: "ClientGroupWrap",
    folderIds: [grpSrc.id],
  });
  assert.ok((grouped?.folder as { id: string } | undefined)?.id);
  // Check parent name collision returns conflictKind: "targetParent"
  await assert.rejects(
    () =>
      groupIntoNewFolder(mutateViaRoute, {
        parentId: null,
        title: "ClientGroupWrap",
        folderIds: [],
      }),
    (err: {
      status?: number;
      code?: string;
      details?: { conflictKind?: string };
    }) =>
      err.status === 409 &&
      err.code === "FOLDER_NAME_CONFLICT" &&
      err.details?.conflictKind === "targetParent",
  );

  // 2. dissolveFolderInTx keepBoth when parent has "A" and dissolved folder has BOTH "A" and "A (2)"
  const disUser = await register("dissolve-keepboth");
  const { deck: pA } = await (
    await decksRoute.POST(
      req(disUser, "/api/decks", { action: "create", title: "A" }),
    )
  ).json();
  assert.ok(pA.id);
  const { deck: container } = await (
    await decksRoute.POST(
      req(disUser, "/api/decks", { action: "create", title: "Container" }),
    )
  ).json();
  const { deck: childA } = await (
    await decksRoute.POST(
      req(disUser, "/api/decks", {
        action: "create",
        parentId: container.id,
        title: "A",
      }),
    )
  ).json();
  const { deck: childA2 } = await (
    await decksRoute.POST(
      req(disUser, "/api/decks", {
        action: "create",
        parentId: container.id,
        title: "A (2)",
      }),
    )
  ).json();
  const disKeep = await decksRoute.POST(
    req(disUser, "/api/decks", {
      action: "dissolve",
      folderId: container.id,
      conflictStrategy: "keepBoth",
    }),
  );
  assert.equal(disKeep.status, 200, await disKeep.clone().text());
  const wsDis = await getWs(disUser);
  const titlesAtRoot = wsDis.decks
    .filter((d) => d.isOwner && d.parentId === null)
    .map((d) => d.title);
  assert.ok(titlesAtRoot.includes("A"));
  assert.ok(titlesAtRoot.includes("A (2)"));
  assert.ok(
    titlesAtRoot.includes("A (3)"),
    `got root titles: ${titlesAtRoot.join(", ")}`,
  );
  assert.equal(wsDis.decks.find((d) => d.id === childA2.id)?.title, "A (2)");
  assert.equal(wsDis.decks.find((d) => d.id === childA.id)?.title, "A (3)");

  // 3. groupIntoNewFolderInTx rejects overlapping parent + child selection cleanly (400, no 500 CHECK crash)
  const { deck: ovParent } = await (
    await decksRoute.POST(
      req(disUser, "/api/decks", { action: "create", title: "Overlap" }),
    )
  ).json();
  const { deck: ovChild } = await (
    await decksRoute.POST(
      req(disUser, "/api/decks", {
        action: "create",
        parentId: ovParent.id,
        title: "Overlap",
      }),
    )
  ).json();
  const ovRes = await decksRoute.POST(
    req(disUser, "/api/decks", {
      action: "groupIntoNew",
      parentId: null,
      title: "OverlapTarget",
      folderIds: [ovChild.id, ovParent.id],
      conflictStrategy: "merge",
    }),
  );
  assert.equal(ovRes.status, 400);

  // 4. batchPublish with [child, parent] order still deduplicates autoSubscribeNew (follower only subscribes to parent!)
  const bpAuthor = await register("bp-order-author");
  const bpFollower = await register("bp-order-follower");
  const { deck: bpSeed } = await (
    await decksRoute.POST(
      req(bpAuthor, "/api/decks", { action: "create", title: "前置公开题库" }),
    )
  ).json();
  await questionsRoute.POST(
    req(bpAuthor, "/api/questions", {
      action: "create",
      deckId: bpSeed.id,
      title: "前置公开题",
      answer: "答案",
    }),
  );
  await decksRoute.POST(
    req(bpAuthor, "/api/decks", {
      action: "publish",
      deckId: bpSeed.id,
      expectedVersion: 0,
      visibility: "public",
    }),
  );
  const bpFollowRes = await authorsRoute.POST(
    req(bpFollower, "/api/authors", {
      action: "follow",
      authorId: bpAuthor.id,
      autoSubscribeNew: true,
      subscribeAll: false,
    }),
  );
  assert.equal(bpFollowRes.status, 200);
  const { deck: bpParent } = await (
    await decksRoute.POST(
      req(bpAuthor, "/api/decks", { action: "create", title: "父体系" }),
    )
  ).json();
  const { deck: bpChild } = await (
    await decksRoute.POST(
      req(bpAuthor, "/api/decks", {
        action: "create",
        parentId: bpParent.id,
        title: "子体系",
      }),
    )
  ).json();
  await questionsRoute.POST(
    req(bpAuthor, "/api/questions", {
      action: "create",
      deckId: bpChild.id,
      title: "批量嵌套排序测试题",
      answer: "答案内容",
    }),
  );
  // Deliberately pass child BEFORE parent!
  const bpRes = await decksRoute.POST(
    req(bpAuthor, "/api/decks", {
      action: "batchPublish",
      items: [
        { deckId: bpChild.id, expectedVersion: 0, visibility: "public" },
        { deckId: bpParent.id, expectedVersion: 0, visibility: "public" },
      ],
      defaultVisibility: "public",
      defaultSummary: "nested",
    }),
  );
  assert.equal(bpRes.status, 200);
  const wsFollower = await getWs(bpFollower);
  const subIds = wsFollower.decks.filter((d) => !d.isOwner).map((d) => d.id);
  assert.ok(
    subIds.includes(bpParent.id),
    "follower auto-subscribed to ancestor",
  );
  assert.ok(
    !subIds.includes(bpChild.id),
    "follower MUST NOT be redundantly auto-subscribed to child when batchPublish lists child before parent",
  );

  // 5. commitImport does NOT create empty orphan folders when all items in a subfolder are skipped as duplicates!
  const impUser = await register("imp-no-orphan");
  await questionsRoute.POST(
    req(impUser, "/api/questions", {
      action: "create",
      deckId: impUser.deckId,
      title: "全局重复卡",
      answer: "一模一样的答案",
    }),
  );
  const dupBatchId = randomUUID();
  const freshBatchId = randomUUID();
  const prevRes = await previewRoute.POST(
    req(impUser, "/api/import/preview", {
      deckId: null,
      inputType: "qa",
      method: "whole",
      sources: [
        {
          batchId: dupBatchId,
          sourceName: "OrphanDupDir/dup.md",
          raw: "# 全局重复卡\n\n一模一样的答案",
        },
        {
          batchId: freshBatchId,
          sourceName: "RealNewDir/fresh.md",
          raw: "# 全新卡\n\n全新答案",
        },
      ],
    }),
  );
  assert.equal(prevRes.status, 200);
  const prevBody = (await prevRes.json()) as {
    previews: Array<{
      batchId: string;
      questions: Array<{
        key: string;
        title: string;
        answer: string;
        tags: string[];
      }>;
    }>;
  };
  const dupItem = prevBody.previews.find((p) => p.batchId === dupBatchId)!
    .questions[0];
  const freshItem = prevBody.previews.find((p) => p.batchId === freshBatchId)!
    .questions[0];
  const commitRes = await commitRoute.POST(
    req(impUser, "/api/import/commit", {
      targetFolderId: null,
      batches: [
        {
          batchId: dupBatchId,
          relativeFolderPath: ["OrphanDupDir"],
          questions: [
            {
              key: dupItem.key,
              title: "全局重复卡",
              answer: "一模一样的答案",
              tags: [],
            },
          ],
        },
        {
          batchId: freshBatchId,
          relativeFolderPath: ["RealNewDir"],
          questions: [
            {
              key: freshItem.key,
              title: "全新卡",
              answer: "全新答案",
              tags: [],
            },
          ],
        },
      ],
    }),
  );
  assert.equal(commitRes.status, 200);
  const commitBody = (await commitRes.json()) as {
    added: number;
    duplicates: number;
    createdFolders?: number;
  };
  assert.equal(commitBody.added, 1);
  assert.equal(commitBody.duplicates, 1);
  assert.equal(commitBody.createdFolders, 1);
  const wsImp = await getWs(impUser);
  assert.equal(
    wsImp.decks.some((d) => d.title === "OrphanDupDir"),
    false,
    "all-duplicate subfolder MUST NOT be created as an empty orphan folder",
  );
  assert.equal(
    wsImp.decks.some((d) => d.title === "RealNewDir"),
    true,
  );

  // 6. 0015_folder_tree sanitizes legacy slash / whitespace titles & is idempotent when re-run
  const pgSlash = new PGlite();
  const journal = JSON.parse(
    await readFile(path.resolve("drizzle/meta/_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };
  const execSql = async (tag: string) => {
    const raw = await readFile(path.resolve("drizzle", `${tag}.sql`), "utf8");
    for (const stmt of raw
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean)) {
      await pgSlash.exec(stmt);
    }
  };
  for (const entry of journal.entries) {
    if (entry.idx > 14) break;
    await execSql(entry.tag);
  }
  await pgSlash.exec(`
    INSERT INTO users (id, name, email) VALUES ('u_slash', 'Slash', 'slash@mig.test');
    INSERT INTO decks (id, owner_id, title, description, group_name) VALUES
      ('d_tcp', 'u_slash', '  TCP/IP  ', '', 'C/C++');
    INSERT INTO deck_groups (id, deck_id, owner_id, title, category, description, position) VALUES
      ('g_io', 'd_tcp', 'u_slash', 'HTTP/2\\gRPC', 'I/O', '', 0);
  `);
  await execSql("0015_folder_tree");
  // Re-run 0015 to verify idempotency!
  await execSql("0015_folder_tree");
  await execSql("0016_drop_legacy_groups");
  const migratedSlash = (
    await pgSlash.query(
      `SELECT id, title FROM decks WHERE owner_id = 'u_slash' AND deleted_at IS NULL`,
    )
  ).rows as Array<{ id: string; title: string }>;
  assert.equal(migratedSlash.length, 4);
  for (const row of migratedSlash) {
    assert.equal(
      validateFolderTitle(row.title),
      null,
      `migrated title ${JSON.stringify(row.title)} must pass validateFolderTitle`,
    );
  }
  assert.equal(migratedSlash.find((r) => r.id === "d_tcp")?.title, "TCP／IP");
  assert.equal(
    migratedSlash.find((r) => r.id === "g_io")?.title,
    "HTTP／2／gRPC",
  );
  await pgSlash.close();

  // 7. Backup restore: (a) materialized multi-level subscription preserves nested groups,
  // (b) intentional same-folder duplicates in v3 backup both restore with distinct notes,
  // (c) legacy slash titles are sanitized cleanly.
  const bkUser = await register("bk-multi-dup");
  const bkRes = await restoreRoute.POST(
    req(bkUser, "/api/backup/restore", {
      format: "shiyi-backup",
      version: 3,
      decks: [
        {
          id: "unavail-sub",
          title: "外部订阅/已下架",
          isOwner: false,
          groups: [
            {
              id: "sg-1",
              deckId: "unavail-sub",
              parentId: null,
              title: "一级章",
            },
            {
              id: "sg-2",
              deckId: "unavail-sub",
              parentId: "sg-1",
              title: "二级节",
            },
          ],
        },
        {
          id: "dup-folder",
          title: "同目录双份",
          isOwner: true,
        },
      ],
      questions: [
        {
          id: "q-sub-nested",
          deckId: "unavail-sub",
          groupId: "sg-2",
          isOwner: false,
          title: "下架订阅深层题",
          answer: "深层答案",
        },
        {
          id: "q-dup-1",
          deckId: "dup-folder",
          isOwner: true,
          title: "故意保留两份的题",
          answer: "完全相同答案",
          note: "卡片一的独特笔记",
        },
        {
          id: "q-dup-2",
          deckId: "dup-folder",
          isOwner: true,
          title: "故意保留两份的题",
          answer: "完全相同答案",
          note: "卡片二的独特笔记",
        },
      ],
    }),
  );
  assert.equal(bkRes.status, 200);
  const wsBk = await getWs(bkUser);
  const nestedSubQ = wsBk.questions.find((q) => q.title === "下架订阅深层题")!;
  assert.equal(
    nestedSubQ.folderPath,
    "外部订阅／已下架 / 一级章 / 二级节",
    "materialized multi-level subscription must preserve nested group parentId & sanitize slashes",
  );
  const restoredDups = wsBk.questions.filter(
    (q) => q.title === "故意保留两份的题",
  );
  assert.equal(
    restoredDups.length,
    2,
    "both intentional same-folder duplicates must restore",
  );
  assert.deepEqual(restoredDups.map((q) => q.note).sort(), [
    "卡片一的独特笔记",
    "卡片二的独特笔记",
  ]);

  // 8. Subscriber single-question AI chat (chat-question.ts) includes subscriber's personal placement prefix
  // while NEVER leaking author's unpublished live folder tree!
  const chatAuthor = await register("chat-place-author");
  const chatSub = await register("chat-place-sub");
  const { deck: authorSecretParent } = await (
    await decksRoute.POST(
      req(chatAuthor, "/api/decks", {
        action: "create",
        title: "作者绝密父目录",
      }),
    )
  ).json();
  const { deck: authorPub } = await (
    await decksRoute.POST(
      req(chatAuthor, "/api/decks", {
        action: "create",
        parentId: authorSecretParent.id,
        title: "公开专题",
      }),
    )
  ).json();
  const { id: chatQId } = await (
    await questionsRoute.POST(
      req(chatAuthor, "/api/questions", {
        action: "create",
        deckId: authorPub.id,
        title: "订阅聊天路径题",
        answer: "参考答案",
      }),
    )
  ).json();
  await decksRoute.POST(
    req(chatAuthor, "/api/decks", {
      action: "publish",
      deckId: authorPub.id,
      expectedVersion: 0,
      visibility: "public",
      summary: "v1",
    }),
  );
  const { deck: subOuter } = await (
    await decksRoute.POST(
      req(chatSub, "/api/decks", { action: "create", title: "订阅者收藏集" }),
    )
  ).json();
  const { deck: subInner } = await (
    await decksRoute.POST(
      req(chatSub, "/api/decks", {
        action: "create",
        parentId: subOuter.id,
        title: "后端资料",
      }),
    )
  ).json();
  await decksRoute.POST(
    req(chatSub, "/api/decks", {
      action: "subscribe",
      deckId: authorPub.id,
      folderId: subInner.id,
    }),
  );
  await placeSubscriptionInFolder(
    async (url, payload) => {
      const r = await decksRoute.POST(req(chatSub, url, payload));
      assert.equal(r.status, 200);
      return r.json();
    },
    authorPub.id,
    subInner.id,
  );
  const setKeyRes = await settingsRoute.POST(
    req(chatSub, "/api/settings", {
      action: "saveKey",
      baseUrl: "https://api.example.com/v1",
      model: "gpt-test",
      key: "sk-sub-chat-path-test-key",
    }),
  );
  assert.equal(setKeyRes.status, 200);

  const capturedPrompts: string[] = [];
  const resolver = mock.method(dns, "lookup", async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  const fetcher = mock.method(
    globalThis,
    "fetch",
    async (_url: URL | string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role: string; content: string }>;
      };
      const sys =
        body.messages?.find((m) => m.role === "system")?.content ?? "";
      capturedPrompts.push(sys);
      const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: "收到" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  );
  try {
    const chatRes = await chatRoute.POST(
      req(chatSub, "/api/chat", {
        scope: "question",
        questionId: chatQId,
        message: "帮我总结要点",
      }),
    );
    assert.equal(chatRes.status, 200);
    await chatRes.text();
    assert.equal(capturedPrompts.length, 1);
    assert.ok(
      capturedPrompts[0].includes("订阅者收藏集 / 后端资料 / 公开专题"),
      `expected subscriber placement prefix in system prompt, got: ${capturedPrompts[0]}`,
    );
    assert.ok(
      !capturedPrompts[0].includes("作者绝密父目录"),
      "must never leak author's private ancestor folder",
    );
  } finally {
    resolver.mock.restore();
    fetcher.mock.restore();
  }
});

test("catalog preview overlap notice: detects ancestor, descendant, and shared sourceQuestionId overlaps from same author only", async () => {
  const author = await register("overlap-author");
  const otherAuthor = await register("overlap-other-author");
  const subscriber = await register("overlap-sub");

  // Author creates 技术知识 -> (Redis, MySQL) and an unrelated top-level 行为面试.
  const { deck: tech } = await (
    await decksRoute.POST(
      req(author, "/api/decks", { action: "create", title: "技术知识" }),
    )
  ).json();
  const { deck: redis } = await (
    await decksRoute.POST(
      req(author, "/api/decks", {
        action: "create",
        parentId: tech.id,
        title: "Redis",
      }),
    )
  ).json();
  const { deck: mysql } = await (
    await decksRoute.POST(
      req(author, "/api/decks", {
        action: "create",
        parentId: tech.id,
        title: "MySQL",
      }),
    )
  ).json();
  const { deck: behavioral } = await (
    await decksRoute.POST(
      req(author, "/api/decks", { action: "create", title: "行为面试" }),
    )
  ).json();

  await questionsRoute.POST(
    req(author, "/api/questions", {
      action: "create",
      deckId: redis.id,
      title: "Redis 持久化 RDB 与 AOF",
      answer: "RDB 快照 + AOF 日志。",
    }),
  );
  const { id: mysqlQId } = await (
    await questionsRoute.POST(
      req(author, "/api/questions", {
        action: "create",
        deckId: mysql.id,
        title: "MySQL MVCC 原理",
        answer: "ReadView + Undo Log。",
      }),
    )
  ).json();
  await questionsRoute.POST(
    req(author, "/api/questions", {
      action: "create",
      deckId: behavioral.id,
      title: "STAR 法则复盘",
      answer: "情境任务行动结果。",
    }),
  );

  // Publish all four.
  for (const d of [tech, redis, mysql, behavioral]) {
    const res = await decksRoute.POST(
      req(author, "/api/decks", {
        action: "publish",
        deckId: d.id,
        expectedVersion: 0,
        visibility: "public",
        summary: "v1",
      }),
    );
    assert.equal(res.status, 200);
  }

  // Other author also publishes a deck named 技术知识 (different author -> never overlaps).
  const { deck: otherTech } = await (
    await decksRoute.POST(
      req(otherAuthor, "/api/decks", { action: "create", title: "技术知识" }),
    )
  ).json();
  await questionsRoute.POST(
    req(otherAuthor, "/api/questions", {
      action: "create",
      deckId: otherTech.id,
      title: "其他作者题",
      answer: "其他作者答案",
    }),
  );
  await decksRoute.POST(
    req(otherAuthor, "/api/decks", {
      action: "publish",
      deckId: otherTech.id,
      expectedVersion: 0,
      visibility: "public",
      summary: "v1",
    }),
  );

  async function preview(account: Account, deckId: string) {
    const res = await catalogRoute.GET(
      req(account, `/api/catalog?preview=1&id=${deckId}`),
    );
    assert.equal(res.status, 200);
    return (await res.json()) as CatalogDeckPreview;
  }

  // 1. Before subscribing, no overlaps.
  assert.deepEqual((await preview(subscriber, redis.id)).overlaps, []);

  // Subscribing to another author's deck must not trigger false overlaps.
  await decksRoute.POST(
    req(subscriber, "/api/decks", {
      action: "subscribe",
      deckId: otherTech.id,
    }),
  );
  assert.deepEqual((await preview(subscriber, redis.id)).overlaps, []);

  // 2. Subscribe to parent 技术知识 -> previewing child Redis detects "ancestor" overlap.
  await decksRoute.POST(
    req(subscriber, "/api/decks", { action: "subscribe", deckId: tech.id }),
  );
  const childPreview = await preview(subscriber, redis.id);
  assert.equal(childPreview.overlaps?.length, 1);
  assert.deepEqual(childPreview.overlaps?.[0], {
    deckId: tech.id,
    title: "技术知识",
    relation: "ancestor",
    overlapCount: 1,
  });

  // Previewing unrelated same-author deck or self-subscribed deck returns no overlap.
  assert.deepEqual((await preview(subscriber, behavioral.id)).overlaps, []);
  assert.deepEqual((await preview(subscriber, tech.id)).overlaps, []);
  // Author previewing own folder returns no overlap.
  assert.deepEqual((await preview(author, redis.id)).overlaps, []);

  // 3. Unsubscribe from parent and subscribe to child Redis -> previewing parent 技术知识 detects "descendant" overlap.
  await decksRoute.POST(
    req(subscriber, "/api/decks", { action: "unsubscribe", deckId: tech.id }),
  );
  await decksRoute.POST(
    req(subscriber, "/api/decks", { action: "subscribe", deckId: redis.id }),
  );
  const parentPreview = await preview(subscriber, tech.id);
  assert.equal(parentPreview.overlaps?.length, 1);
  assert.deepEqual(parentPreview.overlaps?.[0], {
    deckId: redis.id,
    title: "Redis",
    relation: "descendant",
    overlapCount: 1,
  });

  // 4. Cross-folder shared sourceQuestionId overlap (non-ancestor, non-descendant):
  // Subscriber pins MySQL v1 (contains mysqlQId); author moves mysqlQId to a separate folder 专题精选 and publishes it.
  await decksRoute.POST(
    req(subscriber, "/api/decks", { action: "subscribe", deckId: mysql.id }),
  );
  const { deck: curated } = await (
    await decksRoute.POST(
      req(author, "/api/decks", { action: "create", title: "专题精选" }),
    )
  ).json();
  await questionsRoute.POST(
    req(author, "/api/questions", {
      action: "move",
      id: mysqlQId,
      deckId: curated.id,
    }),
  );
  await decksRoute.POST(
    req(author, "/api/decks", {
      action: "publish",
      deckId: curated.id,
      expectedVersion: 0,
      visibility: "public",
      summary: "v1",
    }),
  );
  const overlapPreview = await preview(subscriber, curated.id);
  assert.equal(overlapPreview.overlaps?.length, 1);
  assert.deepEqual(overlapPreview.overlaps?.[0], {
    deckId: mysql.id,
    title: "MySQL",
    relation: "overlap",
    overlapCount: 1,
  });

  // 5. Unpublished private folder moves MUST NOT leak live author tree or produce false overlaps:
  // Subscriber subscribes to behavioral v1 (root) & tech v1 (contains Redis, MySQL — NOT behavioral).
  // Author privately moves behavioral under tech WITHOUT publishing tech v2.
  await decksRoute.POST(
    req(subscriber, "/api/decks", { action: "unsubscribe", deckId: redis.id }),
  );
  await decksRoute.POST(
    req(subscriber, "/api/decks", { action: "unsubscribe", deckId: mysql.id }),
  );
  await decksRoute.POST(
    req(subscriber, "/api/decks", { action: "subscribe", deckId: tech.id }),
  );
  const privMoveRes = await decksRoute.POST(
    req(author, "/api/decks", {
      action: "moveFolder",
      folderId: behavioral.id,
      targetParentId: tech.id,
    }),
  );
  assert.equal(privMoveRes.status, 200);
  // tech v1 pinned by subscriber does NOT include behavioral -> MUST NOT report ancestor overlap!
  assert.deepEqual(
    (await preview(subscriber, behavioral.id)).overlaps,
    [],
    "unpublished move into subscribed parent must not leak or falsely report ancestor overlap",
  );
  // Conversely, subscribing to behavioral v1 and previewing tech v1 (still lacking behavioral) MUST NOT report descendant overlap!
  await decksRoute.POST(
    req(subscriber, "/api/decks", { action: "unsubscribe", deckId: tech.id }),
  );
  await decksRoute.POST(
    req(subscriber, "/api/decks", {
      action: "subscribe",
      deckId: behavioral.id,
    }),
  );
  assert.deepEqual(
    (await preview(subscriber, tech.id)).overlaps,
    [],
    "unpublished move under target parent must not leak or falsely report descendant overlap",
  );

  // 6. Pinned snapshot survival after author restructures & deletes ancestor:
  // Subscriber subscribes to tech v1 (which contained Redis at v1); author moves Redis out and soft-deletes tech.
  await decksRoute.POST(
    req(subscriber, "/api/decks", {
      action: "unsubscribe",
      deckId: behavioral.id,
    }),
  );
  await decksRoute.POST(
    req(subscriber, "/api/decks", { action: "subscribe", deckId: tech.id }),
  );
  await decksRoute.POST(
    req(author, "/api/decks", {
      action: "moveFolder",
      folderId: redis.id,
      targetParentId: null,
    }),
  );
  await decksRoute.POST(
    req(author, "/api/decks", {
      action: "delete",
      deckId: tech.id,
      mode: "trash",
    }),
  );
  const postDeletePreview = await preview(subscriber, redis.id);
  assert.equal(postDeletePreview.overlaps?.length, 1);
  assert.deepEqual(postDeletePreview.overlaps?.[0], {
    deckId: tech.id,
    title: "技术知识",
    relation: "ancestor",
    overlapCount: 1,
  });
});

test("batchPublish with skipUnchanged never bumps unchanged related published folders or triggers spurious subscriber updates", async () => {
  const author = await register("skip-unchanged-author");
  const sub = await register("skip-unchanged-sub");

  const { deck: parent } = await (
    await decksRoute.POST(
      req(author, "/api/decks", { action: "create", title: "后端架构" }),
    )
  ).json();
  const { deck: redis } = await (
    await decksRoute.POST(
      req(author, "/api/decks", {
        action: "create",
        parentId: parent.id,
        title: "Redis",
      }),
    )
  ).json();
  const { deck: mysql } = await (
    await decksRoute.POST(
      req(author, "/api/decks", {
        action: "create",
        parentId: parent.id,
        title: "MySQL",
      }),
    )
  ).json();

  const { id: redisQId } = await (
    await questionsRoute.POST(
      req(author, "/api/questions", {
        action: "create",
        deckId: redis.id,
        title: "Redis 集群槽位",
        answer: "16384 个哈希槽。",
      }),
    )
  ).json();
  await questionsRoute.POST(
    req(author, "/api/questions", {
      action: "create",
      deckId: mysql.id,
      title: "InnoDB 缓冲池",
      answer: "Buffer Pool 缓存数据页。",
    }),
  );

  // Publish all 3 at v1.
  for (const d of [parent, redis, mysql]) {
    const r = await decksRoute.POST(
      req(author, "/api/decks", {
        action: "publish",
        deckId: d.id,
        expectedVersion: 0,
        visibility: "public",
        summary: "init",
      }),
    );
    assert.equal(r.status, 200);
  }
  // Subscriber subscribes to all 3 at v1.
  for (const d of [parent, redis, mysql]) {
    const r = await decksRoute.POST(
      req(sub, "/api/decks", { action: "subscribe", deckId: d.id }),
    );
    assert.equal(r.status, 200);
  }

  // Author edits ONLY Redis question -> Redis & parent have changes, MySQL is synced.
  const editRes = await questionsRoute.POST(
    req(author, "/api/questions", {
      action: "edit",
      id: redisQId,
      expectedRevision: 1,
      title: "Redis 集群槽位",
      answer: "16384 个哈希槽（CRC16(key) % 16384）。",
      tags: ["Redis"],
    }),
  );
  assert.equal(editRes.status, 200);

  const authorWsBefore = await getWs(author);
  assert.equal(
    authorWsBefore.decks.find((d) => d.id === parent.id)?.publishStatus,
    "changes",
  );
  assert.equal(
    authorWsBefore.decks.find((d) => d.id === redis.id)?.publishStatus,
    "changes",
  );
  assert.equal(
    authorWsBefore.decks.find((d) => d.id === mysql.id)?.publishStatus,
    "synced",
  );

  // Batch publish with skipUnchanged: true (including unchanged sibling MySQL).
  const batchRes = await decksRoute.POST(
    req(author, "/api/decks", {
      action: "batchPublish",
      items: [
        {
          deckId: redis.id,
          expectedVersion: 1,
          visibility: "public",
          summary: "补充 CRC16 公式",
          skipUnchanged: false,
        },
        {
          deckId: parent.id,
          expectedVersion: 1,
          visibility: "public",
          summary: "补充 CRC16 公式",
          skipUnchanged: true,
        },
        {
          deckId: mysql.id,
          expectedVersion: 1,
          visibility: "public",
          summary: "补充 CRC16 公式",
          skipUnchanged: true,
        },
      ],
      defaultVisibility: "public",
      defaultSummary: "补充 CRC16 公式",
      skipUnchanged: true,
    }),
  );
  assert.equal(batchRes.status, 200);
  const batchBody = (await batchRes.json()) as {
    publishedCount: number;
    skippedCount: number;
    results: { deckId: string; version: number; skipped: boolean }[];
  };
  assert.equal(batchBody.publishedCount, 2);
  assert.equal(batchBody.skippedCount, 1);
  assert.deepEqual(
    batchBody.results.find((r) => r.deckId === redis.id),
    { deckId: redis.id, version: 2, skipped: false },
  );
  assert.deepEqual(
    batchBody.results.find((r) => r.deckId === parent.id),
    { deckId: parent.id, version: 2, skipped: false },
  );
  assert.deepEqual(
    batchBody.results.find((r) => r.deckId === mysql.id),
    { deckId: mysql.id, version: 1, skipped: true },
  );

  // Subscriber sees update banners ONLY on parent & Redis, NEVER on unchanged MySQL!
  const subWs = await getWs(sub);
  assert.equal(
    subWs.decks.find((d) => d.id === parent.id)?.pendingUpdate?.toVersion,
    2,
  );
  assert.equal(
    subWs.decks.find((d) => d.id === redis.id)?.pendingUpdate?.toVersion,
    2,
  );
  assert.equal(
    subWs.decks.find((d) => d.id === mysql.id)?.pendingUpdate ?? null,
    null,
    "unchanged sibling publication MUST NOT trigger spurious update banner",
  );

  // Verify per-item override: primary skipUnchanged: false still publishes when top-level skipUnchanged: true,
  // while already-synced related ancestor with skipUnchanged: true stays at v2.
  const secondBatch = await decksRoute.POST(
    req(author, "/api/decks", {
      action: "batchPublish",
      items: [
        {
          deckId: redis.id,
          expectedVersion: 2,
          visibility: "public",
          summary: "仅说明更新",
          skipUnchanged: false,
        },
        {
          deckId: parent.id,
          expectedVersion: 2,
          visibility: "public",
          summary: "仅说明更新",
          skipUnchanged: true,
        },
      ],
      defaultVisibility: "public",
      defaultSummary: "仅说明更新",
      skipUnchanged: true,
    }),
  );
  assert.equal(secondBatch.status, 200);
  const secondBody = (await secondBatch.json()) as {
    publishedCount: number;
    skippedCount: number;
    results: { deckId: string; version: number; skipped: boolean }[];
  };
  assert.equal(secondBody.publishedCount, 1);
  assert.equal(secondBody.skippedCount, 1);
  assert.equal(
    secondBody.results.find((r) => r.deckId === redis.id)?.version,
    3,
  );
  assert.equal(
    secondBody.results.find((r) => r.deckId === parent.id)?.version,
    2,
  );
  assert.equal(
    secondBody.results.find((r) => r.deckId === parent.id)?.skipped,
    true,
  );
});

test("lock-order invariant (users -> decks ORDER BY id -> imports -> questions ORDER BY id with FOR NO KEY UPDATE) and concurrent folder+question safety", async () => {
  // 1. Instrument SQL emitted on an isolated PGlite database to prove canonical lock order
  // and FOR NO KEY UPDATE (avoiding PostgreSQL FOR KEY SHARE FK deadlocks) across
  // dissolve (with conflicting merge), moveFolder (merge), deleteFolderToTrash, groupIntoNew,
  // commitImport (replace), batchMutateQuestions, and mergeDuplicateQuestions.
  const pg = new PGlite();
  const sqlLog: string[] = [];
  const instrumentedDb = pgliteDrizzle(pg, {
    schema: dbSchema,
    logger: {
      logQuery(query) {
        sqlLog.push(query.replace(/\s+/g, " ").trim().toLowerCase());
      },
    },
  });
  const dbState = globalThis as unknown as {
    interviewDatabase?: Promise<{ db: unknown; close: () => Promise<void> }>;
  };
  const savedDbPromise = dbState.interviewDatabase;
  try {
    await pgliteMigrate(instrumentedDb, {
      migrationsFolder: path.resolve("drizzle"),
    });
    const uid = `lock-user-${randomUUID()}`;
    await instrumentedDb.insert(dbSchema.user).values({
      id: uid,
      name: "Lock Tester",
      email: `${uid}@example.com`,
    });

    const addQuestion = async (
      deckId: string,
      title: string,
      answer = `answer-${title}`,
    ) => {
      const id = randomUUID();
      await instrumentedDb.insert(dbSchema.questions).values({
        id,
        ownerId: uid,
        deckId,
        title,
        answer,
        contentHash: `hash-${id}`,
      });
      return id;
    };

    const assertCanonicalLockOrder = (
      label: string,
      queries: string[],
      options: { expectDecks?: boolean; expectQuestions?: boolean } = {},
    ) => {
      const expectDecks = options.expectDecks ?? true;
      const expectQuestions = options.expectQuestions ?? true;
      const stageOf = (
        q: string,
      ): "users" | "decks" | "imports" | "questions" | null => {
        if (q.includes('from "users"') && q.includes(" for ")) return "users";
        if (q.includes('from "decks"') && q.includes(" for ")) return "decks";
        if (q.includes('from "imports"') && q.includes(" for "))
          return "imports";
        if (q.includes('from "questions"') && q.includes(" for "))
          return "questions";
        return null;
      };
      const orderRank = {
        users: 1,
        decks: 2,
        imports: 3,
        questions: 4,
      } as const;
      let maxLockRank = 0;
      let sawDecksLock = false;
      let sawQuestionsLock = false;

      for (const q of queries) {
        const stage = stageOf(q);
        if (stage) {
          const rank = orderRank[stage];
          assert.ok(
            rank >= maxLockRank,
            `[${label}] lock order violation: acquired ${stage} lock after higher-rank lock in query: ${q}\nFull trace:\n${queries.join("\n")}`,
          );
          if (stage === "users") {
            assert.ok(
              q.includes("for no key update"),
              `[${label}] users lock must use FOR NO KEY UPDATE (never FOR UPDATE, which blocks FK FOR KEY SHARE): ${q}`,
            );
          }
          if (stage === "decks") {
            sawDecksLock = true;
            assert.ok(
              q.includes('order by "decks"."id" asc for no key update'),
              `[${label}] decks lock must be ORDER BY decks.id ASC FOR NO KEY UPDATE: ${q}`,
            );
          }
          if (stage === "imports") {
            assert.ok(
              q.includes('order by "imports"."id" asc for update'),
              `[${label}] imports lock must be ORDER BY imports.id ASC FOR UPDATE: ${q}`,
            );
          }
          if (stage === "questions") {
            sawQuestionsLock = true;
            assert.ok(
              q.includes("for no key update"),
              `[${label}] questions lock must use FOR NO KEY UPDATE: ${q}`,
            );
            if (!q.includes('where ("questions"."id" = $1')) {
              assert.ok(
                q.includes('order by "questions"."id" asc for no key update'),
                `[${label}] multi-row questions lock must be ORDER BY questions.id ASC FOR NO KEY UPDATE: ${q}`,
              );
            }
          }
          maxLockRank = rank;
        }
        if (q.startsWith('update "questions"')) {
          assert.ok(
            (!expectDecks || sawDecksLock) && sawQuestionsLock,
            `[${label}] updated questions before acquiring canonical locks: ${q}`,
          );
        }
        if (q.startsWith('update "decks"')) {
          assert.ok(
            sawDecksLock,
            `[${label}] updated decks before acquiring decks FOR NO KEY UPDATE lock: ${q}`,
          );
        }
      }
      if (expectDecks) {
        assert.ok(
          sawDecksLock,
          `[${label}] expected decks FOR NO KEY UPDATE lock`,
        );
      }
      if (expectQuestions) {
        assert.ok(
          sawQuestionsLock,
          `[${label}] expected questions FOR NO KEY UPDATE lock`,
        );
      }
    };

    // Case A: moveFolderInTx (merge)
    const fTarget = await instrumentedDb.transaction((tx) =>
      createFolderInTx(tx, uid, { title: "MergeTarget" }),
    );
    const fContainer = await instrumentedDb.transaction((tx) =>
      createFolderInTx(tx, uid, { title: "MergeContainer" }),
    );
    const fSource = await instrumentedDb.transaction((tx) =>
      createFolderInTx(tx, uid, {
        title: "MergeTarget",
        parentId: fContainer.id,
      }),
    );
    await addQuestion(fSource.id, "Q-merge-1");
    sqlLog.length = 0;
    await instrumentedDb.transaction((tx) =>
      moveFolderInTx(tx, uid, {
        folderId: fSource.id,
        targetParentId: null,
        conflictStrategy: "merge",
      }),
    );
    assertCanonicalLockOrder("moveFolderInTx(merge)", [...sqlLog]);

    // Case B: dissolveFolderInTx (with conflicting child merge + direct question)
    const fDisTarget = await instrumentedDb.transaction((tx) =>
      createFolderInTx(tx, uid, { title: "SameChild" }),
    );
    const fDisParent = await instrumentedDb.transaction((tx) =>
      createFolderInTx(tx, uid, { title: "DissolveMe" }),
    );
    const fDisChild = await instrumentedDb.transaction((tx) =>
      createFolderInTx(tx, uid, {
        title: "SameChild",
        parentId: fDisParent.id,
      }),
    );
    await addQuestion(fDisParent.id, "Q-dis-parent");
    await addQuestion(fDisChild.id, "Q-dis-child");
    assert.ok(fDisTarget.id);
    sqlLog.length = 0;
    await instrumentedDb.transaction((tx) =>
      dissolveFolderInTx(tx, uid, {
        folderId: fDisParent.id,
        conflictStrategy: "merge",
      }),
    );
    assertCanonicalLockOrder("dissolveFolderInTx(merge)", [...sqlLog]);

    // Case C: deleteFolderToTrashInTx
    const fTrashRoot = await instrumentedDb.transaction((tx) =>
      createFolderInTx(tx, uid, { title: "TrashRoot" }),
    );
    const fTrashChild = await instrumentedDb.transaction((tx) =>
      createFolderInTx(tx, uid, {
        title: "TrashChild",
        parentId: fTrashRoot.id,
      }),
    );
    await addQuestion(fTrashChild.id, "Q-trash-child");
    sqlLog.length = 0;
    await instrumentedDb.transaction((tx) =>
      deleteFolderToTrashInTx(tx, uid, fTrashRoot.id),
    );
    assertCanonicalLockOrder("deleteFolderToTrashInTx", [...sqlLog]);

    // Case D: groupIntoNewFolderInTx (folders with same name merged + explicit questionIds)
    const fGrpA = await instrumentedDb.transaction((tx) =>
      createFolderInTx(tx, uid, { title: "WrapParentA" }),
    );
    const fGrpB = await instrumentedDb.transaction((tx) =>
      createFolderInTx(tx, uid, { title: "WrapParentB" }),
    );
    const fDup1 = await instrumentedDb.transaction((tx) =>
      createFolderInTx(tx, uid, { title: "DupSub", parentId: fGrpA.id }),
    );
    const fDup2 = await instrumentedDb.transaction((tx) =>
      createFolderInTx(tx, uid, { title: "DupSub", parentId: fGrpB.id }),
    );
    await addQuestion(fDup2.id, "Q-dup2");
    const qLoose = await addQuestion(fTarget.id, "Q-loose");
    sqlLog.length = 0;
    await instrumentedDb.transaction((tx) =>
      groupIntoNewFolderInTx(tx, uid, {
        parentId: null,
        title: "GroupedNew",
        folderIds: [fDup1.id, fDup2.id],
        questionIds: [qLoose],
        conflictStrategy: "merge",
      }),
    );
    assertCanonicalLockOrder("groupIntoNewFolderInTx(merge+questions)", [
      ...sqlLog,
    ]);

    // Case E: commitImport (replace mode) & question-lifecycle mutations (batchMutateQuestions, mergeDuplicateQuestions)
    dbState.interviewDatabase = Promise.resolve({
      db: instrumentedDb,
      close: async () => {},
    });
    const { commitImport } = await import("../src/server/import-workflow");
    const { batchMutateQuestions, mergeDuplicateQuestions } =
      await import("../src/server/question-lifecycle");
    const fImp = await instrumentedDb.transaction((tx) =>
      createFolderInTx(tx, uid, { title: "ImportLockDir" }),
    );
    const qReplace = await addQuestion(fImp.id, "OldReplaceQ", "old answer");
    const impBatchId = randomUUID();
    await instrumentedDb.insert(dbSchema.imports).values({
      id: impBatchId,
      userId: uid,
      deckId: fImp.id,
      raw: "# NewReplaceQ\n\nnew answer",
      inputType: "qa",
      status: "draft",
      preview: [
        {
          key: "k1",
          title: "NewReplaceQ",
          answer: "new answer",
          tags: [],
          needsEditing: false,
          sourceText: "# NewReplaceQ\n\nnew answer",
        },
      ],
    });
    sqlLog.length = 0;
    await commitImport(uid, {
      batchId: impBatchId,
      replace: { id: qReplace, expectedRevision: 1, key: "k1", major: false },
      questions: [
        {
          key: "k1",
          title: "NewReplaceQ",
          answer: "new answer",
          tags: [],
        },
      ],
    });
    assertCanonicalLockOrder("commitImport(replace)", [...sqlLog]);

    const qBatch1 = await addQuestion(fImp.id, "BatchLockQ1", "same-ans");
    const qBatch2 = await addQuestion(fTarget.id, "BatchLockQ2", "same-ans");
    sqlLog.length = 0;
    await batchMutateQuestions(uid, {
      ids: [qBatch1, qBatch2],
      operation: "move",
      deckId: fTarget.id,
      duplicateStrategy: "keepBoth",
    });
    assertCanonicalLockOrder("batchMutateQuestions(move)", [...sqlLog]);

    sqlLog.length = 0;
    await mergeDuplicateQuestions(uid, {
      primaryId: qBatch1,
      duplicateIds: [qBatch2],
      appendNotes: true,
      keepStrongerFsrs: true,
      mergeTags: true,
    });
    assertCanonicalLockOrder("mergeDuplicateQuestions", [...sqlLog], {
      expectDecks: false,
    });
  } finally {
    dbState.interviewDatabase = savedDbPromise;
    await pg.close();
  }

  // 2. Concurrent route-level stress: folder dissolve/delete/merge interleaved with question create/edit/move/mergeDuplicates.
  const raceUser = await register("lock-race-user");
  const { deck: rParent } = await (
    await decksRoute.POST(
      req(raceUser, "/api/decks", { action: "create", title: "RaceParent" }),
    )
  ).json();
  const { deck: rFolder } = await (
    await decksRoute.POST(
      req(raceUser, "/api/decks", {
        action: "create",
        parentId: rParent.id,
        title: "RaceChild",
      }),
    )
  ).json();
  const { id: rq1 } = await (
    await questionsRoute.POST(
      req(raceUser, "/api/questions", {
        action: "create",
        deckId: rFolder.id,
        title: "并发题 1",
        answer: "初始答案 1",
      }),
    )
  ).json();
  const { id: rq2 } = await (
    await questionsRoute.POST(
      req(raceUser, "/api/questions", {
        action: "create",
        deckId: rFolder.id,
        title: "并发题 2",
        answer: "初始答案 2",
      }),
    )
  ).json();

  const results = await Promise.all([
    questionsRoute.POST(
      req(raceUser, "/api/questions", {
        action: "create",
        deckId: rFolder.id,
        title: "并发新建题 3",
        answer: "并发新建答案 3",
      }),
    ),
    questionsRoute.POST(
      req(raceUser, "/api/questions", {
        action: "edit",
        id: rq1,
        expectedRevision: 1,
        title: "并发题 1（已改）",
        answer: "更新后答案 1",
        tags: ["并发"],
      }),
    ),
    questionsRoute.POST(
      req(raceUser, "/api/questions", {
        action: "move",
        id: rq2,
        deckId: rParent.id,
      }),
    ),
    decksRoute.POST(
      req(raceUser, "/api/decks", {
        action: "dissolve",
        folderId: rFolder.id,
        conflictStrategy: "abort",
      }),
    ),
  ]);
  for (const res of results) {
    assert.ok(
      res.status < 500,
      `concurrent folder+question op must never 500, got ${res.status}: ${await res.clone().text()}`,
    );
  }
  const wsRace = await getWs(raceUser);
  const ownedDeckIds = new Set(
    wsRace.decks.filter((d) => d.isOwner).map((d) => d.id),
  );
  // Both questions must survive intact and point to an existing active folder or root (never a deleted folder).
  const surviving1 = wsRace.questions.find((q) => q.id === rq1);
  const surviving2 = wsRace.questions.find((q) => q.id === rq2);
  assert.ok(surviving1, "concurrent question 1 must not be lost");
  assert.ok(surviving2, "concurrent question 2 must not be lost");
  assert.ok(
    surviving1.deckId === null || ownedDeckIds.has(surviving1.deckId),
    "question 1 deckId must reference an active folder or root",
  );
  assert.ok(
    surviving2.deckId === null || ownedDeckIds.has(surviving2.deckId),
    "question 2 deckId must reference an active folder or root",
  );
});

after(async () => {
  const dbState = globalThis as unknown as {
    interviewDatabase?: Promise<{ close: () => Promise<void> }>;
  };
  await (await dbState.interviewDatabase)?.close();
});
