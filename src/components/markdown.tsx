import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { markdownDocument, remarkObsidian } from "@/lib/markdown-source";
export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkObsidian]}
        rehypePlugins={[
          [
            rehypeKatex,
            { strict: "ignore", throwOnError: false, trust: false },
          ],
        ]}
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
}
