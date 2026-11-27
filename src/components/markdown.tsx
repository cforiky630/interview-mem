"use client";
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { PluggableList } from "unified";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Check, ChevronDown, Copy, SlidersHorizontal, Tags } from "lucide-react";
import {
  markdownDocument,
  mergeQuestionTags,
  remarkObsidian,
} from "@/lib/markdown-source";

const plainPlugins: PluggableList = [remarkGfm, remarkObsidian];
const mathPlugins: PluggableList = [remarkGfm, remarkMath, remarkObsidian];
const EMPTY_REHYPE: PluggableList = [];
const mathRehype: PluggableList = [
  [
    rehypeKatex,
    {
      strict: "ignore",
      throwOnError: false,
      trust: false,
      maxSize: 10,
      maxExpand: 500,
    },
  ],
];

let katexCssLoaded = false;
let katexCssPromise: Promise<unknown> | null = null;

function hasMathSyntax(source: string): boolean {
  if (!source.includes("$")) return false;
  if (/(?<!\\)\$\$/.test(source)) return true;
  return /(?<!\\)\$(?!\s)(?:\\.|[^$\\\n])+?(?<!\s)\$/.test(source);
}

function loadKatexCss(): Promise<unknown> {
  if (katexCssLoaded) return Promise.resolve();
  if (!katexCssPromise) {
    katexCssPromise = import("katex/dist/katex.min.css").then(() => {
      katexCssLoaded = true;
    });
  }
  return katexCssPromise;
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  async function handleCopy() {
    const text = preRef.current?.textContent ?? "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      /* Clipboard permission unavailable */
    }
  }

  return (
    <div className="code-block-wrap">
      <button
        type="button"
        className={`code-copy-btn ${copied ? "is-copied" : ""}`}
        title={copied ? "已复制" : "复制代码"}
        aria-label={copied ? "已复制代码" : "复制代码"}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => void handleCopy()}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}
type MarkdownComponents = ComponentProps<typeof ReactMarkdown>["components"];

function buildMarkdownComponents(interactiveLinks: boolean): MarkdownComponents {
  return {
    a: ({ children, href }) =>
      interactiveLinks ? (
        <a
          href={href}
          target={href?.startsWith("#note=") ? undefined : "_blank"}
          rel="noopener noreferrer"
          onClick={
            href?.startsWith("#note=")
              ? (event) => {
                  event.preventDefault();
                  try {
                    window.dispatchEvent(
                      new CustomEvent("shiyi:open-note", {
                        detail: decodeURIComponent(href.slice(6)),
                      }),
                    );
                  } catch {
                    /* malformed imported link */
                  }
                }
              : undefined
          }
        >
          {children}
        </a>
      ) : (
        <span>{children}</span>
      ),
    img: ({ src, alt }) =>
      !interactiveLinks ? (
        <span>[图片：{alt || "查看图片"}]</span>
      ) : typeof src === "string" ? (
        <a href={src} target="_blank" rel="noopener noreferrer">
          [图片：{alt || "查看图片"}]
        </a>
      ) : null,
    table: ({ children }) => (
      <div className="table-scroll">
        <table>{children}</table>
      </div>
    ),
    pre: ({ children }) =>
      interactiveLinks ? (
        <CodeBlock>{children}</CodeBlock>
      ) : (
        <pre>{children}</pre>
      ),
  };
}

const INTERACTIVE_COMPONENTS = buildMarkdownComponents(true);
const STATIC_COMPONENTS = buildMarkdownComponents(false);

// 选文、同步状态、AI 面板变化时，原文不变就不重复解析 Markdown。
export const Markdown = memo(function Markdown({
  children,
  interactiveLinks = true,
}: {
  children: string;
  interactiveLinks?: boolean;
}) {
  const needsMath = hasMathSyntax(children);

  useEffect(() => {
    if (!needsMath || katexCssLoaded) return;
    void loadKatexCss().catch(() => {});
  }, [needsMath]);

  const activeBody = useMemo(() => markdownDocument(children).body, [children]);

  return (
    <div className="prose-content">
      <ReactMarkdown
        remarkPlugins={needsMath ? mathPlugins : plainPlugins}
        rehypePlugins={needsMath ? mathRehype : EMPTY_REHYPE}
        components={
          interactiveLinks ? INTERACTIVE_COMPONENTS : STATIC_COMPONENTS
        }
      >
        {activeBody}
      </ReactMarkdown>
    </div>
  );
});

const PROPERTY_LABELS: Record<string, string> = {
  aliases: "别名",
  alias: "别名",
  difficulty: "难度",
  company: "公司",
  source: "来源",
  date: "日期",
  created: "创建",
  updated: "更新",
  status: "状态",
  category: "分类",
  author: "作者",
};

export function ObsidianProperties({
  source,
  extraTags,
  includeTags = false,
  defaultExpanded = true,
  onTagClick,
}: {
  source: string;
  extraTags?: string[];
  includeTags?: boolean;
  defaultExpanded?: boolean;
  onTagClick?: (tag: string) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const doc = useMemo(() => markdownDocument(source), [source]);
  const mergedTags = useMemo(
    () => mergeQuestionTags(extraTags, doc.tags),
    [extraTags, doc.tags],
  );
  if (!doc.properties.length && !(includeTags && mergedTags.length))
    return null;

  return (
    <section
      className="obsidian-properties"
      data-expanded={expanded}
      aria-label="笔记属性"
    >
      <button
        type="button"
        className="obsidian-properties-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        <SlidersHorizontal size={14} aria-hidden="true" />
        <strong>笔记属性</strong>
        <span className="obsidian-properties-summary">
          {doc.properties.length > 0 && `${doc.properties.length} 项属性`}
          {doc.properties.length > 0 && includeTags && mergedTags.length > 0
            ? " · "
            : ""}
          {includeTags &&
            mergedTags.length > 0 &&
            `${mergedTags.length} 个标签`}
        </span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      <div className="obsidian-properties-panel">
        <dl className="obsidian-properties-grid">
          {includeTags && mergedTags.length > 0 && (
            <div className="obsidian-prop-row">
              <dt title="tags">
                <Tags size={13} aria-hidden="true" />
                标签
              </dt>
              <dd className="obsidian-prop-list">
                {mergedTags.map((tag) =>
                  onTagClick ? (
                    <button
                      type="button"
                      key={tag}
                      className="obsidian-prop-tag"
                      onClick={() => onTagClick(tag)}
                    >
                      <span className="tag-hash" aria-hidden="true">
                        #
                      </span>
                      {tag}
                    </button>
                  ) : (
                    <span key={tag} className="obsidian-prop-tag">
                      <span className="tag-hash" aria-hidden="true">
                        #
                      </span>
                      {tag}
                    </span>
                  ),
                )}
              </dd>
            </div>
          )}
          {doc.properties.map((prop) => {
            const label = PROPERTY_LABELS[prop.key.toLowerCase()] ?? prop.key;
            return (
              <div className="obsidian-prop-row" key={prop.key}>
                <dt title={prop.key}>{label}</dt>
                <dd
                  className={
                    Array.isArray(prop.value)
                      ? "obsidian-prop-list"
                      : "obsidian-prop-scalar"
                  }
                >
                  {Array.isArray(prop.value)
                    ? prop.value.map((item) => (
                        <span key={item} className="obsidian-prop-pill">
                          {item}
                        </span>
                      ))
                    : prop.value}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
    </section>
  );
}
