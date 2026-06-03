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
  const ftsQueries = buildFts5Queries(query);
  if (ftsQueries.length === 0) return [];

  try {
    return runFtsQueries(db, {
      table: 'symbols_fts',
      matchColumn: 'symbols_fts',
      selectSql: `SELECT
        s.id,
        s.name,
        s.kind,
        f.path AS file_path,
        bm25(symbols_fts) AS rank,
        snippet(symbols_fts, -1, '<<', '>>', '...', 12) AS snippet
      FROM symbols_fts
      JOIN symbols s ON s.rowid = symbols_fts.rowid
      JOIN files f ON f.id = s.file_id`,
      buildFilters(sql, params) {
        if (kindFilter) {
          sql += ' AND s.kind = ?';
          params.push(kindFilter);
        }
        if (fileFilter) {
          sql += ' AND f.path LIKE ? ESCAPE \'\\\'';
          params.push(globToSqlLike(fileFilter));
        }
        return sql;
      },
      queries: ftsQueries,
      limit,
      mapRow: (row) => ({
        id: String(row[0]),
        name: String(row[1]),
        kind: String(row[2]),
        filePath: String(row[3]),
        score: bm25ToScore(Number(row[4])),
        snippet: row[5] ? String(row[5]) : null,
      }),
    });
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
  const ftsQueries = buildFts5Queries(query);
  if (ftsQueries.length === 0) return [];

  try {
    return runFtsQueries(db, {
      table: 'files_fts',
      matchColumn: 'files_fts',
      selectSql: `SELECT
        f.id,
        f.path,
        f.language,
        f.role,
        bm25(files_fts) AS rank,
        snippet(files_fts, -1, '<<', '>>', '...', 12) AS snippet
      FROM files_fts
      JOIN files f ON f.rowid = files_fts.rowid`,
      buildFilters(sql, params) {
        if (fileFilter) {
          sql += ' AND f.path LIKE ? ESCAPE \'\\\'';
          params.push(globToSqlLike(fileFilter));
        }
        return sql;
      },
      queries: ftsQueries,
      limit,
      mapRow: (row) => ({
        id: String(row[0]),
        name: String(row[1]).split('/').pop() || String(row[1]),
        kind: 'file',
        filePath: String(row[1]),
        score: bm25ToScore(Number(row[4])),
        snippet: row[5] ? String(row[5]) : null,
      }),
    });
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

function buildFts5Queries(query: string): string[] {
  const rawTerms = [
    ...query.split(/\s+/),
    ...normalizeIdentifierWords(query).split(/\s+/),
  ]
    .map((term) => term.replace(/[^A-Za-z0-9_]/g, '').trim())
    .filter(Boolean);

  const unique = [...new Set(rawTerms)];
  if (unique.length === 0) return [];

  const strict = unique.map((term) => quoteFtsTerm(term)).join(' ');
  const meaningful = unique.filter((term) => !STOP_WORDS.has(term.toLowerCase()));
  const relaxedTerms = meaningful.length > 0 ? meaningful : unique;
  const relaxed = relaxedTerms.map((term) => quoteFtsTerm(term)).join(' OR ');
  return strict === relaxed ? [strict] : [strict, relaxed];
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'before', 'by', 'class', 'does', 'for', 'from',
  'how', 'in', 'into', 'is', 'it', 'logic', 'of', 'on', 'or', 'that', 'the',
  'this', 'to', 'where', 'with',
]);

function quoteFtsTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

function runFtsQueries(optionsDb: SqlJsDatabase, options: {
  table: string;
  matchColumn: string;
  selectSql: string;
  buildFilters: (sql: string, params: Array<string | number>) => string;
  queries: string[];
  limit: number;
  mapRow: (row: unknown[]) => FtsSearchResult;
}): FtsSearchResult[] {
  const results: FtsSearchResult[] = [];
  const seen = new Set<string>();

  for (const query of options.queries) {
    let sql = `${options.selectSql} WHERE ${options.matchColumn} MATCH ?`;
    const params: Array<string | number> = [query];
    sql = options.buildFilters(sql, params);
    sql += ' ORDER BY rank ASC LIMIT ?';
    params.push(options.limit);

    const rows = optionsDb.exec(sql, params)[0]?.values ?? [];
    for (const row of rows) {
      const result = options.mapRow(row);
      if (seen.has(result.id)) continue;
      seen.add(result.id);
      results.push(result);
      if (results.length >= options.limit) return results;
    }
  }

  return results;
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
