import { PGlite } from "@electric-sql/pglite";
import { drizzle as localDrizzle } from "drizzle-orm/pglite";
import { migrate as localMigrate } from "drizzle-orm/pglite/migrator";
import { drizzle as postgresDrizzle } from "drizzle-orm/node-postgres";
import {
  createPostgresPool,
  hasPostgres,
  migratePostgres,
} from "./postgres.mjs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import * as schema from "./schema";

export type Database = ReturnType<typeof localDrizzle<typeof schema>>;
type Connection = { db: Database; close: () => Promise<void> };
const state = globalThis as unknown as {
  interviewDatabase?: Promise<Connection>;
};

export async function openDatabase({
  migrate = process.env.NODE_ENV !== "production",
} = {}): Promise<Connection> {
  const folder = path.resolve("drizzle");
  if (hasPostgres()) {
    const pool = createPostgresPool();
    const db = postgresDrizzle(pool, { schema });
    try {
      if (migrate) await migratePostgres(pool, folder);
    } catch (error) {
      await pool.end();
      throw error;
    }
    return { db: db as unknown as Database, close: () => pool.end() };
  }
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_LOCAL_DATABASE !== "true"
  ) {
    throw new Error(
      "生产环境需要 DATABASE_URL。单进程本地体验请显式设置 ALLOW_LOCAL_DATABASE=true。",
    );
  }
  const directory =
    process.env.LOCAL_DATABASE_PATH === ":memory:"
      ? undefined
      : path.resolve(process.env.LOCAL_DATABASE_PATH ?? ".data/postgres");
  if (directory) await mkdir(path.dirname(directory), { recursive: true });
  const client = new PGlite(directory);
  const db = localDrizzle(client, { schema });
  try {
    if (migrate) await localMigrate(db, { migrationsFolder: folder });
  } catch (error) {
    await client.close();
    throw error;
  }
  return { db, close: () => client.close() };
}

export async function getDb() {
  state.interviewDatabase ??= openDatabase().catch((error) => {
    state.interviewDatabase = undefined;
    throw error;
  });
  return (await state.interviewDatabase).db;
}
