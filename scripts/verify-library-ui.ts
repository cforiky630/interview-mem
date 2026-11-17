import { chromium, expect } from "@playwright/test";
import { createInterface } from "node:readline";
import { once } from "node:events";
import assert from "node:assert/strict";
import { z } from "zod";
import { normalizedNoteTitle } from "../src/lib/markdown-source";
import { writeFile } from "node:fs/promises";

// Read credentials without echoing them or saving them to disk.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
const input = createInterface({ input: process.stdin, terminal: false });
console.log("等待登录信息（通过标准输入传入，不回显）。");
const [line] = await once(input, "line");
input.close();
if (process.stdin.isTTY) process.stdin.setRawMode(false);
process.stdin.destroy();
const credentials = z
  .object({ email: z.email(), password: z.string() })
  .parse(JSON.parse(line));
const baseURL = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({
  channel: process.platform === "win32" ? "chrome" : undefined,
});
const results: unknown[] = [];
async function progress(stage: string) {
  await writeFile(
    ".data/imports/ui-verification.json",
    JSON.stringify({ stage, results }, null, 2),
  );
}
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      baseURL,
      viewport: mobile
        ? { width: 390, height: 844 }
        : { width: 1440, height: 1000 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    const errors: string[] = [];
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    let signedIn = false;
    try {
      await page.goto("/");
      await page.getByLabel("邮箱", { exact: true }).fill(credentials.email);
      await page.getByLabel("密码", { exact: true }).fill(credentials.password);
      await page.getByRole("button", { name: "登录拾忆", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: /今天，\s*记住一点。/ }),
      ).toBeVisible({ timeout: 60_000 });
      signedIn = true;
      await progress(mobile ? "mobile signed in" : "desktop signed in");
      const response = await context.request.get("/api/workspace");
      assert.ok(response.ok());
      const state = await response.json();
      assert.equal(state.questions.length, 9);
      const studySnapshot = state.questions.map(
        (q: {
          id: string;
          note: string;
          fsrs: unknown;
          studyVersion: number;
        }) => ({
          id: q.id,
          note: q.note,
          fsrs: q.fsrs,
          version: q.studyVersion,
        }),
      );
      await page.screenshot({
        path: `docs/notebook-home-${mobile ? "mobile" : "desktop"}.png`,
        fullPage: true,
        animations: "disabled",
      });
      const importedDecks = state.decks.filter((d: { title: string }) =>
        d.title.startsWith("RAG ·"),
      );
      assert.equal(importedDecks.length, 2);
      assert.ok(
        importedDecks.every(
          (d: { visibility: string }) => d.visibility === "private",
        ),
      );
      const second = state.questions.find(
        (q: { validation?: { sourcePath: string } }) =>
          q.validation?.sourcePath.startsWith("RAG/02-"),
      );
      const first = state.questions.find(
        (q: { validation?: { sourcePath: string } }) =>
          q.validation?.sourcePath.startsWith("RAG/01-"),
      );
      const third = state.questions.find(
        (q: { validation?: { sourcePath: string } }) =>
          q.validation?.sourcePath.startsWith("RAG/03-"),
      );
      assert.ok(first && second && third);
      const nav = mobile
        ? page.locator(".mobile-bottom-nav")
        : page.locator(".sidebar");
      await nav.getByRole("button", { name: "我的题库", exact: true }).click();
      await page.screenshot({
        path: `docs/notebook-library-${mobile ? "mobile" : "desktop"}.png`,
        fullPage: false,
        animations: "disabled",
      });
      await page
        .locator(".question-row-main")
        .filter({ hasText: second.title })
        .click();
      await expect(page.locator(".question-card-heading h1")).toHaveText(
        second.title,
      );
      await expect(
        page.locator(".answer-content .katex").first(),
      ).toBeVisible();
      await expect(page.locator(".answer-content .katex-error")).toHaveCount(0);
      await expect(
        page.locator('.answer-content blockquote[data-callout="question"]'),
      ).toHaveCount(0);
      await expect(page.locator(".content-validation")).toHaveCount(0);
      await expect(page.locator(".answer-content")).not.toContainText(
        "[!question]",
      );
      await expect(page.locator(".answer-content")).not.toContainText("tags:");
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        "Reader must fit viewport",
      );
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: `docs/notebook-reader-${mobile ? "mobile" : "desktop"}.png`,
        fullPage: false,
        animations: "disabled",
      });
      await progress(
        mobile ? "mobile reader rendered" : "desktop reader rendered",
      );
      await page
        .getByRole("button", { name: "默写第 1 段", exact: true })
        .click();
      await expect(
        page.getByLabel("第 1 段默写", { exact: true }),
      ).toBeVisible();
      await expect(
        page.locator(".practice-block.is-writing .paragraph-reference"),
      ).toHaveCount(0);
      await page.screenshot({
        path: `docs/notebook-paragraph-${mobile ? "mobile" : "desktop"}.png`,
        fullPage: false,
        animations: "disabled",
      });
      await page
        .getByRole("button", { name: "结束第 1 段默写", exact: true })
        .click();
      await page.getByRole("tab", { name: /^追问/ }).click();
      await expect(page.locator(".followup-answer")).toHaveCount(0);
      await page.getByRole("button", { name: "查看答案", exact: true }).click();
      await expect(page.locator(".followup-answer")).toBeVisible();
      await page
        .getByRole("button", { name: "下一道追问", exact: true })
        .click();
      await expect(page.locator(".followup-answer")).toHaveCount(0);
      await page.screenshot({
        path: `docs/notebook-followups-${mobile ? "mobile" : "desktop"}.png`,
        fullPage: false,
        animations: "disabled",
      });
      await page.getByRole("tab", { name: "正文", exact: true }).click();
      await page.getByLabel("更多题目操作").click();
      await page.getByRole("button", { name: "校验记录", exact: true }).click();
      await expect(
        page.getByRole("dialog").locator(".validation-body section"),
      ).toHaveCount(2);
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "关闭", exact: true })
        .click();
      await page.getByLabel("更多题目操作").click();
      const link = page.locator('.answer-content a[href^="#note="]').first();
      const target = decodeURIComponent(
        (await link.getAttribute("href"))!.slice(6),
      );
      const expected = state.questions.find(
        (q: { title: string; validation?: { sourcePath: string } }) =>
          normalizedNoteTitle(q.validation?.sourcePath ?? q.title) ===
          normalizedNoteTitle(target),
      );
      assert.ok(expected, "Linked question must exist in the imported library");
      await link.click();
      await expect(page.locator(".question-card-heading h1")).toHaveText(
        expected.title,
      );
      await progress(
        mobile ? "mobile linked note opened" : "desktop linked note opened",
      );
      await nav.getByRole("button", { name: "我的题库", exact: true }).click();
      await page
        .locator(".question-row-main")
        .filter({ hasText: third.title })
        .click();
      await expect(page.locator(".answer-content table").first()).toBeVisible();
      await expect(page.locator(".answer-content .katex-error")).toHaveCount(0);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        "Expanded answer must fit viewport",
      );
      await page.getByRole("button", { name: "开始答题", exact: true }).click();
      await expect(page.getByLabel("本题作答", { exact: true })).toBeVisible();
      await expect(page.locator(".answer-content")).toHaveCount(0);
      await page.screenshot({
        path: `docs/notebook-answer-${mobile ? "mobile" : "desktop"}.png`,
        fullPage: false,
        animations: "disabled",
      });
      const after = await (await context.request.get("/api/workspace")).json();
      assert.deepEqual(
        after.questions.map(
          (q: {
            id: string;
            note: string;
            fsrs: unknown;
            studyVersion: number;
          }) => ({
            id: q.id,
            note: q.note,
            fsrs: q.fsrs,
            version: q.studyVersion,
          }),
        ),
        studySnapshot,
      );
      assert.deepEqual(errors, []);
      results.push({
        viewport: mobile ? "mobile" : "desktop",
        passed: true,
        pageErrors: 0,
      });
      await progress(mobile ? "mobile passed" : "desktop passed");
      console.log(
        JSON.stringify({
          viewport: mobile ? "mobile" : "desktop",
          importedQuestions: 9,
          unchangedStudyState: true,
          formulas: true,
          separateFollowups: true,
          linkedNotes: true,
          independentValidation: true,
          overflow: false,
          pageErrors: 0,
        }),
      );
    } catch (error) {
      await progress(
        error instanceof Error
          ? error.message.split("Call log:")[0]
          : "界面验证失败",
      );
      console.error(
        "阅读界面检查未通过。",
        error instanceof Error
          ? error.message.split("Call log:")[0]
          : "未知错误",
      );
      throw error;
    } finally {
      if (signedIn)
        await context.request.post("/api/auth/sign-out", {
          headers: { origin: new URL(baseURL).origin },
          data: {},
        });
      await context.close();
    }
  }
} catch (error) {
  // Avoid Playwright call logs that could contain filled credentials.
  console.error(
    error instanceof Error
      ? `${error.name}: ${error.message.split("Call log:")[0]}`
      : "界面验证失败。",
  );
  process.exitCode = 1;
} finally {
  credentials.password = "";
  await browser.close();
  await progress(
    results.length === 2 && !process.exitCode ? "complete" : "failed",
  );
}
