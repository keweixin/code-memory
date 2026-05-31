/**
 * Code Memory Graph — Feature Tracer
 *
 * Traces business features through the codebase by following
 * symbol relationships from user-facing entry points (routes,
 * commands, event handlers) through to their implementations.
 *
 * This bridges the gap between "what does the code do" (symbol graph)
 * and "how is feature X implemented" (business semantics).
 */

import type { SqlJsDatabase } from '../storage/database.js';
import type { SymbolRecord, EdgeType, SymbolKind } from '../shared/types.js';
import { GraphEngine } from './graph-engine.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('feature-tracer');

const SYMBOL_SELECT =
  'SELECT id, file_id, name, kind, start_byte, end_byte, start_line, end_line, ' +
  'start_column, end_column, range_start, range_end, signature, summary, hash, access_level FROM symbols';

export interface FeatureTrace {
  entryPoint: FeatureNode;
  path: FeatureNode[];
  relatedFiles: string[];
  relatedTests: string[];
  relatedDocs: string[];
}

export interface FeatureNode {
  symbolName: string;
  kind: SymbolKind;
  filePath: string;
  role: 'entry_point' | 'service' | 'repository' | 'utility' | 'middleware' | 'config' | 'test' | 'doc';
  depth: number;
}

export class FeatureTracer {
  private graphEngine: GraphEngine;
  private db: SqlJsDatabase;

  constructor(db: SqlJsDatabase) {
    this.db = db;
    this.graphEngine = new GraphEngine(db);
  }

  /**
   * Trace a feature by name — finds entry points and follows the
   * implementation path through service → repository → utility → config.
   */
  traceFeature(featureName: string): FeatureTrace[] {
    log.info(`Tracing feature: ${featureName}`);
    const traces: FeatureTrace[] = [];

    // Find potential entry points matching the feature name
    const entryPoints = this.findEntryPoints(featureName);
    log.info(`Found ${entryPoints.length} entry points for "${featureName}"`);

    for (const entry of entryPoints) {
      const trace = this.traceFromEntry(entry);
      traces.push(trace);
    }

    return traces;
  }

  /**
   * Trace from a specific symbol — what does this symbol depend on?
   */
  traceFromSymbol(symbolName: string, maxDepth: number = 4): FeatureTrace | null {
    const symbol = this.findSymbol(symbolName);
    if (!symbol) return null;

    return this.traceFromEntry(symbol);
  }

  /**
   * Find all entry points in the codebase.
   * Entry points include: API routes, CLI commands, event handlers,
   * exported public functions in top-level modules, and main() functions.
   */
  findAllEntryPoints(): SymbolRecord[] {
    const entryKinds: SymbolKind[] = ['route', 'api_endpoint', 'function'];

    const results: SymbolRecord[] = [];
    for (const kind of entryKinds) {
      try {
        const result = this.db.exec(
          SYMBOL_SELECT + " WHERE kind = ? OR name LIKE '%route%' OR name LIKE '%handler%' OR name LIKE '%controller%'",
          [kind],
        );
        if (result.length > 0) {
          for (const row of result[0].values) {
            results.push(this.desymbolize(row as any));
          }
        }
      } catch { /* skip */ }
    }

    // Also look for exported functions from files with API/route patterns
    try {
      const fileResult = this.db.exec(
        "SELECT id FROM files WHERE path LIKE '%api%' OR path LIKE '%route%' OR path LIKE '%controller%' OR path LIKE '%handler%'"
      );
      if (fileResult.length > 0) {
        for (const row of fileResult[0].values) {
          const symbolResult = this.db.exec(
            SYMBOL_SELECT + ' WHERE file_id = ? AND kind = ?',
            [String(row[0]), 'function'],
          );
          if (symbolResult.length > 0) {
            for (const symRow of symbolResult[0].values) {
              results.push(this.desymbolize(symRow as any));
            }
          }
        }
      }
    } catch { /* skip */ }

    return results;
  }

  // ============================================================
  // Private
  // ============================================================

  private findEntryPoints(featureName: string): SymbolRecord[] {
    const searchTerms = [featureName.toLowerCase()];

    // Add common variants
    searchTerms.push(featureName.toLowerCase() + 'controller');
    searchTerms.push(featureName.toLowerCase() + 'handler');
    searchTerms.push(featureName.toLowerCase() + 'route');
    searchTerms.push(featureName.toLowerCase() + 'service');

    const symbols: SymbolRecord[] = [];

    for (const term of searchTerms) {
      try {
        const result = this.db.exec(
          SYMBOL_SELECT + " WHERE LOWER(name) LIKE ? OR LOWER(signature) LIKE ?",
          [`%${term}%`, `%${term}%`],
        );
        if (result.length > 0) {
          for (const row of result[0].values) {
            symbols.push(this.desymbolize(row as any));
          }
        }
      } catch { /* skip */ }
    }

    return symbols;
  }

