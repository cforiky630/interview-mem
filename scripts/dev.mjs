import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

await mkdir(".data", { recursive: true });
try {
  await readFile(".env.local");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await writeFile(
    ".env.local",
    [
      "BETTER_AUTH_SECRET=" + randomBytes(32).toString("hex"),
      "KEY_ENCRYPTION_SECRET=" + randomBytes(32).toString("hex"),
      "BETTER_AUTH_URL=http://localhost:3000",
      "",
    ].join("\n"),
    { flag: "wx" },
  );
  console.log("已为本地开发生成独立密钥，保存在忽略提交的 .env.local 中。");
}
const child = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "dev",
    "--webpack",
    "-H",
    "0.0.0.0",
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  },
);
child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
