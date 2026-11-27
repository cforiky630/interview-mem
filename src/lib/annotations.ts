import type { QuestionAnnotation, QuestionAnnotationColor } from "./types";

export const ANNOTATION_COLORS: {
  id: QuestionAnnotationColor;
  label: string;
}[] = [
  { id: "accent", label: "主题色" },
  { id: "amber", label: "琥珀黄" },
  { id: "sky", label: "晴空蓝" },
  { id: "rose", label: "浅玫瑰" },
];

const SKIP_SELECTOR =
  "pre, code, .katex, .katex-display, button, textarea, input, select, script, style, svg, mark.prose-annotation-mark, .prose-concept-link";

const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "LI",
  "UL",
  "OL",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "BLOCKQUOTE",
  "TR",
  "TD",
  "TH",
  "TABLE",
  "SECTION",
  "ARTICLE",
  "HR",
  "BR",
]);

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const BARRIER_CHAR = "\u0000";

export function normalizeAnnotationQuote(quote: string): string {
  return quote.replace(/\s+/g, " ").trim();
}

type CharPos = { node: Text; offset: number } | null;

type TextIndex = {
  normStr: string;
  charPositions: CharPos[];
  textNodes: Text[];
};

function buildTextIndex(container: HTMLElement): TextIndex {
  const normChars: string[] = [];
  const charPositions: CharPos[] = [];
  const textNodes: Text[] = [];

  function pushSoftSpace() {
    if (!normChars.length) return;
    const prev = normChars[normChars.length - 1];
    if (prev !== " " && prev !== BARRIER_CHAR) {
      normChars.push(" ");
      charPositions.push(null);
    }
  }

  function pushBarrier() {
    if (!normChars.length) return;
    if (normChars[normChars.length - 1] !== BARRIER_CHAR) {
      normChars.push(BARRIER_CHAR);
      charPositions.push(null);
    }
  }

  function walk(node: Node) {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === ELEMENT_NODE) {
        const el = child as Element;
        if (typeof el.matches === "function" && el.matches(SKIP_SELECTOR)) {
          pushBarrier();
          continue;
        }
        const isBlock = BLOCK_TAGS.has(el.tagName.toUpperCase());
        if (isBlock) pushSoftSpace();
        walk(el);
        if (isBlock) pushSoftSpace();
      } else if (child.nodeType === TEXT_NODE) {
        const textNode = child as Text;
        const value = textNode.nodeValue ?? "";
        if (!value) continue;
        textNodes.push(textNode);
        for (let i = 0; i < value.length; i++) {
          const ch = value[i];
          if (/\s/.test(ch)) {
            if (
              normChars.length > 0 &&
              normChars[normChars.length - 1] !== " " &&
              normChars[normChars.length - 1] !== BARRIER_CHAR
            ) {
              normChars.push(" ");
              charPositions.push({ node: textNode, offset: i });
            }
          } else {
            normChars.push(ch);
            charPositions.push({ node: textNode, offset: i });
          }
        }
      }
    }
  }

  walk(container);

  while (normChars.length && normChars[normChars.length - 1] === " ") {
    normChars.pop();
    charPositions.pop();
  }

  return {
    normStr: normChars.join(""),
    charPositions,
    textNodes,
  };
}

type TextSlice = { node: Text; start: number; end: number };

function overlapsRanges(
  occupied: readonly { start: number; end: number }[] | undefined,
  start: number,
  end: number,
): boolean {
  if (!occupied) return false;
  for (const range of occupied) {
    if (start < range.end && range.start < end) return true;
  }
  return false;
}

function findAnnotationSlices(
  index: TextIndex,
  rawQuote: string,
  occupiedByNode: Map<Text, Array<{ start: number; end: number }>>,
): TextSlice[] | null {
  const normQuote = normalizeAnnotationQuote(rawQuote);
  if (!normQuote) return null;

  let searchFrom = 0;
  while (searchFrom <= index.normStr.length - normQuote.length) {
    const matchIdx = index.normStr.indexOf(normQuote, searchFrom);
    if (matchIdx === -1) break;
    const slices: TextSlice[] = [];
    for (let i = matchIdx; i < matchIdx + normQuote.length; i++) {
      const pos = index.charPositions[i];
      if (!pos) continue;
      const last = slices[slices.length - 1];
      if (last && last.node === pos.node) {
        last.end = Math.max(last.end, pos.offset + 1);
      } else {
        slices.push({ node: pos.node, start: pos.offset, end: pos.offset + 1 });
      }
    }
    if (
      slices.length > 0 &&
      slices.every(
        (slice) =>
          !overlapsRanges(occupiedByNode.get(slice.node), slice.start, slice.end),
      )
    ) {
      return slices;
    }
    searchFrom = matchIdx + 1;
  }

  // Fallback: exact raw substring match within a single eligible text node.
  const trimmed = rawQuote.trim();
  if (!trimmed) return null;
  for (const textNode of index.textNodes) {
    const value = textNode.nodeValue ?? "";
    let exactFrom = 0;
    while (exactFrom <= value.length - trimmed.length) {
      const exactIdx = value.indexOf(trimmed, exactFrom);
      if (exactIdx === -1) break;
      const start = exactIdx;
      const end = exactIdx + trimmed.length;
      if (!overlapsRanges(occupiedByNode.get(textNode), start, end)) {
        return [{ node: textNode, start, end }];
      }
      exactFrom = exactIdx + 1;
    }
  }

  return null;
}

