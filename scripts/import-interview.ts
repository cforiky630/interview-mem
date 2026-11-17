import env from "@next/env";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { z } from "zod";
import { markdownDocument } from "../src/lib/markdown-source";
import { contentHash } from "../src/server/crypto";
import {
  importLibrary,
  type LibraryDocument,
} from "../src/server/import-library";

env.loadEnvConfig(process.cwd());
const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    source: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
const ownerId = values["dry-run"]
  ? values.owner
  : z.string().uuid().parse(values.owner);
const manifest = z
  .object({
    sourceRoot: z.string(),
    snapshotAt: z.string(),
    files: z.array(
      z.object({
        path: z.string(),
        bytes: z.number().int(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        kind: z.enum(["question", "note", "index"]),
      }),
    ),
  })
  .parse(JSON.parse(await readFile("content/interview-manifest.json", "utf8")));
const findingSchema = z.object({
  id: z.string(),
  severity: z.enum(["error", "qualification", "terminology"]),
  line: z.number().int().positive(),
  title: z.string(),
  explanation: z.string(),
  suggestion: z.string(),
  sources: z.array(
    z.object({
      title: z.string(),
      url: z.url().refine((value) => value.startsWith("https://")),
    }),
  ),
});
const review = z
  .object({
    checkedAt: z.string(),
    scope: z.string(),
    documents: z.array(
      z.object({
        path: z.string(),
        summary: z.string(),
        findings: z.array(findingSchema),
        references: z.array(z.object({ title: z.string(), url: z.url() })),
      }),
    ),
  })
  .parse(JSON.parse(await readFile("content/interview-review.json", "utf8")));
const sourceRoot = await realpath(values.source ?? manifest.sourceRoot);
const archiveRoot = await realpath("content/interview-original");
async function boundedPath(root: string, relative: string) {
  const target = await realpath(path.resolve(root, relative));
  const resolved = path.relative(root, target);
  if (resolved.startsWith("..") || path.isAbsolute(resolved))
    throw new Error("文件路径超出指定题库目录。");
  return target;
}
const documents: LibraryDocument[] = [];
for (const file of manifest.files) {
  const original = await readFile(await boundedPath(sourceRoot, file.path));
  const archive = await readFile(await boundedPath(archiveRoot, file.path));
  const hash = createHash("sha256").update(original).digest("hex");
  if (
    hash !== file.sha256 ||
    original.length !== file.bytes ||
    !original.equals(archive)
  )
    throw new Error(`文件已发生变化，请重新核验后导入：${file.path}`);
  const raw = original.toString("utf8");
  const info = markdownDocument(raw);
  const title =
    file.kind === "note"
      ? `RAG 复习笔记 · ${path.basename(file.path, ".md")}`
      : (info.body.match(/^#\s+(.+?)\s*#*\r?$/m)?.[1] ??
        path.basename(file.path, ".md"));
  const checked = review.documents.find(
    (document) => document.path === file.path,
  );
  if (file.kind !== "index" && !checked)
    throw new Error(`缺少该文件的独立校验记录：${file.path}`);
  documents.push({
    path: file.path,
    kind: file.kind,
    title,
    raw,
    sha256: hash,
    tags: file.kind === "note" ? ["RAG", "复习笔记"] : info.tags,
    validation: checked
      ? {
          checkedAt: review.checkedAt,
          sourcePath: file.path,
          sourceSha256: hash,
          reviewedHash: contentHash(title, raw),
          summary: checked.summary,
          findings: checked.findings,
        }
      : null,
  });
}

const findings = review.documents.flatMap((document) => document.findings);
const followups = documents
  .filter((document) => document.kind === "question")
  .reduce(
    (total, document) =>
      total + Array.from(document.raw.matchAll(/^>\s*\*\*Q[：:]/gm)).length,
    0,
  );
const severityLabels = {
  error: "概念问题",
  qualification: "适用条件需补充",
  terminology: "术语笔误",
};
const report: string[] = [
  "# 面试资料内容校验",
  "",
  `校验日期：${review.checkedAt}。${review.scope} 原文快照时间：${manifest.snapshotAt}。第 3 题按扩写后的快照重新核验，后续外部编辑不自动覆盖本次入库版本。`,
  "",
  "原始目录：`" +
    manifest.sourceRoot +
    "`。原始文件没有写回；完整副本存于 `content/interview-original/`。",
  "",
  `共 ${findings.length} 处记录：${findings.filter((f) => f.severity === "error").length} 处概念问题、${findings.filter((f) => f.severity === "qualification").length} 处适用条件、${findings.filter((f) => f.severity === "terminology").length} 处术语笔误。建议只作为独立说明，未替换任何原句。`,
  "",
  "## 逐文件结论",
  "",
  "| 文件 | 校验结论 | 记录数 |",
  "| --- | --- | --- |",
];
for (const document of review.documents)
  report.push(
    `| ${document.path} | ${document.summary.replaceAll("|", "\\|")} | ${document.findings.length} |`,
  );
report.push("", "## 内容问题明细", "");
for (const document of review.documents)
  for (const finding of document.findings) {
    const source = documents.find((d) => d.path === document.path)!;
    const fileLink = path
      .join(archiveRoot, document.path)
      .replaceAll("\\", "/");
    report.push(
      `### ${finding.id} · ${finding.title}`,
      "",
      `类别：${severityLabels[finding.severity]}。位置：[${document.path} 第 ${finding.line} 行](<${fileLink}:${finding.line}>)。`,
      "",
      "> " + source.raw.split(/\r?\n/)[finding.line - 1],
      "",
      finding.explanation,
      "",
      `建议理解：${finding.suggestion}`,
      "",
      "依据：" +
        finding.sources
          .map((reference) => `[${reference.title}](${reference.url})`)
          .join("、") +
        "。",
      "",
    );
  }
report.push(
  "## 已核实的关键点",
  "",
  "- 第 1、3、7 题：RAG、HyDE、Self-RAG、CRAG 与 GraphRAG 的作用边界，参考各题所列原始论文。",
  "- 第 2 题：BM25 与词法匹配、RRF 的排名融合；模型能力的限制单独列出。",
  "- 第 4 题：原文、阅读顺序、OCR 和表格关系需保留，没有实测每一个第三方解析工具。",
  "- 第 5 题：Contextual Retrieval 是前置块说明；Late Chunking 是长文编码后、块内池化。",
  "- 第 6 题：单位向量平方 L2 = 2 − 2 × 内积；ANN 召回与业务相关性召回不能混用。",
  "- 第 8 题：示例 Hit@5=1、Recall@5=0.25、Precision@5=0.2、RR@5=0.5；Faithfulness 不能替代事实正确性。",
  "",
  "## 逐文件核验依据",
  "",
);
for (const document of review.documents)
  report.push(
    `- ${document.path}：` +
      document.references
        .map((reference) => `[${reference.title}](${reference.url})`)
        .join("、") +
      "。",
  );
report.push(
  "",
  "## 范围与保留方式",
  "",
  `- 8 道 RAG 主问题各自按整个 Markdown 文件导入，${followups} 道追问保持内嵌，不拆分。复习笔记作为独立资料卡保留。`,
  "- 索引文件不是练习题，保留原始副本与原文导入记录。未导入 `.obsidian`、`.claudian` 等工具配置目录。",
  "- 标题、列表、callout、公式、空白和换行都保存在原始文本中；显示层只解释 Obsidian/Markdown 语法，不回写源文件。",
  "- 结果是本次对主要定义、公式、边界与追问的人工内容校验；“未发现明确错误”不等于对所有工程配置作性能保证。工具选型仍需实际语料验证。",
  "- 如果后续在应用内编辑答案，旧校验会标为针对导入版本，避免误认为新内容也已核验。",
  "",
);
await mkdir("docs", { recursive: true });
await writeFile("docs/content-review-2026-11-14.md", report.join("\n"));
if (values["dry-run"])
  console.log(
    JSON.stringify({
      dryRun: true,
      documents: documents.length,
      questionCards: documents.filter((d) => d.kind !== "index").length,
      embeddedFollowups: followups,
      findings: findings.length,
      allBytesPreserved: true,
    }),
  );
else {
  try {
    const result = await importLibrary(ownerId!, documents);
    const { getDb } = await import("../src/db");
    const { questions } = await import("../src/db/schema");
    const { inArray } = await import("drizzle-orm");
    const db = await getDb();
    const saved = await db
      .select({
        id: questions.id,
        answer: questions.answer,
        source: questions.sourceText,
      })
      .from(questions)
      .where(
        inArray(
          questions.id,
          result.imported.map((item) => item.questionId),
        ),
      );
    for (const item of result.imported) {
      const row = saved.find((q) => q.id === item.questionId);
      if (
        !row ||
        row.source !== row.answer ||
        createHash("sha256")
          .update(Buffer.from(row.answer, "utf8"))
          .digest("hex") !== item.sha256
      )
        throw new Error(`入库后字节校验失败：${item.sourcePath}`);
    }
    await mkdir(".data/imports", { recursive: true });
    await writeFile(
      ".data/imports/interview-import.json",
      JSON.stringify(
        {
          ...result,
          verifiedAt: new Date().toISOString(),
          allBytesPreserved: true,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        owner: result.owner,
        added: result.added,
        duplicates: result.duplicates,
        originalFiles: result.originals,
        allBytesPreserved: true,
        findings: findings.length,
      }),
    );
  } finally {
    const state = globalThis as unknown as {
      interviewDatabase?: Promise<{ close: () => Promise<void> }>;
    };
    await (await state.interviewDatabase)?.close();
  }
}
