import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { getDb } from "@/db";
import * as schema from "@/db/schema";

async function createAuth() {
  if (
    !process.env.BETTER_AUTH_SECRET ||
    process.env.BETTER_AUTH_SECRET.length < 32
  )
    throw new Error(
      "请设置 BETTER_AUTH_SECRET，或使用 npm run dev 自动创建本地配置。",
    );
  const db = await getDb();
  return betterAuth({
    appName: "拾忆",
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    secret: process.env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "pg", schema, transaction: true }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    rateLimit: { enabled: true, storage: "memory", window: 60, max: 60 },
    advanced: { database: { generateId: () => crypto.randomUUID() } },
  });
}
const state = globalThis as unknown as {
  interviewAuth?: ReturnType<typeof createAuth>;
};
export function getAuth() {
  state.interviewAuth ??= createAuth().catch((error) => {
    state.interviewAuth = undefined;
    throw error;
  });
  return state.interviewAuth!;
}
