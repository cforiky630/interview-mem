import type {
  ConceptFolderView,
  ConceptView,
  QuestionAnnotationColor,
} from "./types";
import { compareNaturalNames } from "./folders";

export const MAX_CONCEPTS = 500;
export const MAX_CONCEPT_TERM_LENGTH = 120;
export const MAX_CONCEPT_DEFINITION_LENGTH = 4000;
export const MAX_CONCEPT_GROUP_LENGTH = 40;
export const MAX_CONCEPT_ALIASES = 10;
export const MAX_CONCEPT_ALIAS_LENGTH = 80;
export const CONCEPT_UNGROUPED_LABEL = "未分组";
export const CONCEPT_ROOT_LABEL = "我的概念";

export function buildConceptSources<T extends { id: string }>(
  concepts: readonly Pick<ConceptView, "id" | "sourceQuestionId">[],
  questions: readonly T[],
  questionAnnotations: readonly {
    questionId: string;
    annotations: readonly { conceptId?: string | null }[];
  }[],
) {
  const questionById = new Map(
    questions.map((question) => [question.id, question]),
  );
  const sources = new Map(
    concepts.map((concept) => [concept.id, new Map<string, T>()]),
  );
  for (const concept of concepts) {
    if (!concept.sourceQuestionId) continue;
    const question = questionById.get(concept.sourceQuestionId);
    if (question) sources.get(concept.id)?.set(question.id, question);
  }
  for (const { questionId, annotations } of questionAnnotations) {
    const question = questionById.get(questionId);
    if (!question || !Array.isArray(annotations)) continue;
    for (const annotation of annotations) {
      if (annotation?.conceptId) {
        sources.get(annotation.conceptId)?.set(questionId, question);
      }
    }
  }
  return sources;
}

export const CONCEPT_COLORS: readonly QuestionAnnotationColor[] = [
  "accent",
  "amber",
  "sky",
  "rose",
] as const;

export const CONCEPT_SKIP_SELECTOR =
  "pre, code, .katex, .katex-display, a, button, textarea, input, select, script, style, svg, mark.prose-annotation-mark, .prose-concept-link";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const SEPARATOR_CHARS = "[\\s\\-–—−_·]";
