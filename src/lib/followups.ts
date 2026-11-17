import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

export type MarkdownNode = {
  type: string;
  depth?: number;
  value?: string;
  children?: MarkdownNode[];
  position?: {
    start: { offset?: number; column?: number };
    end: { offset?: number };
  };
};
export type Followup = { id: string; question: string; answer: string };
export type FollowupRegion = {
  start: number;
  end: number;
  items: Followup[];
  complete: boolean;
};
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
export function parseMarkdown(source: string) {
  return parser.parse(source) as MarkdownNode;
}
export function markdownText(node: MarkdownNode): string {
  return node.value ?? node.children?.map(markdownText).join("") ?? "";
}
const start = (node: MarkdownNode) => node.position?.start.offset ?? 0;
const end = (node: MarkdownNode) => node.position?.end.offset ?? 0;

function headingTitle(value: string) {
  return value
    .replace(/^(\*\*|__)(.*)\1$/, "$2")
    .trim()
    .replace(/^\d+[.、)）]\s*/, "")
    .replace(/[：:]\s*$/, "")
    .trim();
}
export function isFollowupSection(value: string) {
  return /^(?:(?:常见|面试|延伸|进阶)\s*)*(?:追问(?:汇总|合集)?|延伸问题|follow[ -]?ups?)(?:\s*[（(]\d+\s*(?:题|个)?[)）])?$/i.test(
    headingTitle(value),
  );
}
function inlineQuestion(value: string) {
  return value
    .trim()
    .match(
      /^(?:(?:面试|延伸)\s*)?追问\s*(?:\d+|[一二三四五六七八九十]+)?\s*[：:、.．]\s*(.+)$/,
    )?.[1]
    ?.trim();
}
function questionHeading(value: string) {
  const inline = inlineQuestion(value);
  if (inline) return inline;
  const q = marker(value, "question");
  if (q !== null) return q;
  const numbered = value.match(
    /^(?:\d+|[一二三四五六七八九十]+)[.、)）]\s*(.+)$/,
  );
  if (numbered) return numbered[1];
  return /[?？]\s*$/.test(value) ? value : null;
}

function marker(value: string, kind: "question" | "answer") {
  const candidate = value.replace(/^ {0,3}(?:[-*+]\s+|\d+[.)、]\s+)?/, "");
  const pattern =
    kind === "question"
      ? /^(\*\*|__)?(?:Q(?:uestion)?|问(?:题)?|追问)\s*(?:\d+|[一二三四五六七八九十]+)?(?:\*\*|__)?\s*[：:]\s*(.*)$/i
      : /^(\*\*|__)?(?:A(?:nswer)?|答(?:案)?|回答|解答)(?:\*\*|__)?\s*[：:]\s*(.*)$/i;
  const found = candidate.match(pattern);
  if (!found) return null;
  let content = found[2];
  if (found[1] && content.startsWith(found[1]))
    content = content.slice(found[1].length).trimStart();
  else if (
    found[1] &&
    kind === "question" &&
    content.trimEnd().endsWith(found[1])
  )
    content = content.trimEnd().slice(0, -found[1].length);
  return content;
}

/** Extract only explicitly scoped, complete Q/A; uncertain sections remain visible as source. */
function pairs(source: string, key: string, implicit?: string, quoted = false) {
  const lines = source
    .split(/\r\n?|\n/)
    .map((line) => (quoted ? line.replace(/^ {0,3}> ?/, "") : line));
  const items: Followup[] = [];
  let question = implicit ?? "",
    answer: string[] = [],
    answering = !!implicit,
    unsupported = false;
  let fence: { char: string; length: number } | null = null;
  const finish = () => {
    if (question)
      items.push({
        id: `${key}:${items.length}`,
        question: question.trim(),
        answer: answer.join("\n").trim(),
      });
    question = "";
    answer = [];
    answering = false;
  };
  for (const line of lines) {
    const code = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (code) {
      if (!fence) fence = { char: code[1][0], length: code[1].length };
      else if (
        code[1][0] === fence.char &&
        code[1].length >= fence.length &&
        !code[2].trim()
      )
        fence = null;
      if (answering) answer.push(line);
      else unsupported = true;
      continue;
    }
    if (fence) {
      if (answering) answer.push(line);
      continue;
    }
    const heading = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*$/);
    const numbered = line.match(
      /^ {0,3}(?:\d+|[一二三四五六七八九十]+)[.、)）]\s*(.+)$/,
    );
    const implicitTitle = heading
      ? questionHeading(heading[1])
      : numbered && /[?？]\s*$/.test(numbered[1])
        ? numbered[1]
        : null;
    const q = implicitTitle ?? marker(line, "question");
    const a = marker(line, "answer");
    if (q !== null) {
      finish();
      question = q;
      answering = implicitTitle !== null;
    } else if (a !== null && question) {
      answering = true;
      answer.push(a);
    } else if (answering) answer.push(line);
    else if (question && line.trim()) question += `\n${line}`;
    else if (line.trim()) unsupported = true;
  }
  finish();
  const complete =
    !unsupported &&
    !fence &&
    !!items.length &&
    items.every((item) => !!item.question && !!item.answer);
  return { items: complete ? items : [], complete };
}

export function followupRegions(
  source: string,
  root = parseMarkdown(source),
): FollowupRegion[] {
  const nodes = root.children ?? [];
  const regions: FollowupRegion[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.type === "blockquote") {
      const raw = source.slice(start(node), end(node));
      if (node.children?.[0]?.children?.[0]?.type === "inlineCode") continue;
      const first = markdownText(node.children?.[0] ?? node).split(
        /\r\n?|\n/,
        1,
      )[0];
      if (!/^\s*\\?\[!question\\?\][+-]?(?:\s|$)/i.test(first)) continue;
      const body = raw.slice(
        raw.search(/\r\n?|\n/) < 0 ? raw.length : raw.search(/\r\n?|\n/),
      );
      regions.push({
        start: start(node),
        end: end(node),
        ...pairs(body, String(start(node)), undefined, true),
      });
      continue;
    }
    const rawNode = source.slice(start(node), end(node));
    const firstLine = rawNode.split(/\r\n?|\n/, 1)[0];
    const plain =
      node.type === "paragraph" &&
      (isFollowupSection(firstLine) || !!inlineQuestion(firstLine));
    const title = plain ? firstLine : markdownText(node);
    if (
      (node.type !== "heading" && !plain) ||
      (!isFollowupSection(title) && !inlineQuestion(title))
    )
      continue;
    if (plain && inlineQuestion(title)) {
      const newline = rawNode.match(/\r\n?|\n/);
      regions.push({
        start: start(node),
        end: end(node),
        ...pairs(
          newline ? rawNode.slice(newline.index! + newline[0].length) : "",
          String(start(node)),
          inlineQuestion(title),
        ),
      });
      continue;
    }
    let next = i + 1;
    while (
      next < nodes.length &&
      !(
        nodes[next].type === "heading" &&
        (plain || (nodes[next].depth ?? 6) <= (node.depth ?? 1))
      )
    )
      next++;
    const finish = next < nodes.length ? start(nodes[next]) : source.length;
    regions.push({
      start: start(node),
      end: finish,
      ...pairs(
        source.slice(
          plain ? start(node) + firstLine.length : end(node),
          finish,
        ),
        String(start(node)),
        inlineQuestion(title),
      ),
    });
    i = next - 1;
  }
  return regions;
}
