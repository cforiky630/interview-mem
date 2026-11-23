import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import {
  markAsFollowup,
  sourceSelection,
  replaceWithBlock,
} from "../src/lib/editor-document";
import { splitBySourceBoundaries } from "../src/lib/import-preview";
import { splitFrontmatter } from "../src/lib/markdown-source";
import { studyDocument } from "../src/lib/study-document";
import { BlockMath, InlineMath } from "../src/lib/tiptap-math";
import type { Workspace } from "../src/lib/types";
import type { ImportPreview } from "../src/lib/import-preview";
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
const { questions } = await import("../src/db/schema");
const { contentHash } = await import("../src/server/crypto");
const workspace = await import("../src/app/api/workspace/route");
const questionRoute = await import("../src/app/api/questions/route");
const preview = await import("../src/app/api/import/preview/route");
const commit = await import("../src/app/api/import/commit/route");
const reviews = await import("../src/app/api/reviews/route");
type Account = { id: string; cookie: string; deckId: string };
let alice: Account, bob: Account;
function request(user: Account, path: string, body?: unknown) {
  return new Request(`http://localhost:3000${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie: user.cookie,
      origin: "http://localhost:3000",
      "content-type": "application/json",
      "x-workspace-user": user.id,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function state(user: Account): Promise<Workspace> {
  return (await workspace.GET(request(user, "/api/workspace"))).json();
}
async function register(name: string): Promise<Account> {
  const response = await (
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
  assert.equal(response.status, 200);
  const data = await response.json();
  const user = {
    id: data.user.id,
    cookie: response.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; "),
    deckId: "",
  };
  user.deckId = (await state(user)).decks[0].id;
  return user;
}
before(async () => {
  alice = await register("editor-alice");
  bob = await register("editor-bob");
});

test("manual followup marking preserves formatted answers and survives rich-text Markdown round trips", () => {
  for (const raw of [
    "手动问题？\n**答案保留加粗。**\n\n- 第一条\n- 第二条",
    "手动问题？\nA：答案。",
    "Q：已有标记？\nA：已有答案。",
    "### 标题问题？\n代码与解释。",
    "## 常见面试追问\nQ：保留问题？\nA：保留全部答案。",
  ]) {
    const marked = markAsFollowup(raw);
    const parsed = studyDocument(marked);
    assert.equal(parsed.followups.length, 1);
    assert.ok(parsed.followups[0].answer);
    const manager = new MarkdownManager({ extensions: [StarterKit, TableKit] });
    const serialized = manager.serialize(manager.parse(marked));
    const edited = studyDocument(serialized);
    assert.equal(edited.followups.length, 1);
    assert.equal(edited.followups[0].question, parsed.followups[0].question);
  }
  const marked = markAsFollowup("问题？\n**答案格式**");
  assert.ok(studyDocument(marked).followups[0].answer.includes("**答案格式**"));
});

test("manual source selections map normalized textarea positions back to exact CRLF source", () => {
  const raw = "\uFEFF第一段。\r\n\r\n问题？\r\n答案。\r\n\r\n后续正文。";
  const normalized = raw.replace(/\r\n/g, "\n"),
    from = normalized.indexOf("问题？"),
    to = normalized.indexOf("\n\n后续");
  const selection = sourceSelection(raw, from, to);
  assert.equal(raw.slice(selection.from, selection.to), "问题？\r\n答案。");
  const updated =
    raw.slice(0, selection.from) +
    markAsFollowup(raw.slice(selection.from, selection.to)) +
    raw.slice(selection.to);
  assert.ok(updated.startsWith("\uFEFF第一段。\r\n\r\n"));
  assert.ok(updated.endsWith("\r\n\r\n后续正文。"));
  const bounded = replaceWithBlock(
    raw,
    selection.from,
    selection.to,
    markAsFollowup(raw.slice(selection.from, selection.to)),
  );
  assert.equal(
    bounded,
    raw.slice(0, selection.from) +
      markAsFollowup(raw.slice(selection.from, selection.to)) +
      raw.slice(selection.to),
  );
});

test("AI boundaries cannot promote an indented followup to a separate main question", () => {
  const raw =
    "## 主问题？\n主答案。\n\n  ### 追问\nQ：追问内容？\nA：保留在本题中。\n";
  for (const line of [4, 5])
    assert.throws(
      () =>
        splitBySourceBoundaries(
          raw,
          [
            { title: "主问题？", startLine: 1, answerStartLine: 2 },
            { title: "错误拆分", startLine: line, answerStartLine: 6 },
          ],
          false,
        ),
      /追问/,
    );
  assert.equal(
    splitBySourceBoundaries(
      raw,
      [{ title: "主问题？", startLine: 1, answerStartLine: 2 }],
      false,
    ).length,
    1,
  );
});

let currentId: string;
const original = "\uFEFF# 原题？\r\n\r\n  保留原有空格  \r\n";
test("title-only edits never rewrite the original answer bytes", async () => {
  const db = await getDb();
  currentId = randomUUID();
  await db.insert(questions).values({
    id: currentId,
    ownerId: alice.id,
    deckId: alice.deckId,
    title: "原题？",
    answer: original,
    sourceText: original,
    contentHash: contentHash("原题？", original),
  });
  const q = (await state(alice)).questions.find((q) => q.id === currentId)!;
  const response = await questionRoute.POST(
    request(alice, "/api/questions", {
      action: "edit",
      id: q.id,
      expectedRevision: 1,
      title: "修改标题后的原题？",
      answer: q.answer,
      tags: [],
    }),
  );
  assert.equal(response.status, 200);
  const [stored] = await db
    .select({
      hex: sql<string>`encode(convert_to(${questions.answer},'UTF8'),'hex')`,
    })
    .from(questions)
    .where(eq(questions.id, q.id));
  assert.equal(stored.hex, Buffer.from(original).toString("hex"));
});

test("reviewed whole-document splitting updates one stable question and adds the rest atomically and idempotently", async () => {
  assert.equal(
    (
      await questionRoute.POST(
        request(alice, "/api/questions", {
          action: "note",
          id: currentId,
          note: "原有私人笔记",
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
          questionId: currentId,
          questionRevision: 2,
          eventId: randomUUID(),
          expectedVersion: 0,
          rating: 3,
          answer: "原有个人作答",
        }),
      )
    ).status,
    200,
  );
  const before = (await state(alice)).questions.find(
    (q) => q.id === currentId,
  )!;
  const raw =
    "## 修改标题后的原题？\r\n更新后的核心答案。\r\n\r\n### 追问\r\nQ：为什么保留 ID？\r\nA：关联个人学习数据。\r\n\r\n## 新增的主问题？\r\n独立的新答案。\r\n";
  const parsedResponse = await preview.POST(
    request(alice, "/api/import/preview", {
      batchId: randomUUID(),
      deckId: alice.deckId,
      raw,
      inputType: "qa",
      method: "rules",
    }),
  );
  assert.equal(parsedResponse.status, 200);
  const parsed = (await parsedResponse.json()) as ImportPreview;
  assert.equal(parsed.questions.length, 2);
  assert.equal((await state(alice)).questions.length, 1);
  const payload = {
    batchId: parsed.batchId,
    questions: parsed.questions,
    replace: {
      id: currentId,
      key: parsed.questions[0].key,
      expectedRevision: 2,
      major: true,
    },
  };
  for (const response of await Promise.all([
    commit.POST(request(alice, "/api/import/commit", payload)),
    commit.POST(request(alice, "/api/import/commit", payload)),
  ])) {
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), {
      added: 1,
      duplicates: 0,
      updated: 1,
    });
  }
  const after = await state(alice),
    updated = after.questions.find((q) => q.id === currentId)!;
  assert.equal(after.questions.length, 2);
  assert.equal(updated.revision, 3);
  assert.equal(updated.majorRevision, 3);
  assert.equal(updated.note, before.note);
  assert.deepEqual(updated.fsrs, before.fsrs);
  assert.equal(after.recentReviews[0].answer, "原有个人作答");
  assert.equal(studyDocument(updated.answer).followups.length, 1);
  const [stored] = await (
    await getDb()
  )
    .select({
      hex: sql<string>`encode(convert_to(${questions.sourceText},'UTF8'),'hex')`,
    })
    .from(questions)
    .where(eq(questions.id, currentId));
  assert.equal(stored.hex, Buffer.from(original).toString("hex"));
});

test("stale or foreign replacement identities cannot write any part of a split batch", async () => {
  const response = await preview.POST(
    request(alice, "/api/import/preview", {
      batchId: randomUUID(),
      deckId: alice.deckId,
      raw: "## 修改标题后的原题？\n应整体拒绝的答案。\n\n## 不应被新增的题目？\n不应写入。",
      inputType: "qa",
      method: "rules",
    }),
  );
  const parsed = (await response.json()) as ImportPreview;
  const stale = {
    batchId: parsed.batchId,
    questions: parsed.questions,
    replace: {
      id: currentId,
      key: parsed.questions[0].key,
      expectedRevision: 2,
    },
  };
  assert.equal(
    (await commit.POST(request(alice, "/api/import/commit", stale))).status,
    409,
  );
  assert.equal((await state(alice)).questions.length, 2);
  assert.equal(
    (await state(alice)).questions.find((q) => q.id === currentId)!.revision,
    3,
  );
  const other = await preview.POST(
    request(bob, "/api/import/preview", {
      batchId: randomUUID(),
      deckId: bob.deckId,
      raw: "## 外部题目？\n不可更新别人的题目。",
      inputType: "qa",
      method: "rules",
    }),
  );
  const own = (await other.json()) as ImportPreview;
  assert.equal(
    (
      await commit.POST(
        request(bob, "/api/import/commit", {
          batchId: own.batchId,
          questions: own.questions,
          replace: {
            id: currentId,
            key: own.questions[0].key,
            expectedRevision: 3,
          },
        }),
      )
    ).status,
    404,
  );
  assert.equal((await state(bob)).questions.length, 0);
  assert.equal(
    (
      await commit.POST(
        request(alice, "/api/import/commit", {
          ...stale,
          replace: {
            ...stale.replace,
            key: "not-in-preview",
            expectedRevision: 3,
          },
        }),
      )
    ).status,
    400,
  );
});

test("splitFrontmatter isolates exact YAML metadata prefix without touching horizontal rules", () => {
  const crlfSource = "---\r\ntags:\r\n  - RAG\r\n---\r\n\r\n正文";
  const crlf = splitFrontmatter(crlfSource);
  assert.equal(crlf.prefix, "---\r\ntags:\r\n  - RAG\r\n---\r\n");
  assert.equal(crlf.metadata, "tags:\r\n  - RAG");
  assert.equal(crlf.body, "\r\n正文");
  assert.equal(crlf.prefix + crlf.body, crlfSource);

  const bomSource = "\uFEFF---\ntags:\n  - Retrieval\n---\n正文";
  const bom = splitFrontmatter(bomSource);
  assert.equal(bom.prefix, "\uFEFF---\ntags:\n  - Retrieval\n---\n");
  assert.equal(bom.metadata, "tags:\n  - Retrieval");
  assert.equal(bom.body, "正文");
  assert.equal(bom.prefix + bom.body, bomSource);

  const hrSource = "---\n\n正文";
  const hr = splitFrontmatter(hrSource);
  assert.equal(hr.prefix, "");
  assert.equal(hr.metadata, "");
  assert.equal(hr.body, hrSource);
});

test("MarkdownManager round-trips inline/block KaTeX math, tables, code blocks, and followup callouts cleanly", () => {
  const manager = new MarkdownManager({
    extensions: [StarterKit, TableKit, BlockMath, InlineMath],
  });

  const sample = [
    "## 核心推导",
    "",
    "向量点积满足 $a_i + b_j = \\frac{1}{k}$。",
    "",
    "$$",
    "\\sum_{i=1}^n x_i",
    "$$",
    "",
    "| 指标 | 说明 |",
    "| --- | --- |",
    "| Recall | Top-K 召回率 |",
    "",
    "```ts",
    "const score = (a: number, b: number) => a + b;",
    "```",
    "",
    "> [!question] 追问",
    "> Q：为什么不用纯 BM25？",
    "> A：因为同义词召回不足。",
  ].join("\n");

  const parsed = manager.parse(sample);
  const serialized = manager.serialize(parsed);

  assert.match(serialized, /\$a_i \+ b_j = \\frac\{1\}\{k\}\$/);
  assert.doesNotMatch(serialized, /\\_/);
  assert.match(serialized, /\$\$\n\\sum_\{i=1\}\^n x_i\n\$\$/);
  assert.match(serialized, /\|\s*指标\s*\|\s*说明\s*\|/);
  assert.match(serialized, /\|\s*Recall\s*\|\s*Top-K 召回率\s*\|/);
  assert.match(serialized, /```ts\nconst score = \(a: number, b: number\) => a \+ b;\n```/);

  const parsedDoc = studyDocument(serialized);
  assert.equal(parsedDoc.followups.length, 1);
  assert.match(parsedDoc.followups[0]?.question ?? "", /为什么不用纯 BM25/);
});

after(async () => {
  const connection = globalThis as unknown as {
    interviewDatabase?: Promise<{ close: () => Promise<void> }>;
  };
  await (await connection.interviewDatabase)?.close();
});
