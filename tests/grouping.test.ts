import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { DeckGroupView, DeckView, QuestionView, Workspace } from "../src/lib/types";
import {
  bucketQuestionsByGroup,
  clusterDeckGroupsByCategory,
  computeDeckReadingOrder,
  computeReaderGroupContext,
  formatGroupLabel,
  groupDecksByName,
  inferGroupFromSourceName,
  listDeckCategories,
  listDeckGroupNames,
} from "../src/lib/grouping";

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
const deckGroupsRoute = await import("../src/app/api/deck-groups/route");
const questions = await import("../src/app/api/questions/route");
const preview = await import("../src/app/api/import/preview/route");
const commit = await import("../src/app/api/import/commit/route");
const exporter = await import("../src/app/api/export/route");
const { executeWorkspaceTool } = await import("../src/server/ai-tools");

type Account = { id: string; cookie: string; deckId: string };
let alice: Account;
let bob: Account;

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
  const res = await workspace.GET(request(account, "/api/workspace"));
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
  alice = await register("group-alice");
  bob = await register("group-bob");
});

test("pure grouping helpers compute canonical reading order, reader boundaries, deck buckets, and path inference", () => {
  const groups: DeckGroupView[] = [
    {
      id: "g-ali-1",
      deckId: "d1",
      title: "淘天一面",
      category: "阿里巴巴",
      description: "",
      position: 2,
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
    },
    {
      id: "g-bd-1",
      deckId: "d1",
      title: "抖音一面",
      category: "字节跳动",
      description: "偏 Redis",
      position: 0,
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
    },
    {
      id: "g-bd-2",
      deckId: "d1",
      title: "飞书一面",
      category: "字节跳动",
      description: "",
      position: 3,
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
    },
    {
      id: "g-empty",
      deckId: "d1",
      title: "空分组",
      category: "",
      description: "",
      position: 4,
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
    },
  ];
  const makeQ = (
    id: string,
    groupId: string | null,
    position: number,
    createdAt = "2026-03-01T00:00:00Z",
  ): QuestionView => ({
    id,
    deckId: "d1",
    groupId,
    position,
    parentId: null,
    title: id,
    answer: "ans",
    tags: [],
    revision: 1,
    majorRevision: 0,
    needsEditing: false,
    archived: false,
    createdAt,
    updatedAt: createdAt,
    isOwner: true,
    deckTitle: "面经题库",
    note: "",
    noteVersion: 0,
    favorite: false,
    fsrs: null,
    studyVersion: 0,
    reviewedRevision: 0,
  });

  const qs = [
    makeQ("q-ungrouped", null, 0),
    makeQ("q-ali-1", "g-ali-1", 0),
    makeQ("q-bd1-2", "g-bd-1", 1),
    makeQ("q-bd1-1", "g-bd-1", 0),
    makeQ("q-bd2-1", "g-bd-2", 0),
  ];

  // ByteDance appears first (pos 0), so both ByteDance rounds cluster before Alibaba, then ungrouped last.
  assert.deepEqual(listDeckCategories(groups), ["字节跳动", "阿里巴巴"]);
  const clustered = clusterDeckGroupsByCategory(groups);
  assert.equal(clustered.hasCategories, true);
  assert.deepEqual(
    clustered.orderedGroups.map((g) => g.id),
    ["g-bd-1", "g-bd-2", "g-ali-1", "g-empty"],
  );

  const ordered = computeDeckReadingOrder(qs, groups);
  assert.deepEqual(
    ordered.map((q) => q.id),
    ["q-bd1-1", "q-bd1-2", "q-bd2-1", "q-ali-1", "q-ungrouped"],
  );

  const bucketsFiltered = bucketQuestionsByGroup(qs, groups, {
    includeEmptyGroups: false,
  });
  assert.equal(
    bucketsFiltered.categoryBuckets.some((b) =>
      b.sections.some((s) => s.group?.id === "g-empty"),
    ),
    false,
  );

  // Reader boundary detection at end of g-bd-1 (index 1 -> next is g-bd-2).
  const ctx = computeReaderGroupContext(ordered, 1, groups);
  assert.ok(ctx);
  assert.equal(ctx.currentGroup?.id, "g-bd-1");
  assert.equal(ctx.groupIndex, 1);
  assert.equal(ctx.groupTotal, 2);
  assert.equal(ctx.prevCrossesGroup, false);
  assert.equal(ctx.nextCrossesGroup, true);
  assert.equal(ctx.nextGroup?.id, "g-bd-2");
  assert.equal(formatGroupLabel(ctx.nextGroup), "字节跳动 · 飞书一面");

  // Deck-level bucketing.
  const deckFixtures: Pick<DeckView, "id" | "groupName">[] = [
    { id: "a", groupName: "面经" },
    { id: "b", groupName: "" },
    { id: "c", groupName: "八股" },
    { id: "d", groupName: "面经" },
  ];
  assert.deepEqual(listDeckGroupNames(deckFixtures), ["面经", "八股"]);
  const deckBuckets = groupDecksByName(deckFixtures);
  assert.equal(deckBuckets.hasGroups, true);
  assert.deepEqual(
    deckBuckets.buckets.map((b) => [b.groupName, b.decks.map((d) => d.id)]),
    [
      ["面经", ["a", "d"]],
      ["八股", ["c"]],
      ["", ["b"]],
    ],
  );

  // Folder / filename inference.
  assert.deepEqual(inferGroupFromSourceName("字节跳动/抖音后端一面.md"), {
    category: "字节跳动",
    title: "抖音后端一面",
  });
  assert.deepEqual(inferGroupFromSourceName("面经\\阿里巴巴\\淘天一面.txt"), {
    category: "阿里巴巴",
    title: "淘天一面",
  });
  assert.deepEqual(inferGroupFromSourceName("美团一面.md"), {
    category: "",
    title: "美团一面",
  });
});

