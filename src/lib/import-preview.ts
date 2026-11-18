import type { ParsedQuestion } from "./importer";
import { followupRegions } from "./followups";
import { markdownDocument } from "./markdown-source";
export type ImportMethod = "rules" | "ai" | "whole";
export type ImportPreviewItem = ParsedQuestion & {
  key: string;
  sourceText: string;
};
export type ImportPreview = {
  batchId: string;
  questions: ImportPreviewItem[];
  warning: string;
};
export type SourceBoundary = {
  startLine: number;
  answerStartLine: number | null;
  title: string;
};

/** Use source offsets so AI can suggest boundaries without rewriting the answers. */
export function splitBySourceBoundaries(
  raw: string,
  boundaries: SourceBoundary[],
  questionsOnly: boolean,
) {
  const lines =
    raw
      .match(/[^\n]*(?:\n|$)/g)
      ?.filter((line, i, all) => line || i < all.length - 1) ?? [];
  const offsets = [0];
  for (const line of lines) offsets.push(offsets.at(-1)! + line.length);
  const inFence: boolean[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of lines) {
    inFence.push(!!fence);
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (
        fence.char === marker[1][0] &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = null;
    }
  }
  if (!boundaries.length || boundaries.length > 200)
    throw new Error("没有识别出有效题目。");
  const followups = questionsOnly ? [] : followupRegions(raw);
  const docTags = markdownDocument(raw).tags;
  return boundaries.map((boundary, i) => {
    const { startLine, answerStartLine, title } = boundary;
    const end = (boundaries[i + 1]?.startLine ?? lines.length + 1) - 1;
    if (
      !Number.isInteger(startLine) ||
      startLine < 1 ||
      startLine > end ||
      end > lines.length ||
      (i > 0 && startLine <= boundaries[i - 1].startLine) ||
      inFence[startLine - 1] ||
      !title.trim() ||
      title.length > 200 ||
      (answerStartLine !== null &&
        (!Number.isInteger(answerStartLine) ||
          answerStartLine <= startLine ||
          answerStartLine > end + 1 ||
          inFence[answerStartLine - 1]))
    ) {
      throw new Error("模型返回的切分位置无效，请重新解析或使用自动切分。");
    }
    if (
      followups.some(
        (region) =>
          region.start < (offsets[startLine] ?? raw.length) &&
          region.end > offsets[startLine - 1],
      )
    )
      throw new Error("模型把追问切成了主问题，请重新解析或使用自动切分。");
    const sourceText = raw.slice(offsets[startLine - 1], offsets[end]);
    const tags = Array.from(
      new Set([...docTags, ...markdownDocument(sourceText).tags]),
    ).slice(0, 12);
    const answer =
      questionsOnly || answerStartLine === null
        ? ""
        : raw.slice(offsets[answerStartLine - 1], offsets[end]);
    return {
      title: title.trim(),
      answer,
      tags,
      needsEditing: !answer.trim(),
      sourceText,
    };
  });
}
