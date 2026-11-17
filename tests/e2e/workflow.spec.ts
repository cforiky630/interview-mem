import { test, expect } from "@playwright/test";

test("register, import automatically, select text, write a note and review", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "创建一个", exact: true }).click();
  await page.getByLabel("怎么称呼你").fill("学习者");
  await page
    .getByLabel("邮箱", { exact: true })
    .fill(`qa-${testInfo.project.name}-${Date.now()}@example.test`);
  await page.getByLabel("密码", { exact: true }).fill("test-password-12345");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /今天，\s*记住一点。/ }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "载入示例题库", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "JavaScript 核心 · 示例", exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `test-results/dashboard-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "导入面试题", exact: true }).click();
  const textarea = page.getByLabel("面试资料");
  await textarea.evaluate((element) => {
    const clipboard = new DataTransfer();
    clipboard.setData(
      "text/plain",
      "## 为什么需要稳定的标识？\n稳定标识用于把个人复习记录和持续更新的题目关联起来。\n\n版本改变，关联保持不变。\n\n|字段|用途|\n|---|---|\n|ID|关联历史|\n\n> [!question] 面试追问\n> **Q：内容更新后怎么关联？**\n> **A：** 用相同 ID 关联新的版本。\n>\n> **Q：个人笔记放在哪里？**\n> **A：** 单独按用户保存。\n\n## 如何保持独立笔记？\n将个人笔记与发布内容分开保存。",
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }),
    );
  });
  await expect(
    page.getByRole("status").filter({ hasText: "已入库 2 道题" }),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "去题库看看", exact: true }).click();
  await page.getByRole("button", { name: /^为什么需要稳定的标识？/ }).click();
  await expect(
    page.getByRole("heading", { name: "为什么需要稳定的标识？", exact: true }),
  ).toBeVisible();
  if (
    await page
      .getByRole("button", { name: "关闭 AI 助教", exact: true })
      .isVisible()
  )
    await page
      .getByRole("button", { name: "关闭 AI 助教", exact: true })
      .click();
  await page
    .locator(".answer-content p")
    .first()
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
  await expect(page.locator(".selection-bubble")).toBeVisible();
  await page
    .locator(".selection-bubble")
    .getByRole("button", { name: "追问", exact: true })
    .click();
  await expect(page.locator(".ai-quote")).toContainText("稳定标识");
  await expect(
    page.getByRole("button", { name: "去配置连接", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭 AI 助教", exact: true }).click();
  await expect(page.locator(".answer-content")).not.toContainText(
    "内容更新后怎么关联",
  );
  await page.getByRole("button", { name: "默写第 1 段", exact: true }).click();
  await expect(
    page.locator(".practice-block.is-writing .prose-content"),
  ).toHaveCount(0);
  await expect(page.locator(".answer-content")).toContainText(
    "版本改变，关联保持不变。",
  );
  await page
    .getByLabel("第 1 段默写", { exact: true })
    .fill("稳定 ID 关联我的学习历史。");
  await page.getByRole("button", { name: "对照原文", exact: true }).click();
  await expect(page.locator(".paragraph-reference")).toContainText(
    "稳定标识用于",
  );
  await page
    .getByRole("button", { name: "结束第 1 段默写", exact: true })
    .click();
  await page.getByRole("button", { name: "默写第 1 段", exact: true }).click();
  await expect(page.getByLabel("第 1 段默写", { exact: true })).toHaveValue(
    "稳定 ID 关联我的学习历史。",
  );
  await page
    .getByRole("button", { name: "结束第 1 段默写", exact: true })
    .click();
  await page.getByRole("tab", { name: /^追问/ }).click();
  await expect(page.locator(".followup-question")).toContainText(
    "内容更新后怎么关联？",
  );
  await expect(page.locator(".followup-answer")).toHaveCount(0);
  await page.getByLabel("追问作答").fill("保持稳定的题目 ID。");
  await page.getByRole("button", { name: "查看答案", exact: true }).click();
  await expect(page.locator(".followup-answer")).toContainText("用相同 ID");
  await page.getByRole("button", { name: "下一道追问", exact: true }).click();
  await expect(page.locator(".followup-question")).toContainText(
    "个人笔记放在哪里？",
  );
  await expect(page.locator(".followup-answer")).toHaveCount(0);
  await page.getByRole("button", { name: "上一道追问", exact: true }).click();
  await expect(page.getByLabel("追问作答")).toHaveValue("保持稳定的题目 ID。");
  await page.screenshot({
    path: `test-results/followups-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("tab", { name: "笔记", exact: true }).click();
  await page.getByLabel("个人笔记").fill("这是我的补充，更新题库时应保留。");
  await page.getByRole("button", { name: "保存笔记", exact: true }).click();
  await expect(page.locator(".notes-footer")).toContainText("已保存");
  const state = await (await page.request.get("/api/workspace")).json();
  const current = state.questions.find(
    (q: { title: string }) => q.title === "为什么需要稳定的标识？",
  );
  await page.getByLabel("个人笔记").fill("本地未保存的理解。");
  const remoteNote = await page.request.post("/api/questions", {
    headers: { origin: "http://localhost:3107" },
    data: {
      action: "note",
      id: current.id,
      expectedVersion: current.noteVersion,
      note: "另一台设备的补充。",
    },
  });
  expect(remoteNote.ok()).toBeTruthy();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".note-conflict")).toContainText(
    "云端笔记已有更新",
  );
  await expect(page.getByLabel("个人笔记")).toHaveValue("本地未保存的理解。");
  await page
    .getByText("查看云端版本，再合并到下方草稿", { exact: true })
    .click();
  await expect(page.locator(".note-conflict")).toContainText(
    "另一台设备的补充。",
  );
  await page
    .getByLabel("个人笔记")
    .fill("本地未保存的理解。\n另一台设备的补充。");
  await page
    .getByRole("button", { name: "已合并，保存到最新版本", exact: true })
    .click();
  await expect(page.locator(".note-conflict")).toHaveCount(0);
  await page.getByLabel("更多题目操作").click();
  await page.getByRole("button", { name: "编辑题目", exact: true }).click();
  const editor = page.getByLabel("答案编辑器");
  await expect(editor.locator("table")).toContainText("关联历史");
  await editor.click();
  await editor.press("ControlOrMeta+End");
  await editor.press("ArrowDown");
  await editor.press("Enter");
  await page.keyboard.insertText("补充：标识始终保持稳定。");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("tab", { name: "正文", exact: true }).click();
  await expect(page.locator(".answer-content")).toContainText(
    "补充：标识始终保持稳定。",
  );
  await expect(page.locator(".answer-content table")).toContainText("关联历史");
  await page.getByRole("button", { name: "开始答题", exact: true }).click();
  await expect(page.locator(".answer-content")).toHaveCount(0);
  const writtenAnswer = "稳定标识连接个人复习与持续更新的题目。";
  await page.getByLabel("本题作答", { exact: true }).fill(writtenAnswer);
  await page.getByRole("button", { name: "结束答题", exact: true }).click();
  const nav =
    testInfo.project.name === "mobile"
      ? page.locator(".mobile-bottom-nav")
      : page.locator(".sidebar");
  await nav.getByRole("button", { name: "我的题库", exact: true }).click();
  await page.getByRole("button", { name: /^为什么需要稳定的标识？/ }).click();
  await page.getByRole("button", { name: "开始答题", exact: true }).click();
  await expect(page.getByLabel("本题作答", { exact: true })).toHaveValue(
    writtenAnswer,
  );
  await expect(page.locator(".answer-content")).toHaveCount(0);
  await page.getByRole("button", { name: "对照答案", exact: true }).click();
  await expect(page.getByLabel("本题作答")).toHaveAttribute("readonly", "");
  await page.screenshot({
    path: `test-results/answer-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: /记得/ }).click();
  await expect(
    page.getByRole("heading", { name: "本轮完成", exact: true }),
  ).toBeVisible();
  const graded = await (await page.request.get("/api/workspace")).json();
  expect(graded.recentReviews[0].answer).toEqual(writtenAnswer);
  await page.getByRole("button", { name: "回到今日", exact: true }).click();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `test-results/completed-${testInfo.project.name}.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  expect(errors).toEqual([]);
});
