import { existsSync } from "node:fs";
import { lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
const flags = new Set(process.argv.slice(2));
if ([...flags].some((flag) => !["--dry-run", "--cache"].includes(flag))) {
  throw new Error("支持的选项：--dry-run、--cache。请先停止开发和测试服务。");
}
const targets = [
  ".next",
  ".next-build",
  ".next-e2e",
  "test-results",
  "playwright-report",
  "tsconfig.tsbuildinfo",
  ".data/e2e-postgres",
];
if (flags.has("--cache")) targets.push(".cache/npm");
for (const name of targets.filter((name) => name.startsWith(".next"))) {
  if (
    ["lock", "dev/lock"].some((lock) => existsSync(path.join(root, name, lock)))
  ) {
    throw new Error(`${name} 有运行锁，请先停止对应服务再清理。`);
  }
}
for (const name of targets) {
  const target = path.resolve(root, name);
  if (!existsSync(target)) continue;
  const resolved = await realpath(target);
  const relative = path.relative(root, resolved);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    (await lstat(target)).isSymbolicLink()
  ) {
    throw new Error(`拒绝清理越界或链接目标：${name}`);
  }
  console.log(
    `${flags.has("--dry-run") ? "Would remove" : "Removing"} ${name}`,
  );
  if (!flags.has("--dry-run"))
    await rm(target, { recursive: true, force: true, maxRetries: 3 });
}
