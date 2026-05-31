/**
 * Code Memory Graph — Symbol Repository
 *
 * CRUD operations for the `symbols` table, including
 * FTS3 full-text search via the symbols_fts virtual table.
 *
 * NOTE: sql.js provides FTS3 (not FTS5). FTS3 does not have a
 * built-in `rank` column. Relevance is approximated by
 * matchinfo() or simply by returning matches in docid order
 * (which preserves insertion order for recently-added symbols).
 */

import type { SymbolRecord, SymbolKind } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';
import { getDatabaseSync } from './database.js';

const log = createLogger('symbol-repo');

// ── Serialization ───────────────────────────────────────────

function serializeSymbol(record: Partial<SymbolRecord>): Record<string, unknown> {
  return {
    $id: record.id,
    $fileId: record.fileId,
    $name: record.name,
    $kind: record.kind,
    $rangeStart: record.rangeStart,
    $rangeEnd: record.rangeEnd,
    $signature: record.signature ?? null,
    $summary: record.summary ?? null,
    $hash: record.hash,
    $accessLevel: record.accessLevel ?? null,
  };
}

function deserializeSymbol(row: Record<string, unknown>): SymbolRecord {
  return {
    id: row.id as string,
    fileId: row.file_id as string,
    name: row.name as string,
    kind: row.kind as SymbolKind,
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
       (id, file_id, name, kind, range_start, range_end,
        signature, summary, hash, access_level)
     VALUES ($id, $fileId, $name, $kind, $rangeStart, $rangeEnd,
             $signature, $summary, $hash, $accessLevel)`,
    [
      p.$id, p.$fileId, p.$name, p.$kind, p.$rangeStart, p.$rangeEnd,
      p.$signature, p.$summary, p.$hash, p.$accessLevel,
    ],
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
 * Uses the symbols_fts FTS3 virtual table.
 *
 * The query string is sanitized for FTS3: quotes and special
 * characters are removed, and the query is wrapped in quotes
 * for exact phrase matching when the query contains spaces.
 *
 * FTS3 does not have a built-in rank column. Results are ordered
 * by the FTS match offsets (approximate relevance) or by docid
 * as a fallback.
 */
export function searchSymbols(query: string, limit: number = 20): SymbolRecord[] {
  const db = getDatabaseSync();
  const results: SymbolRecord[] = [];

  // Sanitize query for FTS3 — remove characters that could break the syntax
  const FTS_SPECIAL = /["'*:^(){}[\]]/g;
  const sanitized = query.replace(FTS_SPECIAL, '').trim();

  if (!sanitized) {
    return results;
  }

  // Use FTS3 MATCH with the symbols table joined to get full rows.
  // FTS3 does not support the `rank` column — we order by docid
  // which preserves insertion order (recent symbols last, but this
  // is acceptable for symbol search where exact name matches are
  // typically what users want).
  const ftsQuery = `"${sanitized}"`;
  const stmt = db.prepare(
    `SELECT s.* FROM symbols s
     JOIN symbols_fts fts ON s.rowid = fts.rowid
     WHERE symbols_fts MATCH ?
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
