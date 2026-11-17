import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuestions, parseQuestionTitles } from "../src/lib/importer";
import { contentHash, decryptKey, encryptKey } from "../src/server/crypto";
import { schedule, reviewInsight } from "../src/server/scheduler";

test("question-only import: plain lines, numbering and Markdown titles stay separate and unanswered", () => {
  const parsed = parseQuestions(
    "什么是闭包？\r\n\r\n1. 为什么需要索引？\n- 请说明事务隔离。\n## Q3: 如何处理并发？\n二、谈谈缓存失效。\n+ [ ] Java 的 volatile 有什么作用？\n1.2 版与 1.3 版有什么区别？",
    "questions",
  );
  assert.deepEqual(
    parsed.map((q) => q.title),
    [
      "什么是闭包？",
      "为什么需要索引？",
      "请说明事务隔离。",
      "如何处理并发？",
      "谈谈缓存失效。",
      "Java 的 volatile 有什么作用？",
      "1.2 版与 1.3 版有什么区别？",
    ],
  );
  assert.ok(parsed.every((q) => q.answer === "" && q.needsEditing));
  assert.deepEqual(parseQuestionTitles(" \n\r\n"), []);
  const long = "原始问题".repeat(60);
  assert.equal(
    parseQuestionTitles(long)[0].title,
    long,
    "long titles must be validated, never silently truncated",
  );
});

test("import: split Markdown questions and preserve code, nested headings and lists", () => {
  const raw =
    "# 面试资料\n\n## 什么是闭包？\n闭包说明。\n### 使用场景\n1. 私有状态\n2. 回调\n```js\n## 这里不是题目\nQ: this is code\n```\n\n## 什么是事件循环？\n答案：\n执行同步任务与微任务。";
  const parsed = parseQuestions(raw);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].title, "什么是闭包？");
  assert.ok(parsed[0].answer.includes("### 使用场景"));
  assert.ok(parsed[0].answer.includes("Q: this is code"));
  assert.equal(parsed[1].answer, "执行同步任务与微任务。");
});
test("import: Q/A and numbered questions keep answer lists together", () => {
  assert.equal(
    parseQuestions(
      "Q: 什么是闭包？\nA: 环境与函数。\nQ: 什么是索引？\nA: 检索结构。",
    ).length,
    2,
  );
  const parsed = parseQuestions(
    "1. 什么是索引？\n1. 先看执行计划\n2. 再验证查询\n2. 为什么需要事务？\n保证一致性。",
  );
  assert.equal(parsed.length, 2);
  assert.ok(parsed[0].answer.includes("2. 再验证查询"));
});

test("import: shorter fences inside a longer code block cannot expose fake main questions", () => {
  const raw =
    "## 真正的第一题？\n解释。\n````md\n```text\n## 代码中的假问题？\n```\n````\n\n## 真正的第二题？\n第二个答案。";
  const cards = parseQuestions(raw, "qa", { preserveSource: true });
  assert.equal(cards.length, 2);
  assert.equal(cards[1].title, "真正的第二题？");
  assert.ok(cards[0].answer.includes("代码中的假问题"));
});
test("import: missing answers are put in inbox; CRLF, empty input and tables survive", () => {
  assert.deepEqual(parseQuestions("  "), []);
  assert.equal(parseQuestions("只有一个题目")[0].needsEditing, true);
  assert.equal(
    parseQuestions("## 数组是什么？\nArray is a collection.")[0].answer,
    "Array is a collection.",
  );
  assert.equal(
    parseQuestions("## 缓存？\r\n|字段|说明|\r\n|---|---|\r\n|ETag|验证器|")[0]
      .answer,
    "|字段|说明|\n|---|---|\n|ETag|验证器|",
  );
});
test("crypto: authenticated encryption binds each secret to its owner", () => {
  const secret = "test-master-key-012345678901234567890";
  const encrypted = encryptKey("sk-example-not-real-secret", "alice", secret);
  assert.equal(
    decryptKey(encrypted, "alice", secret),
    "sk-example-not-real-secret",
  );
  assert.ok(!encrypted.includes("sk-example"));
  assert.notEqual(
    encrypted,
    encryptKey("sk-example-not-real-secret", "alice", secret),
  );
  assert.throws(() => decryptKey(encrypted, "bob", secret));
  assert.throws(() =>
    decryptKey(encrypted, "alice", "wrong-key-01234567890123456789012345"),
  );
  const parts = encrypted.split(".");
  parts[3] = (parts[3][0] === "A" ? "B" : "A") + parts[3].slice(1);
  assert.throws(() => decryptKey(parts.join("."), "alice", secret));
});
test("hash: normalize harmless outer spaces without discarding answer differences", () => {
  assert.equal(
    contentHash("  缓存？ ", "答案\r\n内容"),
    contentHash("缓存？", "答案\n内容"),
  );
  assert.notEqual(
    contentHash("缓存？", "答案 A"),
    contentHash("缓存？", "答案 B"),
  );
});
test("FSRS: grades schedule real intervals, serialize/reload, and produce a bounded prediction", async () => {
  const now = new Date("2026-11-14T02:00:00Z");
  const again = await schedule(null, 1, now);
  const good = await schedule(null, 3, now);
  const easy = await schedule(null, 4, now);
  assert.ok(new Date(again.due) > now);
  assert.ok(new Date(good.due) > new Date(again.due));
  assert.ok(new Date(easy.due) >= new Date(good.due));
  const reloaded = JSON.parse(JSON.stringify(good));
  const next = await schedule(reloaded, 3, new Date(good.due));
  assert.equal(next.reps, 2);
  assert.ok(next.stability > 0);
  const insight = await reviewInsight(next, new Date(next.due));
  assert.equal(insight.previews.length, 4);
  assert.ok(insight.curve.length > 0);
  assert.ok(insight.curve.every((p) => p.retention >= 0 && p.retention <= 100));
  assert.ok(insight.curve[0].retention >= insight.curve.at(-1)!.retention);
});
