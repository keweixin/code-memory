/**
 * Code Memory Graph — Native SQLite Database Singleton
 *
 * Uses better-sqlite3 for page-backed persistence. The exported
 * SqlJsDatabase/SqlJsStatement names are compatibility aliases for the
 * pre-v3 repository layer; callers should gradually move to get/all and
 * transaction helpers.
 */

import DatabaseConstructor, {
  type Database as BetterSqliteDatabase,
  type Statement as BetterSqliteStatement,
} from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CONFIG_DIR, DATABASE_FILE } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import {
  CORE_TABLES,
  FTS_TABLES,
  FTS_TRIGGERS,
  INDEXES,
  PARSE_METADATA_TABLES,
  SCHEMA_VERSION,
} from './schema.js';

const log = createLogger('database');

export interface SqlJsStatement {
  bind(params?: unknown[] | Record<string, unknown>): boolean;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): boolean;
  reset(): boolean;
}

export interface SqlJsDatabase {
  run(sql: string, params?: unknown[] | Record<string, unknown>): SqlJsDatabase;
  exec(sql: string, params?: unknown[] | Record<string, unknown>): { columns: string[]; values: unknown[][] }[];
  prepare(sql: string): SqlJsStatement;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[] | Record<string, unknown>): T | undefined;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[] | Record<string, unknown>): T[];
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  close(): void;
  getRowsModified(): number;
  native: BetterSqliteDatabase;
}

type Params = unknown[] | Record<string, unknown> | undefined;

let db: NativeDatabaseAdapter | null = null;
let dbFilePath = '';
let initialized = false;
let legacySchemaDetected = false;

function resolveDbPath(basePath?: string): string {
  const root = resolve(basePath ?? process.cwd());
  return join(root, CONFIG_DIR, DATABASE_FILE);
}

export async function getDatabase(basePath?: string): Promise<SqlJsDatabase> {
  const nextPath = resolveDbPath(basePath);
  if (db && initialized && dbFilePath === nextPath) {
    return db;
  }
  if (db && dbFilePath !== nextPath) {
    await closeDatabase();
  }

  dbFilePath = nextPath;
  mkdirSync(dirname(dbFilePath), { recursive: true });

  log.info(`Opening database: ${dbFilePath}`);
  const native = new DatabaseConstructor(dbFilePath);
  db = new NativeDatabaseAdapter(native);

  applyPragmas(native);
  initializeSchema();
  setMetadataValue('schema_version', String(SCHEMA_VERSION));
  if (legacySchemaDetected) {
    setMetadataValue('needs_reindex', 'true');
  } else if (getMetadataValue('needs_reindex') === null) {
    setMetadataValue('needs_reindex', 'false');
  }

  initialized = true;
  log.info('Database initialized');
  return db;
}

export function getDatabaseSync(): SqlJsDatabase {
  if (!db || !initialized) {
    throw new Error('Database not initialized — call getDatabase() first');
  }
  return db;
}

export function initializeSchema(): void {
  if (!db) {
    throw new Error('Database not initialized — call getDatabase() first');
  }

  const native = db.native;
  legacySchemaDetected = detectLegacySchema(native);
  if (legacySchemaDetected) {
    dropLegacyFts(native);
  }

  const ddl = [
    ...CORE_TABLES,
    ...getSchemaMigrations(native),
    ...PARSE_METADATA_TABLES,
    ...FTS_TABLES,
    ...FTS_TRIGGERS,
    ...INDEXES,
  ];

  const apply = native.transaction((statements: string[]) => {
    for (const statement of statements) native.exec(statement);
  });

  try {
    apply(ddl);
    rebuildFtsIfEmpty(native);
  } catch (err) {
    log.error('Schema initialization failed', err);
    throw err;
  }
}

export async function saveDatabase(): Promise<void> {
  if (!db) {
    throw new Error('Database not initialized — call getDatabase() first');
  }
  try {
    db.native.pragma('wal_checkpoint(PASSIVE)');
  } catch {
    // Checkpointing is best effort; WAL still keeps durable pages.
  }
}

export async function closeDatabase(): Promise<void> {
  if (!db) return;
  try {
    await saveDatabase();
  } catch (err) {
    log.warn('Database checkpoint before close failed: ' + (err instanceof Error ? err.message : String(err)));
  }
  db.close();
  db = null;
  initialized = false;
  dbFilePath = '';
  log.info('Database closed');
}

export function isInitialized(): boolean {
  return initialized;
}

export function getDbFilePath(): string {
  return dbFilePath;
}

export function getSchemaVersion(): number {
  const value = getMetadataValue('schema_version');
  return value ? Number(value) : 0;
}

export function needsReindex(): boolean {
  if (!db) return true;
  if (getMetadataValue('needs_reindex') === 'true') return true;
  if (legacySchemaDetected) return true;
  if (getSchemaVersion() !== SCHEMA_VERSION) return true;
  return !tableExists(db.native, 'file_imports')
    || !tableExists(db.native, 'call_refs')
    || !isFts5Table(db.native, 'symbols_fts')
    || !isFts5Table(db.native, 'files_fts');
}

