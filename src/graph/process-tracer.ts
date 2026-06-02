/**
 * Code Memory Graph — Process Tracer
 *
 * Walks the call graph from a candidate entry point to terminal nodes,
 * producing a deterministic, ordered list of `ProcessStep` records.
 *
 * Entry points come from two sources:
 *   1. HTTP route endpoints (Express, FastAPI, Next.js App Router) — named
 *      after the URL pattern, e.g. `GET /users/:id`.
 *   2. Fallback candidates: `main` functions or exported default functions
 *      in top-level entry files (index.ts / main.ts / etc.).
 *
 * The walk follows outgoing `CALLS` and `IMPORTS` edges and stops at:
 *   - a node that contains throw / process.exit / SQL write heuristics,
 *   - a node already visited (cycle protection),
 *   - the depth limit.
 */

import type { SqlJsDatabase } from '../storage/database.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('process-tracer');

export interface ProcessEntry {
  symbolId: string;
  name: string;
  entryKind: 'route' | 'main' | 'export_default';
  framework?: string;
}

export interface ProcessStep {
  step: number;
  symbolId: string | null;
  fileId: string | null;
  edgeId: string | null;
  label: string;
}

export interface ProcessTraceResult {
  entrySymbolId: string;
  steps: ProcessStep[];
  visitedSymbolIds: Set<string>;
  depthReached: number;
}

export interface ProcessTraceOptions {
  maxDepth?: number;
  terminalKinds?: Set<string>;
}

interface SymbolRow {
  id: string;
  file_id: string;
  name: string;
  kind: string;
  start_line: number;
}

interface EdgeRow {
  id: string;
  from_id: string;
  to_id: string;
  type: string;
}

const TERMINAL_CALLEE_PATTERNS: RegExp[] = [
  /^throw$/i,
  /^process\.exit$/i,
  /^db\.execute$/i,
  /^db\.run$/i,
  /^INSERT$/i,
  /^UPDATE$/i,
  /^DELETE$/i,
];

const DEFAULT_MAX_DEPTH = 10;

export function traceProcess(
  entry: ProcessEntry,
  db: SqlJsDatabase,
  options: ProcessTraceOptions = {},
): ProcessTraceResult {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const terminalKinds = options.terminalKinds;

  const steps: ProcessStep[] = [];
  const visited = new Set<string>();
  let depthReached = 0;

  const symbolCache = new Map<string, SymbolRow | null>();

  // Preload all CALLS/IMPORTS edges in a single query to avoid N+1 roundtrips
  const adjacency = new Map<string, EdgeRow[]>();
  try {
    const allEdges = db.all<EdgeRow>(
      "SELECT id, from_id, to_id, type FROM edges WHERE type IN ('CALLS', 'IMPORTS')",
    );
    for (const edge of allEdges) {
      let neighbors = adjacency.get(edge.from_id);
      if (!neighbors) {
        neighbors = [];
        adjacency.set(edge.from_id, neighbors);
      }
      neighbors.push(edge);
    }
  } catch (err) {
    log.warn(`traceProcess: failed to preload edges: ${err instanceof Error ? err.message : String(err)}`);
  }

  const startSymbol = loadSymbolCached(db, entry.symbolId, symbolCache);
  if (!startSymbol) {
    log.warn(`traceProcess: entry symbol ${entry.symbolId} not found`);
    return {
      entrySymbolId: entry.symbolId,
      steps: [],
      visitedSymbolIds: visited,
      depthReached: 0,
    };
  }

  const queue: Array<{ symbol: SymbolRow; depth: number; viaEdgeId: string | null }> = [
    { symbol: startSymbol, depth: 0, viaEdgeId: null },
  ];

  let head = 0;
  while (head < queue.length) {
    const current = queue[head]!;
    head++;
    if (visited.has(current.symbol.id)) continue;
    visited.add(current.symbol.id);

    if (current.depth > depthReached) depthReached = current.depth;

    const stepNumber = steps.length + 1;
    steps.push({
      step: stepNumber,
      symbolId: current.symbol.id,
      fileId: current.symbol.file_id,
      edgeId: current.viaEdgeId,
      label: buildLabel(current.symbol),
    });

    if (current.depth >= maxDepth) continue;
    if (terminalKinds?.has(current.symbol.kind)) continue;
    if (isTerminalSymbol(db, current.symbol.id, symbolCache)) continue;

    const outgoing = adjacency.get(current.symbol.id) ?? [];
    for (const edge of outgoing) {
      if (visited.has(edge.to_id)) continue;
      const target = loadSymbolCached(db, edge.to_id, symbolCache);
      if (!target) continue;
      queue.push({ symbol: target, depth: current.depth + 1, viaEdgeId: edge.id });
    }
  }

  return {
    entrySymbolId: entry.symbolId,
    steps,
    visitedSymbolIds: visited,
    depthReached,
  };
}

function buildLabel(symbol: SymbolRow): string {
  if (symbol.start_line > 0) {
    return `${symbol.kind}:${symbol.name}:line=${symbol.start_line}`;
  }
  return `${symbol.kind}:${symbol.name}`;
}

function loadSymbol(db: SqlJsDatabase, symbolId: string): SymbolRow | null {
  try {
    const row = db.get<SymbolRow>(
      'SELECT id, file_id, name, kind, start_line FROM symbols WHERE id = ?',
      [symbolId],
    );
    return row ?? null;
  } catch (err) {
    log.warn(`loadSymbol(${symbolId}) failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function loadSymbolCached(db: SqlJsDatabase, symbolId: string, cache: Map<string, SymbolRow | null>): SymbolRow | null {
  const cached = cache.get(symbolId);
  if (cached !== undefined) return cached;
  const result = loadSymbol(db, symbolId);
  cache.set(symbolId, result);
  return result;
}

function loadOutgoingEdges(db: SqlJsDatabase, symbolId: string): EdgeRow[] {
  try {
    return db.all<EdgeRow>(
      `SELECT id, from_id, to_id, type FROM edges
       WHERE from_id = ? AND type IN ('CALLS', 'IMPORTS')
       ORDER BY type, to_id`,
      [symbolId],
    );
  } catch (err) {
    log.warn(`loadOutgoingEdges(${symbolId}) failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function isTerminalSymbol(db: SqlJsDatabase, symbolId: string, cache: Map<string, SymbolRow | null>): boolean {
  const symbol = loadSymbolCached(db, symbolId, cache);
  if (!symbol) return false;

  try {
    const rows = db.all<{ callee_name: string }>(
      `SELECT callee_name FROM call_refs
       WHERE file_id = ? AND caller_symbol_id = ?`,
      [symbol.file_id, symbolId],
    );
    for (const row of rows) {
      if (row.callee_name && matchesTerminalPattern(row.callee_name)) return true;
    }
  } catch (err) {
    log.warn(`isTerminalSymbol(${symbolId}) failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return false;
}

function matchesTerminalPattern(calleeName: string): boolean {
  for (const pattern of TERMINAL_CALLEE_PATTERNS) {
    if (pattern.test(calleeName)) return true;
  }
  return false;
}