export function applyAnnotationHighlights(
  container: HTMLElement,
  annotations: readonly QuestionAnnotation[],
  activeId: string | null,
): { matchedIds: Set<string>; cleanup: () => void } {
  const matchedIds = new Set<string>();
  const createdMarks: HTMLElement[] = [];
  const doc = container.ownerDocument;
  if (!doc || !annotations.length) {
    return { matchedIds, cleanup: () => {} };
  }

  const index = buildTextIndex(container);
  const occupiedByNode = new Map<Text, Array<{ start: number; end: number }>>();
  const plannedByNode = new Map<
    Text,
    Array<{ annotation: QuestionAnnotation; start: number; end: number }>
  >();
  const wrappedIds = new Set<string>();

  for (const annotation of annotations) {
    if (!annotation.quote.trim()) continue;
    const slices = findAnnotationSlices(index, annotation.quote, occupiedByNode);
    if (!slices || !slices.length) continue;

    for (const slice of slices) {
      const value = slice.node.nodeValue ?? "";
      if (
        !slice.node.parentNode ||
        slice.start < 0 ||
        slice.end <= slice.start ||
        slice.end > value.length
      ) {
        continue;
      }
      let occ = occupiedByNode.get(slice.node);
      if (!occ) {
        occ = [];
        occupiedByNode.set(slice.node, occ);
      }
      occ.push({ start: slice.start, end: slice.end });

      let planned = plannedByNode.get(slice.node);
      if (!planned) {
        planned = [];
        plannedByNode.set(slice.node, planned);
      }
      planned.push({
        annotation,
        start: slice.start,
        end: slice.end,
      });
    }
  }

  for (const [textNode, entries] of plannedByNode) {
    entries.sort((a, b) => b.start - a.start);
    for (const entry of entries) {
      const parent = textNode.parentNode;
      const value = textNode.nodeValue ?? "";
      if (
        !parent ||
        entry.start < 0 ||
        entry.end <= entry.start ||
        entry.end > value.length
      ) {
        continue;
      }
      if (entry.end < value.length) {
        textNode.splitText(entry.end);
      }
      const targetNode =
        entry.start > 0 ? textNode.splitText(entry.start) : textNode;
      const mark = doc.createElement("mark");
      mark.className = `prose-annotation-mark color-${entry.annotation.color}${
        activeId === entry.annotation.id ? " is-active" : ""
      }`;
      mark.dataset.annotationId = entry.annotation.id;
      if (entry.annotation.conceptId) {
        mark.dataset.conceptId = entry.annotation.conceptId;
        mark.setAttribute("data-concept-id", entry.annotation.conceptId);
      }
      mark.tabIndex = 0;
      mark.setAttribute("role", "button");
      mark.setAttribute("aria-label", "查看批注");
      parent.insertBefore(mark, targetNode);
      mark.appendChild(targetNode);
      createdMarks.push(mark);
      wrappedIds.add(entry.annotation.id);
    }
  }

  for (const annotation of annotations) {
    if (wrappedIds.has(annotation.id)) {
      matchedIds.add(annotation.id);
    }
  }

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    const affectedParents = new Set<Node>();
    for (let i = createdMarks.length - 1; i >= 0; i--) {
      const mark = createdMarks[i];
      const parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark);
      }
      parent.removeChild(mark);
      affectedParents.add(parent);
    }
    for (const parent of affectedParents) {
      if (typeof parent.normalize === "function") {
        parent.normalize();
      }
    }
  }

  return { matchedIds, cleanup };
}

function annotationSidebarKey(userId: string): string {
  return `shiyi:annotations-sidebar:${userId}`;
}

const REVIEW_COMPARE_LAYOUT_KEY = "shiyi:review-compare-layout";

export function readAnnotationSidebarPref(userId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(annotationSidebarKey(userId));
    return raw === "1" || raw === "true";
  } catch {
    return false;
  }
}

export function writeAnnotationSidebarPref(
  userId: string,
  open: boolean,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(annotationSidebarKey(userId), open ? "1" : "0");
  } catch {
    /* Ignore storage access restrictions. */
  }
}

export function readReviewCompareLayoutPref(): "split" | "stack" {
  if (typeof window === "undefined") return "split";
  try {
    const raw = window.localStorage.getItem(REVIEW_COMPARE_LAYOUT_KEY);
    return raw === "stack" ? "stack" : "split";
  } catch {
    return "split";
  }
}

export function writeReviewCompareLayoutPref(mode: "split" | "stack"): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(REVIEW_COMPARE_LAYOUT_KEY, mode);
  } catch {
    /* Ignore storage access restrictions. */
  }
}
