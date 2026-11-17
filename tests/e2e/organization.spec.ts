import { test, expect } from "./fixtures";

test("floating card controls, dismissible menus, reviewed imports and category deletion", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const origin = "http://localhost:3107";
  expect(
    (
      await page.request.post("/api/auth/sign-up/email", {
        headers: { origin },
        data: {
          name: "拾忆体验",
          email: `organization-${info.project.name}-${Date.now()}@example.test`,
          password: "browser-test-password",
        },
      })
    ).ok(),
  ).toBe(true);
  const workspace = async () =>
    (await page.request.get("/api/workspace")).json();
  let state = await workspace();
  expect(
    (
      await page.request.post("/api/import", {
        headers: { origin },
        data: {
          batchId: crypto.randomUUID(),
          deckId: state.decks[0].id,
          raw: Array.from(
            { length: 6 },
            (_, i) =>
              `## ${["什么是闭包？", "为什么使用索引？", "如何理解事件循环？", "如何保证幂等？", "怎样处理并发修改？", "事务隔离是什么？"][i]}\n用自己的语言讲清概念、举一个例子，再说明适用边界。`,
          ).join("\n\n"),
        },
      })
    ).ok(),
  ).toBe(true);
  await page.goto("/");
  await expect(page.locator(".today-plan .plan-count")).toContainText("5 道");
  await expect(page.locator(".focus-section .carousel-controls")).toContainText(
    "1 / 3",
  );
  const previous = page.getByRole("button", {
    name: "上一张题目卡片",
    exact: true,
  });
  const next = page.getByRole("button", {
    name: "下一张题目卡片",
    exact: true,
  });
  const cardBounds = await page.locator(".focus-card").boundingBox();
  const bounds = await previous.boundingBox();
  expect(
    Math.abs(
      bounds!.y + bounds!.height / 2 - cardBounds!.y - cardBounds!.height / 2,
    ),
  ).toBeLessThan(2);
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(
    (await next.boundingBox())!.x + (await next.boundingBox())!.width,
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  const firstTitle = await page.locator(".focus-card h3").innerText();
  await next.click();
  await expect(page.locator(".focus-card h3")).not.toHaveText(firstTitle);
  await previous.click();
  await expect(page.locator(".focus-card h3")).toHaveText(firstTitle);
  await page.screenshot({
    path: `test-results/organized-home-${info.project.name}.png`,
    animations: "disabled",
    fullPage: true,
  });
  const nav = page.locator(
    info.project.name === "mobile" ? ".mobile-bottom-nav" : ".primary-nav",
  );
  await nav.getByRole("button", { name: "我的题库", exact: true }).click();
  const bookMenu = page.getByLabel("管理题库：我的面试题", { exact: true });
  await bookMenu.click();
  await expect(
    page.getByRole("button", { name: "删除题库", exact: true }),
  ).toBeVisible();
  await page.getByRole("heading", { name: "我的题库", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "删除题库", exact: true }),
  ).not.toBeVisible();
  for (let attempt = 0; attempt < 3; attempt++) {
    await bookMenu.click();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "删除题库", exact: true }),
    ).not.toBeVisible();
  }
  await page.getByRole("button", { name: "导入题目", exact: true }).click();
  let dialog = page.getByRole("dialog");
  const raw =
    "\uFEFF## 原题一？\r\n  第一段原文  \r\n## 原题二？\r\n第二段。\r\n## 原题三？\r\n第三段。\r\n";
  await dialog.getByLabel("读取 Markdown 或文本文件").setInputFiles({
    name: "面试原文.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(raw),
  });
  await dialog.getByRole("button", { name: "整篇保留", exact: true }).click();
  await expect(dialog.getByRole("button", { name: /确认入库/ })).toBeDisabled();
  await expect.poll(async () => (await workspace()).questions.length).toBe(6);
  await dialog.getByRole("button", { name: "自动切分", exact: true }).click();
  await dialog.getByRole("button", { name: "解析并预览", exact: true }).click();
  await expect(dialog.locator(".import-review-card")).toHaveCount(3);
  expect((await workspace()).questions.length).toBe(6);
  await dialog
    .getByRole("button", { name: "合并第 2 题到上一题", exact: true })
    .click();
  await expect(dialog.locator(".import-review-card")).toHaveCount(2);
  await dialog
    .getByLabel("第 1 题标题", { exact: true })
    .fill("用户确认的题目");
  await dialog.getByLabel("选择第 2 题", { exact: true }).uncheck();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "导入题目", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("第 1 题标题", { exact: true })).toHaveValue(
    "用户确认的题目",
  );
  await expect(
    dialog.getByLabel("选择第 2 题", { exact: true }),
  ).not.toBeChecked();
  await page.screenshot({
    path: `test-results/import-review-${info.project.name}.png`,
    animations: "disabled",
  });
  const save = dialog.getByRole("button", {
    name: "确认入库 1 道",
    exact: true,
  });
  const saveBounds = await save.boundingBox();
  expect(saveBounds!.y + saveBounds!.height).toBeLessThanOrEqual(
    page.viewportSize()!.height,
  );
  await save.click();
  await expect(dialog.getByRole("status")).toContainText("已入库 1 道题");
  await dialog.getByRole("button", { name: "去题库看看", exact: true }).click();
  await page.getByLabel("搜索题目", { exact: true }).fill("用户确认");
  await expect(page.locator(".question-row")).toHaveCount(1);
  await page.getByRole("button", { name: /^用户确认的题目/ }).click();
  await page.getByLabel("更多题目操作", { exact: true }).click();
  await page
    .getByRole("heading", { name: "用户确认的题目", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "查看导入原文", exact: true }),
  ).not.toBeVisible();
  await page.getByLabel("更多题目操作", { exact: true }).click();
  await page.getByRole("button", { name: "查看导入原文", exact: true }).click();
  await expect(page.getByLabel("导入原文内容")).toHaveValue(
    raw.replace(/\r\n/g, "\n"),
  );
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByRole("button", { name: "返回题库", exact: true }).click();
  await expect(page.getByLabel("搜索题目", { exact: true })).toHaveValue(
    "用户确认",
  );
  await expect(page.locator(".question-row")).toHaveCount(1);
  await page.getByLabel("管理当前题库", { exact: true }).click();
  await page.getByRole("button", { name: "删除题库", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator(".question-row")).toHaveCount(1);
  await page.getByLabel("管理当前题库", { exact: true }).click();
  await page.getByRole("button", { name: "删除题库", exact: true }).click();
  await page
    .getByRole("button", { name: "删除题库，保留题目", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "未分类", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".question-row")).toHaveCount(7);
  await page.getByRole("button", { name: "全部题库", exact: true }).click();
  await page.getByRole("tab", { name: "回收站", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "回收站是空的", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "全部题目", exact: true }).click();
  await expect(page.locator(".question-row")).toHaveCount(7);
  state = await workspace();
  expect(state.questions.length).toBe(7);
  expect(
    (await (await page.request.get("/api/export")).json()).imports.find(
      (i: { sourceName: string }) => i.sourceName === "面试原文.md",
    ).raw,
  ).toBe(raw);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("delete categories without losing questions; restore questions from the 30-day trash and reclassify them", async ({
  page,
}, info) => {
  const origin = "http://localhost:3107";
  const post = (url: string, data: unknown) =>
    page.request.post(url, { headers: { origin }, data });
  expect(
    (
      await post("/api/auth/sign-up/email", {
        name: "回收站测试",
        email: `trash-${info.project.name}-${Date.now()}@example.test`,
        password: "trash-browser-password",
      })
    ).ok(),
  ).toBe(true);
  const snapshot = async () =>
    (await page.request.get("/api/workspace")).json();
  let state = await snapshot();
  const originalDeck = state.decks[0].id;
  expect(
    (
      await post("/api/import", {
        batchId: crypto.randomUUID(),
        deckId: originalDeck,
        raw: "## 题目应该独立保存吗？\n独立保存答案与学习记录。\n\n## 题库是什么？\n题库只负责整理分类。",
      })
    ).ok(),
  ).toBe(true);
  state = await snapshot();
  const q = state.questions.find(
    (item: { title: string }) => item.title === "题目应该独立保存吗？",
  );
  expect(
    (
      await post("/api/questions", {
        action: "note",
        id: q.id,
        note: "我的私人理解",
        expectedVersion: 0,
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await post("/api/reviews", {
        questionId: q.id,
        questionRevision: 1,
        eventId: crypto.randomUUID(),
        expectedVersion: 0,
        rating: 3,
        answer: "独立于分类的题目",
      })
    ).ok(),
  ).toBe(true);
  const learned = (await snapshot()).questions.find(
    (item: { id: string }) => item.id === q.id,
  );
  await page.goto("/");
  await page
    .locator(
      info.project.name === "mobile" ? ".mobile-bottom-nav" : ".primary-nav",
    )
    .getByRole("button", { name: "我的题库", exact: true })
    .click();
  await page.locator(".library-book-main").click();
  await page.getByLabel(`更多题目操作：${q.title}`, { exact: true }).click();
  await page.getByRole("button", { name: "移动到题库", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("移动到题库", { exact: true }).selectOption("");
  await dialog.getByRole("button", { name: "确认移动", exact: true }).click();
  await expect(page.locator(".question-row")).toHaveCount(1);
  await page.getByLabel("管理当前题库", { exact: true }).click();
  await page.getByRole("button", { name: "删除题库", exact: true }).click();
  await page
    .getByRole("button", { name: "删除题库，保留题目", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "未分类", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".question-row")).toHaveCount(2);
  await page.getByRole("button", { name: new RegExp(`^${q.title}`) }).click();
  await page.getByLabel("更多题目操作", { exact: true }).click();
  await page.getByRole("button", { name: "删除题目", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("保留 30 天");
  await dialog.getByRole("button", { name: "移入回收站", exact: true }).click();
  await expect(page.locator(".question-row")).toHaveCount(1);
  await page.getByRole("button", { name: "全部题库", exact: true }).click();
  await page.getByRole("tab", { name: "回收站", exact: true }).click();
  await expect(page.locator(".trash-row")).toContainText(q.title);
  await expect(page.locator(".trash-row")).toContainText("剩余 30 天");
  expect((await snapshot()).questions.length).toBe(1);
  await page.screenshot({
    path: `test-results/question-trash-${info.project.name}.png`,
    animations: "disabled",
    fullPage: true,
  });
  await page.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "回收站是空的", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "未分类", exact: true }).click();
  await expect(page.locator(".question-row")).toHaveCount(2);
  const restored = (await snapshot()).questions.find(
    (item: { id: string }) => item.id === q.id,
  );
  expect(restored.note).toBe("我的私人理解");
  expect(restored.fsrs).toEqual(learned.fsrs);
  expect(restored.deckId).toBeNull();
  await page.getByRole("button", { name: "导入题目", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("保存到题库")).toHaveValue("");
  await dialog
    .getByLabel("面试资料")
    .fill("## 没有题库也可以导入？\n可以存为未分类题目。");
  await dialog.getByRole("button", { name: "解析并预览", exact: true }).click();
  await dialog
    .getByRole("button", { name: "确认入库 1 道", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("已入库 1 道题");
  await dialog.getByRole("button", { name: "去题库看看", exact: true }).click();
  await expect(page.locator(".question-row")).toHaveCount(3);
  await page.getByRole("button", { name: "全部题库", exact: true }).click();
  await page
    .locator(".library-page .heading-actions")
    .getByRole("button", { name: "新建题库", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("题库名称").fill("重新整理");
  await dialog.getByRole("button", { name: "创建题库", exact: true }).click();
  await page.getByRole("button", { name: "全部题库", exact: true }).click();
  await page.getByRole("tab", { name: "未分类", exact: true }).click();
  await page.getByLabel(`更多题目操作：${q.title}`, { exact: true }).click();
  await page.getByRole("button", { name: "移动到题库", exact: true }).click();
  dialog = page.getByRole("dialog");
  const target = (await snapshot()).decks.find(
    (item: { title: string }) => item.title === "重新整理",
  );
  await dialog
    .getByLabel("移动到题库", { exact: true })
    .selectOption(target.id);
  await dialog.getByRole("button", { name: "确认移动", exact: true }).click();
  await expect(page.locator(".question-row")).toHaveCount(2);
  await page.getByRole("tab", { name: "题库", exact: true }).click();
  await expect(page.locator(".library-book-main")).toContainText("重新整理");
  await expect(page.locator(".library-book-main")).toContainText("1 道题");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("choose AI parsing explicitly, recover from failure and reparse changed sources before saving", async ({
  page,
}, info) => {
  const origin = "http://localhost:3107";
  expect(
    (
      await page.request.post("/api/auth/sign-up/email", {
        headers: { origin },
        data: {
          name: "解析测试",
          email: `parsing-${info.project.name}-${Date.now()}@example.test`,
          password: "parsing-test-password",
        },
      })
    ).ok(),
  ).toBe(true);
  const state = await (await page.request.get("/api/workspace")).json();
  expect(
    (
      await page.request.post("/api/settings", {
        headers: { origin },
        data: {
          action: "saveConnection",
          baseUrl: "https://parse.example/v1",
          model: "fake-parse-model",
          key: "fake-parse-key",
        },
      })
    ).ok(),
  ).toBe(true);
  let paidCalls = 0;
  await page.route("**/api/import/preview", async (route) => {
    const body = route.request().postDataJSON();
    if (body.method !== "ai") return route.continue();
    paidCalls++;
    expect(body.inputType).toBe("questions");
    expect(route.request().headers()["x-workspace-user"]).toBe(state.user.id);
    return route.fulfill({
      status: 502,
      json: { error: "模型没有返回有效切分位置，请切换自动切分。" },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "导入面试题", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "只有题目", exact: true }).click();
  await dialog.getByLabel("面试资料").fill("问题一？\n问题二？");
  await dialog.getByRole("button", { name: "AI 解析", exact: true }).click();
  expect(paidCalls).toBe(0);
  await dialog.getByRole("button", { name: "解析并预览", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "模型没有返回有效切分位置",
  );
  expect(paidCalls).toBe(1);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "导入面试题", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "AI 解析", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(paidCalls).toBe(1);
  await dialog.getByRole("button", { name: "自动切分", exact: true }).click();
  await dialog.getByRole("button", { name: "解析并预览", exact: true }).click();
  await expect(dialog.locator(".import-review-card")).toHaveCount(2);
  await dialog.getByLabel("面试资料").fill("问题一？\n问题二？\n问题三？");
  await expect(
    dialog.getByRole("button", { name: "确认入库 2 道", exact: true }),
  ).toBeDisabled();
  expect(
    (await (await page.request.get("/api/workspace")).json()).questions.length,
  ).toBe(0);
  await dialog.getByRole("button", { name: "重新解析", exact: true }).click();
  await expect(dialog.locator(".import-review-card")).toHaveCount(3);
  await dialog
    .getByRole("button", { name: "确认入库 3 道", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("已入库 3 道题");
  expect(paidCalls).toBe(1);
});
