import { memo } from "react";
import type { PluggableList } from "unified";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { markdownDocument, remarkObsidian } from "@/lib/markdown-source";
const plainPlugins = [remarkGfm, remarkObsidian];
const mathPlugins = [remarkGfm, remarkMath, remarkObsidian];
const mathRehype: PluggableList = [
  [rehypeKatex, { strict: "ignore", throwOnError: false, trust: false }],
];
// 选文、同步状态、AI 面板变化时，原文不变就不重复解析 Markdown。
export const Markdown = memo(function Markdown({
  children,
}: {
  children: string;
}) {
  const math = children.includes("$");
  return (
    <div className="prose-content">
      <ReactMarkdown
        remarkPlugins={math ? mathPlugins : plainPlugins}
        rehypePlugins={math ? mathRehype : []}
        components={{
          a: ({ children, href }) => (
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
          ),
          img: ({ src, alt }) =>
            typeof src === "string" ? (
              <a href={src} target="_blank" rel="noopener noreferrer">
                [图片：{alt || "查看图片"}]
              </a>
            ) : null,
          table: ({ children }) => (
            <div className="table-scroll">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {markdownDocument(children).body}
      </ReactMarkdown>
    </div>
  );
});
