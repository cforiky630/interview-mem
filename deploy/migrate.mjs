import path from "node:path";
import {
  createPostgresPool,
  hasPostgres,
  migratePostgres,
} from "../src/db/postgres.mjs";
import { validateProductionEnvironment } from "../src/server/config.mjs";

validateProductionEnvironment();
if (!hasPostgres()) throw new Error("容器部署需要 PostgreSQL。");
const pool = createPostgresPool();
try {
  await migratePostgres(pool, path.resolve("drizzle"));
  console.log("Database migrations applied.");
} finally {
  await pool.end();
}
