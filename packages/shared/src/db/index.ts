import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export * from "./schema.js";

export type Database = ReturnType<typeof createDb>;

let cached: Database | null = null;
let cachedSql: postgres.Sql | null = null;

export function createDb(connectionString: string) {
  const sql = postgres(connectionString, { max: 10 });
  cachedSql = sql;
  return drizzle(sql, { schema });
}

/** Process-wide singleton. Workers and the API each get one pool. */
export function getDb(connectionString: string): Database {
  if (!cached) cached = createDb(connectionString);
  return cached;
}

export async function closeDb(): Promise<void> {
  if (cachedSql) {
    await cachedSql.end({ timeout: 5 });
    cachedSql = null;
    cached = null;
  }
}
