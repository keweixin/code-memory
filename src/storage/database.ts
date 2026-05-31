/**
 * Code Memory Graph — Database Singleton
 *
 * Initializes sql.js (WASM-based SQLite), manages the in-memory
 * database lifecycle, and persists to disk on demand.
 *
 * All repository methods operate synchronously once the database
 * is initialized — only the sql.js WASM bootstrap is async.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CONFIG_DIR, DATABASE_FILE, SQLITE_PRAGMAS } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import { ALL_DDL, SCHEMA_VERSION } from './schema.js';

const log = createLogger('database');

// ── sql.js type shims ───────────────────────────────────────
// sql.js ships no .d.ts — we declare the minimum surface we use.

interface SqlJsStatement {
  bind(params?: unknown[]): boolean;
  bind(params?: Record<string, unknown>): boolean;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): boolean;
  reset(): boolean;
}

interface SqlJsDatabase {
  run(sql: string, params?: unknown[]): SqlJsDatabase;
  exec(sql: string, params?: unknown[]): { columns: string[]; values: unknown[][] }[];
  prepare(sql: string): SqlJsStatement;
  close(): void;
  export(): Uint8Array;
  getRowsModified(): number;
}

type SqlJsStatic = {
  Database: new (data?: ArrayLike<number> | Buffer | null) => SqlJsDatabase;
};

export type { SqlJsDatabase, SqlJsStatement };

// ── Singleton state ─────────────────────────────────────────

let db: SqlJsDatabase | null = null;
let dbFilePath: string = '';
let initialized = false;

/**
 * Resolve the default database file path.
 * Uses CONFIG_DIR / DATABASE_FILE relative to `basePath`.
 */
function resolveDbPath(basePath?: string): string {
  const root = basePath ?? process.cwd();
  return join(root, CONFIG_DIR, DATABASE_FILE);
}

/**
 * Initialize sql.js and open the database.
 *
 * If a database file already exists on disk, it is loaded into
 * the in-memory instance. Otherwise a fresh database is created
 * and the schema is applied.
 *
 * This is idempotent — calling it again when already initialized
 * simply returns the existing instance.
 */
export async function getDatabase(basePath?: string): Promise<SqlJsDatabase> {
  if (db && initialized) {
    return db;
  }

  dbFilePath = resolveDbPath(basePath);
  log.info(`Opening database: ${dbFilePath}`);

  // Bootstrap sql.js WASM
  const initSqlJs = (await import('sql.js')).default as unknown as () => Promise<SqlJsStatic>;
  const SQL = await initSqlJs();

  // Attempt to load an existing database from disk
  let existingData: Uint8Array | null = null;
  try {
    const buffer = await readFile(dbFilePath);
    existingData = new Uint8Array(buffer);
    log.info('Loaded existing database from disk');
  } catch {
    log.info('No existing database found — creating new database');
  }

  db = existingData ? new SQL.Database(existingData) : new SQL.Database();

  // Apply SQLite pragmas (some may not be supported by sql.js — ignore errors)
  for (const pragma of SQLITE_PRAGMAS) {
    try {
      db.run(pragma);
    } catch {
      // WAL mode and some pragmas may not be supported in sql.js
      log.debug(`Pragma skipped (unsupported): ${pragma}`);
    }
  }

  // Ensure schema exists (all statements use IF NOT EXISTS)
  initializeSchema();

  // Persist schema version
  const currentVersion = getMetadataValue('schema_version');
  if (currentVersion === null) {
    setMetadataValue('schema_version', String(SCHEMA_VERSION));
  }

  initialized = true;
  log.info('Database initialized');
  return db;
}

/**
 * Return the current database instance without async init.
 * Throws if the database has not been initialized yet.
 */
export function getDatabaseSync(): SqlJsDatabase {
  if (!db || !initialized) {
    throw new Error('Database not initialized — call getDatabase() first');
  }
  return db;
}

/**
 * Execute all DDL statements to create tables, FTS indexes,
 * triggers, and performance indexes.
 */
export function initializeSchema(): void {
  if (!db) {
    throw new Error('Database not initialized — call getDatabase() first');
  }

  for (const ddl of ALL_DDL) {
    try {
      db.run(ddl);
    } catch (err) {
      log.error(`Schema DDL failed: ${ddl.slice(0, 80)}...`, err);
      throw err;
    }
  }
  log.debug(`Schema initialized (${ALL_DDL.length} statements)`);
}

/**
 * Persist the in-memory database to disk.
 */
export async function saveDatabase(): Promise<void> {
  if (!db) {
    throw new Error('Database not initialized — call getDatabase() first');
  }

  const data = db.export();
  const dir = dirname(dbFilePath);

  await mkdir(dir, { recursive: true });
  await writeFile(dbFilePath, data);
  log.debug('Database saved to disk');
}

/**
 * Save and close the database.
 * After this call, getDatabase() must be called again to re-open.
 */
export async function closeDatabase(): Promise<void> {
  if (!db) {
    return;
  }

  try {
    await saveDatabase();
  } catch (err) {
    log.error('Failed to save database before close', err);
  }

  db.close();
  db = null;
  initialized = false;
  log.info('Database closed');
}

// ── Metadata helpers ────────────────────────────────────────

function getMetadataValue(key: string): string | null {
  if (!db) return null;
  const stmt = db.prepare('SELECT value FROM index_metadata WHERE key = ?');
  stmt.bind([key]);
  let value: string | null = null;
  if (stmt.step()) {
    const row = stmt.getAsObject();
    value = row.value as string;
  }
  stmt.free();
  return value;
}

function setMetadataValue(key: string, value: string): void {
  if (!db) return;
  db.run(
    'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
    [key, value],
  );
}

/**
 * Check whether the database has been initialized.
 */
export function isInitialized(): boolean {
  return initialized;
}

/**
 * Get the current database file path.
 */
export function getDbFilePath(): string {
  return dbFilePath;
}