const SEPARATOR_RUN_RE = /[\s\-–—−_·]+/g;
const SEPARATOR_SPLIT_RE = /([\s\-–—−_·]+)/;
const TRIM_SEPARATORS_RE = /^[\s\-–—−_·]+|[\s\-–—−_·]+$/g;
const HYPHEN_LIKE_RE = /[-–—−]/;
const ASCII_WORD_MIN2_RE = /^[A-Za-z]{2,}$/;
const STARTS_ASCII_ALNUM_RE = /^[A-Za-z0-9]/;
const ENDS_ASCII_ALNUM_RE = /[A-Za-z0-9]$/;
const CJK_CHAR_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
const CJK_AT_START_RE = /^[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
const CJK_AT_END_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]$/;
const LATIN_OR_SYMBOL_RE = /[A-Za-z0-9+#]/;

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Canonical lookup key for concept terms & aliases:
 * - NFKC normalized & lowercased
 * - whitespace and dash/underscore/middot separators collapsed to a single space
 * - spaces adjacent to CJK characters removed so "大 Key" and "大Key" normalize identically
 */
export function normalizeConceptKey(raw: string): string {
  const collapsed = raw
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(SEPARATOR_RUN_RE, " ")
    .trim();
  if (!collapsed) return "";
  return collapsed
    .replace(/([\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]) (?=\S)/g, "$1")
    .replace(/(\S) ([\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff])/g, "$1$2");
}

/**
 * Deduplicate & sanitize concept aliases against each other and the primary term.
 */
export function normalizeConceptAliases(
  aliases: readonly string[],
  primaryTerm?: string,
): string[] {
  const seen = new Set<string>();
  if (primaryTerm) {
    const primaryKey = normalizeConceptKey(primaryTerm);
    if (primaryKey) seen.add(primaryKey);
  }
  const result: string[] = [];
  for (const raw of aliases) {
    const trimmed = raw.trim().slice(0, MAX_CONCEPT_ALIAS_LENGTH);
    if (!trimmed) continue;
    const key = normalizeConceptKey(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
    if (result.length >= MAX_CONCEPT_ALIASES) break;
  }
  return result;
}

/**
 * Parse a comma/Chinese-comma/semicolon-separated alias input string into normalized aliases.
 */
export function parseConceptAliasesInput(
  raw: string,
  primaryTerm?: string,
): string[] {
  if (!raw.trim()) return [];
  return normalizeConceptAliases(
    raw.split(/[,，;；\n]+/).map((s) => s.trim()),
    primaryTerm,
  );
}

/**
 * Find an existing concept matching `term` by normalized key on its primary term or aliases.
 * Primary term matches always take precedence over alias matches.
 */
export function findMatchingConcept(
  concepts: readonly ConceptView[],
  term: string,
): ConceptView | undefined {
  const key = normalizeConceptKey(term);
  if (!key) return undefined;
  for (const concept of concepts) {
    if (
      concept.normalizedKey === key ||
      normalizeConceptKey(concept.term) === key
    ) {
      return concept;
    }
  }
  for (const concept of concepts) {
    for (const alias of concept.aliases) {
      if (normalizeConceptKey(alias) === key) {
        return concept;
      }
    }
  }
  return undefined;
}

function buildTokenPattern(token: string) {
  let out = "";
  let firstVariableOffset: number | undefined;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (i > 0) {
      const prev = token[i - 1];
      if (
        (CJK_CHAR_RE.test(prev) && LATIN_OR_SYMBOL_RE.test(ch)) ||
        (LATIN_OR_SYMBOL_RE.test(prev) && CJK_CHAR_RE.test(ch))
      ) {
        firstVariableOffset ??= out.length;
        out += "\\s*";
      }
    }
    out += escapeRegExp(ch);
  }
  return { source: out, literalLength: firstVariableOffset ?? out.length };
}

type PhrasePatternResult = {
  source: string;
  head: string;
  tail: string;
  normKey: string;
  compactKey: string | null;
};

/**
 * Build a regex source string for a single concept phrase (term or alias):
 * - Case-insensitive (combined regex uses `gi`)
 * - Spaces, hyphens (`-`, `–`, `—`, `−`), underscores (`_`), middots (`·`) are interchangeable
 * - Hyphenated ASCII pairs with both sides >= 2 letters also match joined form (e.g. Cross-Encoder -> crossencoder)
 * - Optional whitespace between CJK and Latin boundaries ("大Key" <-> "大 Key")
 * - Strict ASCII word boundary guards (`(?<![A-Za-z0-9_])` / `(?![A-Za-z0-9_])`) while allowing adjacent CJK
 */
export function buildConceptPhraseRegexSource(phrase: string): string | null {
  return compilePhrasePattern(phrase)?.source ?? null;
}

function compilePhrasePattern(phrase: string): PhrasePatternResult | null {
  const normalized = phrase.normalize("NFKC").trim();
  const cleaned = normalized.replace(TRIM_SEPARATORS_RE, "");
  if (!cleaned) return null;
  const normKey = normalizeConceptKey(cleaned);
  if (!normKey) return null;

  const parts = cleaned.split(SEPARATOR_SPLIT_RE).filter(Boolean);
  let body = "";
  let literalLength = 0;
  let allowsJoinedAscii = false;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i % 2 === 0) {
      const token = buildTokenPattern(part);
      if (i === 0) literalLength = token.literalLength;
      body += token.source;
    } else {
      const leftTok = parts[i - 1] ?? "";
      const rightTok = parts[i + 1] ?? "";
      const touchesCjk =
        CJK_AT_END_RE.test(leftTok) || CJK_AT_START_RE.test(rightTok);
      const isHyphenAsciiPair =
        HYPHEN_LIKE_RE.test(part) &&
        ASCII_WORD_MIN2_RE.test(leftTok) &&
        ASCII_WORD_MIN2_RE.test(rightTok);
      if (isHyphenAsciiPair) {
        allowsJoinedAscii = true;
      }
      if (touchesCjk || isHyphenAsciiPair) {
        body += `${SEPARATOR_CHARS}*`;
      } else {
        body += `${SEPARATOR_CHARS}+`;
      }
    }
  }

  const startsAscii = STARTS_ASCII_ALNUM_RE.test(cleaned);
  const endsAscii = ENDS_ASCII_ALNUM_RE.test(cleaned);
  const prefix = startsAscii ? "(?<![A-Za-z0-9_])" : "";
  const suffix = endsAscii ? "(?![A-Za-z0-9_])" : "";
  const source = `${prefix}(?:${body})${suffix}`;
  const compactKey = allowsJoinedAscii ? normKey.replace(/ /g, "") : null;
  return {
    source,
    head: prefix + body.slice(0, literalLength),
    tail: body.slice(literalLength) + suffix,
    normKey,
    compactKey,
  };
}

