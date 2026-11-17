import env from "@next/env";
env.loadEnvConfig(process.cwd());
const { openDatabase } = await import("../src/db/index");
const connection = await openDatabase();
console.log("数据库迁移完成。");
await connection.close();
