/**
 * Code Memory Graph — Index Manager
 *
 * Coordinates the full indexing pipeline:
 *   scan project -> parse files -> store records -> update metadata
 *
 * Supports both full (re-index everything) and incremental (changed files only)
 * indexing strategies.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as posixPath from 'node:path/posix';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { CodeMemoryConfig, IndexStatus, FileRecord, SymbolRecord, EdgeRecord, ChunkRecord, ParseResult, ImportInfo, EdgeType } from '../shared/types.js';
import type { DiscoveredFile } from '../scanner/file-discovery.js';
import { initTreeSitter } from '../parser/parser-registry.js';
import { parseFile, resolveParserLanguage } from '../parser/tree-sitter-parser.js';
import { scanProject } from '../scanner/project-scanner.js';
import { getFileContentHash, getFileLastCommit } from '../scanner/git-integration.js';
import { getDatabase, getDatabaseSync, saveDatabase, type SqlJsDatabase } from '../storage/database.js';
import { upsertFile, getAllFiles, deleteFile } from '../storage/file-repository.js';
import { upsertSymbol, deleteSymbolsByFileId } from '../storage/symbol-repository.js';
import { upsertEdge, deleteEdgesByNodeId } from '../storage/edge-repository.js';
import { upsertChunk, deleteChunksByFileId } from '../storage/chunk-repository.js';
import { generateId, normalizePath } from '../shared/utils.js';
import { CONFIG_DIR, VECTORS_DIR } from '../shared/constants.js';
import { EmbeddingGenerator } from './embedding-generator.js';
import {
  addVectors,
  closeVectorStore,
  deleteVectors,
  getEmbeddingDimensions,
  initVectorStore,
  releaseVectorStoreConnection,
  resetVectorStore,
  type VectorRecord,
} from '../search/vector-search.js';
import { createLogger } from '../shared/logger.js';
import {
  countUnresolvedCalls,
  deleteParseMetadataByFileId,
  getCallRefsByFileIds,
  getFileExportsByFileIds,
  getScopeBindingsByFileIds,
  getTypeRelationsByFileIds,
  replaceParseMetadata,
  updateCallRefResolution,
  type StoredCallRefRow,
  type StoredExportRow,
  type StoredScopeBindingRow,
  type StoredTypeRelationRow,
} from '../storage/parse-metadata-repository.js';
import { parseFilesWithWorkers } from './parse-worker-pool.js';

const log = createLogger('index-manager');

interface ResolvedImportSymbol {
  symbol: SymbolRecord;
  resolutionNames: string[];
}

interface ImportResolution {
  edgeCount: number;
  symbolsByName: Map<string, SymbolRecord[]>;
  namespaceSymbolsByName: Map<string, Map<string, SymbolRecord[]>>;
}

type EdgeRebuildMode = 'full' | 'dirty';

interface ReexportAlias {
  source: string;
  importedName: string;
  exportedName: string;
}

interface ReexportNamespace {
  source: string;
  exportedName: string;
}

interface ReexportIndex {
  aliasesByFileId: Map<string, ReexportAlias[]>;
  namespacesByFileId: Map<string, ReexportNamespace[]>;
  sourcesByFileId: Map<string, string[]>;
  exportedNamesByFileId: Map<string, Set<string>>;
}

interface CallEdgeMetadata {
  callRefsByFileId: Map<string, StoredCallRefRow[]>;
  scopeBindingsByFileId: Map<string, StoredScopeBindingRow[]>;
  symbolsById: Map<string, SymbolRecord>;
  classMethodIndex: Map<string, Map<string, SymbolRecord[]>>;
}

export class IndexManager {
  private rootPath: string;
  private config: CodeMemoryConfig;
  private db: SqlJsDatabase | null = null;
  private embeddingGenerator: EmbeddingGenerator | null = null;
  private vectorStoreReady = false;
  private embeddedVectorCount = 0;
  private gitHistoryAvailable = false;

  constructor(rootPath: string, config: CodeMemoryConfig) {
    this.rootPath = resolve(rootPath);
    this.config = config;
  }

  async fullIndex(): Promise<IndexStatus> {
    log.info('Starting full index of: ' + this.rootPath);
    const startTime = Date.now();

    await this.ensureDb();
    await initTreeSitter();
    await this.prepareVectorStore(true);

    this.setMetadata('is_indexing', 'true');

    log.info('Scanning project files...');
    const scanResult = scanProject(this.rootPath, this.config);
    this.gitHistoryAvailable = Boolean(scanResult.gitInfo.currentCommit);
    const files = scanResult.files;
    log.info('Discovered ' + files.length + ' files to index');

    await this.pruneFilesNotInFullScan(files);

    let indexedCount = 0, totalSymbols = 0, totalChunks = 0;
    const workers = this.resolveWorkerCount();
    const results = await this.parseDiscoveredFiles(files, workers);

    for (const { discovered, result, error } of results) {
      if (error) {
        log.error('Failed to index: ' + discovered.relativePath, error);
        continue;
      }
      if (!result) continue;
      await this.removeFileFromIndex(result.fileId);
      this.storeParseResult(result, discovered);
      await this.indexChunkVectors(result, discovered);
      indexedCount++; totalSymbols += result.symbols.length;
      totalChunks += result.chunks.length;

      if (indexedCount % 50 === 0) {
        log.info('Progress: ' + indexedCount + '/' + files.length +
          ' (' + totalSymbols + ' symbols)');
      }
    }

    const totalEdges = await this.rebuildGraphEdges('full');
    const elapsed = Date.now() - startTime;
    this.updateFinalMetadata(scanResult, {
      indexedFiles: indexedCount,
      symbols: totalSymbols,
      edges: totalEdges,
      chunks: totalChunks,
      durationMs: elapsed,
      parseWorkers: workers,
      dirtyFiles: indexedCount,
    }, 'full');
    await saveDatabase();
    releaseVectorStoreConnection();

    log.info('Full index done in ' + (elapsed / 1000).toFixed(1) + 's: ' +
      indexedCount + ' files, ' + totalSymbols + ' symbols, ' + totalEdges + ' edges');

    return this.buildStatus(indexedCount, totalSymbols, totalEdges, totalChunks);
  }

  async incrementalIndex(forceAll: boolean = false): Promise<IndexStatus> {
    log.info('Starting incremental index of: ' + this.rootPath);
    const startTime = Date.now();
    await this.ensureDb();
    await initTreeSitter();
    await this.prepareVectorStore(forceAll);

    this.setMetadata('is_indexing', 'true');
    const scanResult = scanProject(this.rootPath, this.config);
    this.gitHistoryAvailable = Boolean(scanResult.gitInfo.currentCommit);

    const currentFileMap = new Map<string, DiscoveredFile>();
    for (const f of scanResult.files) {
      currentFileMap.set(normalizePath(f.relativePath), f);
    }

    const prevFiles = this.safeGetAllFiles();
    const prevFileMap = new Map<string, FileRecord>();
    for (const pf of prevFiles) {
      prevFileMap.set(normalizePath(pf.path), pf);
    }

    let indexedCount = 0, totalSymbols = 0, totalChunks = 0;
    const dirtyFiles: DiscoveredFile[] = [];
    const deletedFileIds: string[] = [];

    // Check existing files for changes
    for (const [relPath, prevFile] of prevFileMap) {
      const currentFile = currentFileMap.get(relPath);
      if (!currentFile) {
        await this.removeFileFromIndex(prevFile.id);
        deletedFileIds.push(prevFile.id);
        continue;
      }
      let needsReindex = forceAll;
      if (!forceAll) {
        try {
          const currentHash = getFileContentHash(currentFile.path);
          needsReindex = (currentHash !== prevFile.hash);
        } catch (e) { needsReindex = true; }
      }
      if (needsReindex) {
        dirtyFiles.push(currentFile);
      }
    }

    // Index new files
    for (const [relPath, currentFile] of currentFileMap) {
      if (!prevFileMap.has(relPath)) {
        dirtyFiles.push(currentFile);
      }
    }

    const workers = forceAll ? this.resolveWorkerCount() : this.resolveWorkerCount('dirty');
    const parseResults = await this.parseDiscoveredFiles(dirtyFiles, workers);
    const dirtyFileIds = new Set<string>(deletedFileIds);

    for (const { discovered, result, error } of parseResults) {
      if (error) {
        log.error('Failed to index: ' + discovered.relativePath, error);
        continue;
      }
      if (!result) continue;
      dirtyFileIds.add(result.fileId);
      await this.removeFileFromIndex(result.fileId);
      this.storeParseResult(result, discovered);
      await this.indexChunkVectors(result, discovered);
      indexedCount++; totalSymbols += result.symbols.length;
      totalChunks += result.chunks.length;
    }

    const expandedDirtyFileIds = this.expandDirtyFileSet([...dirtyFileIds]);
    const totalEdges = await this.rebuildGraphEdges(forceAll ? 'full' : 'dirty', expandedDirtyFileIds);
    const elapsed = Date.now() - startTime;
    this.updateFinalMetadata(scanResult, {
      indexedFiles: indexedCount,
      symbols: totalSymbols,
      edges: totalEdges,
      chunks: totalChunks,
      durationMs: elapsed,
      parseWorkers: workers,
      dirtyFiles: expandedDirtyFileIds.length,
    }, forceAll ? 'full' : 'incremental');
    this.setMetadata('is_indexing', 'false');
    await saveDatabase();
    releaseVectorStoreConnection();

    log.info('Incremental index done: ' + indexedCount + ' files updated');
    return this.buildStatus(indexedCount, totalSymbols, totalEdges, totalChunks);
  }

  async getStatus(): Promise<IndexStatus> {
    await this.ensureDb();
    return this.buildStatus(0, 0, 0, 0);
  }

  // ============================================================
  // Private methods
  // ============================================================

  private async ensureDb(): Promise<void> {
    if (!this.db) {
      this.db = await getDatabase(this.rootPath);
    }
  }

  private async indexFile(discovered: DiscoveredFile): Promise<ParseResult | null> {
    const parserLang = resolveParserLanguage(discovered.path);
    if (!parserLang) {
      if (discovered.role === 'config' || discovered.role === 'doc') {
        return this.createFileOnlyParseResult(discovered);
      }
      return null;
    }

    let sourceCode: string;
    try {
      sourceCode = readFileSync(discovered.path, 'utf-8');
    } catch (err) {
      log.error('Cannot read file: ' + discovered.path, err);
      return null;
    }

    const fileId = generateId('file', normalizePath(discovered.relativePath));
    return await parseFile(discovered.path, sourceCode, parserLang, fileId);
  }

  private createFileOnlyParseResult(discovered: DiscoveredFile): ParseResult {
    return {
      fileId: generateId('file', normalizePath(discovered.relativePath)),
      filePath: discovered.path,
      language: discovered.language,
      symbols: [],
      imports: [],
      exports: [],
      edges: [],
      calls: [],
      scopeBindings: [],
      typeRelations: [],
      chunks: [],
      errors: [],
    };
  }

  private resolveWorkerCount(_mode: 'full' | 'dirty' = 'full'): number {
    const configured = this.config.indexing?.workers ?? 'auto';
    if (configured === 0) return 0;
    if (typeof configured === 'number') return Math.max(0, Math.floor(configured));
    return Math.max(1, availableParallelism() - 1);
  }

  private async parseDiscoveredFiles(
    files: DiscoveredFile[],
    workers: number,
  ): Promise<Array<{ discovered: DiscoveredFile; result: ParseResult | null; error: unknown | null }>> {
    const workerEntry = fileURLToPath(new URL('./parse-worker.js', import.meta.url));
    if (workers > 0 && existsSync(workerEntry)) {
      return parseFilesWithWorkers(files, {
        workers,
        rootPath: this.rootPath,
      });
    }

    const results: Array<{ discovered: DiscoveredFile; result: ParseResult | null; error: unknown | null }> = [];
    for (const discovered of files) {
      try {
        results.push({ discovered, result: await this.indexFile(discovered), error: null });
      } catch (error) {
        results.push({ discovered, result: null, error });
      }
    }
    return results;
  }

  private storeParseResult(result: ParseResult, discovered: DiscoveredFile): void {
    const now = new Date().toISOString();

    let hash = '';
    try { hash = getFileContentHash(discovered.path); } catch {}

    const lastCommit = this.gitHistoryAvailable
      ? getFileLastCommit(this.rootPath, discovered.path)
      : null;

    const fileRecord: FileRecord = {
      id: result.fileId,
      path: normalizePath(discovered.relativePath),
      language: result.language,
      role: discovered.role,
      size: discovered.size,
      hash,
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
      for (const sym of result.symbols) { upsertSymbol(sym); }
      for (const chunk of result.chunks) { upsertChunk(chunk); }
      replaceParseMetadata({
        fileId: result.fileId,
        imports: result.imports,
        exports: result.exports,
        calls: result.calls,
        scopeBindings: result.scopeBindings,
        typeRelations: result.typeRelations,
      });
    });
    write();
  }

  private async removeFileFromIndex(fileId: string): Promise<void> {
    try {
      const symbolIds = this.getSymbolIdsByFileId(fileId);
      if (this.vectorStoreReady && symbolIds.length > 0) {
        await deleteVectors(symbolIds);
      }
      for (const symbolId of symbolIds) {
        deleteEdgesByNodeId(symbolId);
      }
      deleteEdgesByNodeId(fileId);
      deleteChunksByFileId(fileId);
      deleteSymbolsByFileId(fileId);
      deleteParseMetadataByFileId(fileId);
      deleteFile(fileId);
    } catch (err) {
      log.error('Failed to remove file from index: ' + fileId, err);
    }
  }

  private async pruneFilesNotInFullScan(files: DiscoveredFile[]): Promise<void> {
    const currentFileIds = new Set(
      files.map((file) => generateId('file', normalizePath(file.relativePath))),
    );

    for (const previousFile of this.safeGetAllFiles()) {
      if (!currentFileIds.has(previousFile.id)) {
        await this.removeFileFromIndex(previousFile.id);
      }
    }
  }

  private async prepareVectorStore(reset: boolean): Promise<void> {
    this.vectorStoreReady = false;
    this.embeddedVectorCount = 0;
    this.embeddingGenerator = null;
    if (this.config.embedding.provider === 'none') {
      closeVectorStore();
      return;
    }

    try {
      const dimensions = getEmbeddingDimensions(this.config.embedding);
      await initVectorStore(join(this.rootPath, CONFIG_DIR, VECTORS_DIR), dimensions);
      if (reset) {
        await resetVectorStore(dimensions);
      }
      this.embeddingGenerator = new EmbeddingGenerator(this.config.embedding);
      this.vectorStoreReady = this.embeddingGenerator.isAvailable();
    } catch (err) {
      log.warn('Vector store initialization failed: ' + (err instanceof Error ? err.message : String(err)));
      this.embeddingGenerator = null;
      this.vectorStoreReady = false;
    }
  }

  private async indexChunkVectors(result: ParseResult, discovered: DiscoveredFile): Promise<void> {
    if (!this.vectorStoreReady || !this.embeddingGenerator) return;

    const symbolsById = new Map(result.symbols.map((symbol) => [symbol.id, symbol]));
    const chunkCandidates = result.chunks
      .map((chunk) => ({ chunk, symbol: chunk.symbolId ? symbolsById.get(chunk.symbolId) : undefined }))
      .filter((item): item is { chunk: ChunkRecord; symbol: SymbolRecord } => Boolean(item.symbol));
    const records: VectorRecord[] = [];
    const batchSize = Math.max(1, Math.floor(this.config.embedding.batchSize ?? 50));
    for (let offset = 0; offset < chunkCandidates.length; offset += batchSize) {
      const batch = chunkCandidates.slice(offset, offset + batchSize);
      const vectors = await this.embeddingGenerator.generateBatch(batch.map(({ chunk }) => chunk.content));
      for (let i = 0; i < batch.length; i++) {
        const { chunk, symbol } = batch[i];
        const vector = vectors[i] || [];
        if (vector.length === 0) continue;
        records.push({
          id: symbol.id,
          vector,
          name: symbol.name,
          kind: symbol.kind,
          filePath: normalizePath(discovered.relativePath),
          summary: symbol.summary || symbol.signature || '',
          chunkId: chunk.id,
          contentHash: chunk.contentHash,
        });
        this.setChunkEmbeddingId(chunk.id, symbol.id);
      }
    }

    if (records.length > 0) {
      try {
        await addVectors(records);
        this.embeddedVectorCount += records.length;
      } catch (err) {
        log.warn('Vector write failed for ' + normalizePath(discovered.relativePath) +
          ' - ' + (err instanceof Error ? err.message : String(err)));
      }
    }
  }

  private setChunkEmbeddingId(chunkId: string, embeddingId: string): void {
    try {
      const db = getDatabaseSync();
      db.run('UPDATE chunks SET embedding_id = ? WHERE id = ?', [embeddingId, chunkId]);
    } catch (err) {
      log.warn('Failed to update chunk embedding id: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  private getSymbolIdsByFileId(fileId: string): string[] {
    try {
      const db = getDatabaseSync();
      const rows = db.exec('SELECT id FROM symbols WHERE file_id = ?', [fileId]);
      return rows[0]?.values.map(([id]) => String(id)) ?? [];
    } catch {
      return [];
    }
  }

  private updateFinalMetadata(
    scanResult: ReturnType<typeof scanProject>,
    runStats: {
      indexedFiles: number;
      symbols: number;
      edges: number;
      chunks: number;
      durationMs: number;
      parseWorkers: number;
      dirtyFiles: number;
    },
    mode: 'full' | 'incremental',
  ): void {
    const now = new Date().toISOString();
    const totalFiles = scanResult.files.length;
    const indexedFiles = this.getTableCount('files');
    const totalSymbols = this.getTableCount('symbols');
    const totalEdges = this.getTableCount('edges');
    const totalChunks = this.getTableCount('chunks');
    this.setMetadata('project_name', this.config.projectName);
    this.setMetadata('root_path', this.rootPath);
    this.setMetadata('languages', this.config.languages.join(','));
    this.setMetadata(mode === 'full' ? 'last_full_index' : 'last_incremental_index', now);
    this.setMetadata('total_files', String(totalFiles));
    this.setMetadata('indexed_files', String(indexedFiles));
    this.setMetadata('total_symbols', String(totalSymbols));
    this.setMetadata('total_edges', String(totalEdges));
    this.setMetadata('total_chunks', String(totalChunks));
    this.setMetadata('last_index_mode', mode);
    this.setMetadata('last_run_indexed_files', String(runStats.indexedFiles));
    this.setMetadata('last_run_symbols', String(runStats.symbols));
    this.setMetadata('last_run_edges', String(runStats.edges));
    this.setMetadata('last_run_chunks', String(runStats.chunks));
    this.setMetadata('last_index_duration_ms', String(runStats.durationMs));
    this.setMetadata('parse_workers', String(runStats.parseWorkers));
    this.setMetadata('dirty_files', String(runStats.dirtyFiles));
    this.setMetadata('unresolved_calls', String(countUnresolvedCalls()));
    this.setMetadata('current_commit', scanResult.gitInfo.currentCommit ?? '');
    this.setMetadata('current_branch', scanResult.gitInfo.currentBranch ?? '');
    this.setMetadata('embedding_provider', this.config.embedding.provider);
    this.setMetadata('embedding_model', this.config.embedding.model);
    const embeddedChunkCount = this.getEmbeddedChunkCount();
    this.setMetadata('vector_search', embeddedChunkCount > 0 ? 'enabled' : 'disabled');
    this.setMetadata('embedding_dimensions', String(getEmbeddingDimensions(this.config.embedding)));
    this.setMetadata('needs_reindex', 'false');
    this.setMetadata('is_indexing', 'false');
    this.setMetadata('index_completed', now);
  }

  private setMetadata(key: string, value: string): void {
    try {
      const db = getDatabaseSync();
      db.run(
        'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
        [key, value],
      );
    } catch (err) {
      log.error('Failed to set metadata: ' + key, err);
    }
  }

  private getMetadata(key: string): string | null {
    try {
      const db = getDatabaseSync();
      const stmt = db.prepare('SELECT value FROM index_metadata WHERE key = ?');
      stmt.bind([key]);
      let value: string | null = null;
      if (stmt.step()) {
        value = stmt.getAsObject().value as string;
      }
      stmt.free();
      return value;
    } catch {
      return null;
    }
  }

  private getTableCount(table: 'files' | 'symbols' | 'edges' | 'chunks' | 'memories'): number {
    try {
      const db = getDatabaseSync();
      const result = db.exec(`SELECT COUNT(*) FROM ${table}`);
      return result.length > 0 ? Number(result[0].values[0][0]) : 0;
    } catch {
      return 0;
    }
  }

  private getEmbeddedChunkCount(): number {
    try {
      const db = getDatabaseSync();
      const result = db.exec('SELECT COUNT(*) FROM chunks WHERE embedding_id IS NOT NULL');
      return result.length > 0 ? Number(result[0].values[0][0]) : 0;
    } catch {
      return this.embeddedVectorCount;
    }
  }

  private async rebuildGraphEdges(mode: EdgeRebuildMode, dirtyFileIds: string[] = []): Promise<number> {
    const db = getDatabaseSync();
    const graphTypes = "'IMPORTS', 'CALLS', 'REFERENCES', 'TESTS', 'CONFIGURES', 'EXTENDS', 'IMPLEMENTS'";
    if (mode === 'full' || dirtyFileIds.length === 0) {
      db.run(`DELETE FROM edges WHERE type IN (${graphTypes})`);
    } else {
      this.deleteGraphEdgesForDirtyFiles(dirtyFileIds);
    }

    const indexedFiles = this.safeGetAllFiles();
    const filesByPath = new Map<string, FileRecord>();
    for (const file of indexedFiles) {
      filesByPath.set(normalizePath(file.path), file);
    }

    const symbols = this.getAllIndexedSymbols();
    const symbolsById = new Map(symbols.map((symbol) => [symbol.id, symbol]));
    const symbolsByFile = new Map<string, SymbolRecord[]>();
    for (const symbol of symbols) {
      const list = symbolsByFile.get(symbol.fileId) || [];
      list.push(symbol);
      symbolsByFile.set(symbol.fileId, list);
    }

    let edgeCount = 0;
    const rebuildFileIds = mode === 'dirty' && dirtyFileIds.length > 0
      ? new Set(dirtyFileIds)
      : new Set(indexedFiles.map((file) => file.id));
    const rebuildFileIdList = [...rebuildFileIds];
    const reexportIndex = this.buildReexportIndex(getFileExportsByFileIds());
    const callMetadata: CallEdgeMetadata = {
      callRefsByFileId: this.groupByFileId(getCallRefsByFileIds(rebuildFileIdList)),
      scopeBindingsByFileId: this.groupByFileId(getScopeBindingsByFileIds(rebuildFileIdList)),
      symbolsById,
      classMethodIndex: this.buildClassMethodIndex(symbols),
    };
    const typeRelations = getTypeRelationsByFileIds(mode === 'dirty' ? rebuildFileIdList : undefined);

    for (const fileRecord of indexedFiles) {
      if (!rebuildFileIds.has(fileRecord.id)) continue;
      const importedSymbols = this.createImportEdges(
        fileRecord,
        fileRecord.imports,
        filesByPath,
        symbolsByFile,
        reexportIndex,
      );
      edgeCount += importedSymbols.edgeCount;
      edgeCount += this.createCallEdgesFromMetadata(fileRecord, symbolsByFile, callMetadata, importedSymbols);
    }

    if (mode === 'full') {
      edgeCount += this.createConfigEdges(indexedFiles);
    } else {
      edgeCount += this.createConfigEdges(indexedFiles.filter((file) => rebuildFileIds.has(file.id)));
    }
    edgeCount += this.createTypeRelationEdges(typeRelations, symbolsById, symbols);

    const totalEdges = this.getTableCount('edges');
    log.info('Rebuilt graph edges: ' + totalEdges);
    return totalEdges;
  }

  private deleteGraphEdgesForDirtyFiles(fileIds: string[]): void {
    const db = getDatabaseSync();
    const nodeIds = new Set<string>(fileIds);
    for (const fileId of fileIds) {
      for (const symbolId of this.getSymbolIdsByFileId(fileId)) nodeIds.add(symbolId);
    }
    const ids = [...nodeIds];
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    db.run(
      `DELETE FROM edges
       WHERE type IN ('IMPORTS', 'CALLS', 'REFERENCES', 'TESTS', 'CONFIGURES', 'EXTENDS', 'IMPLEMENTS')
         AND (from_id IN (${placeholders}) OR to_id IN (${placeholders}))`,
      [...ids, ...ids],
    );
  }

  private expandDirtyFileSet(fileIds: string[]): string[] {
    if (fileIds.length === 0) return [];
    const dirty = new Set(fileIds);
    const indexedFiles = this.safeGetAllFiles();
    const filesByPath = new Map(indexedFiles.map((file) => [normalizePath(file.path), file]));
    const filesById = new Map(indexedFiles.map((file) => [file.id, file]));
    const reexportIndex = this.buildReexportIndex(getFileExportsByFileIds());
    const changedPaths = new Set(
      fileIds
        .map((id) => filesById.get(id)?.path)
        .filter((path): path is string => Boolean(path)),
    );
    if (changedPaths.size === 0) return [...dirty];

    for (const file of indexedFiles) {
      for (const imp of file.imports) {
        const target = this.resolveImportTarget(file, imp.source, filesByPath);
        if (target && changedPaths.has(target.path)) dirty.add(file.id);
      }
      for (const source of this.getReexportSources(file.id, reexportIndex)) {
        const target = this.resolveImportTarget(file, source, filesByPath);
        if (target && changedPaths.has(target.path)) dirty.add(file.id);
      }
    }
    return [...dirty];
  }

  private buildReexportIndex(exportRows: StoredExportRow[]): ReexportIndex {
    const aliasesByFileId = new Map<string, ReexportAlias[]>();
    const namespacesByFileId = new Map<string, ReexportNamespace[]>();
    const sourcesByFileId = new Map<string, string[]>();
    const exportedNamesByFileId = new Map<string, Set<string>>();

    const addSource = (fileId: string, source: string) => {
      const sources = sourcesByFileId.get(fileId) || [];
      if (!sources.includes(source)) sources.push(source);
      sourcesByFileId.set(fileId, sources);
    };

    for (const row of exportRows) {
      if (!row.source && !row.kind.startsWith('reexport')) {
        const names = exportedNamesByFileId.get(row.file_id) || new Set<string>();
        names.add(row.local_name || row.exported_name);
        exportedNamesByFileId.set(row.file_id, names);
        continue;
      }

      if (!row.source) continue;
      addSource(row.file_id, row.source);

      if (row.kind === 'reexport_alias' && row.local_name) {
        const aliases = aliasesByFileId.get(row.file_id) || [];
        aliases.push({
          source: row.source,
          importedName: row.local_name,
          exportedName: row.exported_name,
        });
        aliasesByFileId.set(row.file_id, aliases);
        continue;
      }

      if (row.kind === 'reexport_namespace') {
        const namespaces = namespacesByFileId.get(row.file_id) || [];
        namespaces.push({
          source: row.source,
          exportedName: row.exported_name,
        });
        namespacesByFileId.set(row.file_id, namespaces);
      }
    }

    return { aliasesByFileId, namespacesByFileId, sourcesByFileId, exportedNamesByFileId };
  }

  private groupByFileId<T extends { file_id: string }>(rows: T[]): Map<string, T[]> {
    const grouped = new Map<string, T[]>();
    for (const row of rows) {
      const list = grouped.get(row.file_id) || [];
      list.push(row);
      grouped.set(row.file_id, list);
    }
    return grouped;
  }

  private createConfigEdges(indexedFiles: FileRecord[]): number {
    const configs = indexedFiles.filter((file) => file.role === 'config');
    const configuredFiles = indexedFiles.filter((file) => file.role === 'source' || file.role === 'test');
    let edgeCount = 0;

    for (const config of configs) {
      for (const configuredFile of configuredFiles) {
        edgeCount += this.upsertGraphEdge(
          config.id,
          configuredFile.id,
          'CONFIGURES',
          0.55,
          'project configuration',
        );
      }
    }

    return edgeCount;
  }

  private createTypeRelationEdges(
    relations: StoredTypeRelationRow[],
    symbolsById: Map<string, SymbolRecord>,
    symbols: SymbolRecord[],
  ): number {
    let edgeCount = 0;
    for (const relation of relations) {
      const from = relation.from_symbol_id
        ? symbolsById.get(relation.from_symbol_id)
        : null;
      if (!from) continue;
      const target = relation.target_symbol_id
        ? symbolsById.get(relation.target_symbol_id)
        : symbols.find((symbol) => (
          symbol.name === relation.target_name &&
          (symbol.kind === 'class' || symbol.kind === 'interface')
        ));
      if (!target) continue;
      edgeCount += this.upsertGraphEdge(
        from.id,
        target.id,
        relation.relation_kind as EdgeType,
        0.9,
        relation.evidence || relation.target_name,
      );
    }
    return edgeCount;
  }

  private createImportEdges(
    importer: FileRecord,
    imports: ImportInfo[],
    filesByPath: Map<string, FileRecord>,
    symbolsByFile: Map<string, SymbolRecord[]>,
    reexportIndex: ReexportIndex,
  ): ImportResolution {
    let edgeCount = 0;
    const symbolsByName = new Map<string, SymbolRecord[]>();
    const namespaceSymbolsByName = new Map<string, Map<string, SymbolRecord[]>>();
    const localTestSymbols = importer.role === 'test'
      ? symbolsByFile.get(importer.id) || []
      : [];

    for (const imp of imports) {
      const importedFile = this.resolveImportTarget(importer, imp.source, filesByPath);
      if (!importedFile) continue;

      edgeCount += this.upsertGraphEdge(importer.id, importedFile.id, 'IMPORTS', 0.95, imp.source);
      if (importer.role === 'test' && importedFile.role !== 'test') {
        edgeCount += this.upsertGraphEdge(importer.id, importedFile.id, 'TESTS', 0.8, imp.source);
      }

      if (this.isSideEffectImport(imp)) continue;

      const importedSymbols = this.resolveImportedSymbolBindings(
        imp,
        importedFile,
        filesByPath,
        symbolsByFile,
        reexportIndex,
      );
      const namespaceLocalNames = this.getNamespaceBindingLocalNames(imp, importedFile, reexportIndex);
      for (const namespaceName of namespaceLocalNames) {
        if (namespaceName) {
          const byName = namespaceSymbolsByName.get(namespaceName) || new Map<string, SymbolRecord[]>();
          for (const importedSymbol of importedSymbols) {
            const current = byName.get(importedSymbol.symbol.name) || [];
            current.push(importedSymbol.symbol);
            byName.set(importedSymbol.symbol.name, current);
          }
          namespaceSymbolsByName.set(namespaceName, byName);
        }
      }

      for (const importedSymbol of importedSymbols) {
        const symbol = importedSymbol.symbol;
        const resolutionNames = [
          ...new Set([
            ...this.getImportResolutionNames(imp, symbol.name),
            ...importedSymbol.resolutionNames,
          ]),
        ];
        if (!imp.isTypeOnly) {
          for (const resolutionName of resolutionNames) {
            const current = symbolsByName.get(resolutionName) || [];
            current.push(symbol);
            symbolsByName.set(resolutionName, current);
          }
        }
        edgeCount += this.upsertGraphEdge(importer.id, symbol.id, 'REFERENCES', 0.75, imp.source);
        if (localTestSymbols.length > 0) {
          for (const testSymbol of localTestSymbols) {
            edgeCount += this.upsertGraphEdge(testSymbol.id, symbol.id, 'TESTS', 0.82, imp.source);
          }
        }
      }
    }

    return { edgeCount, symbolsByName, namespaceSymbolsByName };
  }

  private getNamespaceBindingLocalNames(
    imp: ImportInfo,
    importedFile: FileRecord,
    reexportIndex: ReexportIndex,
  ): string[] {
    const names = new Set<string>();
    if (imp.isNamespace) {
      const namespaceName = Object.keys(imp.aliases || {})[0] || imp.names[0] || imp.defaultName;
      if (namespaceName) names.add(namespaceName);
    }

    for (const namespace of this.getReexportNamespaces(importedFile.id, reexportIndex)) {
      for (const [localName, exportedName] of Object.entries(imp.aliases || {})) {
        if (exportedName === namespace.exportedName) names.add(localName);
      }
      if (imp.names.includes(namespace.exportedName)) names.add(namespace.exportedName);
      if (imp.defaultName === namespace.exportedName) names.add(imp.defaultName);
    }

    return [...names];
  }

  private isSideEffectImport(imp: ImportInfo): boolean {
    return imp.names.length === 0
      && !imp.defaultName
      && !imp.isDefault
      && !imp.isNamespace;
  }

  private resolveImportedSymbolBindings(
    imp: ImportInfo,
    importedFile: FileRecord,
    filesByPath: Map<string, FileRecord>,
    symbolsByFile: Map<string, SymbolRecord[]>,
    reexportIndex: ReexportIndex,
    seenFileIds: Set<string> = new Set(),
  ): ResolvedImportSymbol[] {
    if (seenFileIds.has(importedFile.id)) return [];
    seenFileIds.add(importedFile.id);

    const directSymbols = symbolsByFile.get(importedFile.id) || [];
    const directNames = this.getImportedSymbolNames(imp, importedFile, directSymbols);
    const directMatches = this.matchSymbolsByName(directSymbols, directNames);
    const matches: ResolvedImportSymbol[] = directMatches
      .map((symbol) => ({ symbol, resolutionNames: [] }));

    const aliasedReexportMatches = this.resolveAliasedReexportSymbols(
      imp,
      importedFile,
      filesByPath,
      symbolsByFile,
      reexportIndex,
      seenFileIds,
    );
    matches.push(...aliasedReexportMatches);

    const namespaceReexportMatches = this.resolveNamespaceReexportSymbols(
      imp,
      importedFile,
      filesByPath,
      symbolsByFile,
      reexportIndex,
      seenFileIds,
    );
    matches.push(...namespaceReexportMatches);

    const reexportSources = reexportIndex.sourcesByFileId.get(importedFile.id) || [];

    for (const source of reexportSources) {
      const reexportFile = this.resolveImportTarget(importedFile, source, filesByPath);
      if (!reexportFile) continue;

      const targetSymbols = symbolsByFile.get(reexportFile.id) || [];
      const requestedNames = imp.names.length > 0
        ? imp.names
        : [...(reexportIndex.exportedNamesByFileId.get(importedFile.id) || [])];
      const names = requestedNames.length > 0
        ? requestedNames
        : targetSymbols.map((symbol) => symbol.name);
      const sourceMatches = this.matchSymbolsByName(targetSymbols, names);
      if (sourceMatches.length > 0) {
        matches.push(
          ...sourceMatches.map((symbol) => ({ symbol, resolutionNames: [] })),
        );
        continue;
      }

      matches.push(
        ...this.resolveImportedSymbolBindings(imp, reexportFile, filesByPath, symbolsByFile, reexportIndex, seenFileIds),
      );
    }

    return this.mergeResolvedImportSymbols(matches);
  }

  private mergeResolvedImportSymbols(matches: ResolvedImportSymbol[]): ResolvedImportSymbol[] {
    const bySymbolId = new Map<string, ResolvedImportSymbol>();
    for (const match of matches) {
      const existing = bySymbolId.get(match.symbol.id);
      if (!existing) {
        bySymbolId.set(match.symbol.id, {
          symbol: match.symbol,
          resolutionNames: [...new Set(match.resolutionNames)],
        });
        continue;
      }
      existing.resolutionNames = [
        ...new Set([
          ...existing.resolutionNames,
          ...match.resolutionNames,
        ]),
      ];
    }
    return [...bySymbolId.values()];
  }

  private resolveNamespaceReexportSymbols(
    imp: ImportInfo,
    importedFile: FileRecord,
    filesByPath: Map<string, FileRecord>,
    symbolsByFile: Map<string, SymbolRecord[]>,
    reexportIndex: ReexportIndex,
    seenFileIds: Set<string>,
  ): ResolvedImportSymbol[] {
    const requestedNames = new Set(imp.names);
    if (imp.defaultName) requestedNames.add(imp.defaultName);
    if (requestedNames.size === 0 && !imp.isNamespace) return [];

    const matches: ResolvedImportSymbol[] = [];
    for (const namespace of this.getReexportNamespaces(importedFile.id, reexportIndex)) {
      if (!imp.isNamespace && !requestedNames.has(namespace.exportedName)) continue;

      const reexportFile = this.resolveImportTarget(importedFile, namespace.source, filesByPath);
      if (!reexportFile || seenFileIds.has(reexportFile.id)) continue;

      const targetSymbols = this.getExportedSymbols(
        reexportFile,
        symbolsByFile.get(reexportFile.id) || [],
        reexportIndex,
      );
      matches.push(
        ...targetSymbols.map((symbol) => ({
          symbol,
          resolutionNames: [symbol.name],
        })),
      );
    }

    return matches;
  }

  private resolveAliasedReexportSymbols(
    imp: ImportInfo,
    importedFile: FileRecord,
    filesByPath: Map<string, FileRecord>,
    symbolsByFile: Map<string, SymbolRecord[]>,
    reexportIndex: ReexportIndex,
    seenFileIds: Set<string>,
  ): ResolvedImportSymbol[] {
    const requestedNames = new Set(imp.names);
    if (imp.defaultName) requestedNames.add(imp.defaultName);
    if (requestedNames.size === 0 && !imp.isNamespace) return [];

    const matches: ResolvedImportSymbol[] = [];
    for (const alias of this.getReexportAliases(importedFile.id, reexportIndex)) {
      if (!imp.isNamespace && !requestedNames.has(alias.exportedName)) continue;

      const reexportFile = this.resolveImportTarget(importedFile, alias.source, filesByPath);
      if (!reexportFile || seenFileIds.has(reexportFile.id)) continue;

      const targetSymbols = symbolsByFile.get(reexportFile.id) || [];
      for (const symbol of this.matchSymbolsByName(targetSymbols, [alias.importedName])) {
        matches.push({
          symbol,
          resolutionNames: [alias.exportedName],
        });
      }
    }

    return matches;
  }

  private getExportedSymbols(
    file: FileRecord,
    symbols: SymbolRecord[],
    reexportIndex: ReexportIndex,
  ): SymbolRecord[] {
    const exportedNames = reexportIndex.exportedNamesByFileId.get(file.id) || new Set<string>();
    const exported = symbols.filter((symbol) => exportedNames.has(symbol.name));
    return exported.length > 0 ? exported : symbols;
  }

  private getReexportAliases(fileId: string, reexportIndex: ReexportIndex): ReexportAlias[] {
    return reexportIndex.aliasesByFileId.get(fileId) || [];
  }

  private getReexportNamespaces(fileId: string, reexportIndex: ReexportIndex): ReexportNamespace[] {
    return reexportIndex.namespacesByFileId.get(fileId) || [];
  }

  private getReexportSources(fileId: string, reexportIndex: ReexportIndex): string[] {
    return reexportIndex.sourcesByFileId.get(fileId) || [];
  }

  private matchSymbolsByName(symbols: SymbolRecord[], names: string[]): SymbolRecord[] {
    const nameSet = new Set(names);
    return symbols.filter((symbol) => nameSet.has(symbol.name));
  }

  private getImportedSymbolNames(
    imp: ImportInfo,
    importedFile: FileRecord,
    targetSymbols: SymbolRecord[],
  ): string[] {
    if (imp.isNamespace) {
      const exported = targetSymbols
        .filter((symbol) => importedFile.exports.includes(symbol.name))
        .map((symbol) => symbol.name);
      return exported.length > 0
        ? exported
        : targetSymbols.map((symbol) => symbol.name);
    }

    if (imp.isDefault && imp.names.length > 0) {
      const names = new Set(imp.names);
      const defaultSymbol = this.findDefaultImportSymbol(importedFile, targetSymbols);
      if (defaultSymbol) names.add(defaultSymbol.name);
      return [...names];
    }

    return imp.names.length > 0
      ? imp.names
      : targetSymbols.slice(0, 1).map((symbol) => symbol.name);
  }

  private getImportResolutionNames(imp: ImportInfo, importedName: string): string[] {
    const names = new Set([importedName]);
    const namedExportNames = new Set(Object.values(imp.aliases || {}));
    if (imp.defaultName && !imp.isNamespace && !namedExportNames.has(importedName)) {
      names.add(imp.defaultName);
    }
    for (const [localName, exportedName] of Object.entries(imp.aliases || {})) {
      if (exportedName === importedName) names.add(localName);
    }
    return [...names];
  }

  private findDefaultImportSymbol(
    importedFile: FileRecord,
    targetSymbols: SymbolRecord[],
  ): SymbolRecord | null {
    return targetSymbols.find((symbol) => importedFile.exports.includes(symbol.name))
      || targetSymbols[0]
      || null;
  }

  private createCallEdgesFromMetadata(
    file: FileRecord,
    symbolsByFile: Map<string, SymbolRecord[]>,
    metadata: CallEdgeMetadata,
    importedSymbols: ImportResolution,
  ): number {
    let edgeCount = 0;
    const localSymbols = symbolsByFile.get(file.id) || [];
    const callRefs = metadata.callRefsByFileId.get(file.id) || [];
    const scopeBindings = metadata.scopeBindingsByFileId.get(file.id) || [];

    for (const call of callRefs) {
      const caller = call.caller_symbol_id
        ? metadata.symbolsById.get(call.caller_symbol_id) ?? null
        : call.caller_name
          ? this.findSymbolByNameAndLine(localSymbols, call.caller_name, call.caller_start_line)
          : null;

      const resolution = this.resolveCallTarget(
        call,
        localSymbols,
        importedSymbols,
        scopeBindings,
        metadata.classMethodIndex,
      );
      if (!resolution.symbol) {
        updateCallRefResolution(call.id, 'unresolved');
        continue;
      }

      const fromId = caller?.id || file.id;
      edgeCount += this.upsertGraphEdge(
        fromId,
        resolution.symbol.id,
        'CALLS',
        resolution.confidence,
        call.evidence || '',
      );
      updateCallRefResolution(call.id, 'resolved');
    }

    return edgeCount;
  }

  private resolveCallTarget(
    call: StoredCallRefRow,
    localSymbols: SymbolRecord[],
    importedSymbols: ImportResolution,
    scopeBindings: StoredScopeBindingRow[],
    classMethodIndex: Map<string, Map<string, SymbolRecord[]>>,
  ): { symbol: SymbolRecord | null; confidence: number } {
    const receiverName = call.receiver_name;
    const memberName = call.member_name || call.callee_name;

    if (call.is_constructor_call) {
      const imported = importedSymbols.symbolsByName.get(call.callee_name)?.find((symbol) => symbol.kind === 'class');
      const local = localSymbols.find((symbol) => symbol.name === call.callee_name && symbol.kind === 'class');
      return { symbol: imported || local || null, confidence: imported || local ? 0.88 : 0 };
    }

    if (receiverName === 'this' && call.caller_class_name) {
      const method = this.findClassMethod(classMethodIndex, call.caller_class_name, memberName, localSymbols[0]?.fileId);
      return { symbol: method, confidence: method ? 0.96 : 0 };
    }

    if (receiverName) {
      const namespaceMethod = importedSymbols.namespaceSymbolsByName.get(receiverName)?.get(memberName)?.[0] ?? null;
      if (namespaceMethod) return { symbol: namespaceMethod, confidence: 0.93 };

      const binding = scopeBindings
        .filter((candidate) => candidate.local_name === receiverName)
        .sort((a, b) => b.start_line - a.start_line)[0];
      if (binding?.target_name) {
        const method = this.findClassMethod(classMethodIndex, binding.target_name, memberName);
        return { symbol: method, confidence: method ? 0.94 : 0 };
      }

      return { symbol: null, confidence: 0 };
    }

    const local = localSymbols.find((symbol) => (
      symbol.name === call.callee_name &&
      (symbol.kind === 'function' || symbol.kind === 'variable' || symbol.kind === 'constant' || symbol.kind === 'method')
    ));
    if (local) return { symbol: local, confidence: 0.9 };

    const imported = importedSymbols.symbolsByName.get(call.callee_name)?.[0] ?? null;
    return { symbol: imported, confidence: imported ? 0.92 : 0 };
  }

  private buildClassMethodIndex(symbols: SymbolRecord[]): Map<string, Map<string, SymbolRecord[]>> {
    const index = new Map<string, Map<string, SymbolRecord[]>>();
    const classes = symbols.filter((symbol) => symbol.kind === 'class' || symbol.kind === 'interface');
    const methods = symbols.filter((symbol) => symbol.kind === 'method' || symbol.kind === 'constructor');

    for (const cls of classes) {
      const classMethods = methods.filter((method) => (
        method.fileId === cls.fileId &&
        method.startLine >= cls.startLine &&
        method.endLine <= cls.endLine
      ));
      const byName = index.get(cls.name) || new Map<string, SymbolRecord[]>();
      for (const method of classMethods) {
        const list = byName.get(method.name) || [];
        list.push(method);
        byName.set(method.name, list);
      }
      index.set(cls.name, byName);
    }

    return index;
  }

  private findClassMethod(
    index: Map<string, Map<string, SymbolRecord[]>>,
    className: string,
    methodName: string,
    preferredFileId?: string,
  ): SymbolRecord | null {
    const candidates = index.get(className)?.get(methodName) || [];
    if (candidates.length === 0) return null;
    if (preferredFileId) {
      const sameFile = candidates.find((candidate) => candidate.fileId === preferredFileId);
      if (sameFile) return sameFile;
    }
    return candidates[0];
  }

  private upsertGraphEdge(
    fromId: string,
    toId: string,
    type: EdgeType,
    confidence: number,
    evidence: string,
  ): number {
    try {
      upsertEdge({
        id: generateId('edge', fromId, toId, type),
        fromId,
        toId,
        type,
        confidence,
        evidence,
      });
      return 1;
    } catch {
      return 0;
    }
  }

  private findSymbolByNameAndLine(
    symbols: SymbolRecord[],
    name: string,
    line: number | null,
  ): SymbolRecord | null {
    const candidates = symbols.filter((symbol) => symbol.name === name);
    if (candidates.length === 0) return null;
    if (line !== null) {
      const exact = candidates.find((symbol) => symbol.rangeStart === line);
      if (exact) return exact;
      const containing = candidates.find((symbol) => symbol.rangeStart <= line && symbol.rangeEnd >= line);
      if (containing) return containing;
    }
    return candidates[0];
  }

  private resolveImportTarget(
    importer: FileRecord,
    source: string,
    filesByPath: Map<string, FileRecord>,
  ): FileRecord | null {
    if (!source.startsWith('.')) return null;

    const importerDir = posixPath.dirname(normalizePath(importer.path));
    const rawPath = normalizePath(posixPath.normalize(posixPath.join(importerDir, source)));
    const candidates = this.getImportCandidates(rawPath, importer.language === 'typescript');

    for (const candidate of candidates) {
      const file = filesByPath.get(candidate);
      if (file) return file;
    }

    return null;
  }

  private getImportCandidates(rawPath: string, preferTypeScript: boolean): string[] {
    const candidates: string[] = [];
    const add = (candidate: string) => {
      const normalized = normalizePath(candidate);
      if (!candidates.includes(normalized)) candidates.push(normalized);
    };

    const ext = posixPath.extname(rawPath);
    if (ext) {
      const withoutExt = rawPath.slice(0, -ext.length);
      if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
        add(withoutExt + '.ts');
        add(withoutExt + '.tsx');
      }
      add(rawPath);
      return candidates;
    }

    const extensions = preferTypeScript
      ? ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
      : ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'];
    for (const candidateExt of extensions) add(rawPath + candidateExt);
    for (const candidateExt of extensions) add(posixPath.join(rawPath, 'index' + candidateExt));
    return candidates;
  }

  private getAllIndexedSymbols(): SymbolRecord[] {
    try {
      const db = getDatabaseSync();
      const rows = db.exec(
        `SELECT id, file_id, name, kind, start_byte, end_byte, start_line, end_line,
                start_column, end_column, range_start, range_end, signature, summary,
                hash, access_level
         FROM symbols`,
      );
      if (rows.length === 0) return [];
      return rows[0].values.map((row) => ({
        id: String(row[0]),
        fileId: String(row[1]),
        name: String(row[2]),
        kind: String(row[3]) as SymbolRecord['kind'],
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
        accessLevel: row[15] ? String(row[15]) as SymbolRecord['accessLevel'] : null,
      }));
    } catch {
      return [];
    }
  }

  private safeGetAllFiles(): FileRecord[] {
    try { return getAllFiles(); }
    catch { return []; }
  }

  private buildStatus(
    recentIndexed: number,
    recentSymbols: number,
    recentEdges: number,
    recentChunks: number,
  ): IndexStatus {
    const totalFiles = parseInt(this.getMetadata('total_files') ?? '0', 10);
    const indexedFiles = parseInt(this.getMetadata('indexed_files') ?? '0', 10);
    const totalSymbols = parseInt(this.getMetadata('total_symbols') ?? '0', 10);
    const totalEdges = parseInt(this.getMetadata('total_edges') ?? '0', 10);
    const totalChunks = parseInt(this.getMetadata('total_chunks') ?? '0', 10);
    const totalMemories = this.getTableCount('memories');

    return {
      projectPath: this.rootPath,
      totalFiles: totalFiles > 0 ? totalFiles : recentIndexed,
      indexedFiles: indexedFiles > 0 ? indexedFiles : recentIndexed,
      totalSymbols: totalSymbols > 0 ? totalSymbols : recentSymbols,
      totalEdges: totalEdges > 0 ? totalEdges : recentEdges,
      totalChunks: totalChunks > 0 ? totalChunks : recentChunks,
      totalMemories,
      lastFullIndex: this.getMetadata('last_full_index'),
      lastIncrementalIndex: this.getMetadata('last_incremental_index'),
      currentCommit: this.getMetadata('current_commit'),
      currentBranch: this.getMetadata('current_branch'),
      embeddingProvider: this.getMetadata('embedding_provider'),
      isIndexing: this.getMetadata('is_indexing') === 'true',
    };
  }
}
