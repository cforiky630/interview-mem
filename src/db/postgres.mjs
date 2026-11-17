import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

/** @param {Record<string, string | undefined>} [env] */
export function hasPostgres(env = process.env) {
  return Boolean(env.DATABASE_URL || env.PGHOST);
}

/** @param {Record<string, string | undefined>} [env] */
export function createPostgresPool(env = process.env) {
  const pool = new Pool({
    ...(env.DATABASE_URL
      ? { connectionString: env.DATABASE_URL }
      : {
          host: env.PGHOST,
          port: Number(env.PGPORT || 5432),
          user: env.PGUSER,
          password: env.PGPASSWORD,
          database: env.PGDATABASE,
        }),
    max: 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  pool.on("error", () => console.error("Idle database connection failed."));
  return pool;
}

/**
 * Serialize releases using a session lock held on the same connection as DDL.
 * @param {Pool} pool
 * @param {string} folder
 */
export async function migratePostgres(pool, folder) {
  const client = await pool.connect();
  try {
    await client.query("SET lock_timeout = '60s'");
    await client.query("SELECT pg_advisory_lock($1)", [0x53485949]); // SHYI
    await migrate(drizzle(client), { migrationsFolder: folder });
  } finally {
    // Destroying this one-off connection also releases its advisory lock on failure.
    client.release(true);
  }
}
