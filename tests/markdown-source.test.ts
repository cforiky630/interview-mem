import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/components/markdown";
import {
  markdownDocument,
  normalizedNoteTitle,
} from "../src/lib/markdown-source";

test("source Markdown: metadata is read without changing CRLF, BOM or original text", () => {
  const source =
    "\uFEFF---\r\ntags:\r\n  - RAG\r\n  - 面试\r\n---\r\n# 原题\r\n\r\n答案\r\n";
  const hash = createHash("sha256").update(source).digest("hex");
  const result = markdownDocument(source);
  assert.deepEqual(result.tags, ["RAG", "面试"]);
  assert.equal(result.body, "# 原题\r\n\r\n答案\r\n");
  assert.equal(createHash("sha256").update(source).digest("hex"), hash);
  const ordinary = "---\n这是一段正文\n---\n后续段落";
  assert.equal(markdownDocument(ordinary).body, ordinary);
});

test("source Markdown: formulas, Obsidian callouts and links render; code stays literal", () => {
  const source =
    "---\ntags:\n  - RAG\n---\n# 原题\n\n$\\frac{1}{k+\\mathrm{rank}}\u200b$\n\n> [!question] 面试追问\n> **Q：为什么？**\n> **A：** 答案。\n\n[[01-关联题|去看关联题]]\n\n`[[不可链接]]`\n\n```js\n[[代码里也不可链接]]\n```\n";
  const html = renderToStaticMarkup(
    createElement(Markdown, { children: source }),
  );
  assert.ok(html.includes('class="katex"'));
  assert.ok(!html.includes("katex-error"));
  const latex = html.match(/<annotation[^>]*>([\s\S]*?)<\/annotation>/)?.[1];
  assert.ok(latex);
  assert.ok(!latex.includes("\u200B"));
  assert.ok(html.includes('data-callout="question"'));
  assert.ok(!html.includes("[!question]"));
  assert.ok(!html.includes("tags:"));
  assert.ok(html.includes("#note=01-"));
  assert.ok(html.includes("<code>[[不可链接]]</code>"));
  assert.ok(html.includes("[[代码里也不可链接]]"));
  assert.equal((html.match(/href=/g) ?? []).length, 1);
  assert.equal(
    normalizedNoteTitle("RAG/01-关联题.md"),
    normalizedNoteTitle("关联题？"),
  );
});

test("source Markdown: imported answers and AI text cannot enable HTML or trusted math commands", () => {
  const source =
    "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[click](javascript:alert%281%29)\n\n$\\href{javascript:alert(1)}{click}$\n\n$\\includegraphics{https://tracking.example/secret}$";
  const html = renderToStaticMarkup(
    createElement(Markdown, { children: source }),
  );
  assert.ok(!/<(?:script|iframe|img)\b/i.test(html));
  assert.ok(!/(?:href|src)=["'](?:javascript:|data:)/i.test(html));
  assert.ok(!html.includes('src="https://tracking.example'));
});
