import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { DeckView, QuestionView, Workspace } from "../src/lib/types";
import {
  ROOT_FOLDER_LABEL,
  buildFolderIndex,
  findExactDuplicateClusters,
  sortFoldersNatural,
  sortQuestionsList,
  validateFolderTitle,
} from "../src/lib/folders";
import {
  detectCommonOuterFolder,
  extractRelativeFolderSegments,
  planFolderImport,
} from "../src/lib/folder-import";

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
  alice = await register("folder-alice");
  bob = await register("folder-bob");
});

test("pure folder helpers validate Finder names, natural sort, build recursive paths, plan folder imports, and cluster exact duplicates", () => {
  // Finder / Explorer folder name validation
  assert.equal(validateFolderTitle("字节跳动"), null);
  assert.ok(validateFolderTitle("   "));
  assert.ok(validateFolderTitle("a/b"));
  assert.ok(validateFolderTitle("a\\b"));
  assert.ok(validateFolderTitle("."));
  assert.ok(validateFolderTitle(".."));
  assert.ok(validateFolderTitle("bad\u0007name"));

  // Natural numeric sort: 第2章 before 第10章
  const sortedFolders = sortFoldersNatural([
    { id: "3", title: "第10章 分布式" },
    { id: "1", title: "第2章 缓存" },
    { id: "2", title: "第1章 基础" },
  ]);
  assert.deepEqual(
    sortedFolders.map((f) => f.title),
    ["第1章 基础", "第2章 缓存", "第10章 分布式"],
  );

  const makeDeck = (
    id: string,
    parentId: string | null,
    title: string,
    isOwner = true,
  ): DeckView => ({
    id,
    parentId,
    title,
    description: "",
    groups: [],
    color: "sand",
    visibility: "private",
    isOwner,
    ownerName: isOwner ? "Alice" : "Bob",
    publishedVersion: 0,
    seenVersion: 0,
    count: 0,
    due: 0,
    newCount: 0,
    updatedAt: "2026-03-01T00:00:00Z",
    releaseSummary: "",
    sourceDeleted: false,
  });

  const deckFixtures: DeckView[] = [
    makeDeck("d-root", null, "公司面经"),
    makeDeck("d-bd", "d-root", "字节跳动"),
    makeDeck("d-bd-1", "d-bd", "抖音一面"),
    makeDeck("d-ali", "d-root", "阿里巴巴"),
    makeDeck("d-sub", "d-root", "开源八股", false),
  ];

  const index = buildFolderIndex(deckFixtures);
  assert.equal(index.depthOf(null), 0);
  assert.equal(index.depthOf("d-root"), 1);
  assert.equal(index.depthOf("d-bd-1"), 3);
  assert.equal(index.subtreeHeightOf("d-root"), 3);
  assert.equal(index.formatPath(null), ROOT_FOLDER_LABEL);
  assert.equal(index.formatPath("d-bd-1"), "公司面经 / 字节跳动 / 抖音一面");
  assert.equal(
    index.formatRelativePath("d-root", "d-bd-1"),
    "字节跳动 / 抖音一面",
  );
  assert.equal(
    index.subscriptionsByFolder.get("d-root")?.[0]?.id,
    "d-sub",
  );

  // Relative path extraction keeps questions in file's parent folder (no folder named after file)
  assert.deepEqual(
    extractRelativeFolderSegments("字节跳动/抖音后端一面.md"),
    ["字节跳动"],
  );
  assert.deepEqual(
    extractRelativeFolderSegments("面经\\阿里巴巴\\淘天一面.txt"),
    ["面经", "阿里巴巴"],
  );
  assert.deepEqual(extractRelativeFolderSegments("美团一面.md"), []);
  assert.equal(
    detectCommonOuterFolder(["面经/字节/a.md", "面经/阿里/b.md"]),
    "面经",
  );

  // Virtual import preview plans reuse vs create accurately
  const plan = planFolderImport({
    existingFolders: deckFixtures,
    baseFolderId: "d-root",
    sources: [
      { batchId: "b1", sourceName: "公司面经/字节跳动/抖音一面/a.md", questionCount: 2 },
      { batchId: "b2", sourceName: "公司面经/美团/核心本地商业/b.md", questionCount: 3 },
    ],
    structureMode: "preserve",
    stripOuterFolder: true,
  });
  assert.equal(plan.commonOuterFolder, "公司面经");
  assert.equal(plan.outerMatchesBase, true);
  assert.equal(plan.foldersToReuse, 2); // 字节跳动 + 抖音一面
  assert.equal(plan.foldersToCreate, 2); // 美团 + 核心本地商业
  assert.equal(plan.depthErrors.length, 0);

  // Question sorting + duplicate clustering
  const makeQ = (id: string, title: string, answer: string, updatedAt: string): QuestionView => ({
    id,
    deckId: "d-bd-1",
    groupId: null,
    position: 0,
    parentId: null,
    title,
    answer,
    tags: [],
    revision: 1,
    majorRevision: 0,
    needsEditing: !answer.trim(),
    archived: false,
    createdAt: updatedAt,
    updatedAt,
    isOwner: true,
    deckTitle: "抖音一面",
    folderPath: "公司面经 / 字节跳动 / 抖音一面",
    note: "",
    noteVersion: 0,
    annotations: [],
    annotationsVersion: 0,
    favorite: false,
    fsrs: null,
    studyVersion: 0,
    reviewedRevision: 0,
  });
  const qList = [
    makeQ("q1", "第10题", "答案 A", "2026-03-01T00:00:00Z"),
    makeQ("q2", "第2题", "答案 B", "2026-03-05T00:00:00Z"),
    makeQ("q3", "第2题", "答案 B", "2026-03-02T00:00:00Z"),
  ];
  assert.deepEqual(
    sortQuestionsList(qList, "name").map((q) => q.id),
    ["q2", "q3", "q1"],
  );
  assert.deepEqual(
    sortQuestionsList(qList, "updated").map((q) => q.id),
    ["q2", "q3", "q1"],
  );
  const clusters = findExactDuplicateClusters(qList);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].questions.length, 2);
});

