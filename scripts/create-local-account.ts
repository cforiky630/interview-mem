import env from "@next/env";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { z } from "zod";

// Credentials arrive over stdin, never argv or an on-disk configuration file.
env.loadEnvConfig(process.cwd());
if (process.stdin.isTTY) process.stdin.setRawMode(true);
const input = createInterface({ input: process.stdin, terminal: false });
console.log("等待账号信息（通过标准输入传入，不回显）。");
const [line] = await once(input, "line");
input.close();
if (process.stdin.isTTY) process.stdin.setRawMode(false);
process.stdin.pause();
const details = z
  .object({
    name: z.string().min(1).max(50),
    email: z.email(),
    password: z.string().min(8).max(128),
  })
  .parse(JSON.parse(line));
const { getAuth } = await import("../src/server/auth");
const { getDb } = await import("../src/db");
const { user } = await import("../src/db/schema");
const { eq } = await import("drizzle-orm");
const db = await getDb();
const auth = await getAuth();
const origin = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000")
  .origin;
function request(path: string, body: unknown, cookie?: string) {
  return new Request(`${origin}/api/auth/${path}`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}
let created = false;
try {
  const [existing] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, details.email));
  if (!existing) {
    const result = await auth.handler(request("sign-up/email", details));
    if (!result.ok) throw new Error(`注册未完成（HTTP ${result.status}）。`);
    created = true;
  }
  const login = await auth.handler(
    request("sign-in/email", {
      email: details.email,
      password: details.password,
    }),
  );
  if (!login.ok)
    throw new Error(`账号登录验证未通过（HTTP ${login.status}）。`);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const session = await auth.api.getSession({
    headers: new Headers({ cookie }),
  });
  if (!session || session.user.email !== details.email)
    throw new Error("会话验证未通过。");
  console.log(
    JSON.stringify({
      created,
      user: {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
      },
      verifiedLogin: true,
    }),
  );
  await auth.handler(request("sign-out", {}, cookie));
} catch (error) {
  console.error(error instanceof Error ? error.message : "账号操作未完成。");
  process.exitCode = 1;
} finally {
  details.password = "";
  const state = globalThis as unknown as {
    interviewDatabase?: Promise<{ close: () => Promise<void> }>;
  };
  await (await state.interviewDatabase)?.close();
}
