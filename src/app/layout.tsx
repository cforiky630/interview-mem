import type { Metadata } from "next";
import { Toaster } from "sonner";
import "./globals.css";
import "katex/dist/katex.min.css";
import "./notebook.css";
export const metadata: Metadata = {
  title: "拾忆 · 把知识变成自己的表达",
  description: "面试题知识库、间隔复习与随文 AI 助教。每天一点，记得更久。",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        {children}
        <Toaster position="top-center" richColors closeButton />
      </body>
    </html>
  );
}
