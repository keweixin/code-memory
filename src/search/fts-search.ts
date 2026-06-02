/**
 * Code Memory Graph — FTS5 Full-Text Search
 */

import type { SqlJsDatabase } from '../storage/database.js';
import type { SymbolKind } from '../shared/types.js';
import { normalizeIdentifierWords } from '../shared/search-text.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('fts-search');

export interface FtsSearchOptions {
  query: string;
  limit?: number;
  kindFilter?: SymbolKind;
  fileFilter?: string;
  searchTarget?: 'symbols' | 'files' | 'both';
}

export interface FtsSearchResult {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  score: number;
  snippet: string | null;
}

export function searchSymbolsFts(
  db: SqlJsDatabase,
  options: FtsSearchOptions,
): FtsSearchResult[] {
  const { query, limit = 20, kindFilter, fileFilter } = options;
  const ftsQuery = escapeFts5Query(query);
  if (!ftsQuery) return [];

  try {
    let sql = `SELECT
      s.id,
      s.name,
      s.kind,
      f.path AS file_path,
      bm25(symbols_fts) AS rank,
      snippet(symbols_fts, -1, '<<', '>>', '...', 12) AS snippet
    FROM symbols_fts
    JOIN symbols s ON s.rowid = symbols_fts.rowid
    JOIN files f ON f.id = s.file_id
    WHERE symbols_fts MATCH ?`;
    const params: Array<string | number> = [ftsQuery];

    if (kindFilter) {
      sql += ' AND s.kind = ?';
      params.push(kindFilter);
    }
    if (fileFilter) {
      sql += ' AND f.path LIKE ? ESCAPE \'\\\'';
      params.push(globToSqlLike(fileFilter));
    }
    sql += ' ORDER BY rank ASC LIMIT ?';
    params.push(limit);

    const rows = db.exec(sql, params)[0]?.values ?? [];
    return rows.map((row) => ({
      id: String(row[0]),
      name: String(row[1]),
      kind: String(row[2]),
      filePath: String(row[3]),
      score: bm25ToScore(Number(row[4])),
      snippet: row[5] ? String(row[5]) : null,
    }));
  } catch (err) {
    log.warn(`FTS5 symbol search failed for "${query}": ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export function searchFilesFts(
  db: SqlJsDatabase,
  query: string,
  limit: number = 20,
  fileFilter?: string,
): FtsSearchResult[] {
  const ftsQuery = escapeFts5Query(query);
  if (!ftsQuery) return [];

  try {
    let sql = `SELECT
      f.id,
      f.path,
      f.language,
      f.role,
      bm25(files_fts) AS rank,
      snippet(files_fts, -1, '<<', '>>', '...', 12) AS snippet
    FROM files_fts
    JOIN files f ON f.rowid = files_fts.rowid
    WHERE files_fts MATCH ?`;
    const params: Array<string | number> = [ftsQuery];

    if (fileFilter) {
      sql += ' AND f.path LIKE ? ESCAPE \'\\\'';
      params.push(globToSqlLike(fileFilter));
    }
    sql += ' ORDER BY rank ASC LIMIT ?';
    params.push(limit);

    const rows = db.exec(sql, params)[0]?.values ?? [];
    return rows.map((row) => ({
      id: String(row[0]),
      name: String(row[1]).split('/').pop() || String(row[1]),
      kind: 'file',
      filePath: String(row[1]),
      score: bm25ToScore(Number(row[4])),
      snippet: row[5] ? String(row[5]) : null,
    }));
  } catch (err) {
    log.warn(`FTS5 file search failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export function normalizeFts5Scores(results: FtsSearchResult[]): FtsSearchResult[] {
  if (results.length === 0) return results;
  return results.map((result, index) => ({
    ...result,
    score: result.score || 1 - index / Math.max(results.length, 1),
  }));
}

function escapeFts5Query(query: string): string {
  const terms = [
    ...query.split(/\s+/),
    ...normalizeIdentifierWords(query).split(/\s+/),
  ]
    .map((term) => term.replace(/[^A-Za-z0-9_]/g, '').trim())
    .filter(Boolean);

  const unique = [...new Set(terms)];
  if (unique.length === 0) return '';
  return unique.map((term) => `"${term}"`).join(' ');
}

function bm25ToScore(rank: number): number {
  if (!Number.isFinite(rank)) return 0;
  return 1 / (1 + Math.max(rank, 0));
}

function globToSqlLike(pattern: string): string {
  let result = '';
  const normalized = pattern.replace(/\\/g, '/');
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (char === '*') {
      result += '%';
      while (normalized[i + 1] === '*') i++;
    } else if (char === '?') {
      result += '_';
    } else if (char === '%' || char === '_' || char === '\\') {
      result += '\\' + char;
    } else {
      result += char;
    }
  }
  return result;
}
