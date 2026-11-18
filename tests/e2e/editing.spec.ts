import { test, expect } from "./fixtures";
import type { Page, TestInfo } from "@playwright/test";

const origin = "http://localhost:3107";
async function snapshot(page: Page) {
  return (await page.request.get("/api/workspace")).json();
}
async function setup(
  page: Page,
  info: TestInfo,
  title: string,
  answer: string,
) {
  expect(
    (
      await page.request.post("/api/auth/sign-up/email", {
        headers: { origin },
        data: {
          name: "整篇编辑",
          email: `editing-${info.project.name}-${Date.now()}@example.test`,
          password: "editor-browser-password",
        },
      })
    ).ok(),
  ).toBe(true);
  const state = await snapshot(page);
  expect(
    (
      await page.request.post("/api/import", {
        headers: { origin },
        data: {
          batchId: crypto.randomUUID(),
          deckId: state.decks[0].id,
          raw: `## ${title}\n${answer}`,
        },
      })
    ).ok(),
  ).toBe(true);
  const q = (await snapshot(page)).questions[0];
  await page.goto("/");
  await page.getByRole("button", { name: "查看全部", exact: true }).click();
  await page.getByRole("tab", { name: "全部题目", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`^${title}`) }).click();
  return q;
}
async function edit(page: Page) {
  await page.getByLabel("更多题目操作", { exact: true }).click();
  await page.getByRole("button", { name: "编辑题目", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "编辑题目", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
async function sourceMode(page: Page) {
  await page.getByRole("button", { name: "原文", exact: true }).click();
  return page.getByLabel("题目原文", { exact: true });
}
async function paste(page: Page, value: string) {
  const field = await sourceMode(page);
  await field.focus();
  await field.evaluate((element, text) => {
    const input = element as HTMLTextAreaElement;
    input.setSelectionRange(0, input.value.length);
    const data = new DataTransfer();
    data.setData("text/plain", text);
    input.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  }, value);
  await expect(field).toHaveValue(value.replace(/\r\n/g, "\n"));
}
async function selectSource(page: Page, value: string) {
  await page
    .getByLabel("题目原文", { exact: true })
    .evaluate((element, part) => {
      const input = element as HTMLTextAreaElement;
      const from = input.value.indexOf(part);
      if (from < 0) throw new Error("Selection missing from source");
      input.focus();
      input.setSelectionRange(from, from + part.length);
    }, value);
}
async function preview(page: Page) {
  const toggle = page.getByRole("button", { name: "查看预览", exact: true });
  if (await toggle.isVisible()) await toggle.click();
}

test("full-page unified editing recognizes whole documents, supports manual followups and preserves conflict drafts", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const q = await setup(page, info, "单篇编辑怎么组织？", "最初的答案。");
  await edit(page);
  const bounds = await page.locator(".question-editor-page").boundingBox();
  expect(bounds!.width).toBeGreaterThan(
    info.project.name === "mobile" ? 350 : 1000,
  );
  await sourceMode(page);
  await selectSource(page, "最初的答案。");
  await page.getByRole("button", { name: "插入追问", exact: true }).click();
  await expect(page.getByLabel("题目原文", { exact: true })).toHaveValue(
    "最初的答案。\n\n## 追问\nQ：\nA：",
  );
  const raw =
    "# 单篇编辑怎么组织？\r\n\r\n核心回答在这里，保留完整正文。\r\n\r\n手动补充的问题？\r\n**手动答案保留格式。**\r\n\r\n## 面试追问\r\nQ：自动识别的追问？\r\nA：属于这道主问题。\r\n";
  await paste(page, raw);
  await expect(page.locator(".editor-detected-count")).toContainText("追问 1");
  const selection = "手动补充的问题？\n**手动答案保留格式。**";
  await selectSource(page, selection);
  await page.getByRole("button", { name: "指定追问", exact: true }).click();
  await expect(page.locator(".editor-detected-count")).toContainText("追问 2");
  await page.getByRole("button", { name: "撤销指定", exact: true }).click();
  await expect(page.locator(".editor-detected-count")).toContainText("追问 1");
  await selectSource(page, selection);
  await page.getByRole("button", { name: "指定追问", exact: true }).click();
  await expect(page.locator(".editor-detected-count")).toContainText("追问 2");
  if (info.project.name === "mobile")
    await page.screenshot({
      path: "test-results/question-editor-writing-mobile.png",
      animations: "disabled",
      fullPage: true,
    });
  await preview(page);
  const pane = page.getByRole("complementary", {
    name: "学习预览",
    exact: true,
  });
  await pane.getByRole("tab", { name: "追问 2", exact: true }).click();
  await expect(pane).toContainText("手动补充的问题？");
  await expect(pane).toContainText("自动识别的追问？");
  await expect(pane.locator("textarea,[contenteditable=true]")).toHaveCount(0);
  await page.screenshot({
    path: `test-results/question-editor-${info.project.name}.png`,
    animations: "disabled",
    fullPage: true,
  });
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "编辑题目", exact: true }),
  ).not.toBeVisible();
  await expect(page.locator(".answer-content")).toContainText("核心回答在这里");
  await expect(page.locator(".answer-content")).not.toContainText(
    "手动补充的问题",
  );
  await page.getByRole("tab", { name: /^追问/ }).click();
  await expect(page.locator(".followup-question")).toContainText(
    "手动补充的问题",
  );
  await page.getByRole("button", { name: "下一道追问", exact: true }).click();
  await expect(page.locator(".followup-question")).toContainText(
    "自动识别的追问",
  );
  await edit(page);
  let field = await sourceMode(page);
  const saved = (await snapshot(page)).questions.find(
    (item: { id: string }) => item.id === q.id,
  );
  const local = saved.answer + "\n\n## 本地补充\n本地尚未保存的内容。";
  await field.fill(local);
  await page.getByRole("button", { name: "返回学习", exact: true }).click();
  expect(
    (await snapshot(page)).questions.find(
      (item: { id: string }) => item.id === q.id,
    ).answer,
  ).toBe(saved.answer);
  await edit(page);
  field = await sourceMode(page);
  await expect(page.locator(".editor-notice")).toContainText(
    "已恢复上次未保存的草稿",
  );
  await expect(field).toHaveValue(local.replace(/\r\n/g, "\n"));
  expect(
    (
      await page.request.post("/api/questions", {
        headers: { origin },
        data: {
          action: "edit",
          id: q.id,
          expectedRevision: saved.revision,
          title: saved.title,
          answer: saved.answer + "\n\n## 远端补充\n另一页面保存的内容。",
          tags: saved.tags,
        },
      })
    ).ok(),
  ).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".editor-conflict")).toContainText(
    "题目已在其他页面更新",
  );
  await expect(
    page.getByRole("button", { name: "保存修改", exact: true }),
  ).toBeDisabled();
  await expect(field).toHaveValue(local.replace(/\r\n/g, "\n"));
  await field.fill(local + "\n\n## 远端补充\n另一页面保存的内容。");
  await page
    .getByRole("button", { name: "已合并，保存到新版本", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "编辑题目", exact: true }),
  ).not.toBeVisible();
  const merged = (await snapshot(page)).questions.find(
    (item: { id: string }) => item.id === q.id,
  );
  expect(merged.revision).toBe(saved.revision + 2);
  expect(merged.answer).toContain("本地尚未保存");
  expect(merged.answer).toContain("另一页面保存");
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("rich document selection can become a followup without a separate answer editor", async ({
  page,
}, info) => {
  await setup(
    page,
    info,
    "富文本追问怎么指定？",
    "核心答案。\n\n手选问题？\n\n**手选答案保留加粗。**",
  );
  await edit(page);
  const editor = page.getByLabel("答案编辑器", { exact: true });
  await expect(editor).toBeVisible();
  await editor.evaluate((element) => {
    const paragraphs = Array.from(element.querySelectorAll("p"));
    const first = paragraphs.find((p) => p.textContent?.includes("手选问题"))!,
      last = paragraphs.find((p) => p.textContent?.includes("手选答案"))!;
    (element as HTMLElement).focus();
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.childNodes.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.getByRole("button", { name: "指定追问", exact: true }).click();
  await expect(page.locator(".editor-detected-count")).toContainText("追问 1");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "编辑题目", exact: true }),
  ).not.toBeVisible();
  await page.getByRole("tab", { name: /^追问/ }).click();
  await expect(page.locator(".followup-question")).toContainText("手选问题");
  await page.getByRole("button", { name: "查看答案", exact: true }).click();
  await expect(page.locator(".followup-answer strong")).toContainText(
    "手选答案保留加粗",
  );
  await edit(page);
  await page.getByRole("button", { name: "文档", exact: true }).click();
  await expect(editor).toBeVisible();
  await editor.click();
  await editor.press("ControlOrMeta+a");
  const whole =
    "# 富文本追问怎么指定？\n新的核心回答。\n\n## 追问\n问：整篇粘贴后呢？\n答：仍在同一份内容里。";
  await editor.evaluate((element, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  }, whole);
  await expect(page.getByLabel("题目原文", { exact: true })).toHaveValue(whole);
  await expect(page.locator(".editor-detected-count")).toContainText("追问 1");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "编辑题目", exact: true }),
  ).not.toBeVisible();
  await expect(page.locator(".answer-content")).toContainText("新的核心回答");
  await page.getByRole("tab", { name: /^追问/ }).click();
  await expect(page.locator(".followup-question")).toContainText(
    "整篇粘贴后呢",
  );
});