export type ConceptLinkInput = Pick<
  ConceptView,
  "id" | "term" | "aliases" | "color"
>;

export type ConceptTextMatch<Concept extends ConceptLinkInput = ConceptView> = {
  start: number;
  end: number;
  text: string;
  concept: Concept;
};

export type CompiledConceptMatcher<
  Concept extends ConceptLinkInput = ConceptView,
> = {
  regex: RegExp;
  resolveConcept: (matchedText: string) => Concept | undefined;
};

type CandidateEntry = PhrasePatternResult & {
  rawLength: number;
  isPrimaryTerm: boolean;
};

/**
 * Compile a single reusable matcher for a list of concepts (terms + aliases).
 * Alternatives are ordered longest-first with primary terms taking precedence over aliases.
 */
export function buildConceptMatcherPattern<Concept extends ConceptLinkInput>(
  concepts: readonly Concept[],
): CompiledConceptMatcher<Concept> | null {
  if (!concepts.length) return null;

  const exactKeyMap = new Map<string, Concept>();
  const compactKeyMap = new Map<string, Concept>();
  const entries: CandidateEntry[] = [];

  function addPhrase(concept: Concept, phrase: string, isPrimaryTerm: boolean) {
    const compiled = compilePhrasePattern(phrase);
    if (!compiled) return;
    if (!exactKeyMap.has(compiled.normKey)) {
      exactKeyMap.set(compiled.normKey, concept);
    }
    if (compiled.compactKey && !compactKeyMap.has(compiled.compactKey)) {
      compactKeyMap.set(compiled.compactKey, concept);
    }
    entries.push({
      ...compiled,
      rawLength: phrase.trim().length,
      isPrimaryTerm,
    });
  }

  // Register primary terms first so they win lookup precedence over another concept's alias.
  for (const concept of concepts) {
    addPhrase(concept, concept.term, true);
  }
  for (const concept of concepts) {
    for (const alias of concept.aliases) {
      addPhrase(concept, alias, false);
    }
  }

  if (!entries.length) return null;

  entries.sort(
    (a, b) =>
      b.normKey.length - a.normKey.length ||
      b.rawLength - a.rawLength ||
      (a.isPrimaryTerm === b.isPrimaryTerm ? 0 : a.isPrimaryTerm ? -1 : 1),
  );

  const groups: { head: string; tails: string[] }[] = [];
  const seenSources = new Set<string>();
  for (const entry of entries) {
    if (seenSources.has(entry.source)) continue;
    seenSources.add(entry.source);
    // Share only fixed prefixes of consecutive alternatives to preserve match priority.
    const group = groups.at(-1);
    if (group?.head === entry.head) {
      group.tails.push(entry.tail);
    } else {
      groups.push({ head: entry.head, tails: [entry.tail] });
    }
  }

  const sources = groups.map(({ head, tails }) =>
    tails.length === 1 ? head + tails[0] : `${head}(?:${tails.join("|")})`,
  );
  const regex = new RegExp(`(?:${sources.join("|")})`, "gi");
  const resolveConcept = (matchedText: string): Concept | undefined => {
    const norm = normalizeConceptKey(matchedText);
    if (!norm) return undefined;
    const direct = exactKeyMap.get(norm);
    if (direct) return direct;
    const compact = norm.replace(/ /g, "");
    return compactKeyMap.get(compact);
  };

  return { regex, resolveConcept };
}

