import {
  parseMarkdown,
  followupRegions,
  markdownText as text,
  type MarkdownNode as Node,
  type Followup,
} from "./followups";
export type { Followup } from "./followups";
import { markdownDocument, normalizedNoteTitle } from "./markdown-source";

export type StudyBlock = {
  id: string;
  markdown: string;
  type: string;
  practice: boolean;
  number: number;
  depth: number;
};
export type StudyDocument = {
  blocks: StudyBlock[];
  followups: Followup[];
  references: string;
  unresolvedFollowups: number;
};
/** Derive the learning view from source offsets. No source text is rewritten or saved. */
export function studyDocument(source: string, title = ""): StudyDocument {
  const { body } = markdownDocument(source);
  const root = parseMarkdown(body);
  const regions = followupRegions(body, root);
  const leading = root.children?.find((node) => node.type !== "definition");
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
      node === leading &&
      normalizedNoteTitle(text(node)) === normalizedNoteTitle(title)
    )
      continue;
    const region = regions.find(
      (region) =>
        region.complete &&
        (node.position?.start.offset ?? 0) >= region.start &&
        (node.position?.start.offset ?? 0) < region.end,
    );
    if (region) {
      if ((node.position?.start.offset ?? 0) === region.start)
        followups.push(...region.items);
      continue;
    }
    if (node.type === "list") listItems(node, 0);
    else append(node);
  }
  return {
    blocks,
    followups,
    references: definitions,
    unresolvedFollowups: regions.filter((region) => !region.complete).length,
  };
}

export {
  practiceDraftKey,
  readPracticeDraft,
  savePracticeDraft,
} from "./drafts";
