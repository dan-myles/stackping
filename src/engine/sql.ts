export type SqlValue = string | number | null

/**
 * The synchronous SQLite surface the engine needs. Durable Object storage
 * (`ctx.storage.sql`) and `bun:sqlite` both implement it, so the engine runs
 * unchanged in production and in tests.
 */
export interface Sql {
  run(query: string, ...params: SqlValue[]): void
  all<T>(query: string, ...params: SqlValue[]): T[]
  transaction<T>(fn: () => T): T
}

export function one<T>(
  sql: Sql,
  query: string,
  ...params: SqlValue[]
): T | undefined {
  return sql.all<T>(query, ...params)[0]
}
