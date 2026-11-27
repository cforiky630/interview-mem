/** @param {Record<string, string | undefined>} [env] */
export function applicationOrigins(env = process.env) {
  return [
    ...new Set(
      [
        env.BETTER_AUTH_URL || "http://localhost:3000",
        ...(env.BETTER_AUTH_TRUSTED_ORIGINS || "").split(","),
      ]
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => {
          const url = new URL(value);
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.hostname.includes("*") ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            url.pathname !== "/"
          ) {
            throw new Error(
              "应用来源必须是完整的 HTTP(S) Origin，不能包含路径或凭证。",
            );
          }
          return url.origin;
        }),
    ),
  ];
}

/** @param {Record<string, string | undefined>} [env] */
export function validateProductionEnvironment(env = process.env) {
  if (env.NODE_ENV !== "production") return;
  if (!env.BETTER_AUTH_URL)
    throw new Error("生产环境必须设置 BETTER_AUTH_URL。");
  const origins = applicationOrigins(env);
  for (const origin of origins) {
    const url = new URL(origin);
    if (
      url.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    ) {
      throw new Error(
        "生产环境的 BETTER_AUTH_URL 与 BETTER_AUTH_TRUSTED_ORIGINS 必须使用 HTTPS。",
      );
    }
  }
  for (const key of ["BETTER_AUTH_SECRET", "KEY_ENCRYPTION_SECRET"]) {
    if (!env[key] || env[key].length < 32)
      throw new Error(`${key} 必须至少 32 字符。`);
  }
  if (env.BETTER_AUTH_SECRET === env.KEY_ENCRYPTION_SECRET) {
    throw new Error("登录密钥和 API Key 加密主密钥必须使用不同的随机值。");
  }
  if (!env.DATABASE_URL && !env.PGHOST && env.ALLOW_LOCAL_DATABASE !== "true") {
    throw new Error(
      "生产环境需要 PostgreSQL：设置 DATABASE_URL 或 PGHOST 等连接参数。",
    );
  }
}
