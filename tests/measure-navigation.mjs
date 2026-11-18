import { chromium, request } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

// 只连接独立测试服务；保留同一账号和网络条件以对比修改前后。
const baseURL = "http://localhost:3107";
const directory = ".cache/mobile-audit";
await mkdir(directory, { recursive: true });
const storage = `${directory}/storage.json`;
const title = "如何整理面试题并复习？";
if (process.argv[2] === "seed") {
  const api = await request.newContext({
    baseURL,
    extraHTTPHeaders: { origin: baseURL },
  });
  try {
    const signed = await api.post("/api/auth/sign-up/email", {
      data: {
        name: "手机性能检查",
        email: `mobile-${randomUUID()}@example.test`,
        password: randomUUID(),
      },
    });
    if (!signed.ok()) throw new Error(`Registration: ${signed.status()}`);
    const workspace = await (await api.get("/api/workspace")).json();
    const longAnswer = Array.from(
      { length: 32 },
      (_, i) =>
        `### 知识要点 ${i + 1}\n\n先回忆原理，再结合一个具体例子解释适用条件。练习时保留原文，单独记录自己的理解，并在复习后检查遗漏。\n\n- 第一个要点：说明关键步骤与边界。\n- 第二个要点：说明实现和取舍。\n${i % 5 === 0 ? "\n$$p(t)=e^{-t/s}$$\n" : ""}`,
    ).join("\n\n");
    for (let batch = 0; batch < 3; batch++) {
      const raw = Array.from({ length: 40 }, (_, index) => {
        const n = batch * 40 + index;
        return `## ${n ? `性能样例问题 ${n}？` : title}\n\n${n ? "用自己的语言讲清概念、举一个例子，再说明适用边界。".repeat(8) : longAnswer}\n\n### 面试追问\nQ：如何检验自己的理解？\nA：用例子解释，再对照参考答案。`;
      }).join("\n\n");
      const imported = await api.post("/api/import", {
        data: { batchId: randomUUID(), deckId: workspace.decks[0].id, raw },
      });
      if (!imported.ok()) throw new Error(`Import: ${imported.status()}`);
    }
    await api.storageState({ path: storage });
    console.log(
      "Prepared 120 synthetic questions in the isolated test database.",
    );
  } finally {
    await api.dispose();
  }
} else {
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "chrome" : undefined,
    headless: true,
  });
  try {
    const context = await browser.newContext({
      baseURL,
      storageState: storage,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 120,
      downloadThroughput: 500_000,
      uploadThroughput: 250_000,
    });
    await page.addInitScript(() => {
      window.__mobileAudit = { tasks: [], start: 0 };
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          window.__mobileAudit.tasks.push({
            start: entry.startTime,
            duration: entry.duration,
          });
      }).observe({ type: "longtask", buffered: true });
      document.addEventListener(
        "pointerdown",
        () => {
          window.__mobileAudit.start = performance.now();
        },
        true,
      );
    });
    const nav = page.locator(".mobile-bottom-nav");
    const samples = [];
    async function measure(name, button, ready) {
      await button.tap();
      await ready.waitFor({ state: "visible" });
      const result = await page.evaluate(async () => {
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        const start = window.__mobileAudit.start;
        return {
          ms: Math.round(performance.now() - start),
          longTasksMs: Math.round(
            window.__mobileAudit.tasks
              .filter((task) => task.start >= start)
              .reduce((sum, task) => sum + task.duration, 0),
          ),
        };
      });
      samples.push({ name, ...result });
    }
    await page.goto("/");
    await page.locator(".notebook-dashboard").waitFor();
    await page.waitForLoadState("networkidle");
    await measure(
      "today-to-library",
      nav.getByRole("button", { name: "我的题库", exact: true }),
      page.locator(".library-page"),
    );
    await page.getByRole("tab", { name: "全部题目", exact: true }).tap();
    await measure(
      "cold-reader",
      page.getByRole("button", { name: new RegExp(`^${title}`) }),
      page.locator(".answer-content .practice-block").first(),
    );
    await page.waitForTimeout(500);
    await measure(
      "open-ai",
      page
        .locator(".reader-tools")
        .getByRole("button", { name: "AI", exact: true }),
      page.locator(".ai-panel"),
    );
    await page
      .locator(".reader-tools")
      .getByRole("button", { name: "AI", exact: true })
      .tap();
    await measure(
      "reader-to-library",
      page.getByRole("button", { name: "返回题库", exact: true }),
      page.locator(".library-page"),
    );
    await measure(
      "warm-reader",
      page.getByRole("button", { name: new RegExp(`^${title}`) }),
      page.locator(".answer-content .practice-block").first(),
    );
    await measure(
      "reader-to-today",
      nav.getByRole("button", { name: "今日", exact: true }),
      page.locator(".notebook-dashboard"),
    );
    await measure(
      "today-to-review",
      nav.getByRole("button", { name: "开始复习", exact: true }),
      page.getByLabel("本题作答", { exact: true }),
    );
    const result = { cpuSlowdown: 4, latencyMs: 120, questions: 120, samples };
    await writeFile(
      `${directory}/navigation-${process.argv[2] ?? "measure"}.json`,
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result, null, 2));
    await context.close();
  } finally {
    await browser.close();
  }
}
