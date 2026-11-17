import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { studyDocument, practiceDraftKey } from "../src/lib/study-document";

test("learning view: split paragraphs and list items without mutating CRLF source", () => {
  const raw =
    "---\r\ntags:\r\n - RAG\r\n---\r\n# 原题？\r\n\r\n第一段。\r\n\r\n第二段。\r\n\r\n1. 要点一\r\n2. 要点二\r\n\r\n| 字段 | 值 |\r\n|---|---|\r\n| ID | 1 |\r\n";
  const before = Buffer.from(raw);
  const result = studyDocument(raw, "原题？");
  assert.equal(result.blocks.length, 5);
  assert.equal(
    result.blocks.filter((block) => block.type === "listItem").length,
    2,
  );
  assert.deepEqual(
    result.blocks.map((block) => block.number),
    [1, 2, 3, 4, 5],
  );
  assert.ok(result.blocks.at(-1)!.markdown.includes("\r\n"));
  assert.ok(before.equals(Buffer.from(raw)));
});

test("learning view: nested concepts can be recalled individually while list headings stay visible", () => {
  const raw =
    "1. **稀疏召回**\n   - 原理：词面匹配。\n   - 优点：精确实体。\n     - 型号\n     - 数字\n";
  const result = studyDocument(raw);
  assert.equal(result.blocks[0].practice, false);
  assert.ok(result.blocks[0].markdown.startsWith("1. **稀疏召回**"));
  assert.ok(
    result.blocks.some(
      (block) => block.markdown === "- 原理：词面匹配。" && block.practice,
    ),
  );
  assert.ok(
    result.blocks.some(
      (block) => block.markdown === "- 型号" && block.depth === 2,
    ),
  );
  assert.ok(
    result.blocks.some(
      (block) => block.markdown === "- 数字" && block.practice,
    ),
  );
});

test("learning view: followups have their own Q/A column; code and incomplete Q/A stay visible", () => {
  const raw =
    "正文。\n\n> [!question] 面试追问\n> **Q：第一个问题？**\n> **A：** 回答一。\n>\n> **Q：第二个问题？**\n> **A：** 回答二。\n> ```text\n> Q: 这是代码\n> ```\n\n## 后续正文\n\n保留这里。";
  const result = studyDocument(raw);
  assert.equal(result.followups.length, 2);
  assert.equal(result.followups[0].question, "第一个问题？");
  assert.equal(result.followups[0].answer, "回答一。");
  assert.ok(result.followups[1].answer.includes("Q: 这是代码"));
  assert.ok(result.blocks.some((block) => block.markdown === "保留这里。"));
  assert.ok(
    !result.blocks.some((block) => block.markdown.includes("第一个问题")),
  );
  const incomplete = studyDocument("> [!question]\n> Q: 没有答案？");
  assert.equal(incomplete.followups.length, 0);
  assert.ok(incomplete.blocks[0].markdown.includes("没有答案"));
});

test("learning view: all imported followups are extracted without changing the eight source answers", () => {
  const manifest = JSON.parse(
    readFileSync("content/interview-manifest.json", "utf8"),
  );
  let count = 0;
  for (const file of manifest.files.filter(
    (file: { kind: string }) => file.kind === "question",
  )) {
    const bytes = readFileSync(`content/interview-original/${file.path}`);
    const result = studyDocument(bytes.toString("utf8"));
    count += result.followups.length;
    assert.ok(result.blocks.length);
    assert.ok(
      bytes.equals(readFileSync(`content/interview-original/${file.path}`)),
    );
  }
  assert.equal(count, 28);
});

test("learning drafts: user, source revision and paragraph all isolate their keys", () => {
  assert.notEqual(
    practiceDraftKey("alice", "q", 1),
    practiceDraftKey("bob", "q", 1),
  );
  assert.notEqual(
    practiceDraftKey("alice", "q", 1),
    practiceDraftKey("alice", "q", 2),
  );
  assert.notEqual(
    practiceDraftKey("alice", "q", 1, "paragraph:1"),
    practiceDraftKey("alice", "q", 1, "paragraph:2"),
  );
});