/**
 * Find non-overlapping concept matches in `text` resolved longest-match-first,
 * returned in ascending document order.
 */
export function findConceptMatchesInText<Concept extends ConceptLinkInput>(
  text: string,
  concepts: readonly Concept[],
  compiled?: CompiledConceptMatcher<Concept> | null,
): ConceptTextMatch<Concept>[] {
  if (!text) return [];
  const matcher =
    compiled !== undefined ? compiled : buildConceptMatcherPattern(concepts);
  if (!matcher) return [];

  const re = matcher.regex;
  re.lastIndex = 0;
  const candidates: ConceptTextMatch<Concept>[] = [];
  let previousEnd = 0;
  let hasOverlap = false;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const matchedText = match[0];
    if (!matchedText) {
      re.lastIndex += 1;
      continue;
    }
    const concept = matcher.resolveConcept(matchedText);
    if (concept) {
      const end = match.index + matchedText.length;
      hasOverlap ||= match.index < previousEnd;
      previousEnd = end;
      candidates.push({
        start: match.index,
        end,
        text: matchedText,
        concept,
      });
    }
    // Step by 1 character after a match so a longer match starting inside this match is not missed.
    re.lastIndex = match.index + 1;
  }

  if (!hasOverlap) return candidates;

  candidates.sort(
    (a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start,
  );

  const selected: ConceptTextMatch<Concept>[] = [];
  for (const cand of candidates) {
    const overlaps = selected.some(
      (s) => cand.start < s.end && cand.end > s.start,
    );
    if (!overlaps) selected.push(cand);
  }

  selected.sort((a, b) => a.start - b.start);
  return selected;
}

/**
 * Walk eligible text nodes inside `container` and wrap concept mentions in interactive
 * `.prose-concept-link` spans. Returns matched concept IDs, total match count, and a
 * reversible idempotent `cleanup()` function.
 */
