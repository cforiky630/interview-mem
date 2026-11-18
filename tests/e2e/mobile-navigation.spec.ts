import { test, expect } from "./fixtures";

test("long libraries expand on demand, keep filters and restore the reading position", async ({
  page,
}, info) => {
  const origin = "http://localhost:3107";
  expect(
    (
      await page.request.post("/api/auth/sign-up/email", {
        headers: { origin },
        data: {
          name: "手机切页",
          email: `navigation-${info.project.name}-${Date.now()}@example.test`,
          password: "navigation-browser-password",
        },
      })
    ).ok(),
  ).toBe(true);
  const data = await (await page.request.get("/api/workspace")).json();
  const raw = Array.from(
    { length: 75 },
    (_, i) =>
      `## 切页样例 ${i + 1}？\n正文回答 ${i + 1}，保留完整原文。\n\n### 面试追问\nQ：追问怎么复习？\nA：单独回忆再对照。`,
  ).join("\n\n");
  expect(
    (
      await page.request.post("/api/import", {
        headers: { origin },
        data: { batchId: crypto.randomUUID(), deckId: data.decks[0].id, raw },
      })
    ).ok(),
  ).toBe(true);
  await page.goto("/");
  const nav = page.locator(
    info.project.name === "mobile" ? ".mobile-bottom-nav" : ".primary-nav",
  );
  await nav.getByRole("button", { name: "我的题库", exact: true }).click();
  await page.getByRole("tab", { name: "全部题目", exact: true }).click();
  await expect(page.locator(".list-count")).toHaveText("75 道题");
  await expect(page.locator(".question-row")).toHaveCount(40);
  // 搜索覆盖尚未挂载的题目，而不只是当前屏幕里的 40 道。
  await page.getByLabel("搜索题目", { exact: true }).fill("切页样例 75？");
  await expect(page.locator(".question-row")).toHaveCount(1);
  await expect(page.locator(".question-row-main")).toContainText(
    "切页样例 75？",
  );
  await page.getByLabel("搜索题目", { exact: true }).fill("");
  await expect(page.locator(".question-row")).toHaveCount(40);
  await page
    .getByRole("button", { name: "加载更多题目", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(page.locator(".question-row")).toHaveCount(75);
  const question = page.locator(".question-row-main").nth(18);
  await question.scrollIntoViewIfNeeded();
  const previousScroll = await page.evaluate(() => window.scrollY);
  expect(previousScroll).toBeGreaterThan(300);
  await question.click();
  await expect(page.locator(".answer-content")).toContainText("保留完整原文");
  expect(await page.evaluate(() => window.scrollY)).toBeLessThan(10);
  if (info.project.name === "mobile")
    await expect(
      nav.getByRole("button", { name: "我的题库", exact: true }),
    ).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "返回题库", exact: true }).click();
  await expect(page.locator(".question-row")).toHaveCount(75);
  await expect
    .poll(async () =>
      Math.abs((await page.evaluate(() => window.scrollY)) - previousScroll),
    )
    .toBeLessThan(3);
  await page.getByLabel("搜索题目", { exact: true }).fill("切页样例 75？");
  await expect(page.locator(".question-row")).toHaveCount(1);
  await page.locator(".question-row-main").click();
  await page.getByRole("button", { name: "返回题库", exact: true }).click();
  await expect(page.getByLabel("搜索题目", { exact: true })).toHaveValue(
    "切页样例 75？",
  );
  await expect(page.locator(".question-row")).toHaveCount(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("mobile reading uses reachable controls and the drawer keeps the background still", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "mobile", "Phone layout only");
  const origin = "http://localhost:3107";
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.request.post("/api/auth/sign-up/email", {
    headers: { origin },
    data: {
      name: "手机阅读",
      email: `touch-${Date.now()}@example.test`,
      password: "touch-browser-password",
    },
  });
  const data = await (await page.request.get("/api/workspace")).json();
  await page.request.post("/api/import", {
    headers: { origin },
    data: {
      batchId: crypto.randomUUID(),
      deckId: data.decks[0].id,
      raw: "## 手机怎样阅读和复习？\n先用自己的话说明原理，再用例子验证理解。\n\n$$p(t)=e^{-t/s}$$\n\n### 面试追问\nQ：如何检查遗漏？\nA：对照参考答案，并记下自己的理解。",
    },
  });
  await page.goto("/");
  await page.getByLabel("打开导航", { exact: true }).click();
  await expect(page.getByLabel("打开导航", { exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(
    await page.evaluate(() => document.documentElement.style.overflow),
  ).toBe("hidden");
  await page
    .getByLabel("关闭导航", { exact: true })
    .click({ position: { x: 320, y: 100 } });
  await expect(page.getByLabel("打开导航", { exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(
    await page.evaluate(() => document.documentElement.style.overflow),
  ).not.toBe("hidden");
  await page
    .locator(".mobile-bottom-nav")
    .getByRole("button", { name: "我的题库", exact: true })
    .click();
  await page.getByRole("tab", { name: "全部题目", exact: true }).click();
  await page.getByRole("button", { name: /^手机怎样阅读和复习？/ }).click();
  await expect(page.locator(".katex")).toBeVisible();
  const text = page.locator(".answer-content .prose-content").first();
  expect(
    await text.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(16);
  for (const control of [
    page.getByLabel("更多题目操作", { exact: true }),
    page.getByRole("button", { name: "收藏题目", exact: true }),
    page.getByRole("tab", { name: "正文", exact: true }),
  ]) {
    const bounds = await control.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.width).toBeGreaterThanOrEqual(40);
  }
  await page.screenshot({
    path: "test-results/mobile-reader-improved.png",
    animations: "disabled",
    fullPage: true,
  });
  await page.getByRole("tab", { name: "笔记", exact: true }).click();
  const note = page.getByLabel("个人笔记", { exact: true });
  expect(
    await note.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(16);
  await note.fill("移动端尚未提交的笔记。");
  await page
    .locator(".mobile-bottom-nav")
    .getByRole("button", { name: "今日", exact: true })
    .click();
  await page
    .locator(".mobile-bottom-nav")
    .getByRole("button", { name: "我的题库", exact: true })
    .click();
  await page.getByRole("tab", { name: "全部题目", exact: true }).click();
  await page.getByRole("button", { name: /^手机怎样阅读和复习？/ }).click();
  await page.getByRole("tab", { name: "笔记", exact: true }).click();
  await expect(note).toHaveValue("移动端尚未提交的笔记。");
  expect(errors).toEqual([]);
});