test("intra-deck groups support CRUD, cross-group dedup, batch folder import, move, publish, export, and AI tools", async () => {
  // 1. Create a deck with deck-level groupName.
  const createDeckRes = await decks.POST(
    request(alice, "/api/decks", {
      action: "create",
      title: "后端面经题库",
      description: "收录各公司后端真题",
      groupName: "公司面经",
      color: "blue",
    }),
  );
  assert.equal(createDeckRes.status, 200);
  const { deck: interviewDeck } = await createDeckRes.json();

  // 2. Create two groups in the same company + one in another company.
  const g1Res = await deckGroupsRoute.POST(
    request(alice, "/api/deck-groups", {
      action: "create",
      deckId: interviewDeck.id,
      category: "字节跳动",
      title: "抖音一面 · 2026.03",
      description: "偏 Redis 与并发",
    }),
  );
  assert.equal(g1Res.status, 200);
  const { group: bd1 } = await g1Res.json();

  const g2Res = await deckGroupsRoute.POST(
    request(alice, "/api/deck-groups", {
      action: "create",
      deckId: interviewDeck.id,
      category: "字节跳动",
      title: "抖音二面 · 2026.03",
      description: "系统设计",
    }),
  );
  assert.equal(g2Res.status, 200);
  const { group: bd2 } = await g2Res.json();

  // Isolation check: Bob cannot edit, delete, or create groups in Alice's deck.
  assert.equal(
    (
      await deckGroupsRoute.POST(
        request(bob, "/api/deck-groups", {
          action: "edit",
          id: bd1.id,
          title: "恶意篡改",
        }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await deckGroupsRoute.POST(
        request(bob, "/api/deck-groups", {
          action: "create",
          deckId: interviewDeck.id,
          title: "越权分组",
        }),
      )
    ).status,
    404,
  );

  // 3. Batch import two files with per-file group creation (same question asked in both ByteDance & Alibaba!).
  const batchIdBd = randomUUID();
  const batchIdAli = randomUUID();
  const prevRes = await preview.POST(
    request(alice, "/api/import/preview", {
      deckId: interviewDeck.id,
      inputType: "questions",
      method: "rules",
      sources: [
        {
          batchId: batchIdBd,
          sourceName: "字节跳动/抖音一面 · 2026.03.md",
          raw: "1. Redis 持久化有哪些方式？\n2. Go GMP 调度模型？\n",
        },
        {
          batchId: batchIdAli,
          sourceName: "阿里巴巴/淘天一面.md",
          raw: "1. Redis 持久化有哪些方式？\n2. MySQL MVCC 原理？\n",
        },
      ],
    }),
  );
  assert.equal(prevRes.status, 200, await prevRes.clone().text());
  const { previews } = await prevRes.json();

  const commitPayload = {
    batches: [
      {
        batchId: batchIdBd,
        group: { mode: "existing" as const, groupId: bd1.id },
        questions: previews[0].questions,
      },
      {
        batchId: batchIdAli,
        group: {
          mode: "create" as const,
          category: "阿里巴巴",
          title: "淘天一面",
          description: "2026-03",
        },
        questions: previews[1].questions,
      },
    ],
  };
  const commitRes = await commit.POST(
    request(alice, "/api/import/commit", commitPayload),
  );
  assert.equal(commitRes.status, 200, await commitRes.clone().text());
  const commitResult = await commitRes.json();
  // Both interviews keep "Redis 持久化有哪些方式？" because they are in distinct groups!
  assert.equal(commitResult.added, 4);
  assert.equal(commitResult.duplicates, 0);

  // Idempotent retry returns same result.
  const retryRes = await commit.POST(
    request(alice, "/api/import/commit", commitPayload),
  );
  assert.equal(retryRes.status, 200);
  assert.deepEqual(await retryRes.json(), commitResult);

  // Re-importing the SAME question into the SAME group STILL deduplicates!
  const dupBatchId = randomUUID();
  const dupPrev = await (
    await preview.POST(
      request(alice, "/api/import/preview", {
        batchId: dupBatchId,
        deckId: interviewDeck.id,
        inputType: "questions",
        method: "rules",
        raw: "1. Redis 持久化有哪些方式？\n",
      }),
    )
  ).json();
  const dupCommit = await (
    await commit.POST(
      request(alice, "/api/import/commit", {
        batchId: dupBatchId,
        group: { mode: "existing", groupId: bd1.id },
        questions: dupPrev.questions,
      }),
    )
  ).json();
  assert.equal(dupCommit.added, 0);
  assert.equal(dupCommit.duplicates, 1);

  // 4. Verify workspace hydration, positions, and group metadata.
  let ws = await state(alice);
  const deckView = ws.decks.find((d) => d.id === interviewDeck.id)!;
  assert.equal(deckView.groupName, "公司面经");
  assert.equal(deckView.groups.length, 3);
  const aliGroup = deckView.groups.find((g) => g.category === "阿里巴巴")!;
  assert.equal(aliGroup.title, "淘天一面");

  const bd1Qs = ws.questions.filter((q) => q.groupId === bd1.id);
  assert.equal(bd1Qs.length, 2);
  assert.equal(bd1Qs[0].title, "Redis 持久化有哪些方式？");
  assert.equal(bd1Qs[0].position, 0);
  assert.equal(bd1Qs[1].position, 1);

  // 5. Move a question between groups in the same deck without bumping revision.
  const gmpQ = bd1Qs.find((q) => q.title.includes("GMP"))!;
  const moveRes = await questions.POST(
    request(alice, "/api/questions", {
      action: "move",
      id: gmpQ.id,
      deckId: interviewDeck.id,
      groupId: bd2.id,
    }),
  );
  assert.equal(moveRes.status, 200);
  ws = await state(alice);
  const movedGmp = ws.questions.find((q) => q.id === gmpQ.id)!;
  assert.equal(movedGmp.groupId, bd2.id);
  assert.equal(movedGmp.revision, gmpQ.revision);

  // 6. Batch move ungrouped question into bd2.
  const createQRes = await questions.POST(
    request(alice, "/api/questions", {
      action: "create",
      deckId: interviewDeck.id,
      title: "分布式锁如何保证高可用？",
      answer: "Redlock / etcd lease",
      tags: ["分布式"],
    }),
  );
  assert.equal(createQRes.status, 200);
  const { id: ungroupedId } = await createQRes.json();
  const batchMoveRes = await questions.POST(
    request(alice, "/api/questions", {
      action: "batch",
      ids: [ungroupedId],
      operation: "move",
      deckId: interviewDeck.id,
      groupId: bd2.id,
    }),
  );
  assert.equal(batchMoveRes.status, 200);
  assert.equal((await batchMoveRes.json()).updated, 1);

  // 7. Reorder groups & rename category.
  assert.equal(
    (
      await deckGroupsRoute.POST(
        request(alice, "/api/deck-groups", {
          action: "reorder",
          deckId: interviewDeck.id,
          orderedIds: [aliGroup.id, bd2.id, bd1.id],
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await deckGroupsRoute.POST(
        request(alice, "/api/deck-groups", {
          action: "renameCategory",
          deckId: interviewDeck.id,
          from: "阿里巴巴",
          to: "阿里集团",
        }),
      )
    ).status,
    200,
  );
  ws = await state(alice);
  const refreshedDeck = ws.decks.find((d) => d.id === interviewDeck.id)!;
  assert.deepEqual(
    refreshedDeck.groups.map((g) => g.id),
    [aliGroup.id, bd2.id, bd1.id],
  );
  assert.equal(refreshedDeck.groups[0].category, "阿里集团");

  // 8. Scoped AI tools see group metadata & detect cross-company duplicates.
  const searchTool = await executeWorkspaceTool(
    alice.id,
    "deck",
    interviewDeck.id,
    "search_questions",
    JSON.stringify({ query: "阿里集团 Redis" }),
  );
  const searchMatches = (
    searchTool.output as { matches: { groupCategory?: string; title: string }[] }
  ).matches;
  assert.equal(searchMatches.length, 1);
  assert.equal(searchMatches[0].groupCategory, "阿里集团");

  const dupTool = await executeWorkspaceTool(
    alice.id,
    "deck",
    interviewDeck.id,
    "find_duplicate_questions",
    JSON.stringify({ limit: 5 }),
  );
  const dupCandidates = (
    dupTool.output as {
      candidates: {
        a: { groupCategory?: string; title: string };
        b: { groupCategory?: string; title: string };
      }[];
    }
  ).candidates;
  assert.ok(
    dupCandidates.some(
      (c) =>
        c.a.title === "Redis 持久化有哪些方式？" &&
        c.b.title === "Redis 持久化有哪些方式？" &&
        c.a.groupCategory !== c.b.groupCategory,
    ),
  );

  const overviewTool = await executeWorkspaceTool(
    alice.id,
    "deck",
    interviewDeck.id,
    "list_workspace_overview",
    "{}",
  );
  const overviewDecks = (
    overviewTool.output as {
      decks: { groupName?: string; groups?: { title: string }[] }[];
    }
  ).decks;
  assert.equal(overviewDecks[0].groupName, "公司面经");
  assert.equal(overviewDecks[0].groups?.length, 3);

  // 9. Publish deck -> Bob subscribes -> Bob receives groups & sets personal subscription groupName.
  assert.equal(
    (
      await decks.POST(
        request(alice, "/api/decks", {
          action: "publish",
          deckId: interviewDeck.id,
          expectedVersion: 0,
          visibility: "public",
          summary: "首发分组版面经",
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await decks.POST(
        request(bob, "/api/decks", {
          action: "subscribe",
          deckId: interviewDeck.id,
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await decks.POST(
        request(bob, "/api/decks", {
          action: "setSubscriptionGroup",
          deckId: interviewDeck.id,
          groupName: "订阅面经",
        }),
      )
    ).status,
    200,
  );
  const bobWs = await state(bob);
  const bobSubDeck = bobWs.decks.find((d) => d.id === interviewDeck.id)!;
  assert.equal(bobSubDeck.groupName, "订阅面经");
  assert.equal(bobSubDeck.groups.length, 3);
  assert.ok(
    bobWs.questions.some(
      (q) => q.deckId === interviewDeck.id && q.groupId === aliGroup.id,
    ),
  );

  // Rename deck group for Alice does not affect Bob.
  assert.equal(
    (
      await decks.POST(
        request(alice, "/api/decks", {
          action: "renameDeckGroup",
          from: "公司面经",
          to: "大厂真题",
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (await state(alice)).decks.find((d) => d.id === interviewDeck.id)
      ?.groupName,
    "大厂真题",
  );
  assert.equal(
    (await state(bob)).decks.find((d) => d.id === interviewDeck.id)?.groupName,
    "订阅面经",
  );

  // Dissolving a deck group (to: "") clears groupName across both owned & subscribed decks without deleting decks.
  assert.equal(
    (
      await decks.POST(
        request(bob, "/api/decks", {
          action: "edit",
          deckId: bob.deckId,
          expected: {
            title: (await state(bob)).decks.find((d) => d.id === bob.deckId)!
              .title,
            description: (await state(bob)).decks.find(
              (d) => d.id === bob.deckId,
            )!.description,
            groupName: "",
          },
          title: (await state(bob)).decks.find((d) => d.id === bob.deckId)!
            .title,
          description: (await state(bob)).decks.find(
            (d) => d.id === bob.deckId,
          )!.description,
          groupName: "订阅面经",
        }),
      )
    ).status,
    200,
  );
  const dissolveRes = await decks.POST(
    request(bob, "/api/decks", {
      action: "renameDeckGroup",
      from: "订阅面经",
      to: "",
    }),
  );
  assert.equal(dissolveRes.status, 200);
  assert.equal((await dissolveRes.json()).updated, 2);
  const bobAfterDissolve = await state(bob);
  assert.equal(
    bobAfterDissolve.decks.find((d) => d.id === bob.deckId)?.groupName,
    "",
  );
  assert.equal(
    bobAfterDissolve.decks.find((d) => d.id === interviewDeck.id)?.groupName,
    "",
  );

  // 10. Export includes groupName, groups, groupId, position.
  const expData = await (
    await exporter.GET(request(alice, "/api/export"))
  ).json();
  const expDeck = expData.decks.find(
    (d: DeckView) => d.id === interviewDeck.id,
  );
  assert.equal(expDeck.groupName, "大厂真题");
  assert.equal(expDeck.groups.length, 3);

  // 11. Deleting a group preserves ALL questions even when an identical contentHash exists in ungrouped!
  // Put an ungrouped copy of "Redis 持久化有哪些方式？" in interviewDeck first, then delete bd1 & aliGroup.
  assert.equal(
    (
      await deckGroupsRoute.POST(
        request(alice, "/api/deck-groups", {
          action: "delete",
          id: bd1.id,
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await deckGroupsRoute.POST(
        request(alice, "/api/deck-groups", {
          action: "delete",
          id: aliGroup.id,
        }),
      )
    ).status,
    200,
  );
  ws = await state(alice);
  const redisCopies = ws.questions.filter(
    (q) => q.title === "Redis 持久化有哪些方式？",
  );
  // Both copies survived without throwing a unique-index violation!
  assert.equal(redisCopies.length, 2);
  assert.ok(redisCopies.every((q) => q.groupId === null));

  // 12. Trash & restore: restore keeps groupId when group exists, clears groupId if group deleted.
  assert.equal(
    (
      await questions.POST(
        request(alice, "/api/questions", {
          action: "delete",
          id: ungroupedId,
        }),
      )
    ).status,
    200,
  );
  const restoreOk = await (
    await questions.POST(
      request(alice, "/api/questions", {
        action: "restore",
        id: ungroupedId,
      }),
    )
  ).json();
  assert.equal(restoreOk.deckId, interviewDeck.id);
  assert.equal(restoreOk.groupId, bd2.id);

  // Deleting deck detaches questions and clears groupId cleanly.
  assert.equal(
    (
      await decks.POST(
        request(alice, "/api/decks", {
          action: "delete",
          deckId: interviewDeck.id,
        }),
      )
    ).status,
    200,
  );
  ws = await state(alice);
  const detached = ws.questions.find((q) => q.id === ungroupedId)!;
  assert.equal(detached.deckId, null);
  assert.equal(detached.groupId, null);
});

after(async () => {
  const dbState = globalThis as unknown as {
    interviewDatabase?: Promise<{ close: () => Promise<void> }>;
  };
  await (await dbState.interviewDatabase)?.close();
});