test("recursive folders support CRUD, local folder import, cross-folder move, AI subtree tools, publish, subscription placement, export v3, dissolve, and trash/restore", async () => {
  // 1. Create a 3-level nested folder tree: 公司面经 / 字节跳动 / 抖音一面 & 抖音二面
  const { deck: companyRoot } = await (
    await decks.POST(
      request(alice, "/api/decks", {
        action: "create",
        title: "公司面经",
        description: "收录各公司后端真题",
        color: "blue",
      }),
    )
  ).json();

  const { deck: bdFolder } = await (
    await decks.POST(
      request(alice, "/api/decks", {
        action: "create",
        parentId: companyRoot.id,
        title: "字节跳动",
      }),
    )
  ).json();

  const { deck: bd1 } = await (
    await decks.POST(
      request(alice, "/api/decks", {
        action: "create",
        parentId: bdFolder.id,
        title: "抖音一面 · 2026.03",
        description: "偏 Redis 与并发",
      }),
    )
  ).json();

  const { deck: bd2 } = await (
    await decks.POST(
      request(alice, "/api/decks", {
        action: "create",
        parentId: bdFolder.id,
        title: "抖音二面 · 2026.03",
        description: "系统设计",
      }),
    )
  ).json();

  // Isolation check: Bob cannot edit or create subfolders inside Alice's folder.
  assert.equal(
    (
      await decks.POST(
        request(bob, "/api/decks", {
          action: "edit",
          deckId: bd1.id,
          expected: { title: bd1.title, description: bd1.description },
          title: "恶意篡改",
          description: "",
        }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await decks.POST(
        request(bob, "/api/decks", {
          action: "create",
          parentId: companyRoot.id,
          title: "越权子文件夹",
        }),
      )
    ).status,
    404,
  );

  // 2. Local folder import with relative paths: reuses existing 字节跳动/抖音一面 · 2026.03 and creates 阿里巴巴/淘天一面 atomically!
  const batchIdBd = randomUUID();
  const batchIdAli = randomUUID();
  const prevRes = await preview.POST(
    request(alice, "/api/import/preview", {
      deckId: companyRoot.id,
      inputType: "questions",
      method: "rules",
      sources: [
        {
          batchId: batchIdBd,
          sourceName: "字节跳动/抖音一面 · 2026.03/notes.md",
          raw: "1. Redis 持久化有哪些方式？\n2. Go GMP 调度模型？\n",
        },
        {
          batchId: batchIdAli,
          sourceName: "阿里巴巴/淘天一面/notes.md",
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
        targetFolderId: companyRoot.id,
        relativeFolderPath: ["字节跳动", "抖音一面 · 2026.03"],
        questions: previews[0].questions,
      },
      {
        batchId: batchIdAli,
        targetFolderId: companyRoot.id,
        relativeFolderPath: ["阿里巴巴", "淘天一面"],
        questions: previews[1].questions,
      },
    ],
  };
  const commitRes = await commit.POST(
    request(alice, "/api/import/commit", commitPayload),
  );
  assert.equal(commitRes.status, 200, await commitRes.clone().text());
  const commitResult = await commitRes.json();
  // Blank-answer question stubs only dedup within the same folder, so both interviews keep "Redis 持久化有哪些方式？".
  assert.equal(commitResult.added, 4);
  assert.equal(commitResult.duplicates, 0);

  // Idempotent retry returns the same result without creating duplicates.
  const retryRes = await commit.POST(
    request(alice, "/api/import/commit", commitPayload),
  );
  assert.equal(retryRes.status, 200);
  assert.deepEqual(await retryRes.json(), commitResult);

  // Re-importing the SAME question stub into the SAME folder deduplicates by default!
  const dupBatchId = randomUUID();
  const dupPrev = await (
    await preview.POST(
      request(alice, "/api/import/preview", {
        batchId: dupBatchId,
        deckId: bd1.id,
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
        targetFolderId: bd1.id,
        questions: dupPrev.questions,
      }),
    )
  ).json();
  assert.equal(dupCommit.added, 0);
  assert.equal(dupCommit.duplicates, 1);

  // 3. Verify workspace hydration, recursive counts, and full folderPath metadata.
  let ws = await state(alice);
  const rootView = ws.decks.find((d) => d.id === companyRoot.id)!;
  assert.equal(rootView.count, 4);
  assert.equal(rootView.directCount, 0);
  const aliParent = ws.decks.find(
    (d) => d.parentId === companyRoot.id && d.title === "阿里巴巴",
  )!;
  const aliLeaf = ws.decks.find(
    (d) => d.parentId === aliParent.id && d.title === "淘天一面",
  )!;
  assert.ok(aliLeaf);

  const bd1Qs = ws.questions.filter((q) => q.deckId === bd1.id);
  assert.equal(bd1Qs.length, 2);
  assert.equal(
    bd1Qs[0].folderPath,
    "公司面经 / 字节跳动 / 抖音一面 · 2026.03",
  );

  // 4. Move a question between sibling folders without bumping revision.
  const gmpQ = bd1Qs.find((q) => q.title.includes("GMP"))!;
  const moveRes = await questions.POST(
    request(alice, "/api/questions", {
      action: "move",
      id: gmpQ.id,
      deckId: bd2.id,
    }),
  );
  assert.equal(moveRes.status, 200);
  ws = await state(alice);
  const movedGmp = ws.questions.find((q) => q.id === gmpQ.id)!;
  assert.equal(movedGmp.deckId, bd2.id);
  assert.equal(movedGmp.revision, gmpQ.revision);

  // 5. Batch move direct root question into bd2.
  const { id: directId } = await (
    await questions.POST(
      request(alice, "/api/questions", {
        action: "create",
        deckId: companyRoot.id,
        title: "分布式锁如何保证高可用？",
        answer: "Redlock / etcd lease",
        tags: ["分布式"],
      }),
    )
  ).json();
  const batchMoveRes = await questions.POST(
    request(alice, "/api/questions", {
      action: "batch",
      ids: [directId],
      operation: "move",
      deckId: bd2.id,
    }),
  );
  assert.equal(batchMoveRes.status, 200);
  assert.equal((await batchMoveRes.json()).updated, 1);

  // 6. Rename folder 阿里巴巴 -> 阿里集团 and verify scoped AI tools see updated recursive paths & cross-folder duplicates.
  assert.equal(
    (
      await decks.POST(
        request(alice, "/api/decks", {
          action: "edit",
          deckId: aliParent.id,
          expected: { title: aliParent.title, description: aliParent.description },
          title: "阿里集团",
          description: "",
        }),
      )
    ).status,
    200,
  );

  const searchTool = await executeWorkspaceTool(
    alice.id,
    "deck",
    companyRoot.id,
    "search_questions",
    JSON.stringify({ query: "阿里集团 Redis" }),
  );
  const searchMatches = (
    searchTool.output as { matches: { folderPath: string; title: string }[] }
  ).matches;
  assert.equal(searchMatches.length, 1);
  assert.equal(searchMatches[0].folderPath, "公司面经 / 阿里集团 / 淘天一面");

  const dupTool = await executeWorkspaceTool(
    alice.id,
    "deck",
    companyRoot.id,
    "find_duplicate_questions",
    JSON.stringify({ limit: 5 }),
  );
  const dupCandidates = (
    dupTool.output as {
      candidates: {
        a: { folderPath: string; title: string };
        b: { folderPath: string; title: string };
      }[];
    }
  ).candidates;
  assert.ok(
    dupCandidates.some(
      (c) =>
        c.a.title === "Redis 持久化有哪些方式？" &&
        c.b.title === "Redis 持久化有哪些方式？" &&
        c.a.folderPath !== c.b.folderPath,
    ),
  );

  const overviewTool = await executeWorkspaceTool(
    alice.id,
    "deck",
    companyRoot.id,
    "list_workspace_overview",
    "{}",
  );
  const overviewDecks = (
    overviewTool.output as {
      decks: { deckId: string | null; path: string }[];
    }
  ).decks;
  assert.ok(
    overviewDecks.some((d) => d.path === "公司面经 / 阿里集团 / 淘天一面"),
  );

  // 7. Publish companyRoot -> Bob subscribes and places subscription in his personal folder "订阅面经".
  assert.equal(
    (
      await decks.POST(
        request(alice, "/api/decks", {
          action: "publish",
          deckId: companyRoot.id,
          expectedVersion: 0,
          visibility: "public",
          summary: "首发多级目录面经",
        }),
      )
    ).status,
    200,
  );
  const { deck: bobSubFolder } = await (
    await decks.POST(
      request(bob, "/api/decks", { action: "create", title: "订阅面经" }),
    )
  ).json();
  assert.equal(
    (
      await decks.POST(
        request(bob, "/api/decks", {
          action: "subscribe",
          deckId: companyRoot.id,
          folderId: bobSubFolder.id,
        }),
      )
    ).status,
    200,
  );
  const bobWs = await state(bob);
  const bobSubDeck = bobWs.decks.find((d) => d.id === companyRoot.id)!;
  assert.equal(bobSubDeck.parentId, bobSubFolder.id);
  // Multi-level release groups preserve nested hierarchy (字节跳动 -> 抖音一面, 抖音二面; 阿里集团 -> 淘天一面)
  assert.equal(bobSubDeck.groups.length, 5);
  const bobAliLeaf = bobSubDeck.groups.find((g) => g.id === aliLeaf.id)!;
  assert.equal(bobAliLeaf.parentId, aliParent.id);
  assert.ok(
    bobWs.questions.some(
      (q) => q.deckId === companyRoot.id && q.groupId === aliLeaf.id,
    ),
  );

  // Dissolving Bob's personal folder lifts his placed subscription up to root without unsubscribing.
  assert.equal(
    (
      await decks.POST(
        request(bob, "/api/decks", {
          action: "dissolve",
          folderId: bobSubFolder.id,
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (await state(bob)).decks.find((d) => d.id === companyRoot.id)?.parentId,
    null,
  );

  // 8. Export v3 includes parentId hierarchy cleanly.
  const expData = await (
    await exporter.GET(request(alice, "/api/export"))
  ).json();
  assert.equal(expData.version, 3);
  const expAliLeaf = expData.decks.find(
    (d: { id: string }) => d.id === aliLeaf.id,
  );
  assert.equal(expAliLeaf.parentId, aliParent.id);

  // 9. Dissolving child folders lifts identical questions cleanly without unique-constraint failure.
  assert.equal(
    (
      await decks.POST(
        request(alice, "/api/decks", { action: "dissolve", folderId: bd1.id }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await decks.POST(
        request(alice, "/api/decks", {
          action: "dissolve",
          folderId: bdFolder.id,
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await decks.POST(
        request(alice, "/api/decks", {
          action: "dissolve",
          folderId: aliLeaf.id,
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await decks.POST(
        request(alice, "/api/decks", {
          action: "dissolve",
          folderId: aliParent.id,
        }),
      )
    ).status,
    200,
  );
  ws = await state(alice);
  const redisCopies = ws.questions.filter(
    (q) => q.title === "Redis 持久化有哪些方式？",
  );
  assert.equal(redisCopies.length, 2);
  assert.ok(redisCopies.every((q) => q.deckId === companyRoot.id));

  // 10. Trash & restore keeps surviving folder, and dissolving folder lifts items to root.
  assert.equal(
    (
      await questions.POST(
        request(alice, "/api/questions", { action: "delete", id: directId }),
      )
    ).status,
    200,
  );
  const restoreOk = await (
    await questions.POST(
      request(alice, "/api/questions", { action: "restore", id: directId }),
    )
  ).json();
  assert.equal(restoreOk.deckId, bd2.id);

  assert.equal(
    (
      await decks.POST(
        request(alice, "/api/decks", { action: "dissolve", folderId: bd2.id }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await decks.POST(
        request(alice, "/api/decks", {
          action: "dissolve",
          folderId: companyRoot.id,
        }),
      )
    ).status,
    200,
  );
  ws = await state(alice);
  assert.equal(
    ws.questions.find((q) => q.id === directId)?.deckId,
    null,
  );
});

after(async () => {
  const dbState = globalThis as unknown as {
    interviewDatabase?: Promise<{ close: () => Promise<void> }>;
  };
  await (await dbState.interviewDatabase)?.close();
});
