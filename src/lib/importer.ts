export type ParsedQuestion = {
  title: string;
  answer: string;
  tags: string[];
  needsEditing: boolean;
};

/** Split only question boundaries outside fenced code; keep the original batch separately. */
export function parseQuestions(input: string): ParsedQuestion[] {
  const raw = input.replace(/\r\n?/g, "\n").trim();
  if (!raw) return [];
  const lines = raw.split("\n");
  const markers: {
    index: number;
    title: string;
    level: number;
    explicit: boolean;
  }[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenced = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenced) {
      if (!fence) fence = fenced[1][0];
      else if (fenced[1][0] === fence) fence = null;
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
        level: 0,
        explicit: true,
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
      });
    }
  }
  let boundaries = markers.filter((m) => m.explicit);
  if (!boundaries.length) {
    const levels = [1, 2, 3];
    const repeated = levels.find(
      (level) => markers.filter((m) => m.level === level).length > 1,
    );
    const selected = repeated ?? Math.min(...markers.map((m) => m.level));
    boundaries = markers.filter((m) => m.level === selected);
  }
  if (!boundaries.length) {
    const [first, ...rest] = lines;
    return [
      {
        title: first.replace(/^#+\s*/, "").slice(0, 200),
        answer: rest
          .join("\n")
          .replace(/^\s*(?:A|答案|参考答案)[：:]\s*/i, "")
          .trim(),
        tags: [],
        needsEditing: rest.join("").trim().length === 0 || first.length > 200,
      },
    ];
  }
  return boundaries
    .map((boundary, i) => {
      const answer = lines
        .slice(boundary.index + 1, boundaries[i + 1]?.index ?? lines.length)
        .join("\n")
        .replace(
          /^\s*(?:#{1,3}\s*)?(?:A(?:nswer)?|答案|参考答案|解答)(?:\s*[：:]\s*|\s*\n|$)/i,
          "",
        )
        .trim();
      return {
        title: boundary.title.slice(0, 200),
        answer,
        tags: [],
        needsEditing: !answer,
      };
    })
    .filter((q) => q.title);
}