export function applyConceptLinks<Concept extends ConceptLinkInput>(
  container: HTMLElement,
  concepts: readonly Concept[],
  activeConceptId: string | null,
  compiled?: CompiledConceptMatcher<Concept> | null,
): { matchedConceptIds: Set<string>; matchCount: number; cleanup: () => void } {
  const matchedConceptIds = new Set<string>();
  const createdSpans: HTMLElement[] = [];
  const doc = container.ownerDocument;
  if (!doc || !concepts.length) {
    return { matchedConceptIds, matchCount: 0, cleanup: () => {} };
  }

  const matcher =
    compiled !== undefined ? compiled : buildConceptMatcherPattern(concepts);
  if (!matcher) {
    return { matchedConceptIds, matchCount: 0, cleanup: () => {} };
  }

  const textNodes: Text[] = [];
  function walk(node: Node) {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === ELEMENT_NODE) {
        const el = child as Element;
        if (
          typeof el.matches === "function" &&
          el.matches(CONCEPT_SKIP_SELECTOR)
        ) {
          continue;
        }
        walk(el);
      } else if (child.nodeType === TEXT_NODE) {
        const textNode = child as Text;
        if (textNode.nodeValue && textNode.nodeValue.trim()) {
          textNodes.push(textNode);
        }
      }
    }
  }

  walk(container);

  let matchCount = 0;
  for (const textNode of textNodes) {
    const value = textNode.nodeValue ?? "";
    if (!value) continue;
    const matches = findConceptMatchesInText(value, concepts, matcher);
    if (!matches.length) continue;

    // Split from right to left so earlier offsets in `textNode` remain valid.
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      const parent = textNode.parentNode;
      const curLen = (textNode.nodeValue ?? "").length;
      if (!parent || m.start < 0 || m.end <= m.start || m.end > curLen) {
        continue;
      }
      if (m.end < curLen) {
        textNode.splitText(m.end);
      }
      const targetNode = m.start > 0 ? textNode.splitText(m.start) : textNode;
      const span = doc.createElement("span");
      const active = activeConceptId === m.concept.id;
      span.className = `prose-concept-link color-${m.concept.color}${
        active ? " is-active" : ""
      }`;
      span.dataset.conceptId = m.concept.id;
      span.setAttribute("data-concept-id", m.concept.id);
      span.setAttribute("role", "button");
      span.tabIndex = 0;
      span.setAttribute("aria-label", `查看概念释义：${m.concept.term}`);
      parent.insertBefore(span, targetNode);
      span.appendChild(targetNode);
      createdSpans.push(span);
      matchedConceptIds.add(m.concept.id);
      matchCount += 1;
    }
  }

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    const affectedParents = new Set<Node>();
    for (let i = createdSpans.length - 1; i >= 0; i--) {
      const span = createdSpans[i];
      const parent = span.parentNode;
      if (!parent) continue;
      while (span.firstChild) {
        parent.insertBefore(span.firstChild, span);
      }
      parent.removeChild(span);
      affectedParents.add(parent);
    }
    for (const parent of affectedParents) {
      if (typeof parent.normalize === "function") {
        parent.normalize();
      }
    }
  }

  return { matchedConceptIds, matchCount, cleanup };
}

export function sortConceptsNatural<
  T extends Pick<ConceptView, "id" | "term">,
>(concepts: readonly T[]): T[] {
  return [...concepts].sort(
    (a, b) => compareNaturalNames(a.term, b.term) || a.id.localeCompare(b.id),
  );
}

export function sortConceptFoldersNatural<
  T extends Pick<ConceptFolderView, "id" | "title">,
>(folders: readonly T[]): T[] {
  return [...folders].sort(
    (a, b) => compareNaturalNames(a.title, b.title) || a.id.localeCompare(b.id),
  );
}

export type ConceptFolderBreadcrumbNode = {
  id: string | null;
  title: string;
};

export type ConceptFolderFlatItem = {
  folder: ConceptFolderView;
  depth: number;
  path: string;
};

export type ConceptFolderIndex = {
  byId: Map<string, ConceptFolderView>;
  children: Map<string | null, ConceptFolderView[]>;
  depthOf: (folderId: string | null) => number;
  subtreeHeight: (folderId: string) => number;
  subtreeHeightOf: (folderId: string) => number;
  ancestorsOf: (folderId: string | null) => ConceptFolderView[];
  breadcrumbsOf: (folderId: string | null) => ConceptFolderView[];
  breadcrumbsFor: (folderId: string | null) => ConceptFolderBreadcrumbNode[];
  ancestorIds: (folderId: string | null) => string[];
  descendantIds: (folderId: string) => Set<string>;
  subtreeIds: (folderId: string | null) => Set<string | null>;
  pathSegmentsOf: (folderId: string | null) => string[];
  pathOf: (folderId: string | null) => string;
  formatPath: (folderId: string | null) => string;
  relativePathOf: (
    targetFolderId: string | null,
    baseFolderId: string | null,
  ) => string;
  formatRelativePath: (
    baseFolderId: string | null,
    targetFolderId: string | null,
  ) => string;
  flatList: ConceptFolderFlatItem[];
  directConceptsByFolder: Map<string | null, ConceptView[]>;
  directCountOf: (folderId: string | null) => number;
  subtreeCountOf: (folderId: string | null) => number;
};

