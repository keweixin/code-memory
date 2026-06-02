/**
 * Code Memory Graph — Database Schema
 *
 * Schema v7 uses native SQLite + WAL + FTS5 and adds process and
 * community tables for feature/process tracking and graph community
 * detection. v0.1 does not migrate legacy index contents; users should
 * run `code-memory index --full` after upgrading from an older schema.
 */

export const SCHEMA_VERSION = 7;

export const CORE_TABLES: string[] = [
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
    risk_level      TEXT NOT NULL DEFAULT 'low',
    search_text     TEXT NOT NULL DEFAULT ''
  )`,

  `CREATE TABLE IF NOT EXISTS symbols (
    id              TEXT PRIMARY KEY,
    file_id         TEXT NOT NULL,
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'function',
    start_byte      INTEGER NOT NULL DEFAULT 0,
    end_byte        INTEGER NOT NULL DEFAULT 0,
    start_line      INTEGER NOT NULL DEFAULT 0,
    end_line        INTEGER NOT NULL DEFAULT 0,
    start_column    INTEGER NOT NULL DEFAULT 0,
    end_column      INTEGER NOT NULL DEFAULT 0,
    range_start     INTEGER NOT NULL DEFAULT 0,
    range_end       INTEGER NOT NULL DEFAULT 0,
    signature       TEXT,
    summary         TEXT,
    hash            TEXT NOT NULL DEFAULT '',
    access_level    TEXT,
    search_text     TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS edges (
    id              TEXT PRIMARY KEY,
    from_id         TEXT NOT NULL,
    to_id           TEXT NOT NULL,
    type            TEXT NOT NULL,
    confidence      REAL NOT NULL DEFAULT 1.0,
    evidence        TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS graph_edge_evidence (
    id              TEXT PRIMARY KEY,
    edge_id         TEXT NOT NULL,
    source_table    TEXT,
    source_id       TEXT,
    file_id         TEXT,
    start_line      INTEGER NOT NULL DEFAULT 0,
    start_column    INTEGER NOT NULL DEFAULT 0,
    evidence        TEXT,
    created_at      TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (edge_id) REFERENCES edges(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS chunks (
    id              TEXT PRIMARY KEY,
    file_id         TEXT NOT NULL,
    symbol_id       TEXT,
    start_byte      INTEGER NOT NULL DEFAULT 0,
    end_byte        INTEGER NOT NULL DEFAULT 0,
    start_line      INTEGER NOT NULL DEFAULT 0,
    end_line        INTEGER NOT NULL DEFAULT 0,
    start_column    INTEGER NOT NULL DEFAULT 0,
    end_column      INTEGER NOT NULL DEFAULT 0,
    content_hash    TEXT NOT NULL DEFAULT '',
    content         TEXT NOT NULL DEFAULT '',
    token_count     INTEGER NOT NULL DEFAULT 0,
    summary         TEXT,
    embedding_id    TEXT,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
  )`,

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

  `CREATE TABLE IF NOT EXISTS context_ledger (
    id                      TEXT PRIMARY KEY,
    session_id              TEXT NOT NULL,
    task_id                 TEXT,
    repo_root               TEXT,
    branch                  TEXT,
    commit_hash             TEXT,
    query                   TEXT NOT NULL DEFAULT '',
    returned_files          TEXT NOT NULL DEFAULT '[]',
    returned_symbols        TEXT NOT NULL DEFAULT '[]',
    returned_chunks         TEXT NOT NULL DEFAULT '[]',
    token_estimate          INTEGER NOT NULL DEFAULT 0,
    evidence_ids            TEXT NOT NULL DEFAULT '[]',
    evidence_fingerprints   TEXT NOT NULL DEFAULT '[]',
    novelty_score           REAL NOT NULL DEFAULT 1.0,
    repeated_penalty        REAL NOT NULL DEFAULT 0.0,
    agent_feedback          TEXT,
    feedback_reason         TEXT,
    created_at              TEXT NOT NULL DEFAULT ''
  )`,

  `CREATE TABLE IF NOT EXISTS index_metadata (
    key             TEXT PRIMARY KEY,
    value           TEXT NOT NULL DEFAULT ''
  )`,
];

export const PARSE_METADATA_TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS file_imports (
    id              TEXT PRIMARY KEY,
    file_id         TEXT NOT NULL,
    source          TEXT NOT NULL,
    imported_name   TEXT,
    local_name      TEXT,
    kind            TEXT NOT NULL DEFAULT 'named',
    is_type_only    INTEGER NOT NULL DEFAULT 0,
    start_line      INTEGER NOT NULL DEFAULT 0,
    start_column    INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS file_exports (
    id              TEXT PRIMARY KEY,
    file_id         TEXT NOT NULL,
    exported_name   TEXT NOT NULL,
    local_name      TEXT,
    source          TEXT,
    kind            TEXT NOT NULL DEFAULT 'named',
    start_line      INTEGER NOT NULL DEFAULT 0,
    start_column    INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS call_refs (
    id                    TEXT PRIMARY KEY,
    file_id               TEXT NOT NULL,
    caller_symbol_id      TEXT,
    caller_name           TEXT,
    caller_start_line     INTEGER,
    caller_class_name     TEXT,
    callee_name           TEXT NOT NULL,
    receiver_name         TEXT,
    receiver_kind         TEXT,
    member_name           TEXT,
    is_constructor_call   INTEGER NOT NULL DEFAULT 0,
    start_line            INTEGER NOT NULL DEFAULT 0,
    start_column          INTEGER NOT NULL DEFAULT 0,
    evidence              TEXT,
    resolution_status     TEXT NOT NULL DEFAULT 'unresolved',
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS scope_bindings (
    id                TEXT PRIMARY KEY,
    file_id           TEXT NOT NULL,
    symbol_id         TEXT,
    local_name        TEXT NOT NULL,
    binding_kind      TEXT NOT NULL,
    target_name       TEXT,
    target_symbol_id  TEXT,
    start_line        INTEGER NOT NULL DEFAULT 0,
    end_line          INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS type_relations (
    id                TEXT PRIMARY KEY,
    file_id           TEXT NOT NULL,
    from_symbol_id    TEXT,
    relation_kind     TEXT NOT NULL,
    target_name       TEXT NOT NULL,
    target_symbol_id  TEXT,
    evidence          TEXT,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS route_endpoints (
    id                TEXT PRIMARY KEY,
    file_id           TEXT NOT NULL,
    symbol_id         TEXT,
    route_path        TEXT NOT NULL,
    http_method       TEXT NOT NULL,
    framework         TEXT NOT NULL,
    start_line        INTEGER NOT NULL DEFAULT 0,
    start_column      INTEGER NOT NULL DEFAULT 0,
    evidence          TEXT,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS route_references (
    id                TEXT PRIMARY KEY,
    file_id           TEXT NOT NULL,
    caller_symbol_id  TEXT,
    route_path        TEXT NOT NULL,
    http_method       TEXT,
    framework         TEXT NOT NULL,
    start_line        INTEGER NOT NULL DEFAULT 0,
    start_column      INTEGER NOT NULL DEFAULT 0,
    evidence          TEXT,
    resolution_status TEXT NOT NULL DEFAULT 'unresolved',
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
  )`,
];

export const PROCESS_AND_COMMUNITY_TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS processes (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    entry_point     TEXT NOT NULL,
    entry_kind      TEXT NOT NULL DEFAULT 'route',
    framework       TEXT,
    depth_limit     INTEGER NOT NULL DEFAULT 10,
    step_count      INTEGER NOT NULL DEFAULT 0,
    last_indexed    TEXT,
    created_at      TEXT NOT NULL DEFAULT ''
  )`,

  `CREATE TABLE IF NOT EXISTS process_steps (
    id              TEXT PRIMARY KEY,
    process_id      TEXT NOT NULL,
    step            INTEGER NOT NULL,
    symbol_id       TEXT,
    file_id         TEXT,
    edge_id         TEXT,
    label           TEXT,
    FOREIGN KEY (process_id) REFERENCES processes(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS communities (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    cohesion        REAL NOT NULL DEFAULT 0.0,
    symbol_count    INTEGER NOT NULL DEFAULT 0,
    keywords        TEXT NOT NULL DEFAULT '[]',
    detection_method TEXT NOT NULL DEFAULT 'louvain',
    top_entry_symbols TEXT NOT NULL DEFAULT '[]',
    last_indexed    TEXT,
    created_at      TEXT NOT NULL DEFAULT ''
  )`,

  `CREATE TABLE IF NOT EXISTS community_members (
    id              TEXT PRIMARY KEY,
    community_id    TEXT NOT NULL,
    symbol_id       TEXT NOT NULL,
    file_id         TEXT,
    weight          REAL NOT NULL DEFAULT 1.0,
    FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE
  )`,
];

export const FTS_TABLES: string[] = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts
    USING fts5(name, kind, signature, summary, search_text, file_id,
               content='symbols', content_rowid='rowid', tokenize='unicode61')`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS files_fts
    USING fts5(path, summary, language, role, search_text,
               content='files', content_rowid='rowid', tokenize='unicode61')`,
];

export const FTS_TRIGGERS: string[] = [
  `CREATE TRIGGER IF NOT EXISTS symbols_fts_insert
    AFTER INSERT ON symbols
    BEGIN
      INSERT INTO symbols_fts(rowid, name, kind, signature, summary, search_text, file_id)
        VALUES (new.rowid, new.name, new.kind, COALESCE(new.signature, ''),
                COALESCE(new.summary, ''), COALESCE(new.search_text, ''), new.file_id);
    END`,

  `CREATE TRIGGER IF NOT EXISTS symbols_fts_update
    AFTER UPDATE ON symbols
    BEGIN
      INSERT INTO symbols_fts(symbols_fts, rowid, name, kind, signature, summary, search_text, file_id)
        VALUES ('delete', old.rowid, old.name, old.kind, COALESCE(old.signature, ''),
                COALESCE(old.summary, ''), COALESCE(old.search_text, ''), old.file_id);
      INSERT INTO symbols_fts(rowid, name, kind, signature, summary, search_text, file_id)
        VALUES (new.rowid, new.name, new.kind, COALESCE(new.signature, ''),
                COALESCE(new.summary, ''), COALESCE(new.search_text, ''), new.file_id);
    END`,

  `CREATE TRIGGER IF NOT EXISTS symbols_fts_delete
    AFTER DELETE ON symbols
    BEGIN
      INSERT INTO symbols_fts(symbols_fts, rowid, name, kind, signature, summary, search_text, file_id)
        VALUES ('delete', old.rowid, old.name, old.kind, COALESCE(old.signature, ''),
                COALESCE(old.summary, ''), COALESCE(old.search_text, ''), old.file_id);
    END`,

  `CREATE TRIGGER IF NOT EXISTS files_fts_insert
    AFTER INSERT ON files
    BEGIN
      INSERT INTO files_fts(rowid, path, summary, language, role, search_text)
        VALUES (new.rowid, new.path, COALESCE(new.summary, ''), new.language,
                new.role, COALESCE(new.search_text, ''));
    END`,

  `CREATE TRIGGER IF NOT EXISTS files_fts_update
    AFTER UPDATE ON files
    BEGIN
      INSERT INTO files_fts(files_fts, rowid, path, summary, language, role, search_text)
        VALUES ('delete', old.rowid, old.path, COALESCE(old.summary, ''), old.language,
                old.role, COALESCE(old.search_text, ''));
      INSERT INTO files_fts(rowid, path, summary, language, role, search_text)
        VALUES (new.rowid, new.path, COALESCE(new.summary, ''), new.language,
                new.role, COALESCE(new.search_text, ''));
    END`,

  `CREATE TRIGGER IF NOT EXISTS files_fts_delete
    AFTER DELETE ON files
    BEGIN
      INSERT INTO files_fts(files_fts, rowid, path, summary, language, role, search_text)
        VALUES ('delete', old.rowid, old.path, COALESCE(old.summary, ''), old.language,
                old.role, COALESCE(old.search_text, ''));
    END`,
];

export const INDEXES: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_files_path ON files(path)`,
  `CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash)`,
  `CREATE INDEX IF NOT EXISTS idx_files_language ON files(language)`,
  `CREATE INDEX IF NOT EXISTS idx_files_role ON files(role)`,

  `CREATE INDEX IF NOT EXISTS idx_symbols_file_id ON symbols(file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind)`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_name_kind ON symbols(name, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_hash ON symbols(hash)`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_location ON symbols(file_id, start_line, start_column)`,

  `CREATE INDEX IF NOT EXISTS idx_edges_from_id ON edges(from_id)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_to_id ON edges(to_id)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_from_type ON edges(from_id, type)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_to_type ON edges(to_id, type)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_from_to ON edges(from_id, to_id)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_confidence ON edges(type, confidence)`,

  `CREATE INDEX IF NOT EXISTS idx_graph_edge_evidence_edge ON graph_edge_evidence(edge_id)`,
  `CREATE INDEX IF NOT EXISTS idx_graph_edge_evidence_source ON graph_edge_evidence(source_table, source_id)`,
  `CREATE INDEX IF NOT EXISTS idx_graph_edge_evidence_file ON graph_edge_evidence(file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_graph_edge_evidence_location ON graph_edge_evidence(file_id, start_line, start_column)`,

  `CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_symbol_id ON chunks(symbol_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_location ON chunks(file_id, start_line, start_column)`,

  `CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope)`,

  `CREATE INDEX IF NOT EXISTS idx_context_ledger_session ON context_ledger(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_context_ledger_created_at ON context_ledger(created_at)`,

  `CREATE INDEX IF NOT EXISTS idx_file_imports_file ON file_imports(file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_file_imports_source ON file_imports(source)`,
  `CREATE INDEX IF NOT EXISTS idx_file_imports_local ON file_imports(local_name)`,
  `CREATE INDEX IF NOT EXISTS idx_file_exports_file ON file_exports(file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_file_exports_name ON file_exports(exported_name)`,
  `CREATE INDEX IF NOT EXISTS idx_call_refs_file ON call_refs(file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_call_refs_callee ON call_refs(callee_name)`,
  `CREATE INDEX IF NOT EXISTS idx_call_refs_receiver ON call_refs(receiver_name, member_name)`,
  `CREATE INDEX IF NOT EXISTS idx_call_refs_status ON call_refs(resolution_status)`,
  `CREATE INDEX IF NOT EXISTS idx_scope_bindings_file_name ON scope_bindings(file_id, local_name)`,
  `CREATE INDEX IF NOT EXISTS idx_scope_bindings_target ON scope_bindings(target_name)`,
  `CREATE INDEX IF NOT EXISTS idx_type_relations_file ON type_relations(file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_type_relations_target ON type_relations(target_name)`,
  `CREATE INDEX IF NOT EXISTS idx_route_endpoints_file ON route_endpoints(file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_route_endpoints_path_method ON route_endpoints(route_path, http_method)`,
  `CREATE INDEX IF NOT EXISTS idx_route_references_file ON route_references(file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_route_references_path_method ON route_references(route_path, http_method)`,
  `CREATE INDEX IF NOT EXISTS idx_route_references_status ON route_references(resolution_status)`,

  `CREATE INDEX IF NOT EXISTS idx_processes_name ON processes(name)`,
  `CREATE INDEX IF NOT EXISTS idx_process_steps_process_id ON process_steps(process_id)`,
  `CREATE INDEX IF NOT EXISTS idx_process_steps_step ON process_steps(process_id, step)`,
  `CREATE INDEX IF NOT EXISTS idx_communities_name ON communities(name)`,
  `CREATE INDEX IF NOT EXISTS idx_community_members_community ON community_members(community_id)`,
  `CREATE INDEX IF NOT EXISTS idx_community_members_symbol ON community_members(symbol_id)`,
];

export const ALL_DDL: string[] = [
  ...CORE_TABLES,
  ...PARSE_METADATA_TABLES,
  ...PROCESS_AND_COMMUNITY_TABLES,
  ...FTS_TABLES,
  ...FTS_TRIGGERS,
  ...INDEXES,
];
