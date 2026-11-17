import { followupRegions } from "./followups";
import { markdownDocument } from "./markdown-source";

export type ParsedQuestion = {
  title: string;
  answer: string;
  tags: string[];
  needsEditing: boolean;
  sourceText?: string;
};
export type ImportType = "qa" | "questions";

/** Explicit question lists use one non-empty line per question, never as an answer. */
export function parseQuestionTitles(input: string): ParsedQuestion[] {
  return input
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const title = line
        .trim()
        .replace(/^#{1,6}\s+(.+?)(?:\s+#+)?$/, "$1")
        .replace(/^[-*+]\s+(?:\[[ xX]\]\s*)?/, "")
        .replace(
          /^(?:\d+|[一二三四五六七八九十百]+)(?:[、)）]|\.(?!\d))\s*/,
          "",
        )
        .replace(/^(?:Q(?:uestion)?|问题|题目)\s*\d*\s*[：:.、]\s*/i, "")
        .trim();
      return { title, answer: "", tags: [], needsEditing: true };
    })
    .filter((question) => question.title);
}

/** Split only question boundaries outside fenced code; keep the original batch separately. */
export function parseQuestions(
  input: string,
  inputType: ImportType = "qa",
  options: { preserveSource?: boolean } = {},
): ParsedQuestion[] {
  const preserve = options.preserveSource;
  if (inputType === "questions")
    return preserve
      ? (input.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? []).flatMap((line) =>
          parseQuestionTitles(line).map((q) => ({ ...q, sourceText: line })),
        )
      : parseQuestionTitles(input);
  const raw = preserve ? input : input.replace(/\r\n?/g, "\n").trim();
  if (!raw.trim()) return [];
  const lines = raw.split(/\r\n?|\n/);
  const offsets = [0];
  for (const match of raw.matchAll(/\r\n|\r|\n/g))
    offsets.push(match.index + match[0].length);
  const document = markdownDocument(raw);
  const metadataEnd = raw.length - document.body.length;
  const protectedRegions = followupRegions(raw);
  const markers: {
    index: number;
    title: string;
    level: number;
    explicit: boolean;
    heading: boolean;
  }[] = [];
  let fence: { char: string; length: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (
      offsets[i] < metadataEnd ||
      protectedRegions.some(
        (region) =>
          (offsets[i + 1] ?? raw.length) > region.start &&
          offsets[i] < region.end,
      )
    )
      continue;
    const line = lines[i];
    const fenced = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fenced) {
      if (!fence) fence = { char: fenced[1][0], length: fenced[1].length };
      else if (
        fenced[1][0] === fence.char &&
        fenced[1].length >= fence.length &&
        !fenced[2].trim()
      )
        fence = null;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^\s*(#{1,3})\s+(.+?)\s*#*$/);
    const text = (heading?.[2] ?? line).trim();
    const explicit = text.match(
      /^(?:(?:Q(?:uestion)?|问题|题目)\s*\d*\s*[：:.、]\s*)(.+)$/i,
    );
    const numbered = text.match(/^\d+[.、)）]\s*(.+)$/);
    const isQuestion =
      numbered &&
      /[?？]|^(?:什么|为什么|如何|怎么|谈谈|说说|解释|简述|请|描述)/.test(
        numbered[1],
      );
    if (explicit || isQuestion)
      markers.push({
        index: i,
        title: (explicit?.[1] ?? numbered![1]).trim(),
        level: heading?.[1].length ?? 0,
        explicit: true,
        heading: !!heading,
      });
    else if (
      heading &&
      !/^(?:答案|解答|解析|参考答案|Answer|A)[：:]?$/i.test(text)
    ) {
      markers.push({
        index: i,
        title: text,
        level: heading[1].length,
        explicit: false,
        heading: true,
      });
    }
  }
  const questionHeadings = markers.filter(
    (m) =>
      m.heading &&
      (m.explicit ||
        /[?？]\s*$|^(?:什么|为什么|如何|怎么|谈谈|说说|解释|简述|请|描述|比较|对比|what\b|why\b|how\b)/i.test(
          m.title,
        )),
  );
  const mainLevel = Math.min(...questionHeadings.map((m) => m.level));
  let boundaries = questionHeadings.length
    ? questionHeadings.filter((m) => m.level === mainLevel)
    : markers.filter((m) => m.explicit);
  if (!boundaries.length) {
    const levels = [1, 2, 3];
    const repeated = levels.find(
      (level) => markers.filter((m) => m.level === level).length > 1,
    );
    const selected = repeated ?? Math.min(...markers.map((m) => m.level));
    boundaries = markers.filter((m) => m.level === selected);
  }
  if (!boundaries.length) {
    const firstIndex = lines.findIndex((line) => line.trim());
    const first = lines[firstIndex];
    const rest = lines.slice(firstIndex + 1);
    const answer = preserve
      ? raw.slice(offsets[firstIndex + 1] ?? raw.length)
      : rest
          .join("\n")
          .replace(/^\s*(?:A|答案|参考答案)[：:]\s*/i, "")
          .trim();
    return [
      {
        title: first.trim().replace(/^#+\s*/, ""),
        answer,
        tags: [],
        needsEditing: !answer.trim() || first.length > 200,
        ...(preserve ? { sourceText: raw } : {}),
      },
    ];
  }
  return boundaries
    .map((boundary, i) => {
      const end = offsets[boundaries[i + 1]?.index] ?? raw.length;
      const answer = preserve
        ? raw.slice(offsets[boundary.index + 1] ?? raw.length, end)
        : lines
            .slice(boundary.index + 1, boundaries[i + 1]?.index ?? lines.length)
            .join("\n")
            .replace(
              /^\s*(?:#{1,3}\s*)?(?:A(?:nswer)?|答案|参考答案|解答)(?:\s*[：:]\s*|\s*\n|$)/i,
              "",
            )
            .trim();
      return {
        title: boundary.title,
        answer,
        tags: [],
        needsEditing: !answer.trim(),
        ...(preserve
          ? { sourceText: raw.slice(offsets[boundary.index], end) }
          : {}),
      };
    })
    .filter((q) => q.title);
}