test("whole pasted batches preview main questions and explicitly choose replacement or all-new import", async ({
  page,
}, info) => {
  const q = await setup(page, info, "第一道主问题？", "最初的答案。");
  expect(
    (
      await page.request.post("/api/questions", {
        headers: { origin },
        data: {
          action: "note",
          id: q.id,
          expectedVersion: 0,
          note: "保留当前题的笔记",
        },
      })
    ).ok(),
  ).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await edit(page);
  await page.getByText("标签与复习提醒", { exact: true }).click();
  await page.getByLabel("标签", { exact: true }).fill("保留标签");
  const raw =
    "## 第一道主问题？\r\n更新后的第一题答案。\r\n\r\n### 面试追问\r\nQ：这条属于第一题吗？\r\nA：是，不要切成新主问题。\r\n\r\n## 第二道主问题？\r\n第二题的独立答案。\r\n\r\n## 第三道主问题？\r\n第三题的独立答案。\r\n";
  await paste(page, raw);
  await expect(page.locator(".editor-paste-review")).toContainText(
    "识别到 3 道主问题",
  );
  await expect(
    page.getByRole("button", { name: "保存修改", exact: true }),
  ).toBeDisabled();
  // 离开再恢复仍需确认；明确选择整篇保留后，重开草稿也保留该选择。
  await page.getByRole("button", { name: "返回学习", exact: true }).click();
  await edit(page);
  const restored = await sourceMode(page);
  await expect(page.locator(".editor-paste-review")).toContainText(
    "识别到 3 道主问题",
  );
  await page
    .getByRole("button", { name: "保留为当前一题", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "保存修改", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "返回学习", exact: true }).click();
  await edit(page);
  await sourceMode(page);
  await expect(page.locator(".editor-paste-review")).toHaveCount(0);
  await restored.fill((await restored.inputValue()) + "\n");
  await expect(page.locator(".editor-paste-review")).toContainText(
    "识别到 3 道主问题",
  );
  await page.getByRole("button", { name: "预览切分", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.locator(".import-review-card")).toHaveCount(3);
  expect((await snapshot(page)).questions.length).toBe(1);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "编辑题目", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "预览切分", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.locator(".import-review-card")).toHaveCount(3);
  await expect(dialog.getByLabel("当前题的处理")).not.toHaveValue("");
  const replacement = await dialog.getByLabel("当前题的处理").inputValue();
  await dialog
    .getByRole("button", { name: "移除第 1 题", exact: true })
    .click();
  await expect(dialog.getByLabel("当前题的处理")).toHaveValue("");
  await dialog.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(dialog.getByLabel("当前题的处理")).toHaveValue(replacement);
  await expect(dialog.locator(".import-review-card")).toHaveCount(3);
  await page.screenshot({
    path: `test-results/editor-split-${info.project.name}.png`,
    animations: "disabled",
  });
  await dialog
    .getByRole("button", { name: "确认保存 3 道", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText(
    "已更新 1 道，新增 2 道题",
  );
  await dialog.getByRole("button", { name: "去题库看看", exact: true }).click();
  let state = await snapshot(page);
  expect(state.questions.length).toBe(3);
  const updated = state.questions.find(
    (item: { id: string }) => item.id === q.id,
  );
  expect(updated.revision).toBe(2);
  expect(updated.note).toBe("保留当前题的笔记");
  expect(updated.tags).toEqual(["保留标签"]);
  await page.getByRole("button", { name: /^第一道主问题？/ }).click();
  await edit(page);
  const field = await sourceMode(page);
  await expect(field).not.toContainText("第三道主问题");
  const more =
    "## 新材料问题一？\n新增答案一。\n\n## 新材料问题二？\n新增答案二。";
  await paste(page, more);
  await page.getByRole("button", { name: "预览切分", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.locator(".import-review-card")).toHaveCount(2);
  await expect(dialog.getByLabel("当前题的处理")).toHaveValue("");
  await dialog
    .getByRole("button", { name: "确认入库 2 道", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("已入库 2 道题");
  state = await snapshot(page);
  expect(state.questions.length).toBe(5);
  expect(
    state.questions.find((item: { id: string }) => item.id === q.id).revision,
  ).toBe(2);
  await dialog.getByRole("button", { name: "去题库看看", exact: true }).click();
  await page.getByRole("button", { name: /^第一道主问题？/ }).click();
  await edit(page);
  const appended = await sourceMode(page);
  await appended.fill("## 第一道主问题？\n已有答案。");
  await appended.focus();
  await appended.press("ControlOrMeta+End");
  const extra =
    "\n\n## 追加的问题一？\n追加答案一。\n\n## 追加的问题二？\n追加答案二。";
  await appended.evaluate((element, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  }, extra);
  // 合成 paste 事件不执行浏览器的原生插入，用键盘插入模拟其后的 input。
  await page.keyboard.insertText(extra);
  await expect(page.locator(".editor-paste-review")).toContainText(
    "识别到 3 道主问题",
  );
  await expect(
    page.getByRole("button", { name: "保存修改", exact: true }),
  ).toBeDisabled();
});
