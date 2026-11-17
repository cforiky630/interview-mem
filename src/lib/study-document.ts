import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { markdownDocument, normalizedNoteTitle } from "./markdown-source";

type Node = {
  type: string;
  depth?: number;
  value?: string;
  children?: Node[];
  position?: {
    start: { offset?: number; column?: number };
    end: { offset?: number };
  };
};
export type StudyBlock = {
  id: string;
  markdown: string;
  type: string;
  practice: boolean;
  number: number;
  depth: number;
};
export type Followup = { id: string; question: string; answer: string };
export type StudyDocument = {
  blocks: StudyBlock[];
  followups: Followup[];
  references: string;
};
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

function text(node: Node): string {
  return node.value ?? node.children?.map(text).join("") ?? "";
}

/** Read Q/A only at line boundaries, and never interpret fenced code as a question. */
function followupPairs(source: string, key: string): Followup[] {
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.replace(/^ {0,3}> ?/, ""));
  if (!/^\s*\[!question\]/i.test(lines[0] ?? "")) return [];
  lines.shift();
  const pairs: Followup[] = [];
  let question = "",
    answer: string[] = [],
    answering = false;
  let fence: { char: string; length: number } | null = null;
  let unsupported = false;
  function finish() {
    if (question)
      pairs.push({
        id: `${key}:${pairs.length}`,
        question: question.trim(),
        answer: answer.join("\n").trim(),
      });
    question = "";
    answer = [];
    answering = false;
  }
  for (const line of lines) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length)
        fence = null;
      if (answering) answer.push(line);
      else if (line.trim()) unsupported = true;
      continue;
    }
    if (fence) {
      if (answering) answer.push(line);
      continue;
    }
    const q = line.match(/^\s*(?:\*\*|__)?(?:Q|问|问题)\s*[：:]\s*(.*)$/i);
    const a = line.match(
      /^\s*(?:\*\*|__)?(?:A|答|答案)\s*[：:]\s*(?:\*\*|__)?\s*(.*)$/i,
    );
    if (q) {
      finish();
      question = q[1].replace(/(?:\*\*|__)\s*$/, "");
    } else if (a && question) {
      answering = true;
      answer.push(a[1]);
    } else if (answering) answer.push(line);
    else if (line.trim()) unsupported = true;
  }
  finish();
  return unsupported || pairs.some((pair) => !pair.answer) ? [] : pairs;
}

/** Derive the learning view from source offsets. No source text is rewritten or saved. */
export function studyDocument(source: string, title = ""): StudyDocument {
  const { body } = markdownDocument(source);
  const root = parser.parse(body) as Node;
  const slice = (node: Node) =>
    body.slice(
      node.position?.start.offset ?? 0,
      node.position?.end.offset ?? 0,
    );
  const definitions =
    root.children
      ?.filter((node) => node.type === "definition")
      .map(slice)
      .join("\n") ?? "";
  const blocks: StudyBlock[] = [],
    followups: Followup[] = [];
  let number = 0;
  function append(
    unit: Node,
    depth = 0,
    raw = slice(unit),
    canPractice?: boolean,
    column = unit.position?.start.column ?? 1,
  ) {
    const practice =
      canPractice ??
      ["paragraph", "listItem", "blockquote", "code", "math", "table"].includes(
        unit.type,
      );
    if (practice) number++;
    // Dedent a nested item's continuation lines only in the derived view.
    const markdown =
      column > 1
        ? raw.replace(/(?<=\n)[ \t]+/g, (space) =>
            space.slice(Math.min(space.length, column - 1)),
          )
        : raw;
    blocks.push({
      id: `${unit.position?.start.offset ?? 0}:${unit.position?.end.offset ?? 0}`,
      markdown,
      type: unit.type,
      practice,
      number,
      depth,
    });
  }
  function listItems(list: Node, depth: number) {
    for (const item of list.children ?? []) {
      const children = item.children ?? [];
      if (!children.some((child) => child.type === "list")) {
        append(item, depth);
        continue;
      }
      children.forEach((child, index) => {
        if (child.type === "list") {
          listItems(child, depth + 1);
          return;
        }
        const prefix = index === 0 && child.type === "paragraph";
        const raw = prefix
          ? body.slice(
              item.position?.start.offset ?? 0,
              child.position?.end.offset ?? 0,
            )
          : slice(child);
        append(
          child,
          depth,
          raw,
          prefix && text(child).length < 90 ? false : undefined,
          prefix ? item.position?.start.column : child.position?.start.column,
        );
      });
    }
  }
  for (const node of root.children ?? []) {
    if (node.type === "definition") continue;
    if (
      node.type === "heading" &&
      node.depth === 1 &&
      normalizedNoteTitle(text(node)) === normalizedNoteTitle(title)
    )
      continue;
    if (node.type === "blockquote") {
      const pairs = followupPairs(
        slice(node),
        String(node.position?.start.offset ?? 0),
      );
      if (pairs.length) {
        followups.push(...pairs);
        continue;
      }
    }
    if (node.type === "list") listItems(node, 0);
    else append(node);
  }
  return { blocks, followups, references: definitions };
}

export function practiceDraftKey(
  userId: string,
  questionId: string,
  revision: number,
  part = "answer",
) {
  return `shiyi:practice:${userId}:${questionId}:v${revision}:${part}`;
}

export function readPracticeDraft(key: string) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
export function savePracticeDraft(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
