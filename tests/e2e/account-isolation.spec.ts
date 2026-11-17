import { test, expect } from "./fixtures";

test("switch accounts with a delayed workspace response; reset reviews, dialogs and private drafts", async ({
  page,
  playwright,
  extraHTTPHeaders,
}, testInfo) => {
  const baseURL = "http://localhost:3107";
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const password = "isolation-browser-password";
  const other = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { ...extraHTTPHeaders, origin: baseURL },
  });
  const bobEmail = `bob-${suffix}@example.test`;
  expect(
    (
      await other.post("/api/auth/sign-up/email", {
        data: { name: "Bob", email: bobEmail, password },
      })
    ).ok(),
  ).toBe(true);
  await other.dispose();
  const headers = { origin: baseURL };
  expect(
    (
      await page.request.post("/api/auth/sign-up/email", {
        headers,
        data: {
          name: "Alice",
          email: `alice-${suffix}@example.test`,
          password,
        },
      })
    ).ok(),
  ).toBe(true);
  const initial = await (await page.request.get("/api/workspace")).json();
  const deckId = initial.decks[0].id;
  expect(
    (
      await page.request.post("/api/import", {
        headers,
        data: {
          batchId: crypto.randomUUID(),
          deckId,
          raw: "## Alice private card\nALICE_BROWSER_PRIVATE_REFERENCE",
        },
      })
    ).ok(),
  ).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "开始答题", exact: true }).click();
  await page.getByLabel("本题作答").fill("ALICE_PRIVATE_ANSWER_DRAFT");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("API Key", { exact: true })
    .fill("ALICE_UNSAVED_KEY_DRAFT");
  await page.keyboard.press("Escape");

  let release!: () => void;
  let received = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delayed = false;
  await page.route("**/api/workspace", async (route) => {
    if (delayed || route.request().method() !== "GET") return route.continue();
    delayed = true;
    const response = await route.fetch();
    received = true;
    await gate;
    await route.fulfill({ response }).catch(() => {}); // account change cancels the old fetch
  });
  try {
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => received).toBe(true);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await page.getByLabel("邮箱", { exact: true }).fill(bobEmail);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录拾忆", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: /今天，\s*记住一点。/ }),
    ).toBeVisible();
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
  await expect(page.locator("body")).not.toContainText("Alice private card");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByLabel("API Key", { exact: true }),
  ).toHaveValue("");
  await page.keyboard.press("Escape");
  const nav = page.locator(
    testInfo.project.name === "mobile" ? ".mobile-bottom-nav" : ".primary-nav",
  );
  await nav.getByRole("button", { name: "开始复习", exact: true }).click();
  await expect(page.getByLabel("本题作答")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("ALICE_");
  const exported = await page.request.get("/api/export");
  expect(await exported.text()).not.toContain("ALICE_");
  const stale = await page.request.post("/api/settings", {
    headers: { ...headers, "X-Workspace-User": initial.user.id },
    data: { action: "deleteKey" },
  });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).code).toBe("ACCOUNT_CHANGED");
});
