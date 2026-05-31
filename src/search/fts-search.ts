/**
 * Code Memory Graph — FTS3 Full-Text Search
 *
 * Uses SQLite FTS3 for keyword-based code search.
 * sql.js (WASM SQLite) ships with FTS3, not FTS5.
 *
 * FTS3 differences from FTS5:
 * - No built-in bm25() — we order by docid (insertion order) or manual scoring
 * - No snippet() / highlight() — we implement simple highlighting
 * - docid instead of rowid for explicit row-id references
 * - Supports MATCH with same query syntax
 * - Column-specific search with column_name:term
 */

import type { Database as SqlJsDatabase } from 'sql.js';
import type { SearchResult, SymbolKind } from '../shared/types.js';
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

/**
 * Search symbols using FTS3 with MATCH.
 *
 * Returns results ordered by insertion order (docid).
 * For ranked results, use normalizeFts3Scores() which
 * estimates relevance by match count in the output.
 */
export function searchSymbolsFts(
  db: SqlJsDatabase,
  options: FtsSearchOptions,
): FtsSearchResult[] {
  const { query, limit = 20, kindFilter, fileFilter } = options;

  const escapedQuery = escapeFts3Query(query, ['name', 'kind', 'signature']);
  if (!escapedQuery) return [];

  try {
    // For FTS3, we join symbols_fts with symbols on docid = rowid
    // Must use full table name in MATCH clause, not an alias
    let sql: string;
    const params: string[] = [escapedQuery];

    if (kindFilter || fileFilter) {
      sql = `SELECT
        s.id, s.name, s.kind, s.file_id AS file_path, s.signature, s.summary
      FROM symbols_fts
      JOIN symbols s ON s.rowid = symbols_fts.docid
      WHERE symbols_fts MATCH ?`;
    } else {
      sql = `SELECT
        s.id, s.name, s.kind, s.file_id AS file_path, s.signature, s.summary
      FROM symbols_fts
      JOIN symbols s ON s.rowid = symbols_fts.docid
      WHERE symbols_fts MATCH ?`;
    }

    if (kindFilter) {
      sql += ' AND s.kind = ?';
      params.push(kindFilter);
    }

    sql += ` LIMIT ${limit * 2}`;

    const results = db.exec(sql, params);
    if (!results.length || !results[0].values.length) return [];

    return results[0].values.map((row, i) => {
      const name = String(row[1]);
      const kind = String(row[2]);
      const filePath = getFilePath(db, String(row[3]));
      const signature = row[4] ? String(row[4]) : '';
      const summary = row[5] ? String(row[5]) : '';

      // Generate snippet with highlighting
      const snippet = generateSnippet(
        [name, kind, signature, summary].join(' '),
        query.split(/\s+/).filter(Boolean),
      );

      // Score: later docid = more recently indexed (higher score for matches)
      return {
        id: String(row[0]),
        name,
        kind,
        filePath,
        score: 1 - i / (limit * 2), // Simple position-based score
        snippet,
      };
    });
  } catch (err) {
    log.warn(`FTS3 search failed for "${query}": ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Search file metadata using FTS3.
 */
export function searchFilesFts(
  db: SqlJsDatabase,
  query: string,
  limit: number = 20,
): FtsSearchResult[] {
  const escapedQuery = escapeFts3Query(query, ['path', 'summary', 'language', 'role']);
  if (!escapedQuery) return [];

  try {
    const sql = `SELECT
      f.id, f.path, f.summary, f.language, f.role
    FROM files_fts
    JOIN files f ON f.rowid = files_fts.docid
    WHERE files_fts MATCH ?
    LIMIT ${limit}`;

    const results = db.exec(sql, [escapedQuery]);
    if (!results.length || !results[0].values.length) return [];

    return results[0].values.map((row, i) => ({
      id: String(row[0]),
      name: String(row[1]).split('/').pop() || String(row[1]),
      kind: 'file',
      filePath: String(row[1]),
      score: 1 - i / limit,
      snippet: generateSnippet(
        [String(row[1]), String(row[2] || '')].join(' '),
        query.split(/\s+/).filter(Boolean),
      ),
    }));
  } catch (err) {
    log.warn(`FTS3 file search failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ── Private Helpers ────────────────────────────────────────

/**
 * Escape a query string for FTS3 MATCH.
 * FTS3 special characters: " * ( ) : . - < > [ ] { } ~ ^
 *
 * For simple word queries, wraps each word with * suffix and joins with AND.
 * Adds column-qualified search targeting name, kind, and signature columns.
 */
function escapeFts3Query(query: string, columns: string[]): string {
  const cleaned = query
    .replace(/["*()[]:.{}<>~^-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (cleaned.length === 0) return '';

  // Column-qualified search: search name and signature with higher priority
  // Note: FTS3 with porter stemmer automatically handles word variants
  return cleaned
    .map((w) => '(' + columns.map((column) => `${column}:${w}*`).join(' OR ') + ')')
    .join(' AND ');
}

/**
 * Get file path from file_id.
 */
function getFilePath(db: SqlJsDatabase, fileId: string): string {
  try {
    const result = db.exec('SELECT path FROM files WHERE id = ?', [fileId]);
    if (result.length > 0 && result[0].values.length > 0) {
      return String(result[0].values[0][0]);
    }
  } catch { /* fallback to file_id */ }
  return fileId;
}

/**
 * Generate a snippet with highlighted search terms.
 * Simple approach since FTS3 lacks snippet()/highlight().
 */
function generateSnippet(text: string, terms: string[], maxLength: number = 80): string | null {
  if (!text || terms.length === 0) return null;

  const lowerText = text.toLowerCase();

  // Find the first occurrence of any term
  let bestPos = -1;
  let bestTerm = '';
  for (const term of terms) {
    const pos = lowerText.indexOf(term.toLowerCase());
    if (pos !== -1 && (bestPos === -1 || pos < bestPos)) {
      bestPos = pos;
      bestTerm = term;
    }
  }

  if (bestPos === -1) {
    // No match found — return the beginning of text
    return text.length > maxLength ? text.slice(0, maxLength) + '...' : text;
  }

  // Extract a window around the match, highlighting all terms
  const windowStart = Math.max(0, bestPos - maxLength / 2);
  const windowEnd = Math.min(text.length, bestPos + maxLength / 2);
  let snippet = text.slice(windowStart, windowEnd);

  // Apply highlighting
  for (const term of terms) {
    const regex = new RegExp(`(${escapeRegex(term)})`, 'gi');
    snippet = snippet.replace(regex, '<<$1>>');
  }

  const prefix = windowStart > 0 ? '...' : '';
  const suffix = windowEnd < text.length ? '...' : '';
  return prefix + snippet + suffix;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize position-based scores to 0-1 range for RRF compatibility.
 */
export function normalizeFts3Scores(results: FtsSearchResult[]): FtsSearchResult[] {
  if (results.length === 0) return results;

  return results.map((r, i) => ({
    ...r,
    score: 1 - i / Math.max(results.length, 1),
  }));
}
