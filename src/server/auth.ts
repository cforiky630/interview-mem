import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { captcha, emailOTP } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import {
  applicationOrigins,
  validateProductionEnvironment,
} from "./config.mjs";
import { isEmailOtpEnabled, sendOtpEmail } from "./email";
import {
  checkOtpEmailQuota,
  clearLoginFailure,
  createBetterAuthSecondaryStorage,
  getRedis,
  isLoginEmailThrottled,
  recordLoginFailure,
} from "./redis";

const SESSION_IDLE_SECONDS = 60 * 60 * 24 * 7; // 7 days sliding idle window
const SESSION_UPDATE_SECONDS = 60 * 60 * 24; // refresh at most once per 24h
const SESSION_ABSOLUTE_MAX_MS = 30 * 24 * 60 * 60 * 1000; // 30 days hard cap

const COMMON_WEAK_PASSWORDS = new Set([
  "12345678",
  "123456789",
  "1234567890",
  "password",
  "password1",
  "password123",
  "qwertyui",
  "qwerty123",
  "qwertyuiop",
  "abcdefgh",
  "11111111",
  "00000000",
  "admin123",
  "welcome1",
  "abc12345",
  "letmein1",
  "iloveyou",
  "sunshine",
  "princess",
  "football",
  "baseball",
  "passw0rd",
  "qazwsxedc",
  "a1234567",
  "zxcvbnm1",
  "1q2w3e4r",
  "1qaz2wsx",
  "65432100",
  "87654321",
]);

function assertStrongPassword(password: string, email?: string) {
  const lower = password.trim().toLowerCase();
  if (
    COMMON_WEAK_PASSWORDS.has(lower) ||
    /^(.)\1+$/.test(password) ||
    (email && lower === email.trim().toLowerCase())
  ) {
    throw new APIError("BAD_REQUEST", {
      message: "密码过于简单，请避免使用常见弱密码或与邮箱相同的密码。",
      code: "PASSWORD_TOO_WEAK",
    });
  }
}

async function createAuth() {
  validateProductionEnvironment();
  if (
    !process.env.BETTER_AUTH_SECRET ||
    process.env.BETTER_AUTH_SECRET.length < 32
  )
    throw new Error(
      "请设置 BETTER_AUTH_SECRET，或使用 npm run dev 自动创建本地配置。",
    );
  const db = await getDb();
  const redis = getRedis();
  const secondaryStorage = redis
    ? createBetterAuthSecondaryStorage(redis)
    : undefined;
  const emailOtpEnabled = isEmailOtpEnabled();
  const turnstileSecret = process.env.TURNSTILE_SECRET_KEY?.trim();
  const origins = applicationOrigins();
  const plugins = [];

  if (turnstileSecret) {
    plugins.push(
      captcha({
        provider: "cloudflare-turnstile",
        secretKey: turnstileSecret,
        allowedHostnames: origins.map((origin) => new URL(origin).hostname),
        endpoints: [
          "/sign-up/email",
          "/sign-in/email",
          "/request-password-reset",
          "/email-otp/send-verification-otp",
          "/email-otp/request-password-reset",
        ],
      }),
    );
  }

  if (emailOtpEnabled) {
    plugins.push(
      emailOTP({
        overrideDefaultEmailVerification: true,
        disableSignUp: true,
        storeOTP: "hashed",
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 3,
        async sendVerificationOTP({ email, otp, type }) {
          await checkOtpEmailQuota(email);
          await sendOtpEmail({ email, otp, type });
        },
      }),
    );
  }

  return betterAuth({
    appName: "拾忆",
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    trustedOrigins: origins,
    secret: process.env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "pg", schema, transaction: true }),
    ...(secondaryStorage ? { secondaryStorage } : {}),
    disabledPaths: ["/forget-password/email-otp"],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      requireEmailVerification: emailOtpEnabled,
      revokeSessionsOnPasswordReset: true,
    },
    ...(emailOtpEnabled
      ? {
          emailVerification: {
            sendOnSignUp: true,
            sendOnSignIn: true,
            autoSignInAfterVerification: true,
          },
        }
      : {}),
    session: {
      expiresIn: SESSION_IDLE_SECONDS,
      updateAge: SESSION_UPDATE_SECONDS,
      storeSessionInDatabase: true,
    },
    rateLimit: {
      enabled: true,
      storage: secondaryStorage ? "secondary-storage" : "memory",
      window: 60,
      max: 60,
      customRules: {
        "/sign-up/email": { window: 3600, max: 10 },
        "/sign-in/email": { window: 60, max: 10 },
        "/email-otp/send-verification-otp": { window: 60, max: 3 },
        "/email-otp/request-password-reset": { window: 300, max: 3 },
      },
    },
    databaseHooks: {
      session: {
        update: {
          before: async (sessionData, context) => {
            const createdRaw =
              context?.context?.session?.session?.createdAt ??
              sessionData.createdAt;
            if (!createdRaw) return;
            const createdMs = new Date(createdRaw).getTime();
            if (!Number.isFinite(createdMs)) return;
            const hardDeadline = createdMs + SESSION_ABSOLUTE_MAX_MS;
            if (hardDeadline <= Date.now()) {
              return false;
            }
            if (sessionData.expiresAt) {
              const requestedMs = new Date(sessionData.expiresAt).getTime();
              if (requestedMs > hardDeadline) {
                return {
                  data: {
                    ...sessionData,
                    expiresAt: new Date(hardDeadline),
                  },
                };
              }
            }
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-up/email") {
          const password =
            typeof ctx.body?.password === "string" ? ctx.body.password : "";
          const email =
            typeof ctx.body?.email === "string" ? ctx.body.email : undefined;
          if (password) assertStrongPassword(password, email);
        } else if (
          ctx.path === "/change-password" ||
          ctx.path === "/email-otp/reset-password" ||
          ctx.path === "/reset-password"
        ) {
          const password =
            typeof ctx.body?.newPassword === "string"
              ? ctx.body.newPassword
              : typeof ctx.body?.password === "string"
                ? ctx.body.password
                : "";
          const email =
            typeof ctx.body?.email === "string"
              ? ctx.body.email
              : ctx.context.session?.user?.email;
          if (password) assertStrongPassword(password, email);
        } else if (ctx.path === "/sign-in/email") {
          const email =
            typeof ctx.body?.email === "string" ? ctx.body.email : "";
          if (email && (await isLoginEmailThrottled(email))) {
            throw new APIError("TOO_MANY_REQUESTS", {
              message: "该账号登录失败次数过多，请 15 分钟后再试。",
              code: "ACCOUNT_TEMPORARILY_LOCKED",
            });
          }
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-in/email") {
          const email =
            typeof ctx.body?.email === "string" ? ctx.body.email : "";
          if (!email) return;
          if (ctx.context.newSession) {
            await clearLoginFailure(email);
          } else if (
            isAPIError(ctx.context.returned) &&
            ctx.context.returned.statusCode === 401
          ) {
            await recordLoginFailure(email);
          }
        }
      }),
    },
    advanced: {
      database: {
        generateId: () => crypto.randomUUID(),
        joins: true,
      },
      ipAddress: {
        ipAddressHeaders: ["x-real-ip", "cf-connecting-ip", "x-forwarded-for"],
      },
    },
    plugins,
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
export function resetAuthForTests() {
  state.interviewAuth = undefined;
}
