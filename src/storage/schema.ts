/**
 * Code Memory Graph — Database Schema
 *
 * DDL statements for all tables, FTS3 virtual tables,
 * sync triggers, and indexes.
 *
 * NOTE: sql.js (WASM SQLite) ships with FTS3 enabled but NOT FTS5.
 * All full-text search uses FTS3 with the porter + unicode61 tokenizer.
 * FTS3 uses `docid` for explicit row-id inserts and does not provide
 * a built-in `rank` column — relevance ordering is handled in the
 * repository query layer.
 */

export const SCHEMA_VERSION = 1;

/**
 * Core tables DDL — executed in order.
 */
export const CORE_TABLES: string[] = [
  // ── files ──────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS files (
    id              TEXT PRIMARY KEY,
    path            TEXT NOT NULL UNIQUE,
    language        TEXT NOT NULL DEFAULT 'unknown',
    role            TEXT NOT NULL DEFAULT 'source',
    size            INTEGER NOT NULL DEFAULT 0,
    hash            TEXT NOT NULL DEFAULT '',
    indexed_at      TEXT NOT NULL DEFAULT '',
    last_commit     TEXT,
    is_generated    INTEGER NOT NULL DEFAULT 0,
    is_ignored      INTEGER NOT NULL DEFAULT 0,
    exports         TEXT NOT NULL DEFAULT '[]',
    imports         TEXT NOT NULL DEFAULT '[]',
    summary         TEXT,
    risk_level      TEXT NOT NULL DEFAULT 'low'
  )`,

  // ── symbols ────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS symbols (
    id              TEXT PRIMARY KEY,
    file_id         TEXT NOT NULL,
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'function',
    range_start     INTEGER NOT NULL DEFAULT 0,
    range_end       INTEGER NOT NULL DEFAULT 0,
    signature       TEXT,
    summary         TEXT,
    hash            TEXT NOT NULL DEFAULT '',
    access_level    TEXT,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
  )`,

  // ── edges ──────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS edges (
    id              TEXT PRIMARY KEY,
    from_id         TEXT NOT NULL,
    to_id           TEXT NOT NULL,
    type            TEXT NOT NULL,
    confidence      REAL NOT NULL DEFAULT 1.0,
    evidence        TEXT
  )`,

  // ── chunks ─────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS chunks (
    id              TEXT PRIMARY KEY,
    file_id         TEXT NOT NULL,
    symbol_id       TEXT,
    content_hash    TEXT NOT NULL DEFAULT '',
    content         TEXT NOT NULL DEFAULT '',
    token_count     INTEGER NOT NULL DEFAULT 0,
    summary         TEXT,
    embedding_id    TEXT,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
  )`,

  // ── memories ───────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS memories (
    id                      TEXT PRIMARY KEY,
    type                    TEXT NOT NULL,
    content                 TEXT NOT NULL DEFAULT '',
    scope                   TEXT NOT NULL DEFAULT '[]',
    evidence                TEXT NOT NULL DEFAULT '[]',
    confidence              REAL NOT NULL DEFAULT 1.0,
    created_commit          TEXT,
    last_validated_commit   TEXT,
    invalidation_rules      TEXT NOT NULL DEFAULT '[]',
    created_at              TEXT NOT NULL DEFAULT '',
    updated_at              TEXT NOT NULL DEFAULT ''
  )`,

  // ── index_metadata ─────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS index_metadata (
    key             TEXT PRIMARY KEY,
    value           TEXT NOT NULL DEFAULT ''
  )`,
];

/**
 * FTS3 virtual tables for full-text search.
 *
 * sql.js does not include FTS5 — we use FTS3 which is compiled in
 * with ENABLE_FTS3 and ENABLE_FTS3_PARENTHESIS.
 *
 * FTS3 tokenizer: 'porter unicode61' provides stemming and
 * Unicode-aware tokenization.
 */
export const FTS_TABLES: string[] = [
  // FTS on symbols — synced via triggers
  `CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts
    USING fts3(name, kind, signature, summary, file_id,
               tokenize=porter unicode61)`,

  // FTS on files — for file path / summary search
  `CREATE VIRTUAL TABLE IF NOT EXISTS files_fts
    USING fts3(path, summary, language, role,
               tokenize=porter unicode61)`,
];

/**
 * Triggers to keep symbols_fts in sync with the symbols table.
 *
 * FTS3 uses `docid` for explicit row-id specification (equivalent
 * to `rowid` but the preferred syntax for FTS3 content tables).
 * The triggers use the source table's `rowid` as the FTS `docid`
 * so JOINs on rowid work correctly.
 */
export const FTS_TRIGGERS: string[] = [
  // INSERT trigger
  `CREATE TRIGGER IF NOT EXISTS symbols_fts_insert
    AFTER INSERT ON symbols
    BEGIN
      INSERT INTO symbols_fts(docid, name, kind, signature, summary, file_id)
        VALUES (
          new.rowid, new.name, new.kind,
          COALESCE(new.signature, ''),
          COALESCE(new.summary, ''),
          new.file_id
        );
    END`,

  // UPDATE trigger
  `CREATE TRIGGER IF NOT EXISTS symbols_fts_update
    AFTER UPDATE ON symbols
    BEGIN
      DELETE FROM symbols_fts WHERE docid = old.rowid;
      INSERT INTO symbols_fts(docid, name, kind, signature, summary, file_id)
        VALUES (
          new.rowid, new.name, new.kind,
          COALESCE(new.signature, ''),
          COALESCE(new.summary, ''),
          new.file_id
        );
    END`,

  // DELETE trigger
  `CREATE TRIGGER IF NOT EXISTS symbols_fts_delete
    AFTER DELETE ON symbols
    BEGIN
      DELETE FROM symbols_fts WHERE docid = old.rowid;
    END`,
];

/**
 * Performance indexes.
 */
export const INDEXES: string[] = [
  // files
  `CREATE INDEX IF NOT EXISTS idx_files_path ON files(path)`,
  `CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash)`,
  `CREATE INDEX IF NOT EXISTS idx_files_language ON files(language)`,
  `CREATE INDEX IF NOT EXISTS idx_files_role ON files(role)`,

  // symbols
  `CREATE INDEX IF NOT EXISTS idx_symbols_file_id ON symbols(file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind)`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_hash ON symbols(hash)`,

  // edges
  `CREATE INDEX IF NOT EXISTS idx_edges_from_id ON edges(from_id)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_to_id ON edges(to_id)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_from_type ON edges(from_id, type)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_to_type ON edges(to_id, type)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_from_to ON edges(from_id, to_id)`,

  // chunks
  `CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_symbol_id ON chunks(symbol_id)`,

  // memories
  `CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope)`,
];

/**
 * All DDL statements in execution order.
 */
export const ALL_DDL: string[] = [
  ...CORE_TABLES,
  ...FTS_TABLES,
  ...FTS_TRIGGERS,
  ...INDEXES,
];
