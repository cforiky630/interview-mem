import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "拾忆 · 面试题知识库",
    short_name: "拾忆",
    description: "面试题知识库、间隔复习与 AI 助手。每天一点，记得更久。",
    start_url: "/",
    display: "standalone",
    background_color: "#F5F7F6",
    theme_color: "#1A6347",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