export function getDatabaseHealth(): {
  schemaVersion: number;
  needsReindex: boolean;
  walEnabled: boolean;
  fts5Available: boolean;
  nativeDriver: boolean;
} {
  const database = getDatabaseSync();
  return {
    schemaVersion: getSchemaVersion(),
    needsReindex: needsReindex(),
    walEnabled: String(database.exec('PRAGMA journal_mode')[0]?.values[0]?.[0] ?? '').toLowerCase() === 'wal',
    fts5Available: checkFts5(database.native),
    nativeDriver: true,
  };
}

function applyPragmas(native: BetterSqliteDatabase): void {
  native.pragma('journal_mode = WAL');
  native.pragma('synchronous = NORMAL');
  native.pragma('temp_store = MEMORY');
  native.pragma('foreign_keys = ON');
  native.pragma('busy_timeout = 5000');
}

function getMetadataValue(key: string): string | null {
  if (!db || !tableExists(db.native, 'index_metadata')) return null;
  const row = db.native.prepare('SELECT value FROM index_metadata WHERE key = ?').get(key) as { value?: string } | undefined;
  return row?.value ?? null;
}

function setMetadataValue(key: string, value: string): void {
  if (!db) return;
  db.native
    .prepare('INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)')
    .run(key, value);
}

function getSchemaMigrations(native: BetterSqliteDatabase): string[] {
  const migrations: string[] = [];
  migrations.push(...missingColumnMigrations(native, 'files', [
    ['search_text', "TEXT NOT NULL DEFAULT ''"],
  ]));
  migrations.push(...missingColumnMigrations(native, 'symbols', [
    ['start_byte', 'INTEGER NOT NULL DEFAULT 0'],
    ['end_byte', 'INTEGER NOT NULL DEFAULT 0'],
    ['start_line', 'INTEGER NOT NULL DEFAULT 0'],
    ['end_line', 'INTEGER NOT NULL DEFAULT 0'],
    ['start_column', 'INTEGER NOT NULL DEFAULT 0'],
    ['end_column', 'INTEGER NOT NULL DEFAULT 0'],
    ['search_text', "TEXT NOT NULL DEFAULT ''"],
  ]));
  migrations.push(...missingColumnMigrations(native, 'chunks', [
    ['start_byte', 'INTEGER NOT NULL DEFAULT 0'],
    ['end_byte', 'INTEGER NOT NULL DEFAULT 0'],
    ['start_line', 'INTEGER NOT NULL DEFAULT 0'],
    ['end_line', 'INTEGER NOT NULL DEFAULT 0'],
    ['start_column', 'INTEGER NOT NULL DEFAULT 0'],
    ['end_column', 'INTEGER NOT NULL DEFAULT 0'],
  ]));
  return migrations;
}

