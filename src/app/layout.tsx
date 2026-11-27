import type { Metadata, Viewport } from "next";
import { Toaster } from "sonner";
import { DeviceProfileSync } from "@/lib/device-profile";
import "@fontsource/cormorant-garamond/600-italic.css";
import "@fontsource-variable/inter";
import "./globals.css";
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
// Keep in sync with DEVICE_PROFILE_INIT_SCRIPT in src/lib/device-profile.ts
const DEVICE_PROFILE_INIT_SCRIPT = `(function(){try{var d=document.documentElement;var mm=window.matchMedia;var coarse=!!(mm&&mm("(pointer: coarse)").matches);var noHover=!!(mm&&mm("(hover: none)").matches);var fineHover=!!(mm&&mm("(hover: hover) and (pointer: fine)").matches);var touch=coarse||(noHover&&!fineHover);var mobile=touch&&!!(mm&&(mm("(max-width: 960px)").matches||mm("(max-height: 540px)").matches));var compact=!touch&&!!(mm&&mm("(max-width: 860px)").matches);d.dataset.input=touch?"touch":"mouse";d.dataset.shell=mobile?"mobile":(compact?"desktop-compact":"desktop");var vv=window.visualViewport;var vvh=Math.round(vv?vv.height:window.innerHeight);if(vvh>0)d.style.setProperty("--vvh",vvh+"px");d.style.setProperty("--kb-offset","0px");}catch(e){}})();`;
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <script
          dangerouslySetInnerHTML={{ __html: DEVICE_PROFILE_INIT_SCRIPT }}
        />
      </head>
      <body>
        {children}
        <DeviceProfileSync />
        <Toaster position="top-center" richColors closeButton />
      </body>
    </html>
  );
}
