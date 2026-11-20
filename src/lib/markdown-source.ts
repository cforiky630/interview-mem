export type NoteProperty = {
  key: string;
  value: string | string[];
};

const MAX_NOTE_TAGS = 12;
const MAX_TAG_LENGTH = 30;

function stripWrappingQuotes(value: string) {
  return value
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .trim();
}

export function normalizeTagValue(value: string) {
  return stripWrappingQuotes(value).replace(/^#+/, "").trim();
}

/** Merge and deduplicate tag lists while stripping any leading `#`. */
export function mergeQuestionTags(
  ...lists: (readonly string[] | undefined)[]
): string[] {
  const result: string[] = [];
  for (const list of lists) {
    if (!list) continue;
    for (const raw of list) {
      const tag = normalizeTagValue(raw);
      if (tag && !result.includes(tag)) result.push(tag);
    }
  }
  return result;
}

/** Parse Obsidian-style tag formats: YAML lists, inline arrays, comma/space lists, or `#tag`. */
export function parseTagListInput(value: string) {
  const inner = value.trim().replace(/^\[(.*)\]$/, "$1");
  return Array.from(
    new Set(
      inner
        .split(/[,，\s]+/)
        .map(normalizeTagValue)
        .filter((tag) => tag && tag.length <= MAX_TAG_LENGTH),
    ),
  ).slice(0, MAX_NOTE_TAGS);
}

/** Display Obsidian frontmatter properties without rewriting the source kept in the database. */
export function markdownDocument(source: string): {
  body: string;
  tags: string[];
  properties: NoteProperty[];
} {
  const match = source.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const valid = !!match && /^[A-Za-z0-9_\u4e00-\u9fa5-]+:\s*/m.test(match[1]);
  const metadata = valid ? match[1] : "";
  const rawEntries: { key: string; rawValue: string | string[] }[] = [];
  if (metadata) {
    let currentKey: string | null = null;
    let currentList: string[] | null = null;
    const flush = () => {
      if (currentKey && currentList) {
        rawEntries.push({ key: currentKey, rawValue: currentList });
      }
      currentKey = null;
      currentList = null;
    };
    for (const line of metadata.split(/\r?\n/)) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const listMatch = line.match(/^[ \t]*-\s*(.*?)\s*$/);
      if (listMatch && currentKey && currentList) {
        const item = stripWrappingQuotes(listMatch[1]);
        if (item) currentList.push(item);
        continue;
      }
      const keyMatch = line.match(/^([A-Za-z0-9_\u4e00-\u9fa5-]+)\s*:\s*(.*)$/);
      if (keyMatch) {
        flush();
        const key = keyMatch[1].trim();
        const rest = keyMatch[2].trim();
        if (!rest) {
          currentKey = key;
          currentList = [];
        } else if (/^\[.*\]$/.test(rest)) {
          const items = rest
            .slice(1, -1)
            .split(/[,，]/)
            .map(stripWrappingQuotes)
            .filter(Boolean);
          rawEntries.push({ key, rawValue: items });
        } else {
          rawEntries.push({
            key,
            rawValue: stripWrappingQuotes(rest),
          });
        }
      }
    }
    flush();
  }

  const tags: string[] = [];
  const pushTag = (raw: string) => {
    const tag = normalizeTagValue(raw);
    if (
      tag &&
      tag.length <= MAX_TAG_LENGTH &&
      !tags.includes(tag) &&
      tags.length < MAX_NOTE_TAGS
    ) {
      tags.push(tag);
    }
  };
  const properties: NoteProperty[] = [];
  for (const entry of rawEntries) {
    const lower = entry.key.toLowerCase();
    if (lower === "tags" || lower === "tag") {
      if (Array.isArray(entry.rawValue)) {
        for (const item of entry.rawValue) pushTag(item);
      } else {
        for (const part of entry.rawValue.split(/[,，\s]+/)) pushTag(part);
      }
      continue;
    }
    if (lower === "aliases" || lower === "alias") {
      const aliases = (
        Array.isArray(entry.rawValue)
          ? entry.rawValue
          : entry.rawValue.split(/[,，]/)
      )
        .map((item) =>
          stripWrappingQuotes(item)
            .replace(/^\[\[|\]\]$/g, "")
            .trim(),
        )
        .filter(Boolean);
      if (aliases.length) properties.push({ key: entry.key, value: aliases });
      continue;
    }
    if (Array.isArray(entry.rawValue)) {
      if (entry.rawValue.length)
        properties.push({ key: entry.key, value: entry.rawValue });
    } else if (entry.rawValue) {
      properties.push({ key: entry.key, value: entry.rawValue });
    }
  }

  return {
    body: valid && match ? source.slice(match[0].length) : source,
    tags,
    properties,
  };
}

export function extractNoteAliases(source: string) {
  const { properties } = markdownDocument(source);
  const aliases: string[] = [];
  for (const prop of properties) {
    const lower = prop.key.toLowerCase();
    if (lower === "aliases" || lower === "alias") {
      if (Array.isArray(prop.value)) aliases.push(...prop.value);
      else aliases.push(prop.value);
    }
  }
  return aliases;
}

export function normalizedNoteTitle(value: string) {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .at(-1)!
    .replace(/\.md$/i, "")
    .replace(/^\d+\s*[-.、]\s*/, "")
    .replace(/[\s?？。.!！、，,:：()（）]/g, "")
    .toLowerCase();
}

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
  data?: { hProperties?: Record<string, unknown>; hChildren?: MarkdownNode[] };
};

/** Obsidian syntax is interpreted only in the AST; original Markdown stays intact. */
export function remarkObsidian() {
  return (root: MarkdownNode) => {
    function visit(node: MarkdownNode) {
      if (node.type === "math" || node.type === "inlineMath") {
        node.value = node.value?.replace(/[\u200B\uFEFF]/g, "");
        const cleanMath = (child: MarkdownNode) => {
          if (child.value)
            child.value = child.value.replace(/[\u200B\uFEFF]/g, "");
          child.children?.forEach(cleanMath);
        };
        node.data?.hChildren?.forEach(cleanMath);
      }
      if (
        ["code", "inlineCode", "html", "link", "image"].includes(node.type) ||
        !node.children
      )
        return;
      if (node.type === "blockquote") {
        const first = node.children[0]?.children?.[0];
        const marker =
          first?.type === "text"
            ? first.value?.match(/^\[!([a-z]+)\][+-]?\s*/i)
            : null;
        if (first && marker) {
          node.data = {
            hProperties: { "data-callout": marker[1].toLowerCase() },
          };
          first.value = first.value!.slice(marker[0].length) || "面试追问";
        }
      }
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) {
          visit(child);
          return [child];
        }
        const result: MarkdownNode[] = [];
        let start = 0;
        for (const match of child.value.matchAll(
          /(?<!!)\[\[([^\[\]\r\n]{1,512})\]\]/g,
        )) {
          const index = match.index!;
          if (index > start)
            result.push({
              type: "text",
              value: child.value.slice(start, index),
            });
          const [target, alias] = match[1].split("|");
          result.push({
            type: "link",
            url: `#note=${encodeURIComponent(target.split("#")[0])}`,
            children: [{ type: "text", value: alias || target }],
          });
          start = index + match[0].length;
        }
        if (!result.length) return [child];
        if (start < child.value.length)
          result.push({ type: "text", value: child.value.slice(start) });
        return result;
      });
    }
    visit(root);
  };
}
