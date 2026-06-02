import type { SqlJsDatabase } from '../storage/database.js';
import type { SearchResult, SymbolKind, ToolDiagnostics } from '../shared/types.js';
import type { FusedSearchItem } from './rrf-fusion.js';

export function enrichSearchResults(
  db: SqlJsDatabase,
  merged: FusedSearchItem[],
  limit: number,
  diagnostics?: ToolDiagnostics,
): SearchResult[] {
  const topItems = merged.slice(0, limit);
  if (topItems.length === 0) return [];

  const topIds = topItems.map((item) => item.id);
  const placeholders = topIds.map(() => '?').join(',');
  const symbolRows = db.all<{
    id: string;
    name: string;
    kind: string;
    filePath: string;
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
  }>(
    `SELECT s.id AS id,
            s.name AS name,
            s.kind AS kind,
            f.path AS filePath,
            s.start_line AS startLine,
            s.end_line AS endLine,
            s.start_column AS startColumn,
            s.end_column AS endColumn
     FROM symbols s
     JOIN files f ON f.id = s.file_id
     WHERE s.id IN (${placeholders})`,
    topIds,
  );
  const symbolsById = new Map(symbolRows.map((row) => [String(row.id), row]));

  const fileRows = db.all<{ id: string; path: string; language: string }>(
    `SELECT id, path, language FROM files WHERE id IN (${placeholders})`,
    topIds,
  );
  const filesById = new Map(fileRows.map((row) => [String(row.id), row]));

  const results: SearchResult[] = [];

  for (const item of topItems) {
    const symbol = symbolsById.get(item.id);
    if (symbol) {
      results.push({
        id: item.id,
        name: String(symbol.name),
        kind: String(symbol.kind) as SymbolKind,
        filePath: String(symbol.filePath),
        score: item.score,
        sources: item.sources,
        snippet: null,
        lineRange: [Number(symbol.startLine), Number(symbol.endLine)],
        columnRange: [Number(symbol.startColumn), Number(symbol.endColumn)],
        scoreBreakdown: item.scoreBreakdown,
        diagnostics,
      });
      continue;
    }

    const file = filesById.get(item.id);
    if (file) {
      const path = String(file.path);
      results.push({
        id: item.id,
        name: path.split('/').pop() || path,
        kind: 'file',
        filePath: path,
        score: item.score,
        sources: item.sources,
        snippet: null,
        lineRange: null,
        columnRange: null,
        scoreBreakdown: item.scoreBreakdown,
        diagnostics,
      });
      continue;
    }

    results.push({
      id: item.id,
      name: item.id,
      kind: 'file',
      filePath: '',
      score: item.score,
      sources: item.sources,
      snippet: null,
      lineRange: null,
      columnRange: null,
      scoreBreakdown: item.scoreBreakdown,
      diagnostics,
    });
  }

  return results;
}
