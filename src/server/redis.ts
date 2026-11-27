import Redis from "ioredis";
import { AppError } from "./errors";

const redisState = globalThis as unknown as {
  interviewRedisClient?: Redis | null;
  interviewMemoryThrottle?: Map<string, { value: number; expiresAt: number }>;
};

const INCR_FIXED_WINDOW_LUA = `
local v = redis.call("INCR", KEYS[1])
if v == 1 then redis.call("EXPIRE", KEYS[1], tonumber(ARGV[1])) end
return v`;

export function getRedis(): Redis | null {
  const url = process.env.REDIS_URL?.trim();
  if (!url) return null;
  if (redisState.interviewRedisClient) return redisState.interviewRedisClient;
  const client = new Redis(url, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    connectTimeout: 5000,
  });
  client.on("error", () => {
    console.error("Redis connection error.");
  });
  redisState.interviewRedisClient = client;
  return client;
}

export function createBetterAuthSecondaryStorage(redis: Redis) {
  return {
    get: async (key: string) => redis.get(`ba:${key}`),
    set: async (key: string, value: string, ttl?: number) => {
      if (ttl && ttl > 0) {
        await redis.set(`ba:${key}`, value, "EX", Math.ceil(ttl));
      } else {
        await redis.set(`ba:${key}`, value);
      }
    },
    delete: async (key: string) => {
      await redis.del(`ba:${key}`);
    },
    getAndDelete: async (key: string) => redis.getdel(`ba:${key}`),
    increment: async (key: string, ttl: number) =>
      Number(
        await redis.eval(
          INCR_FIXED_WINDOW_LUA,
          1,
          `ba:rl:${key}`,
          Math.max(1, Math.ceil(ttl)),
        ),
      ),
  };
}

function memMap() {
  redisState.interviewMemoryThrottle ??= new Map();
  const map = redisState.interviewMemoryThrottle;
  if (map.size > 5000) {
    const now = Date.now();
    for (const [k, v] of map) {
      if (v.expiresAt <= now) map.delete(k);
    }
    while (map.size > 5000) {
      const oldest = map.keys().next().value;
      if (!oldest) break;
      map.delete(oldest);
    }
  }
  return map;
}

function normalizeEmailKey(email: string) {
  return email.trim().toLowerCase();
}

export async function checkOtpEmailQuota(email: string) {
  const normalized = normalizeEmailKey(email);
  const redis = getRedis();
  const day = new Date().toISOString().slice(0, 10);
  if (redis) {
    const locked = await redis.set(
      `otp:cd:${normalized}`,
      "1",
      "EX",
      60,
      "NX",
    );
    if (!locked) {
      throw new AppError(429, "验证码发送太频繁，请 60 秒后再试。");
    }
    const dailyCount = Number(
      await redis.eval(
        INCR_FIXED_WINDOW_LUA,
        1,
        `otp:day:${normalized}:${day}`,
        86_400,
      ),
    );
    if (dailyCount > 10) {
      throw new AppError(429, "该邮箱今日发送次数已达上限，请明天再试。");
    }
    return;
  }

  const map = memMap();
  const now = Date.now();
  const cdKey = `otp:cd:${normalized}`;
  const cd = map.get(cdKey);
  if (cd && cd.expiresAt > now) {
    throw new AppError(429, "验证码发送太频繁，请 60 秒后再试。");
  }
  map.set(cdKey, { value: 1, expiresAt: now + 60_000 });

  const dayKey = `otp:day:${normalized}:${day}`;
  const existingDay = map.get(dayKey);
  const nextCount =
    existingDay && existingDay.expiresAt > now ? existingDay.value + 1 : 1;
  map.set(dayKey, {
    value: nextCount,
    expiresAt:
      existingDay && existingDay.expiresAt > now
        ? existingDay.expiresAt
        : now + 86_400_000,
  });
  if (nextCount > 10) {
    throw new AppError(429, "该邮箱今日发送次数已达上限，请明天再试。");
  }
}

const LOGIN_FAIL_WINDOW_SEC = 15 * 60;
const LOGIN_FAIL_MAX = 5;

export async function isLoginEmailThrottled(email: string): Promise<boolean> {
  const normalized = normalizeEmailKey(email);
  if (!normalized) return false;
  const redis = getRedis();
  if (redis) {
    const count = Number((await redis.get(`auth:fail:${normalized}`)) ?? "0");
    return count >= LOGIN_FAIL_MAX;
  }
  const map = memMap();
  const entry = map.get(`auth:fail:${normalized}`);
  return Boolean(
    entry && entry.expiresAt > Date.now() && entry.value >= LOGIN_FAIL_MAX,
  );
}

export async function recordLoginFailure(email: string): Promise<void> {
  const normalized = normalizeEmailKey(email);
  if (!normalized) return;
  const redis = getRedis();
  if (redis) {
    await redis.eval(
      INCR_FIXED_WINDOW_LUA,
      1,
      `auth:fail:${normalized}`,
      LOGIN_FAIL_WINDOW_SEC,
    );
    return;
  }
  const map = memMap();
  const now = Date.now();
  const key = `auth:fail:${normalized}`;
  const entry = map.get(key);
  const next = entry && entry.expiresAt > now ? entry.value + 1 : 1;
  map.set(key, {
    value: next,
    expiresAt:
      entry && entry.expiresAt > now
        ? entry.expiresAt
        : now + LOGIN_FAIL_WINDOW_SEC * 1000,
  });
}

export async function clearLoginFailure(email: string): Promise<void> {
  const normalized = normalizeEmailKey(email);
  if (!normalized) return;
  const redis = getRedis();
  if (redis) {
    await redis.del(`auth:fail:${normalized}`);
    return;
  }
  memMap().delete(`auth:fail:${normalized}`);
}