  private traceFromEntry(entry: SymbolRecord): FeatureTrace {
    const path: FeatureNode[] = [];
    const visited = new Set<string>();
    const queue: Array<{ symbol: SymbolRecord; depth: number }> = [{ symbol: entry, depth: 0 }];

    while (queue.length > 0 && visited.size < 100) {
      const { symbol, depth } = queue.shift()!;
      if (visited.has(symbol.id)) continue;
      visited.add(symbol.id);

      const role = this.classifySymbolRole(symbol, depth);
      path.push({
        symbolName: symbol.name,
        kind: symbol.kind,
        filePath: this.getFilePath(symbol.fileId),
        role,
        depth,
      });

      // Follow outgoing edges (what does this symbol depend on?)
      const edges = this.graphEngine.getOutgoingNeighbors(symbol.id);
      for (const edge of edges) {
        if (!visited.has(edge.to)) {
          const nextSymbol = this.findSymbolById(edge.to);
          if (nextSymbol) {
            queue.push({ symbol: nextSymbol, depth: depth + 1 });
          }
        }
      }
    }

    // Find related tests and docs
    const relatedFiles = [...new Set(path.map((n) => n.filePath))];
    const relatedTests = this.findTestFiles(relatedFiles);
    const relatedDocs = this.findDocFiles(relatedFiles);

    return {
      entryPoint: {
        symbolName: entry.name,
        kind: entry.kind,
        filePath: this.getFilePath(entry.fileId),
        role: 'entry_point',
        depth: 0,
      },
      path,
      relatedFiles,
      relatedTests,
      relatedDocs,
    };
  }

  private classifySymbolRole(symbol: SymbolRecord, depth: number): FeatureNode['role'] {
    const name = symbol.name.toLowerCase();
    const path = this.getFilePath(symbol.fileId).toLowerCase();

    if (path.includes('controller') || path.includes('handler') || path.includes('route') || path.includes('api')) {
      return 'entry_point';
    }
    if (name.includes('service') || name.includes('usecase') || path.includes('service')) {
      return 'service';
    }
    if (name.includes('repository') || name.includes('repo') || path.includes('repository') || path.includes('repo')) {
      return 'repository';
    }
    if (name.includes('middleware') || name.includes('guard') || path.includes('middleware')) {
      return 'middleware';
    }
    if (path.includes('config') || path.includes('env') || path.includes('constant')) {
      return 'config';
    }
    if (depth === 1) return 'service';
    if (depth === 2) return 'repository';
    return 'utility';
  }

  private findSymbol(name: string): SymbolRecord | null {
    try {
      const result = this.db.exec(
        SYMBOL_SELECT + ' WHERE name = ? LIMIT 1',
        [name],
      );
      if (result.length > 0 && result[0].values.length > 0) {
        return this.desymbolize(result[0].values[0] as any);
      }
    } catch { /* not found */ }
    return null;
  }

  private findSymbolById(id: string): SymbolRecord | null {
    try {
      const result = this.db.exec(SYMBOL_SELECT + ' WHERE id = ?', [id]);
      if (result.length > 0 && result[0].values.length > 0) {
        return this.desymbolize(result[0].values[0] as any);
      }
    } catch { /* not found */ }
    return null;
  }

  private getFilePath(fileId: string): string {
    try {
      const result = this.db.exec('SELECT path FROM files WHERE id = ?', [fileId]);
      if (result.length > 0 && result[0].values.length > 0) {
        return String(result[0].values[0][0]);
      }
    } catch { /* not found */ }
    return fileId;
  }

  private findTestFiles(sourceFiles: string[]): string[] {
    const testFiles: string[] = [];
    for (const sf of sourceFiles) {
      try {
        const result = this.db.exec(
          "SELECT path FROM files WHERE role = 'test' AND (path LIKE ? OR path LIKE ?)",
          [`%${sf.replace(/\.[^.]+$/, '')}%`, `%${sf.split('/').pop()}%`],
        );
        if (result.length > 0) {
          for (const row of result[0].values) {
            testFiles.push(String(row[0]));
          }
        }
      } catch { /* skip */ }
    }
    return [...new Set(testFiles)];
  }

  private findDocFiles(sourceFiles: string[]): string[] {
    const docFiles: string[] = [];
    try {
      const result = this.db.exec(
        "SELECT path FROM files WHERE role = 'doc'"
      );
      if (result.length > 0) {
        for (const row of result[0].values) {
          docFiles.push(String(row[0]));
        }
      }
    } catch { /* skip */ }
    return docFiles;
  }

  private desymbolize(row: any[]): SymbolRecord {
    return {
      id: String(row[0]),
      fileId: String(row[1]),
      name: String(row[2]),
      kind: String(row[3]) as SymbolKind,
      startByte: Number(row[4]),
      endByte: Number(row[5]),
      startLine: Number(row[6]),
      endLine: Number(row[7]),
      startColumn: Number(row[8]),
      endColumn: Number(row[9]),
      rangeStart: Number(row[10]),
      rangeEnd: Number(row[11]),
      signature: row[12] ? String(row[12]) : null,
      summary: row[13] ? String(row[13]) : null,
      hash: String(row[14]),
      accessLevel: row[15] ? String(row[15]) as any : null,
    };
  }
}
