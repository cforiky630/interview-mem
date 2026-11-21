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
    { media: "(prefers-color-scheme: light)", color: "#F5F7F6" },
    { media: "(prefers-color-scheme: dark)", color: "#0C0F0E" },
  ],
};
export const metadata: Metadata = {
  title: "拾忆 · 把知识变成自己的表达",
  description: "面试题知识库、间隔复习与 AI 助手。每天一点，记得更久。",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "拾忆",
  },
};
const THEME_INIT_SCRIPT = `(function(){try{var d=document.documentElement.dataset;var t=localStorage.getItem("shiyi:theme");if(t!=="light"&&t!=="dark"){t=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}d.theme=t;var p=localStorage.getItem("shiyi:palette")==="lavender"?"lavender":"forest";d.palette=p;var c=p==="lavender"?(t==="dark"?"#0D0C13":"#F6F4F8"):(t==="dark"?"#0C0F0E":"#F5F7F6");var ms=document.querySelectorAll('meta[name="theme-color"]');for(var i=0;i<ms.length;i++)ms[i].setAttribute("content",c);}catch(e){}})();`;
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
