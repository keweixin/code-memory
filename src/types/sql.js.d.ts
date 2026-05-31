/**
 * Type declarations for sql.js (WASM SQLite)
 * sql.js does not ship with TypeScript definitions.
 */

declare module 'sql.js' {
  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => SqlJsDatabase;
  }

  export interface SqlJsDatabase {
    run(sql: string, params?: unknown[]): SqlJsDatabase;
    exec(
      sql: string,
      params?: unknown[],
    ): Array<{ columns: string[]; values: unknown[][] }>;
    prepare(sql: string): SqlJsStatement;
    close(): void;
    export(): Uint8Array;
    getRowsModified(): number;
  }

  export interface SqlJsStatement {
    bind(params?: unknown[]): boolean;
    bind(params?: Record<string, unknown>): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): boolean;
    reset(): boolean;
  }

  export { SqlJsDatabase as Database };

  export default function initSqlJs(): Promise<SqlJsStatic>;
}
