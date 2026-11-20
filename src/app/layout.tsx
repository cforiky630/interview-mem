import type { Metadata, Viewport } from "next";
import { Toaster } from "sonner";
import "./globals.css";
import "katex/dist/katex.min.css";
import "./notebook.css";
import "./mobile.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F4F5F6" },
    { media: "(prefers-color-scheme: dark)", color: "#0E1010" },
  ],
};
export const metadata: Metadata = {
  title: "拾忆 · 把知识变成自己的表达",
  description: "面试题知识库、间隔复习与 AI 助手。每天一点，记得更久。",
};
const THEME_INIT_SCRIPT = `(function(){try{var d=document.documentElement.dataset;var t=localStorage.getItem("shiyi:theme");if(t==="light"||t==="dark")d.theme=t;var p=localStorage.getItem("shiyi:palette");d.palette=p==="lavender"?"lavender":"forest";}catch(e){}})();`;
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        {children}
        <Toaster position="top-center" richColors closeButton />
      </body>
    </html>
  );
}
