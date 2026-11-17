import { createHash } from "node:crypto";
import { test as base, expect } from "@playwright/test";

// Keep real auth limits enabled while independent tests use independent clients.
export const test = base.extend({
  extraHTTPHeaders: async ({}, use, info) => {
    const id = createHash("sha256")
      .update(`${info.testId}:${info.retry}`)
      .digest("hex")
      .slice(0, 24);
    await use({
      "X-Forwarded-For": `2001:db8:${id.match(/.{4}/g)!.join(":")}`,
    });
  },
});
export { expect };
