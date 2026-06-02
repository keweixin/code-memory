/**
 * Code Memory Graph — Symbol Repository
 *
 * CRUD operations for the `symbols` table, including
 * FTS5 full-text search via the symbols_fts virtual table.
 */

import type { SymbolRecord, SymbolKind } from '../shared/types.js';
import { getDatabaseSync } from './database.js';
import { buildSearchText } from '../shared/search-text.js';

// ── Serialization ───────────────────────────────────────────

function serializeSymbol(record: Partial<SymbolRecord>): Record<string, unknown> {
  return {
    $id: record.id,
    $fileId: record.fileId,
    $name: record.name,
    $kind: record.kind,
    $startByte: record.startByte,
    $endByte: record.endByte,
    $startLine: record.startLine,
    $endLine: record.endLine,
    $startColumn: record.startColumn,
    $endColumn: record.endColumn,
    $rangeStart: record.rangeStart,
    $rangeEnd: record.rangeEnd,
    $signature: record.signature ?? null,
    $summary: record.summary ?? null,
    $hash: record.hash,
    $accessLevel: record.accessLevel ?? null,
    $searchText: record.searchText ?? buildSearchText([
      record.name,
      record.kind,
      record.signature,
      record.summary,
    ]),
  };
}

function deserializeSymbol(row: Record<string, unknown>): SymbolRecord {
  return {
    id: row.id as string,
    fileId: row.file_id as string,
    name: row.name as string,
    kind: row.kind as SymbolKind,
    startByte: row.start_byte as number,
    endByte: row.end_byte as number,
    startLine: row.start_line as number,
    endLine: row.end_line as number,
    startColumn: row.start_column as number,
    endColumn: row.end_column as number,
    rangeStart: row.range_start as number,
    rangeEnd: row.range_end as number,
    signature: (row.signature as string) ?? null,
    summary: (row.summary as string) ?? null,
    hash: row.hash as string,
    accessLevel: (row.access_level as SymbolRecord['accessLevel']) ?? null,
  };
}

// ── Repository methods ──────────────────────────────────────

export function upsertSymbol(symbol: SymbolRecord): void {
  const db = getDatabaseSync();
  const p = serializeSymbol(symbol);

  db.run(
    `INSERT OR REPLACE INTO symbols
       (id, file_id, name, kind, start_byte, end_byte, start_line, end_line,
        start_column, end_column, range_start, range_end,
        signature, summary, hash, access_level, search_text)
     VALUES ($id, $fileId, $name, $kind, $startByte, $endByte, $startLine, $endLine,
             $startColumn, $endColumn, $rangeStart, $rangeEnd,
             $signature, $summary, $hash, $accessLevel, $searchText)`,
    p,
  );
}

export function getSymbolById(id: string): SymbolRecord | null {
  const db = getDatabaseSync();
  const stmt = db.prepare('SELECT * FROM symbols WHERE id = ?');
  stmt.bind([id]);

  let result: SymbolRecord | null = null;
  if (stmt.step()) {
    result = deserializeSymbol(stmt.getAsObject());
  }
  stmt.free();
  return result;
}

export function getSymbolsByName(name: string): SymbolRecord[] {
  const db = getDatabaseSync();
  const results: SymbolRecord[] = [];
  const stmt = db.prepare('SELECT * FROM symbols WHERE name = ?');
  stmt.bind([name]);

  while (stmt.step()) {
    results.push(deserializeSymbol(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

export function getSymbolsByFileId(fileId: string): SymbolRecord[] {
  const db = getDatabaseSync();
  const results: SymbolRecord[] = [];
  const stmt = db.prepare('SELECT * FROM symbols WHERE file_id = ?');
  stmt.bind([fileId]);

  while (stmt.step()) {
    results.push(deserializeSymbol(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

export function getSymbolsByKind(kind: SymbolKind): SymbolRecord[] {
  const db = getDatabaseSync();
  const results: SymbolRecord[] = [];
  const stmt = db.prepare('SELECT * FROM symbols WHERE kind = ?');
  stmt.bind([kind]);

  while (stmt.step()) {
    results.push(deserializeSymbol(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

/**
 * Full-text search across symbol names, kinds, signatures, and summaries.
 * Uses the symbols_fts FTS5 virtual table and SQLite bm25 ranking.
 */
export function searchSymbols(query: string, limit: number = 20): SymbolRecord[] {
  const db = getDatabaseSync();
  const results: SymbolRecord[] = [];

  const FTS_SPECIAL = /["'*:^(){}[\]]/g;
  const sanitized = query.replace(FTS_SPECIAL, '').trim();

  if (!sanitized) {
    return results;
  }

  const ftsQuery = sanitized
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term}"`)
    .join(' ');
  const stmt = db.prepare(
    `SELECT s.* FROM symbols s
     JOIN symbols_fts fts ON s.rowid = fts.rowid
     WHERE symbols_fts MATCH ?
     ORDER BY bm25(symbols_fts) ASC
     LIMIT ?`,
  );
  stmt.bind([ftsQuery, limit]);

  while (stmt.step()) {
    results.push(deserializeSymbol(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

export function deleteSymbolsByFileId(fileId: string): void {
  const db = getDatabaseSync();
  db.run('DELETE FROM symbols WHERE file_id = ?', [fileId]);
}
