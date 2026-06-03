import type { DiscoveredFile } from '../scanner/file-discovery.js';
import { getFileLastCommit } from '../scanner/git-integration.js';
import { getDatabaseSync } from '../storage/database.js';
import { upsertChunks } from '../storage/chunk-repository.js';
import { upsertFile } from '../storage/file-repository.js';
import { replaceParseMetadata } from '../storage/parse-metadata-repository.js';
import { upsertSymbol } from '../storage/symbol-repository.js';
import type { FileRecord, ParseResult } from '../shared/types.js';
import { normalizePath } from '../shared/utils.js';

export interface PersistParseResultOptions {
  rootPath: string;
  result: ParseResult;
  discovered: DiscoveredFile;
  gitHistoryAvailable: boolean;
}

export function persistParseResult(options: PersistParseResultOptions): void {
  const { rootPath, result, discovered, gitHistoryAvailable } = options;
  const now = new Date().toISOString();
  const lastCommit = gitHistoryAvailable
    ? getFileLastCommit(rootPath, discovered.path)
    : null;

  const fileRecord: FileRecord = {
    id: result.fileId,
    path: normalizePath(discovered.relativePath),
    language: result.language,
    role: discovered.role,
    size: discovered.size,
    hash: result.contentHash,
    indexedAt: now,
    lastCommit,
    isGenerated: discovered.role === 'generated',
    isIgnored: false,
    exports: result.exports,
    imports: result.imports,
    summary: null,
    riskLevel: 'low',
  };

  const db = getDatabaseSync();
  const write = db.transaction(() => {
    upsertFile(fileRecord);
    for (const sym of result.symbols) upsertSymbol(sym);
    upsertChunks(result.chunks);
    replaceParseMetadata({
      fileId: result.fileId,
      imports: result.imports,
      exports: result.exports,
      calls: result.calls,
      scopeBindings: result.scopeBindings,
      typeRelations: result.typeRelations,
      routeEndpoints: result.routeEndpoints,
      routeReferences: result.routeReferences,
    });
  });
  write();
}
