import { spawn } from "node:child_process";
import env from "@next/env";
import { validateProductionEnvironment } from "../src/server/config.mjs";

process.env.NODE_ENV = "production";
env.loadEnvConfig(process.cwd());
// Validate before opening a listening socket; Next's hook alone may keep it open.
validateProductionEnvironment();
const child = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "start",
    "-H",
    "0.0.0.0",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } },
);
child.on("error", () => {
  console.error("生产服务未能启动。");
  process.exitCode = 1;
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
