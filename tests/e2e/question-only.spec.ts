import { test, expect } from "./fixtures";
import type { Page, TestInfo } from "@playwright/test";

const origin = "http://localhost:3107";
async function register(page: Page, info: TestInfo) {
  const response = await page.request.post("/api/auth/sign-up/email", {
    headers: { origin },
    data: {
      name: "补答案测试",
      email: `answers-${info.project.name}-${Date.now()}@example.test`,
      password: "answer-test-password",
    },
  });
  expect(response.ok()).toBe(true);
}
async function configure(page: Page) {
  expect(
    (
      await page.request.post("/api/settings", {
        headers: { origin },
        data: {
          action: "saveConnection",
          baseUrl: "https://answers.example/v1",
          model: "test-answer-model",
          key: "fake-browser-answer-key",
        },
      })
    ).ok(),
  ).toBe(true);
}
async function workspace(page: Page) {
  return (await page.request.get("/api/workspace")).json();
}

test("import question lists, generate editable drafts and explicitly save references", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await register(page, info);
  await page.goto("/");
  await page.getByRole("button", { name: "导入面试题", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "只有题目", exact: true }).click();
  const raw = "什么是闭包？\n1. 为什么需要索引？\n- CAS 是什么？";
  await dialog.getByLabel("面试资料").fill(raw);
  await dialog.getByRole("button", { name: "解析并预览", exact: true }).click();
  await expect(dialog.locator(".import-review-card")).toHaveCount(3);
  await expect(dialog.getByLabel("第 2 题标题", { exact: true })).toHaveValue(
    "为什么需要索引？",
  );
  await page.screenshot({
    path: `test-results/question-only-import-${info.project.name}.png`,
    animations: "disabled",
  });
  await dialog
    .getByRole("button", { name: "确认入库 3 道", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("已入库 3 道题");
  await dialog.getByRole("button", { name: "去补答案", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "待整理", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".question-row")).toHaveCount(3);
  let state = await workspace(page);
  expect(
    state.questions.every(
      (q: { answer: string; needsEditing: boolean }) =>
        q.answer === "" && q.needsEditing,
    ),
  ).toBe(true);
  expect(state.stats.new).toBe(0);
  const nav = page.locator(
    info.project.name === "mobile" ? ".mobile-bottom-nav" : ".primary-nav",
  );
  await nav.getByRole("button", { name: "今日", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "先补上参考答案", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".deck-card")).toContainText("3 道待补答案");
  await page.getByRole("button", { name: "去补答案", exact: true }).click();

  await page
    .getByRole("button", { name: "AI 写答案：什么是闭包？", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "让拾忆更适合你" }),
  ).toBeVisible();
  await dialog.getByLabel("服务预设").selectOption("custom");
  await dialog
    .getByLabel("Base URL", { exact: true })
    .fill("https://answers.example/v1");
  await dialog.getByLabel("模型", { exact: true }).fill("test-answer-model");
  await dialog
    .getByLabel("API Key", { exact: true })
    .fill("fake-browser-answer-key");
  await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect(dialog.getByText(/已保存 ·/)).toBeVisible();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();

  let generated = 0;
  const requests: { questionId: string; instructions: string }[] = [];
  await page.route("**/api/questions/answer", async (route) => {
    const body = route.request().postDataJSON();
    expect(route.request().headers()["x-workspace-user"]).toBe(state.user.id);
    expect(body.expectedRevision).toBe(1);
    requests.push(body);
    generated++;
    await route.fulfill({
      json: {
        answer: body.instructions
          ? "## 核心回答\n使用 Java 示例说明索引的作用。"
          : "## 核心回答\n函数与词法环境的组合。\n\n```js\nconst value = 1;\n```",
        questionRevision: 1,
      },
    });
  });
  await page
    .getByRole("button", { name: "AI 写答案：什么是闭包？", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "AI 参考答案", exact: true }),
  ).toBeVisible();
  await expect(dialog.locator(".answer-composer-body")).toContainText(
    "函数与词法环境的组合",
  );
  expect(
    (await workspace(page)).questions.find(
      (q: { title: string }) => q.title === "什么是闭包？",
    ).answer,
  ).toBe("");
  await dialog.getByRole("button", { name: "编辑", exact: true }).click();
  const edited =
    "## 我的参考答案\n闭包由函数及其词法环境组成。\n\n这是我修改后的解释。";
  await dialog.getByLabel("参考答案草稿", { exact: true }).fill(edited);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page
    .getByRole("button", { name: "AI 写答案：什么是闭包？", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await expect(dialog.locator(".answer-composer-body")).toContainText(
    "这是我修改后的解释。",
  );
  expect(generated).toBe(1);
  await page.screenshot({
    path: `test-results/ai-answer-draft-${info.project.name}.png`,
    animations: "disabled",
  });
  await dialog
    .getByRole("button", { name: "保存为参考答案", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".question-row")).toHaveCount(2);
  state = await workspace(page);
  const saved = state.questions.find(
    (q: { title: string }) => q.title === "什么是闭包？",
  );
  expect(saved.answer).toBe(edited);
  expect(saved.needsEditing).toBe(false);
  expect(saved.revision).toBe(2);
  expect(saved.fsrs).toBeNull();
  expect(state.stats.new).toBe(1);

  await page.getByRole("button", { name: /^为什么需要索引？/ }).click();
  await expect(
    page.getByRole("heading", { name: "先把答案补上" }),
  ).toBeVisible();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await page.screenshot({
    path: `test-results/missing-answer-${info.project.name}.png`,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "AI 写答案", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.locator(".answer-composer-body")).toContainText(
    "函数与词法环境的组合",
  );
  await dialog.getByText("补充要求", { exact: true }).click();
  await dialog.getByLabel("答案补充要求").fill("使用 Java 举例");
  await dialog.getByRole("button", { name: "重新生成", exact: true }).click();
  await expect(dialog.locator(".answer-composer-body")).toContainText(
    "使用 Java 示例",
  );
  expect(requests.at(-1)?.instructions).toBe("使用 Java 举例");
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await dialog
    .getByRole("button", { name: "保存为参考答案", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".answer-content")).toContainText("使用 Java 示例");
  await expect(
    page.getByRole("button", { name: "开始答题", exact: true }),
  ).toBeVisible();
  expect(
    (await workspace(page)).questions.find(
      (q: { title: string }) => q.title === "CAS 是什么？",
    ).answer,
  ).toBe("");
  const exported = await (await page.request.get("/api/export")).json();
  expect(exported.imports[0].raw).toBe(raw);
  expect(exported.imports[0].inputType).toBe("questions");
  expect(errors).toEqual([]);
});

test("retry or cancel generation; stale drafts never overwrite an answer saved elsewhere", async ({
  page,
}, info) => {
  await register(page, info);
  let state = await workspace(page);
  await configure(page);
  expect(
    (
      await page.request.post("/api/import", {
        headers: { origin },
        data: {
          deckId: state.decks[0].id,
          batchId: crypto.randomUUID(),
          raw:
            "如何验证并发保存？" +
            "在多标签页中并行修改答案时怎样保证内容不被旧版本覆盖？".repeat(6),
          inputType: "questions",
        },
      })
    ).ok(),
  ).toBe(true);
  state = await workspace(page);
  const q = state.questions[0];
  await page.goto("/");
  await page.getByRole("button", { name: "查看全部", exact: true }).click();
  await page.getByRole("tab", { name: "全部题目", exact: true }).click();
  await page.getByRole("button", { name: /^如何验证并发保存？/ }).click();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/questions/answer", async (route) => {
    calls++;
    if (calls === 1)
      return route.fulfill({
        status: 502,
        json: { error: "模型暂时不可用，请重试。" },
      });
    if (calls === 2) {
      await gate;
      await route
        .fulfill({
          json: { answer: "已经停止的旧请求。", questionRevision: 1 },
        })
        .catch(() => {});
      return;
    }
    await route.fulfill({
      json: {
        answer: "## 有效草稿\n使用版本号检查并发修改。",
        questionRevision: 1,
      },
    });
  });
  try {
    await page.getByRole("button", { name: "AI 写答案", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("alert")).toContainText("模型暂时不可用");
    await expect(
      dialog.getByRole("button", { name: "保存为参考答案", exact: true }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "生成答案", exact: true }).click();
    await expect.poll(() => calls).toBe(2);
    await dialog.getByRole("button", { name: "停止生成", exact: true }).click();
    await dialog.getByRole("button", { name: "生成答案", exact: true }).click();
    await expect(dialog.locator(".answer-composer-body")).toContainText(
      "有效草稿",
    );
    release();
    await page.unrouteAll({ behavior: "wait" });
    await expect(dialog.locator(".answer-composer-body")).not.toContainText(
      "已经停止的旧请求",
    );
    await dialog.getByText("补充要求", { exact: true }).click();
    const saveBounds = await dialog
      .getByRole("button", { name: "保存为参考答案", exact: true })
      .boundingBox();
    expect(saveBounds!.y + saveBounds!.height).toBeLessThanOrEqual(
      page.viewportSize()!.height,
    );
    expect(
      (
        await page.request.post("/api/questions", {
          headers: { origin },
          data: {
            action: "edit",
            id: q.id,
            expectedRevision: 1,
            title: q.title,
            answer: "其他页面保存的参考答案。",
            tags: [],
            major: false,
          },
        })
      ).ok(),
    ).toBe(true);
    await dialog
      .getByRole("button", { name: "保存为参考答案", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText("答案草稿已保留");
    expect((await workspace(page)).questions[0].answer).toBe(
      "其他页面保存的参考答案。",
    );
    await dialog.getByRole("button", { name: "编辑", exact: true }).click();
    await expect(
      dialog.getByLabel("参考答案草稿", { exact: true }),
    ).toHaveValue("## 有效草稿\n使用版本号检查并发修改。");
    expect(
      await page.evaluate(
        ([id, questionId]) =>
          localStorage.getItem(
            `shiyi:practice:${id}:${questionId}:v1:ai-reference`,
          ),
        [state.user.id, q.id],
      ),
    ).toContain("有效草稿");
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