/**
 * Build an O(F + C) recursive folder index for Concept folders, mirroring `buildFolderIndex`.
 */
export function buildConceptFolderIndex(
  folders: readonly ConceptFolderView[],
  concepts?: readonly ConceptView[],
): ConceptFolderIndex {
  const byId = new Map<string, ConceptFolderView>();
  for (const f of folders) byId.set(f.id, f);

  const children = new Map<string | null, ConceptFolderView[]>();
  for (const f of folders) {
    const pid =
      f.parentId && byId.has(f.parentId) && f.parentId !== f.id
        ? f.parentId
        : null;
    const list = children.get(pid);
    if (list) list.push(f);
    else children.set(pid, [f]);
  }
  for (const [key, list] of children) {
    children.set(key, sortConceptFoldersNatural(list));
  }

  function ancestorsOf(folderId: string | null): ConceptFolderView[] {
    if (!folderId) return [];
    const chain: ConceptFolderView[] = [];
    const visited = new Set<string>();
    let cursor: string | null = folderId;
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const node = byId.get(cursor);
      if (!node) break;
      chain.push(node);
      cursor =
        node.parentId && byId.has(node.parentId) && node.parentId !== node.id
          ? node.parentId
          : null;
    }
    return chain.reverse();
  }

  function depthOf(folderId: string | null): number {
    if (!folderId) return 0;
    return ancestorsOf(folderId).length;
  }

  function subtreeHeight(folderId: string): number {
    const visited = new Set<string>();
    const dfs = (id: string): number => {
      if (visited.has(id)) return 1;
      visited.add(id);
      let maxChild = 0;
      for (const kid of children.get(id) ?? []) {
        maxChild = Math.max(maxChild, dfs(kid.id));
      }
      return 1 + maxChild;
    };
    return dfs(folderId);
  }

  function ancestorIds(folderId: string | null): string[] {
    return ancestorsOf(folderId)
      .slice(0, -1)
      .map((f) => f.id);
  }

  function descendantIds(folderId: string): Set<string> {
    const result = new Set<string>();
    if (!byId.has(folderId)) return result;
    const stack = [folderId];
    while (stack.length) {
      const cur = stack.pop()!;
      if (result.has(cur)) continue;
      result.add(cur);
      for (const kid of children.get(cur) ?? []) {
        stack.push(kid.id);
      }
    }
    return result;
  }

  function subtreeIds(folderId: string | null): Set<string | null> {
    if (folderId === null) {
      const all = new Set<string | null>([null]);
      for (const f of folders) all.add(f.id);
      return all;
    }
    if (!byId.has(folderId)) return new Set();
    const result = new Set<string | null>();
    const stack = [folderId];
    while (stack.length) {
      const cur = stack.pop()!;
      if (result.has(cur)) continue;
      result.add(cur);
      for (const kid of children.get(cur) ?? []) {
        stack.push(kid.id);
      }
    }
    return result;
  }

  function breadcrumbsFor(
    folderId: string | null,
  ): ConceptFolderBreadcrumbNode[] {
    const nodes: ConceptFolderBreadcrumbNode[] = [
      { id: null, title: CONCEPT_ROOT_LABEL },
    ];
    if (!folderId) return nodes;
    for (const f of ancestorsOf(folderId)) {
      nodes.push({ id: f.id, title: f.title });
    }
    return nodes;
  }

  function pathSegmentsOf(folderId: string | null): string[] {
    return ancestorsOf(folderId).map((f) => f.title);
  }

  function pathOf(folderId: string | null): string {
    const segs = pathSegmentsOf(folderId);
    return segs.length ? segs.join(" / ") : CONCEPT_ROOT_LABEL;
  }

  function formatRelativePath(
    baseFolderId: string | null,
    targetFolderId: string | null,
  ): string {
    if (baseFolderId === targetFolderId) return "";
    if (!baseFolderId) return pathOf(targetFolderId);
    const baseSegs = pathSegmentsOf(baseFolderId);
    const targetSegs = pathSegmentsOf(targetFolderId);
    if (
      targetSegs.length >= baseSegs.length &&
      baseSegs.every((seg, idx) => targetSegs[idx] === seg)
    ) {
      const rest = targetSegs.slice(baseSegs.length);
      return rest.length ? rest.join(" / ") : "";
    }
    return targetSegs.join(" / ") || CONCEPT_ROOT_LABEL;
  }

  function relativePathOf(
    targetFolderId: string | null,
    baseFolderId: string | null,
  ): string {
    return formatRelativePath(baseFolderId, targetFolderId);
  }

  const flatList: ConceptFolderFlatItem[] = [];
  {
    const visited = new Set<string>();
    const walk = (parentId: string | null, depth: number, prefix: string[]) => {
      for (const child of children.get(parentId) ?? []) {
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        const nextPrefix = [...prefix, child.title];
        flatList.push({
          folder: child,
          depth,
          path: nextPrefix.join(" / "),
        });
        walk(child.id, depth + 1, nextPrefix);
      }
    };
    walk(null, 1, []);
  }

  const directConceptsByFolder = new Map<string | null, ConceptView[]>();
  const subtreeCountMemo = new Map<string, number>();

  if (concepts) {
    for (const c of concepts) {
      const fid = c.folderId && byId.has(c.folderId) ? c.folderId : null;
      const list = directConceptsByFolder.get(fid);
      if (list) list.push(c);
      else directConceptsByFolder.set(fid, [c]);
    }
    for (const [k, list] of directConceptsByFolder) {
      directConceptsByFolder.set(k, sortConceptsNatural(list));
    }
  }

  function directCountOf(folderId: string | null): number {
    if (concepts) {
      return directConceptsByFolder.get(folderId)?.length ?? 0;
    }
    if (folderId === null) return 0;
    return byId.get(folderId)?.directCount ?? 0;
  }

  function subtreeCountOf(folderId: string | null): number {
    if (!concepts) {
      if (folderId === null) {
        let total = 0;
        for (const f of children.get(null) ?? []) total += f.count;
        return total;
      }
      return byId.get(folderId)?.count ?? 0;
    }
    if (folderId === null) return concepts.length;
    if (!byId.has(folderId)) return 0;
    const calc = (id: string, visiting: Set<string>): number => {
      const cached = subtreeCountMemo.get(id);
      if (cached !== undefined) return cached;
      if (visiting.has(id)) return 0;
      visiting.add(id);
      let total = directConceptsByFolder.get(id)?.length ?? 0;
      for (const kid of children.get(id) ?? []) {
        total += calc(kid.id, visiting);
      }
      subtreeCountMemo.set(id, total);
      return total;
    };
    return calc(folderId, new Set());
  }

  return {
    byId,
    children,
    depthOf,
    subtreeHeight,
    subtreeHeightOf: subtreeHeight,
    ancestorsOf,
    breadcrumbsOf: ancestorsOf,
    breadcrumbsFor,
    ancestorIds,
    descendantIds,
    subtreeIds,
    pathSegmentsOf,
    pathOf,
    formatPath: pathOf,
    relativePathOf,
    formatRelativePath,
    flatList,
    directConceptsByFolder,
    directCountOf,
    subtreeCountOf,
  };
}

