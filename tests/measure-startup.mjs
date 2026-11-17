import { chromium, request } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const baseURL = "http://localhost:3107";
await mkdir("test-results", { recursive: true });
if (process.argv[2] === "seed") {
  const api = await request.newContext({
    baseURL,
    extraHTTPHeaders: { origin: baseURL },
  });
  try {
    const signed = await api.post("/api/auth/sign-up/email", {
      data: {
        name: "加载测试",
        email: `startup-${Date.now()}@example.test`,
        password: randomUUID(),
      },
    });
    if (!signed.ok())
      throw new Error(`Test registration failed: ${signed.status()}`);
    const state = await (await api.get("/api/workspace")).json();
    const raw = Array.from(
      { length: 9 },
      (_, i) =>
        `## 性能样例题 ${i + 1}\n${"这是用于测量的参考答案，涵盖边界条件与代码示例。\n".repeat(60)}`,
    ).join("\n\n");
    const imported = await api.post("/api/import", {
      data: { batchId: randomUUID(), deckId: state.decks[0].id, raw },
    });
    if (!imported.ok())
      throw new Error(`Test import failed: ${imported.status()}`);
    await api.storageState({ path: "test-results/startup-storage.json" });
    console.log("Prepared a private nine-question test account.");
  } finally {
    await api.dispose();
  }
} else {
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "chrome" : undefined,
  });
  try {
    const context = await browser.newContext({
      baseURL,
      storageState: "test-results/startup-storage.json",
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const start = performance.now();
    await page.goto("/");
    await page
      .getByRole("heading", { name: /今天，\s*记住一点。/ })
      .waitFor({ state: "visible" });
    const readyMs = Math.round(performance.now() - start);
    const resources = await page.evaluate(() =>
      performance.getEntriesByType("resource").map((r) => ({
        name: r.name,
        start: r.startTime,
        end: r.responseEnd,
        bytes: r.encodedBodySize,
      })),
    );
    const result = {
      readyMs,
      jsBytes: resources
        .filter((r) => /\.js(?:\?|$)/.test(r.name))
        .reduce((sum, r) => sum + r.bytes, 0),
      api: resources
        .filter((r) => r.name.includes("/api/"))
        .map((r) => ({
          path: new URL(r.name).pathname,
          startMs: Math.round(r.start),
          durationMs: Math.round(r.end - r.start),
        })),
    };
    const label = process.argv[2] || "measure";
    await writeFile(
      `test-results/startup-${label}.json`,
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
    await context.close();
  } finally {
    await browser.close();
  }
}