function missingColumnMigrations(
  native: BetterSqliteDatabase,
  table: string,
  columns: Array<[string, string]>,
): string[] {
  if (!tableExists(native, table)) return [];
  const existing = new Set(
    (native.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  return columns
    .filter(([name]) => !existing.has(name))
    .map(([name, definition]) => `ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${quoteIdent(name)} ${definition}`);
}

function detectLegacySchema(native: BetterSqliteDatabase): boolean {
  if (!existsSync(dbFilePath)) return false;
  const version = tableExists(native, 'index_metadata')
    ? (native.prepare("SELECT value FROM index_metadata WHERE key = 'schema_version'").get() as { value?: string } | undefined)?.value
    : null;
  if (version && Number(version) < SCHEMA_VERSION) return true;
  return isFts3Table(native, 'symbols_fts') || isFts3Table(native, 'files_fts');
}

function dropLegacyFts(native: BetterSqliteDatabase): void {
  const statements = [
    'DROP TRIGGER IF EXISTS symbols_fts_insert',
    'DROP TRIGGER IF EXISTS symbols_fts_update',
    'DROP TRIGGER IF EXISTS symbols_fts_delete',
    'DROP TRIGGER IF EXISTS files_fts_insert',
    'DROP TRIGGER IF EXISTS files_fts_update',
    'DROP TRIGGER IF EXISTS files_fts_delete',
    'DROP TABLE IF EXISTS symbols_fts',
    'DROP TABLE IF EXISTS files_fts',
  ];
  for (const statement of statements) native.exec(statement);
}

function rebuildFtsIfEmpty(native: BetterSqliteDatabase): void {
  const symbolCount = (native.prepare('SELECT COUNT(*) AS count FROM symbols_fts').get() as { count: number }).count;
  if (symbolCount === 0 && tableExists(native, 'symbols')) {
    native.exec(
      `INSERT INTO symbols_fts(rowid, name, kind, signature, summary, search_text, file_id)
       SELECT rowid, name, kind, COALESCE(signature, ''), COALESCE(summary, ''),
              COALESCE(search_text, ''), file_id
       FROM symbols`,
    );
  }

  const fileCount = (native.prepare('SELECT COUNT(*) AS count FROM files_fts').get() as { count: number }).count;
  if (fileCount === 0 && tableExists(native, 'files')) {
    native.exec(
      `INSERT INTO files_fts(rowid, path, summary, language, role, search_text)
       SELECT rowid, path, COALESCE(summary, ''), language, role, COALESCE(search_text, '')
       FROM files`,
    );
  }
}

function tableExists(native: BetterSqliteDatabase, table: string): boolean {
  const row = native
    .prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? LIMIT 1")
    .get(table);
  return Boolean(row);
}

function isFts3Table(native: BetterSqliteDatabase, table: string): boolean {
  const row = native.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(table) as { sql?: string } | undefined;
  return Boolean(row?.sql?.toLowerCase().includes('using fts3'));
}

function isFts5Table(native: BetterSqliteDatabase, table: string): boolean {
  const row = native.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(table) as { sql?: string } | undefined;
  return Boolean(row?.sql?.toLowerCase().includes('using fts5'));
}

function checkFts5(native: BetterSqliteDatabase): boolean {
  try {
    native.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.__cm_fts5_check USING fts5(value)");
    native.exec('DROP TABLE IF EXISTS temp.__cm_fts5_check');
    return true;
  } catch {
    return false;
  }
}

function quoteIdent(identifier: string): string {
  return '"' + identifier.replace(/"/g, '""') + '"';
}

class NativeDatabaseAdapter implements SqlJsDatabase {
  native: BetterSqliteDatabase;
  private lastRowsModified = 0;

  constructor(native: BetterSqliteDatabase) {
    this.native = native;
  }

  run(sql: string, params?: Params): SqlJsDatabase {
    const normalized = normalizeSqlAndParams(sql, params);
    const info = this.native.prepare(normalized.sql).run(normalized.params ?? []);
    this.lastRowsModified = Number(info.changes ?? 0);
    return this;
  }

  exec(sql: string, params?: Params): { columns: string[]; values: unknown[][] }[] {
    const normalized = normalizeSqlAndParams(sql, params);
    const statement = this.native.prepare(normalized.sql);
    if (!statement.reader) {
      const info = statement.run(normalized.params ?? []);
      this.lastRowsModified = Number(info.changes ?? 0);
      return [];
    }
    const columns = statement.columns().map((column) => column.name);
    const rawRows = statement.raw().all(normalized.params ?? []) as unknown[][];
    return [{
      columns,
      values: rawRows,
    }];
  }

  prepare(sql: string): SqlJsStatement {
    return new NativeStatementAdapter(this.native, sql);
  }

  get<T = Record<string, unknown>>(sql: string, params?: Params): T | undefined {
    const normalized = normalizeSqlAndParams(sql, params);
    return this.native.prepare(normalized.sql).get(normalized.params ?? []) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, params?: Params): T[] {
    const normalized = normalizeSqlAndParams(sql, params);
    return this.native.prepare(normalized.sql).all(normalized.params ?? []) as T[];
  }

  transaction<T extends (...args: never[]) => unknown>(fn: T): T {
    return this.native.transaction(fn) as unknown as T;
  }

  close(): void {
    this.native.close();
  }

  getRowsModified(): number {
    return this.lastRowsModified;
  }
}

class NativeStatementAdapter implements SqlJsStatement {
  private native: BetterSqliteDatabase;
  private sql: string;
  private boundParams: Params;
  private statement: BetterSqliteStatement | null = null;
  private rows: Record<string, unknown>[] | null = null;
  private index = -1;

  constructor(native: BetterSqliteDatabase, sql: string) {
    this.native = native;
    this.sql = sql;
  }

  bind(params?: Params): boolean {
    this.boundParams = params;
    this.statement = null;
    this.rows = null;
    this.index = -1;
    return true;
  }

  step(): boolean {
    if (!this.rows) {
      const normalized = normalizeSqlAndParams(this.sql, this.boundParams);
      this.statement = this.native.prepare(normalized.sql);
      if (!this.statement.reader) {
        this.statement.run(normalized.params ?? []);
        this.rows = [];
      } else {
        this.rows = this.statement.all(normalized.params ?? []) as Record<string, unknown>[];
      }
    }
    this.index += 1;
    return this.index < this.rows.length;
  }

  getAsObject(): Record<string, unknown> {
    return this.rows?.[this.index] ?? {};
  }

  free(): boolean {
    this.statement = null;
    this.rows = null;
    this.index = -1;
    return true;
  }

  reset(): boolean {
    this.rows = null;
    this.index = -1;
    return true;
  }
}

function normalizeSqlAndParams(sql: string, params?: Params): { sql: string; params?: unknown[] | Record<string, unknown> } {
  if (!Array.isArray(params)) return { sql, params };
  if (!/\$[A-Za-z_][A-Za-z0-9_]*/.test(sql)) return { sql, params };
  return {
    sql: sql.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, '?'),
    params,
  };
}
