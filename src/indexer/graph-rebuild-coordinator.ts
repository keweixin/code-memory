import type { FileRecord, SymbolRecord, EdgeType } from '../shared/types.js';
import type { SqlJsDatabase } from '../storage/database.js';
import { deleteGraphEvidenceByTypes } from '../storage/graph-evidence-repository.js';
import { normalizePath } from '../shared/utils.js';

export type EdgeRebuildMode = 'full' | 'dirty';

export const GRAPH_EDGE_TYPES: EdgeType[] = [
  'IMPORTS',
  'CALLS',
  'REFERENCES',
  'TESTS',
  'CONFIGURES',
  'EXTENDS',
  'IMPLEMENTS',
];

export interface GraphRebuildScope {
  fullRebuild: boolean;
  rebuildFileIds: Set<string>;
  rebuildFileIdList: string[];
}

export interface GraphRebuildIndexes {
  filesByPath: Map<string, FileRecord>;
  symbolsById: Map<string, SymbolRecord>;
  symbolsByFile: Map<string, SymbolRecord[]>;
}

export function prepareGraphRebuildScope(
  mode: EdgeRebuildMode,
  dirtyFileIds: string[],
  indexedFiles: FileRecord[],
): GraphRebuildScope {
  const fullRebuild = mode === 'full' || dirtyFileIds.length === 0;
  const rebuildFileIds = !fullRebuild
    ? new Set(dirtyFileIds)
    : new Set(indexedFiles.map((file) => file.id));

  return {
    fullRebuild,
    rebuildFileIds,
    rebuildFileIdList: [...rebuildFileIds],
  };
}

export function buildGraphRebuildIndexes(
  indexedFiles: FileRecord[],
  symbols: SymbolRecord[],
): GraphRebuildIndexes {
  const filesByPath = new Map<string, FileRecord>();
  for (const file of indexedFiles) {
    filesByPath.set(normalizePath(file.path), file);
  }

  const symbolsById = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const symbolsByFile = new Map<string, SymbolRecord[]>();
  for (const symbol of symbols) {
    const list = symbolsByFile.get(symbol.fileId) || [];
    list.push(symbol);
    symbolsByFile.set(symbol.fileId, list);
  }

  return { filesByPath, symbolsById, symbolsByFile };
}

export function commitGraphRebuild(options: {
  db: SqlJsDatabase;
  fullRebuild: boolean;
  dirtyFileIds: string[];
  deleteDirtyGraphEdges: (fileIds: string[]) => void;
  flushGraphWrites: () => void;
  countEdges: () => number;
}): number {
  const commitGraph = options.db.native.transaction(() => {
    if (options.fullRebuild) {
      const placeholders = GRAPH_EDGE_TYPES.map(() => '?').join(',');
      deleteGraphEvidenceByTypes(GRAPH_EDGE_TYPES);
      options.db.run(`DELETE FROM edges WHERE type IN (${placeholders})`, GRAPH_EDGE_TYPES);
    } else {
      options.deleteDirtyGraphEdges(options.dirtyFileIds);
    }
    options.flushGraphWrites();
    return options.countEdges();
  });

  return commitGraph();
}
