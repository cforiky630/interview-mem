import { test, expect } from "@playwright/test";

test("configure OpenAI-compatible presets, test drafts and preserve keys only for the same endpoint", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "创建一个", exact: true }).click();
  await page.getByLabel("怎么称呼你").fill("连接测试");
  await page
    .getByLabel("邮箱", { exact: true })
    .fill(`ai-${testInfo.project.name}-${Date.now()}@example.test`);
  await page.getByLabel("密码", { exact: true }).fill("test-password-12345");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /今天，\s*记住一点。/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("OpenAI 兼容", { exact: true })).toBeVisible();
  await dialog.getByLabel("服务预设").selectOption("openai");
  await expect(dialog.getByLabel("Base URL", { exact: true })).toHaveValue(
    "https://api.openai.com/v1",
  );
  await expect(dialog.getByLabel("模型", { exact: true })).toHaveValue(
    "gpt-4.1-mini",
  );
  await dialog.getByLabel("服务预设").selectOption("deepseek");
  await expect(dialog.getByLabel("Base URL", { exact: true })).toHaveValue(
    "https://api.deepseek.com",
  );
  await expect(dialog.getByLabel("模型", { exact: true })).toHaveValue(
    "deepseek-flash",
  );
  await dialog.getByLabel("服务预设").selectOption("custom");
  await dialog
    .getByLabel("Base URL", { exact: true })
    .fill("https://gateway.example.com/api/v1/");
  await dialog.getByLabel("模型", { exact: true }).fill("vendor/custom-model");
  const fakeKey = "fake-browser-key-no-real-provider-call";
  await dialog.getByLabel("API Key", { exact: true }).fill(fakeKey);
  let tested = 0;
  await page.route("**/api/settings", async (route) => {
    const body = route.request().postDataJSON();
    if (body.action !== "testConnection") return route.continue();
    expect(body.baseUrl).toEqual("https://gateway.example.com/api/v1/");
    expect(body.model).toEqual("vendor/custom-model");
    expect(body.key).toEqual(fakeKey);
    tested++;
    await route.fulfill({ json: { ok: true } });
  });
  await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "连接正常", exact: true }),
  ).toBeVisible();
  expect(tested).toEqual(1);
  let state = await (await page.request.get("/api/workspace")).json();
  expect(state.settings.hasKey).toBe(false);
  await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect(dialog.getByLabel("API Key", { exact: true })).toHaveValue("");
  await expect(dialog.getByLabel("Base URL", { exact: true })).toHaveValue(
    "https://gateway.example.com/api/v1",
  );
  state = await (await page.request.get("/api/workspace")).json();
  expect(state.settings.provider).toEqual("openai-compatible");
  expect(state.settings.baseUrl).toEqual("https://gateway.example.com/api/v1");
  expect(JSON.stringify(state)).not.toContain(fakeKey);
  await dialog.getByLabel("模型", { exact: true }).fill("another-model");
  await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "保存连接", exact: true }),
  ).toBeDisabled();
  state = await (await page.request.get("/api/workspace")).json();
  expect(state.settings.model).toEqual("another-model");
  await page.screenshot({
    path: `test-results/ai-settings-${testInfo.project.name}.png`,
    fullPage: true,
    animations: "disabled",
  });
  await dialog
    .getByLabel("Base URL", { exact: true })
    .fill("https://other.example.com/v1");
  await expect(
    dialog.getByRole("button", { name: "保存连接", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "测试连接", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(dialog.getByLabel("Base URL", { exact: true })).toHaveValue(
    "https://gateway.example.com/api/v1",
  );
  await expect(dialog.getByLabel("模型", { exact: true })).toHaveValue(
    "another-model",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  expect(errors).toEqual([]);
});
