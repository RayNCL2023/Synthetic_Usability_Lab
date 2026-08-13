import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createDb, closeDb } from "./index.js";
import { loadEnv, DataEnv } from "../env.js";

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const env = loadEnv(DataEnv);
  const db = createDb(env.DATABASE_URL);
  await migrate(db, { migrationsFolder: path.resolve(here, "../../drizzle") });
  console.log("migrations applied");
  await closeDb();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
