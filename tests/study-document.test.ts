import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { studyDocument, practiceDraftKey } from "../src/lib/study-document";
import { parseQuestions } from "../src/lib/importer";

test("whole documents share heading-based followup recognition with imports", () => {
  const source =
    "# 闭包是什么？\r\n\r\n正文与示例。\r\n\r\n1. 要点\r\n   - 嵌套列表\r\n2. 结论\r\n\r\n## 面试追问\r\n\r\nQ1：怎么保存状态？\r\nA：用词法环境。\r\n\r\nQ2：注意什么？\r\nA：避免持有多余引用。\r\n```text\r\nQ：代码里的示例\r\nA：不是追问\r\n```\r\n\r\n## 参考资料\r\n保留链接说明。\r\n";
  const view = studyDocument(source, "闭包是什么？");
  assert.equal(view.followups.length, 2);
  assert.equal(view.followups[0].question, "怎么保存状态？");
  assert.ok(view.followups[1].answer.includes("Q：代码里的示例"));
  assert.ok(
    view.blocks.some((block) => block.markdown.includes("保留链接说明")),
  );
  assert.ok(
    !view.blocks.some((block) => block.markdown.includes("怎么保存状态")),
  );
  assert.ok(view.bodyMarkdown.includes("1. 要点\r\n   - 嵌套列表\r\n2. 结论"));
  assert.ok(view.bodyMarkdown.includes("## 参考资料\r\n保留链接说明。"));
  assert.doesNotMatch(view.bodyMarkdown, /闭包是什么|怎么保存状态|注意什么/);
  const imported = parseQuestions(source, "qa", { preserveSource: true });
  assert.equal(imported.length, 1);
  assert.equal(imported[0].title, "闭包是什么？");
  assert.equal(studyDocument(imported[0].answer).followups.length, 2);
  assert.equal(source.includes("\r\n"), true);
});

test("plain followup sections stop at the next heading and literal code markers stay in the body", () => {
  const source =
    "## 第一主问题？\n核心答案。\n\n追问：\nQ：追问是什么？\nA：属于第一题。\n\n## 第二主问题？\n第二个答案。";
  const cards = parseQuestions(source, "qa", { preserveSource: true });
  assert.equal(cards.length, 2);
  assert.equal(studyDocument(cards[0].answer).followups.length, 1);
  assert.equal(
    studyDocument("正文。\n\n追问：如何手动分类？\n答：选中后指定。").followups
      .length,
    1,
  );
  assert.equal(
    studyDocument("> `[!question]`\n> Q: 文档示例？\n> A: 仍然属于正文。")
      .followups.length,
    0,
  );
});

test("followups accept Markdown emitted by rich editing, numbered headings and Chinese Q/A", () => {
  const edited =
    "正文。\n\n> \\[!question\\] 面试追问\n> **Q：问题一？**\n> **A：** 答案一。\n";
  assert.equal(studyDocument(edited).followups[0].answer, "答案一。");
  const structured =
    "正文\n\n## 追问\n### 1. 如何设计？\n按职责拆分。\n### 2. 有哪些边界？\n保留代码和列表。\n\n## 总结\n正文结尾。";
  const result = studyDocument(structured);
  assert.equal(result.followups.length, 2);
  assert.equal(result.followups[1].question, "有哪些边界？");
  assert.ok(result.blocks.some((block) => block.markdown === "正文结尾。"));
  assert.equal(
    studyDocument("## 追问\n- **问：** 怎么选？\n- **答：** 结合场景。")
      .followups[0].answer,
    "结合场景。",
  );
});

test("incomplete followups and question-like code remain in the document instead of being lost or split", () => {
  const source =
    "## 主问题？\n正文。\n\n### 追问\nQ：暂时没有答案？\n\n## 另一道主问题？\n第二个答案。";
  const view = studyDocument(source);
  assert.equal(view.followups.length, 0);
  assert.equal(view.unresolvedFollowups, 1);
  assert.ok(
    view.blocks.some((block) => block.markdown.includes("暂时没有答案")),
  );
  assert.ok(view.bodyMarkdown.includes("暂时没有答案"));
  const cards = parseQuestions(source, "qa", { preserveSource: true });
  assert.equal(cards.length, 2);
  assert.ok(cards[0].answer.includes("暂时没有答案"));
  assert.equal(cards[1].title, "另一道主问题？");
  assert.equal(
    studyDocument("```md\n## 追问\nQ: 只是代码？\nA: 只是文本。\n```").followups
      .length,
    0,
  );
});

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
