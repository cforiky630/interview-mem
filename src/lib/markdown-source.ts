/** Display metadata without rewriting the source kept in the database. */
export function markdownDocument(source: string) {
  const match = source.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const valid = match && /^[\w-]+:\s*/m.test(match[1]);
  const metadata = valid ? match[1] : "";
  const tags: string[] = [];
  const block = metadata.match(
    /^tags:\s*\r?\n((?:[ \t]+-\s*[^\r\n]+\r?\n?)+)/m,
  )?.[1];
  for (const item of block?.matchAll(/^[ \t]+-\s*(.+?)\s*$/gm) ?? []) {
    const tag = item[1].replace(/^["']|["']$/g, "");
    if (tag && tag.length <= 30) tags.push(tag);
  }
  return {
    body: valid ? source.slice(match[0].length) : source,
    tags: Array.from(new Set(tags)),
  };
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
