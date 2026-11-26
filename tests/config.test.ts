import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applicationOrigins,
  validateProductionEnvironment,
} from "../src/server/config.mjs";
import { createPostgresPool } from "../src/db/postgres.mjs";

test("deployment: production refuses missing secrets, database, non-HTTPS public URLs and invalid origins", () => {
  const env = {
    NODE_ENV: "production",
    BETTER_AUTH_URL: "https://study.example.com",
    BETTER_AUTH_SECRET: "a".repeat(64),
    KEY_ENCRYPTION_SECRET: "b".repeat(64),
    PGHOST: "db",
    PGUSER: "shiyi",
    PGDATABASE: "shiyi",
    PGPASSWORD: "test-password",
  };
  assert.doesNotThrow(() => validateProductionEnvironment(env));
  for (const key of [
    "BETTER_AUTH_URL",
    "BETTER_AUTH_SECRET",
    "KEY_ENCRYPTION_SECRET",
    "PGHOST",
  ] as const) {
    assert.throws(
      () => validateProductionEnvironment({ ...env, [key]: "" }),
      key,
    );
  }
  assert.throws(() =>
    validateProductionEnvironment({
      ...env,
      KEY_ENCRYPTION_SECRET: env.BETTER_AUTH_SECRET,
    }),
  );
  assert.throws(() =>
    validateProductionEnvironment({
      ...env,
      BETTER_AUTH_URL: "http://public.example.com",
    }),
  );
  assert.doesNotThrow(() =>
    validateProductionEnvironment({
      ...env,
      BETTER_AUTH_URL: "http://localhost:3000",
      PGHOST: "",
      ALLOW_LOCAL_DATABASE: "true",
    }),
  );
  for (const origin of [
    "https://study.example.com/path",
    "https://user:pass@study.example.com",
    "https://study.example.com?key=123",
    "https://study.example.com/#test",
    "file:///tmp",
    "https://*.example.com",
  ]) {
    assert.throws(
      () => applicationOrigins({ BETTER_AUTH_URL: origin }),
      origin,
    );
  }
  assert.deepEqual(
    applicationOrigins({
      BETTER_AUTH_URL: "http://localhost:3000",
      BETTER_AUTH_TRUSTED_ORIGINS:
        " http://192.168.1.10:3000/, http://localhost:3000 ",
    }),
    ["http://localhost:3000", "http://192.168.1.10:3000"],
  );
});

test("deployment: separate PostgreSQL fields preserve special characters in passwords", async () => {
  const pool = createPostgresPool({
    PGHOST: "db",
    PGUSER: "shiyi",
    PGDATABASE: "shiyi",
    PGPORT: "5433",
    PGPASSWORD: "test:@/%?#$& password",
  });
  assert.equal(pool.options.password, "test:@/%?#$& password");
  assert.equal(pool.options.host, "db");
  assert.equal(pool.options.port, 5433);
  await pool.end();
});

test("deployment: nginx allows 20 MiB backup restores while keeping 1m default limit", async () => {
  const fs = await import("node:fs/promises");
  const conf = await fs.readFile("deploy/nginx.conf", "utf8");
  assert.match(conf, /^\s*client_max_body_size\s+1m;/m);
  const restoreBlock = conf.match(
    /location\s*=\s*\/api\/backup\/restore\s*\{([\s\S]*?)\}/,
  );
  assert.ok(restoreBlock, "nginx.conf should configure = /api/backup/restore");
  const sizeMatch = restoreBlock[1].match(/client_max_body_size\s+(\d+)m;/i);
  assert.ok(sizeMatch && Number(sizeMatch[1]) >= 20);
});