/**
 * Recompute O(F + C) `directCount`, recursive `count`, `folderPath`, and `groupName`
 * for concept folders and concepts in a single pass.
 */
export function recomputeConceptFolderState(
  folders: readonly ConceptFolderView[],
  concepts: readonly ConceptView[],
): { conceptFolders: ConceptFolderView[]; concepts: ConceptView[] } {
  const byId = new Map<string, ConceptFolderView>();
  for (const f of folders) byId.set(f.id, f);

  const children = new Map<string | null, ConceptFolderView[]>();
  for (const f of folders) {
    const pid =
      f.parentId && byId.has(f.parentId) && f.parentId !== f.id
        ? f.parentId
        : null;
    const list = children.get(pid);
    if (list) list.push(f);
    else children.set(pid, [f]);
  }

  const directCounts = new Map<string, number>();
  for (const c of concepts) {
    if (c.folderId && byId.has(c.folderId)) {
      directCounts.set(c.folderId, (directCounts.get(c.folderId) ?? 0) + 1);
    }
  }

  const pathMemo = new Map<string, string>();
  const resolvePath = (folderId: string | null): string => {
    if (!folderId || !byId.has(folderId)) return CONCEPT_ROOT_LABEL;
    const cached = pathMemo.get(folderId);
    if (cached !== undefined) return cached;
    const segs: string[] = [];
    const visited = new Set<string>();
    let cursor: string | null = folderId;
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const node = byId.get(cursor);
      if (!node) break;
      segs.push(node.title);
      cursor =
        node.parentId && byId.has(node.parentId) && node.parentId !== node.id
          ? node.parentId
          : null;
    }
    const path = segs.length ? segs.reverse().join(" / ") : CONCEPT_ROOT_LABEL;
    pathMemo.set(folderId, path);
    return path;
  };

  const countMemo = new Map<string, number>();
  const resolveSubtreeCount = (id: string, visiting: Set<string>): number => {
    const cached = countMemo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let total = directCounts.get(id) ?? 0;
    for (const kid of children.get(id) ?? []) {
      total += resolveSubtreeCount(kid.id, visiting);
    }
    countMemo.set(id, total);
    return total;
  };

  const nextFolders = sortConceptFoldersNatural(
    folders.map((f) => {
      const validParent =
        f.parentId && byId.has(f.parentId) && f.parentId !== f.id
          ? f.parentId
          : null;
      return {
        ...f,
        parentId: validParent,
        directCount: directCounts.get(f.id) ?? 0,
        count: resolveSubtreeCount(f.id, new Set()),
      };
    }),
  );

  const nextConcepts = sortConceptsNatural(
    concepts.map((c) => {
      const validFolderId = c.folderId && byId.has(c.folderId) ? c.folderId : null;
      const folder = validFolderId ? byId.get(validFolderId) : undefined;
      return {
        ...c,
        folderId: validFolderId,
        folderPath: resolvePath(validFolderId),
        groupName: folder ? folder.title : "",
      };
    }),
  );

  return { conceptFolders: nextFolders, concepts: nextConcepts };
}

export type ConceptGroupBucket = {
  groupName: string;
  label: string;
  items: ConceptView[];
};

/**
 * Group concepts by `groupName` using natural Chinese ordering.
 * Named groups appear first (sorted naturally); empty/未分组 appears last if non-empty.
 */
export function groupConceptsByName(
  concepts: readonly ConceptView[],
): ConceptGroupBucket[] {
  const buckets = new Map<string, ConceptView[]>();
  for (const concept of concepts) {
    const key = concept.groupName.trim();
    const list = buckets.get(key);
    if (list) list.push(concept);
    else buckets.set(key, [concept]);
  }

  const namedKeys = [...buckets.keys()]
    .filter((k) => k.length > 0)
    .sort((a, b) => compareNaturalNames(a, b));

  const result: ConceptGroupBucket[] = namedKeys.map((groupName) => ({
    groupName,
    label: groupName,
    items: sortConceptsNatural(buckets.get(groupName)!),
  }));

  const ungrouped = buckets.get("");
  if (ungrouped && ungrouped.length > 0) {
    result.push({
      groupName: "",
      label: CONCEPT_UNGROUPED_LABEL,
      items: sortConceptsNatural(ungrouped),
    });
  }

  return result;
}
