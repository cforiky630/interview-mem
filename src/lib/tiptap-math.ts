import { InputRule, Node } from "@tiptap/core";

type MathNode = {
  attrs?: {
    latex?: string;
  };
};

/**
 * Lossless `$...$` inline LaTeX node for `@tiptap/markdown`.
 * Preserves raw LaTeX delimiters (`$...$`) and backslashes/underscores verbatim
 * without Markdown-escaping them during serialization.
 */
export const InlineMath = Node.create({
  name: "inlineMath",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      latex: {
        default: "",
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-latex") ?? "",
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-math-inline]" }];
  },

  renderHTML({ node }: { node: { attrs: Record<string, unknown> } }) {
    const latex = String(node.attrs.latex ?? "");
    return [
      "span",
      { "data-math-inline": "", "data-latex": latex },
      `$${latex}$`,
    ];
  },

  markdownTokenName: "inlineMath",

  markdownTokenizer: {
    name: "inlineMath",
    level: "inline",
    start: (src: string) => src.indexOf("$"),
    tokenize(src: string) {
      if (src.startsWith("$$")) return undefined;
      const match = /^\$(?!\s)([^$\n]+?)(?<!\s)\$/.exec(src);
      if (!match) return undefined;
      return {
        type: "inlineMath",
        raw: match[0],
        latex: match[1],
      };
    },
  },

  parseMarkdown(token, helpers) {
    return helpers.createNode("inlineMath", {
      latex: String((token as { latex?: unknown }).latex ?? ""),
    });
  },

  renderMarkdown(node: MathNode) {
    return `$${String(node.attrs?.latex ?? "")}$`;
  },

  addInputRules() {
    const type = this.type;
    return [
      new InputRule({
        find: /(?:^|[^$\\])\$(?!\s)([^$\n]+?)(?<!\s)\$$/,
        handler({ state, range, match }) {
          const full = match[0];
          const latex = match[1]?.trim();
          if (!latex) return null;
          const prefixLen = full.startsWith("$") ? 0 : 1;
          const start = range.from + prefixLen;
          if (start > 0 && state.doc.textBetween(start - 1, start, "") === "$") {
            return null;
          }
          state.tr.replaceWith(start, range.to, type.create({ latex }));
        },
      }),
    ];
  },
});

/**
 * Lossless `$$...$$` display LaTeX block node for `@tiptap/markdown`.
 */
export const BlockMath = Node.create({
  name: "blockMath",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      latex: {
        default: "",
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-latex") ?? "",
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-math-block]" }];
  },

  renderHTML({ node }: { node: { attrs: Record<string, unknown> } }) {
    const latex = String(node.attrs.latex ?? "");
    return [
      "div",
      { "data-math-block": "", "data-latex": latex },
      `$$\n${latex}\n$$`,
    ];
  },

  markdownTokenName: "blockMath",

  markdownTokenizer: {
    name: "blockMath",
    level: "block",
    start: (src: string) => src.indexOf("$$"),
    tokenize(src: string) {
      const multiline = /^\$\$\r?\n([\s\S]+?)\r?\n\$\$(?:\r?\n|$)/.exec(src);
      if (multiline) {
        return {
          type: "blockMath",
          raw: multiline[0],
          latex: multiline[1].trim(),
        };
      }
      const singleLine = /^\$\$(?!\s)([^\n$]+?)(?<!\s)\$\$(?:\r?\n|$)/.exec(
        src,
      );
      if (singleLine) {
        return {
          type: "blockMath",
          raw: singleLine[0],
          latex: singleLine[1].trim(),
        };
      }
      return undefined;
    },
  },

  parseMarkdown(token, helpers) {
    return helpers.createNode("blockMath", {
      latex: String((token as { latex?: unknown }).latex ?? ""),
    });
  },

  renderMarkdown(node: MathNode) {
    return `$$\n${String(node.attrs?.latex ?? "")}\n$$`;
  },

  addInputRules() {
    const type = this.type;
    return [
      new InputRule({
        find: /^\$\$\s$/,
        handler({ state, range }) {
          const $start = state.doc.resolve(range.from);
          if (!$start.parent.isTextblock) return null;
          state.tr.replaceWith(
            $start.before(),
            $start.after(),
            type.create({ latex: "" }),
          );
        },
      }),
    ];
  },
});
