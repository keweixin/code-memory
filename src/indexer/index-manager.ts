/**
 * Code Memory Graph — Index Manager
 *
 * Coordinates the full indexing pipeline:
 *   scan project -> parse files -> store records -> update metadata
 *
 * Supports both full (re-index everything) and incremental (changed files only)
 * indexing strategies.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as posixPath from 'node:path/posix';
import { availableParallelism } from 'node:os';
import type { CodeMemoryConfig, IndexStatus, FileRecord, SymbolRecord, ChunkRecord, ParseResult, ImportInfo, EdgeType } from '../shared/types.js';
import type { DiscoveredFile } from '../scanner/file-discovery.js';
import { initTreeSitter } from '../parser/parser-registry.js';
import { parseFile, resolveParserLanguage } from '../parser/tree-sitter-parser.js';
import { ModuleResolver } from '../parser/module-resolver.js';
import { scanProject, type ScanResult } from '../scanner/project-scanner.js';
import { loadProjectManifest } from '../scanner/project-manifest.js';
import { getFileContentHash, getGitInfo } from '../scanner/git-integration.js';
import { getDatabase, getDatabaseSync, saveDatabase, type SqlJsDatabase } from '../storage/database.js';
import { deleteFile } from '../storage/file-repository.js';
import { deleteSymbolsByFileId } from '../storage/symbol-repository.js';
import { deleteGraphEvidenceForNodes } from '../storage/graph-evidence-repository.js';
import { deleteChunksByFileId } from '../storage/chunk-repository.js';
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
  deleteParseMetadataByFileId,
  getCallRefsByFileIds,
  getFileExportsByFileIds,
  getRouteEndpointsByFileIds,
  getRouteReferencesByFileIds,
  getScopeBindingsByFileIds,
  getTypeRelationsByFileIds,
  type StoredCallRefRow,
  type StoredExportRow,
  type StoredRouteEndpointRow,
  type StoredRouteReferenceRow,
  type StoredScopeBindingRow,
  type StoredTypeRelationRow,
} from '../storage/parse-metadata-repository.js';
import { resolveWorkerPoolSize } from './parse-worker-pool.js';
import { parseDiscoveredFilesBatched, type ParseBatchItem } from './parse-coordinator.js';
import {
  buildGraphRebuildIndexes,
  commitGraphRebuild,
  prepareGraphRebuildScope,
  GRAPH_EDGE_TYPES,
  type EdgeRebuildMode,
} from './graph-rebuild-coordinator.js';
import { createIndexRunId, type IndexRunMode } from './index-run-lifecycle.js';
import { acquireIndexLock, type IndexLock } from './index-lock.js';
import { EmbeddingQueue } from './embedding-queue.js';
import { IndexMetricsRecorder } from './index-metrics.js';
import { IndexMetadataStore } from './index-metadata-store.js';
import { GraphWriteBuffer, type CallResolutionStatus, type GraphEdgeEvidenceMeta } from './graph-write-buffer.js';
import { pruneContextLedgerReferences, type ContextLedgerPruneInput } from '../memory/context-ledger.js';
import { planDirtyFilesFromPaths } from './dirty-file-planner.js';
import { persistParseResult } from './persistence-writer.js';
import {
  traceProcess,
  type ProcessEntry,
  type ProcessTraceResult,
} from '../graph/process-tracer.js';
import { detectCommunities } from '../graph/community-detector.js';

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

const AUTO_WORKER_CAP = 8;

export function resolveAutoWorkerCount(availableCpus: number = availableParallelism()): number {
  const cpuCount = Number.isFinite(availableCpus)
    ? Math.max(1, Math.floor(availableCpus))
    : 1;
  return Math.max(1, Math.min(AUTO_WORKER_CAP, cpuCount - 1));
}

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

interface RouteEdgeMetadata {
  endpoints: StoredRouteEndpointRow[];
  references: StoredRouteReferenceRow[];
}

export interface IncrementalIndexOptions {
  forceAll?: boolean;
  changedPaths?: string[];
  fallbackToScan?: boolean;
}

export class IndexManager {
  private rootPath: string;
  private config: CodeMemoryConfig;
  private db: SqlJsDatabase | null = null;
  private embeddingGenerator: EmbeddingGenerator | null = null;
  private vectorStoreReady = false;
  private embeddedVectorCount = 0;
  private gitHistoryAvailable = false;
  private moduleResolver: ModuleResolver | null = null;
  private metadata: IndexMetadataStore;
  private graphBuffer: GraphWriteBuffer;
  private _lastCommunityMs = 0;

  /** Community detection timing from the most recent run (ms). */
  get lastCommunityMs(): number { return this._lastCommunityMs; }

  constructor(rootPath: string, config: CodeMemoryConfig) {
    this.rootPath = resolve(rootPath);
    this.config = config;
    this.metadata = new IndexMetadataStore(
      this.rootPath,
      this.config,
      () => this.embeddedVectorCount,
    );
    this.graphBuffer = new GraphWriteBuffer();
  }

  async fullIndex(): Promise<IndexStatus> {
    log.info('Starting full index of: ' + this.rootPath);
    const startTime = Date.now();
    const runId = createIndexRunId('full');
    const metrics = new IndexMetricsRecorder();
    metrics.mark('start');
    let lock: IndexLock | null = null;
    let runStarted = false;
    let runCompleted = false;
    let scanMs = 0;
  let parseMs = 0;
  let writeMs = 0;
  let vectorMs = 0;
  let edgeMs = 0;
  let communityMs = 0;
  let processMs = 0;

  try {
    await this.ensureDb();
    lock = acquireIndexLock(this.rootPath);
    await initTreeSitter();
    await this.prepareVectorStore(true);

    this.beginIndexRun(runId, 'full');
    runStarted = true;

    log.info('Scanning project files...');
    const scanStart = Date.now();
    const scanResult = scanProject(this.rootPath, this.config);
    scanMs = Date.now() - scanStart;
      this.gitHistoryAvailable = Boolean(scanResult.gitInfo.currentCommit);
      const files = scanResult.files;
      log.info('Discovered ' + files.length + ' files to index');

      await this.pruneFilesNotInFullScan(files);

      let indexedCount = 0, totalSymbols = 0, totalChunks = 0;
      const workers = this.resolveWorkerCount('full', files.length);
      let parseWaitStart = Date.now();

      for await (const batch of this.parseDiscoveredFilesBatched(files, workers)) {
        parseMs += Date.now() - parseWaitStart;
        for (const { discovered, result, error } of batch) {
          if (error) {
            log.error('Failed to index: ' + discovered.relativePath, error);
            continue;
          }
          if (!result) continue;
          const writeStart = Date.now();
          await this.removeFileFromIndex(result.fileId);
          this.storeParseResult(result, discovered);
          writeMs += Date.now() - writeStart;
          const vectorStart = Date.now();
          await this.indexChunkVectors(result, discovered);
          vectorMs += Date.now() - vectorStart;
          indexedCount++; totalSymbols += result.symbols.length;
          totalChunks += result.chunks.length;
        }

        log.info('Progress: ' + indexedCount + '/' + files.length +
          ' (' + totalSymbols + ' symbols)');
        parseWaitStart = Date.now();
      }

      const edgeStart = Date.now();
      // Rebuild FTS indexes from scratch after bulk row inserts.
      // This ensures the FTS index is consistent and optimized after
      // many incremental trigger-fired updates during the indexing loop.
      try {
        const ftsDb = getDatabaseSync();
        ftsDb.run("INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild')");
        ftsDb.run("INSERT INTO files_fts(files_fts) VALUES('rebuild')");
      } catch (ftsErr) {
        log.warn('FTS rebuild after full index failed: ' + (ftsErr instanceof Error ? ftsErr.message : String(ftsErr)));
      }
      const totalEdges = await this.rebuildGraphEdges('full');
      edgeMs = Date.now() - edgeStart;
      const processStart = Date.now();
      await this.runProcessAndCommunityDetection();
      processMs = Date.now() - processStart;
      communityMs = this.lastCommunityMs;
      const elapsed = Date.now() - startTime;
      this.markIndexRunCommitting(runId);
      this.updateFinalMetadata(scanResult, {
        indexedFiles: indexedCount,
        symbols: totalSymbols,
        edges: totalEdges,
        chunks: totalChunks,
        durationMs: elapsed,
        parseWorkers: workers,
        dirtyFiles: indexedCount,
        scanMs,
        parseMs,
        writeMs,
        edgeMs,
        vectorMs,
        communityMs,
        processMs,
        peakRssMb: metrics.peakRssMb(),
      }, 'full');

      log.info('Full index done in ' + (elapsed / 1000).toFixed(1) + 's: ' +
        indexedCount + ' files, ' + totalSymbols + ' symbols, ' + totalEdges + ' edges');

      this.completeIndexRun(runId);
      runCompleted = true;
      return this.buildStatus(indexedCount, totalSymbols, totalEdges, totalChunks);
    } catch (err) {
      if (runStarted && !runCompleted) {
        this.failIndexRun(runId, err);
      }
      throw err;
    } finally {
      if (runStarted && !runCompleted) {
        this.metadata.set('is_indexing', 'false');
      }
      try {
        await saveDatabase();
      } catch (err) {
        log.warn('Database checkpoint after full index failed: ' + (err instanceof Error ? err.message : String(err)));
      }
      releaseVectorStoreConnection();
      lock?.release();
    }
  }

  async incrementalIndex(options: boolean | IncrementalIndexOptions = false): Promise<IndexStatus> {
    const incrementalOptions: IncrementalIndexOptions = typeof options === 'boolean'
      ? { forceAll: options }
      : options;
    const forceAll = incrementalOptions.forceAll ?? false;
    log.info('Starting incremental index of: ' + this.rootPath);
    const startTime = Date.now();
    const runMode: IndexRunMode = forceAll ? 'full' : 'incremental';
    const runId = createIndexRunId(runMode);
    const metrics = new IndexMetricsRecorder();
    metrics.mark('start');
    let lock: IndexLock | null = null;
    let runStarted = false;
    let runCompleted = false;
    let scanMs = 0;
    let parseMs = 0;
    let writeMs = 0;
    let vectorMs = 0;
    let edgeMs = 0;
    let communityMs = 0;
    let processMs = 0;

    try {
      await this.ensureDb();
      lock = acquireIndexLock(this.rootPath);
      await initTreeSitter();
      await this.prepareVectorStore(forceAll);

      this.beginIndexRun(runId, runMode);
      runStarted = true;
      const prevFiles = this.safeGetAllFiles();
      let scanResult!: ScanResult;
      let indexedCount = 0, totalSymbols = 0, totalChunks = 0;
      const dirtyFiles: DiscoveredFile[] = [];
      const deletedFileIds: string[] = [];
      const hasChangedPaths = !forceAll
        && Array.isArray(incrementalOptions.changedPaths)
        && incrementalOptions.changedPaths.length > 0;
      let usedPathAwarePlan = false;

      if (hasChangedPaths) {
        const scanStart = Date.now();
        const plan = planDirtyFilesFromPaths(
          this.rootPath,
          this.config,
          incrementalOptions.changedPaths ?? [],
          prevFiles,
        );
        scanMs = Date.now() - scanStart;
        if (plan.mode === 'fallback-scan' && incrementalOptions.fallbackToScan === false) {
          throw new Error('Path-aware incremental indexing requires full-scan fallback: ' + (plan.fallbackReason ?? 'unknown reason'));
        }
        if (plan.mode === 'path-aware' || plan.mode === 'noop') {
          usedPathAwarePlan = true;
          const gitInfo = getGitInfo(this.rootPath);
          this.gitHistoryAvailable = Boolean(gitInfo.currentCommit);
          dirtyFiles.push(...plan.changedFiles);
          for (const fileId of plan.deletedFileIds) {
            await this.removeFileFromIndex(fileId);
            deletedFileIds.push(fileId);
          }
          scanResult = {
            files: [],
            gitInfo,
            stats: {
              totalFiles: this.getTableCount('files'),
              byLanguage: {},
              byRole: {},
              skippedSize: 0,
              skippedBinary: 0,
            },
          };
          this.setMetadata('last_incremental_planner', plan.mode);
          this.setMetadata('last_incremental_changed_paths', String((incrementalOptions.changedPaths ?? []).length));
          this.setMetadata('last_incremental_ignored_paths', String(plan.ignoredPaths.length));
          this.setMetadata('last_incremental_unsupported_paths', String(plan.unsupportedPaths.length));
        } else {
          this.setMetadata('last_incremental_planner', 'fallback-scan');
          this.setMetadata('last_incremental_fallback_reason', plan.fallbackReason ?? '');
        }
      }

      if (!usedPathAwarePlan) {
        const scanStart = Date.now();
        scanResult = scanProject(this.rootPath, this.config);
        scanMs = Date.now() - scanStart;
        this.gitHistoryAvailable = Boolean(scanResult.gitInfo.currentCommit);

        const currentFileMap = new Map<string, DiscoveredFile>();
        for (const f of scanResult.files) {
          currentFileMap.set(normalizePath(f.relativePath), f);
        }

        const prevFileMap = new Map<string, FileRecord>();
        for (const pf of prevFiles) {
          prevFileMap.set(normalizePath(pf.path), pf);
        }

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
              const currentHash = await getFileContentHash(currentFile.path);
              needsReindex = (currentHash !== prevFile.hash);
            } catch { needsReindex = true; }
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
      }

      if (usedPathAwarePlan && dirtyFiles.length === 0 && deletedFileIds.length === 0) {
        const elapsed = Date.now() - startTime;
        this.markIndexRunCommitting(runId);
        this.updateFinalMetadata(scanResult, {
          indexedFiles: 0,
          symbols: 0,
          edges: this.getTableCount('edges'),
          chunks: 0,
          durationMs: elapsed,
          parseWorkers: 0,
          dirtyFiles: 0,
          scanMs,
          parseMs,
          writeMs,
          edgeMs,
          vectorMs,
          peakRssMb: metrics.peakRssMb(),
        }, 'incremental');
        this.completeIndexRun(runId);
        runCompleted = true;
        log.info('Incremental index skipped: no indexable changed paths');
        return this.buildStatus(0, 0, 0, 0);
      }

      const workers = forceAll
        ? this.resolveWorkerCount('full', dirtyFiles.length)
        : this.resolveWorkerCount('dirty', dirtyFiles.length);
      const dirtyFileIds = new Set<string>(deletedFileIds);
      let parseWaitStart = Date.now();

      for await (const batch of this.parseDiscoveredFilesBatched(dirtyFiles, workers)) {
        parseMs += Date.now() - parseWaitStart;
        for (const { discovered, result, error } of batch) {
          if (error) {
            log.error('Failed to index: ' + discovered.relativePath, error);
            continue;
          }
          if (!result) continue;
          dirtyFileIds.add(result.fileId);
          const writeStart = Date.now();
          await this.removeFileFromIndex(result.fileId);
          this.storeParseResult(result, discovered);
          writeMs += Date.now() - writeStart;
          const vectorStart = Date.now();
          await this.indexChunkVectors(result, discovered);
          vectorMs += Date.now() - vectorStart;
          indexedCount++; totalSymbols += result.symbols.length;
          totalChunks += result.chunks.length;
        }
        parseWaitStart = Date.now();
      }

      const expandedDirtyFileIds = this.expandDirtyFileSet([...dirtyFileIds]);
      const edgeStart = Date.now();
      const totalEdges = await this.rebuildGraphEdges(forceAll ? 'full' : 'dirty', expandedDirtyFileIds);
      edgeMs = Date.now() - edgeStart;
      const processStart = Date.now();
      await this.runProcessAndCommunityDetection();
      processMs = Date.now() - processStart;
      communityMs = this.lastCommunityMs;
      const elapsed = Date.now() - startTime;
      if (usedPathAwarePlan) {
        scanResult.stats.totalFiles = this.getTableCount('files');
      }
      this.markIndexRunCommitting(runId);
      this.updateFinalMetadata(scanResult, {
        indexedFiles: indexedCount,
        symbols: totalSymbols,
        edges: totalEdges,
        chunks: totalChunks,
        durationMs: elapsed,
        parseWorkers: workers,
        dirtyFiles: expandedDirtyFileIds.length,
        scanMs,
        parseMs,
        writeMs,
        edgeMs,
        vectorMs,
        communityMs,
        processMs,
        peakRssMb: metrics.peakRssMb(),
      }, forceAll ? 'full' : 'incremental');

      log.info('Incremental index done: ' + indexedCount + ' files updated');
      this.completeIndexRun(runId);
      runCompleted = true;
      return this.buildStatus(indexedCount, totalSymbols, totalEdges, totalChunks);
    } catch (err) {
      if (runStarted && !runCompleted) {
        this.failIndexRun(runId, err);
      }
      throw err;
    } finally {
      if (runStarted && !runCompleted) {
        this.setMetadata('is_indexing', 'false');
      }
      try {
        await saveDatabase();
      } catch (err) {
        log.warn('Database checkpoint after incremental index failed: ' + (err instanceof Error ? err.message : String(err)));
      }
      releaseVectorStoreConnection();
      lock?.release();
    }
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
        const hash = await getFileContentHash(discovered.path).catch(() => '');
        return this.createFileOnlyParseResult(discovered, hash);
      }
      return null;
    }

    let sourceCode: string;
    try {
      sourceCode = await readFile(discovered.path, 'utf-8');
    } catch (err) {
      log.error('Cannot read file: ' + discovered.path, err);
      return null;
    }

    const fileId = generateId('file', normalizePath(discovered.relativePath));
    return await parseFile(discovered.path, sourceCode, parserLang, fileId);
  }

  private createFileOnlyParseResult(discovered: DiscoveredFile, contentHashValue: string): ParseResult {
    return {
      fileId: generateId('file', normalizePath(discovered.relativePath)),
      filePath: discovered.path,
      language: discovered.language,
      contentHash: contentHashValue,
      symbols: [],
      imports: [],
      exports: [],
      edges: [],
      calls: [],
      scopeBindings: [],
      typeRelations: [],
      routeEndpoints: [],
      routeReferences: [],
      chunks: [],
      errors: [],
    };
  }

  private resolveWorkerCount(_mode: 'full' | 'dirty' = 'full', fileCount?: number): number {
    const configured = this.config.indexing?.workers ?? 'auto';
    if (configured === 0) return 0;
    const requested = typeof configured === 'number'
      ? Math.max(0, Math.floor(configured))
      : resolveAutoWorkerCount();
    return fileCount === undefined
      ? requested
      : resolveWorkerPoolSize(requested, fileCount);
  }

  private getParseBatchSize(): number {
    return Math.max(1, Math.floor(this.config.indexing?.parseBatchSize ?? 100));
  }

  private async parseDiscoveredFiles(
    files: DiscoveredFile[],
    workers: number,
  ): Promise<ParseBatchItem[]> {
    const results: ParseBatchItem[] = [];
    for await (const batch of this.parseDiscoveredFilesBatched(files, workers)) {
      results.push(...batch);
    }
    return results;
  }

  private async *parseDiscoveredFilesBatched(
    files: DiscoveredFile[],
    workers: number,
  ): AsyncGenerator<ParseBatchItem[]> {
    yield* parseDiscoveredFilesBatched(files, {
      workers,
      rootPath: this.rootPath,
      batchSize: this.getParseBatchSize(),
      parseFile: (discovered) => this.indexFile(discovered),
    });
  }

  private storeParseResult(result: ParseResult, discovered: DiscoveredFile): void {
    persistParseResult({
      rootPath: this.rootPath,
      result,
      discovered,
      gitHistoryAvailable: this.gitHistoryAvailable,
    });
  }

  private async removeFileFromIndex(fileId: string): Promise<void> {
    try {
      const ledgerReferences = this.collectRemovedContextLedgerReferences(fileId);
      const symbolIds = this.getSymbolIdsByFileId(fileId);
      if (this.vectorStoreReady && symbolIds.length > 0) {
        await deleteVectors(symbolIds);
      }
      pruneContextLedgerReferences(ledgerReferences);

      const allNodeIds = [fileId, ...symbolIds];
      deleteGraphEvidenceForNodes(allNodeIds);

      // Batch edge deletion: single SQL statement instead of N+1 individual calls
      if (allNodeIds.length > 0) {
        const db = getDatabaseSync();
        const placeholders = allNodeIds.map(() => '?').join(',');
        db.run(
          `DELETE FROM edges WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})`,
          [...allNodeIds, ...allNodeIds],
        );
      }

      deleteChunksByFileId(fileId);
      deleteSymbolsByFileId(fileId);
      deleteParseMetadataByFileId(fileId);
      deleteFile(fileId);
    } catch (err) {
      log.error('Failed to remove file from index: ' + fileId, err);
    }
  }

  private collectRemovedContextLedgerReferences(fileId: string): ContextLedgerPruneInput {
    try {
      const db = getDatabaseSync();
      const filePath = String(
        db.exec('SELECT path FROM files WHERE id = ?', [fileId])[0]?.values[0]?.[0] ?? '',
      );
      const filePaths = filePath ? [filePath] : [];
      const symbols = db.all<{
        id: string;
        name: string;
        kind: string;
        start_line: number;
        end_line: number;
      }>(
        'SELECT id, name, kind, start_line, end_line FROM symbols WHERE file_id = ?',
        [fileId],
      );
      const chunks = db.all<{
        id: string;
        symbol_name: string | null;
        start_line: number;
        end_line: number;
      }>(
        `SELECT c.id, COALESCE(s.name, 'file') AS symbol_name, c.start_line, c.end_line
         FROM chunks c
         LEFT JOIN symbols s ON s.id = c.symbol_id
         WHERE c.file_id = ?`,
        [fileId],
      );
      const symbolKeys = [
        ...symbols.map((symbol) => symbol.id),
        ...symbols
          .filter(() => filePath.length > 0)
          .map((symbol) => [
            filePath,
            symbol.name,
            symbol.kind,
            symbol.start_line,
            symbol.end_line,
          ].join(':')),
      ];
      const chunkKeys = [
        ...chunks.map((chunk) => chunk.id),
        ...chunks
          .filter(() => filePath.length > 0)
          .map((chunk) => [
            filePath,
            chunk.symbol_name || 'file',
            chunk.start_line,
            chunk.end_line,
          ].join(':')),
      ];
      return {
        filePaths,
        symbolKeys,
        chunkKeys,
        evidenceIds: [
          ...symbolKeys.map((key) => 'symbol:' + key),
          ...chunkKeys.map((key) => 'chunk:' + key),
        ],
      };
    } catch (err) {
      log.warn('Failed to collect context ledger cleanup keys: ' + (err instanceof Error ? err.message : String(err)));
      return {};
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
    const expectedDimensions = getEmbeddingDimensions(this.config.embedding);
    const queue = new EmbeddingQueue(this.embeddingGenerator, {
      batchSize,
      concurrency: Math.max(1, Math.floor(this.config.embedding.concurrency ?? 2)),
      retries: 2,
      timeoutMs: 60_000,
    });
    const vectors = await queue.embed(chunkCandidates.map(({ chunk }) => chunk.content));
    for (let i = 0; i < chunkCandidates.length; i++) {
      const { chunk, symbol } = chunkCandidates[i];
      const vector = vectors[i] || [];
      if (vector.length === 0) continue;
      if (vector.length !== expectedDimensions) {
        log.warn('Skipping vector with mismatched dimensions for ' + symbol.name +
          ': expected ' + expectedDimensions + ', got ' + vector.length);
        continue;
      }
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
    }

    if (records.length > 0) {
      try {
        const added = await addVectors(records);
        for (const record of records) {
          this.setChunkEmbeddingId(record.chunkId, record.id);
        }
        this.embeddedVectorCount += added;
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
      scanMs?: number;
      parseMs?: number;
      writeMs?: number;
      edgeMs?: number;
      vectorMs?: number;
      communityMs?: number;
      processMs?: number;
      peakRssMb?: number;
    },
    mode: 'full' | 'incremental',
  ): void {
    this.metadata.finalizeRun(scanResult, runStats, mode);
  }

  private beginIndexRun(runId: string, mode: IndexRunMode): void {
    this.metadata.beginRun(runId, mode);
  }

  private markIndexRunCommitting(runId: string): void {
    this.metadata.markCommitting(runId);
  }

  private completeIndexRun(runId: string): void {
    this.metadata.completeRun(runId);
  }

  private failIndexRun(runId: string, err: unknown): void {
    this.metadata.failRun(runId, err);
  }

  private setMetadata(key: string, value: string): void {
    this.metadata.set(key, value);
  }

  private setMetadataBatch(entries: Record<string, string>): void {
    this.metadata.setBatch(entries);
  }

  private getMetadata(key: string): string | null {
    return this.metadata.get(key);
  }

  private getTableCount(table: 'files' | 'symbols' | 'edges' | 'chunks' | 'memories'): number {
    return this.metadata.getTableCount(table);
  }

  private getEmbeddedChunkCount(): number {
    return this.metadata.getEmbeddedChunkCount();
  }

  private getAllIndexedSymbols(): SymbolRecord[] {
    return this.metadata.getAllIndexedSymbols();
  }

  private safeGetAllFiles(): FileRecord[] {
    return this.metadata.getAllFiles();
  }

  /**
   * Run the post-graph phase: detect execution flows (processes) and
   * functional communities. Both steps operate on the freshly built
   * edges, so they must run after `rebuildGraphEdges()`.
   *
   * The method is idempotent — re-running it replaces the persisted
   * processes and communities in-place.
   */
  async runProcessAndCommunityDetection(): Promise<void> {
    this.runProcessDetection();
    const communityStart = Date.now();
    this.runCommunityDetection();
    this._lastCommunityMs = Date.now() - communityStart;
  }

  /**
   * Detect execution flows (Process nodes) by walking the call graph
   * from candidate entry points (route endpoints, then main / default
   * export fallbacks) to terminal nodes. Persists the result to the
   * `processes` and `process_steps` tables (deleting any prior rows
   * for the same `name` first so the operation is idempotent).
   */
  private runProcessDetection(): void {
    try {
      const db = getDatabaseSync();
      const entries = this.findEntryPoints();
      if (entries.length === 0) {
        log.debug('Process detection: no candidate entry points found');
        return;
      }

      for (const entry of entries) {
        const result = traceProcess(entry, db);
        this.persistProcess(result, entry);
      }

      log.info('Process detection produced ' + entries.length + ' processes');
    } catch (err) {
      log.error('Process detection failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  private findEntryPoints(): ProcessEntry[] {
    const db = getDatabaseSync();
    const entries: ProcessEntry[] = [];

    const routeRows = db.all<{
      symbol_id: string | null;
      route_path: string;
      http_method: string;
      framework: string;
    }>(
      `SELECT symbol_id, route_path, http_method, framework
       FROM route_endpoints
       WHERE symbol_id IS NOT NULL
       ORDER BY route_path, http_method`,
    );
    const seenRoute = new Set<string>();
    for (const row of routeRows) {
      if (!row.symbol_id) continue;
      const name = `${row.http_method} ${row.route_path}`;
      if (seenRoute.has(name)) continue;
      seenRoute.add(name);
      entries.push({
        symbolId: row.symbol_id,
        name,
        entryKind: 'route',
        framework: row.framework,
      });
    }

    if (entries.length > 0) return entries;

    const mainRows = db.all<{ id: string }>(
      `SELECT s.id FROM symbols s
       WHERE s.kind = 'function' AND s.name = 'main'`,
    );
    for (const row of mainRows) {
      entries.push({
        symbolId: row.id,
        name: 'main',
        entryKind: 'main',
      });
    }
    if (entries.length > 0) return entries;

    const indexRows = db.all<{ id: string; name: string }>(
      `SELECT s.id, s.name FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE s.kind = 'function'
         AND f.path IN ('index.ts', 'index.js', 'index.mjs', 'index.cjs',
                        'index.tsx', 'index.jsx',
                        'main.ts', 'main.js', 'main.mjs', 'main.cjs',
                        'main.tsx', 'main.jsx',
                        'src/index.ts', 'src/index.js', 'src/index.mjs', 'src/index.cjs',
                        'src/main.ts', 'src/main.js', 'src/main.mjs', 'src/main.cjs')
       ORDER BY f.path, s.start_line`,
    );
    for (const row of indexRows) {
      entries.push({
        symbolId: row.id,
        name: row.name,
        entryKind: 'export_default',
      });
    }

    return entries;
  }

  private persistProcess(result: ProcessTraceResult, entry: ProcessEntry): void {
    const db = getDatabaseSync();
    const processId = generateId('process', entry.name);
    const now = new Date().toISOString();

    db.run('DELETE FROM process_steps WHERE process_id = ?', [processId]);
    db.run('DELETE FROM processes WHERE id = ?', [processId]);

    db.run(
      `INSERT INTO processes
        (id, name, entry_point, entry_kind, framework, depth_limit, step_count, last_indexed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        processId,
        entry.name,
        entry.symbolId,
        entry.entryKind,
        entry.framework ?? null,
        10,
        result.steps.length,
        now,
        now,
      ],
    );

    if (result.steps.length === 0) return;

    const insertStep = db.native.prepare(
      `INSERT INTO process_steps
        (id, process_id, step, symbol_id, file_id, edge_id, label)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const write = db.native.transaction((steps: ProcessTraceResult['steps']) => {
      for (const step of steps) {
        const stepId = generateId('process-step', processId + ':' + step.step);
        insertStep.run(
          stepId,
          processId,
          step.step,
          step.symbolId,
          step.fileId,
          step.edgeId,
          step.label,
        );
      }
    });
    write(result.steps);
  }

  /**
   * Detect functional communities over the undirected projection of
   * CALLS + IMPORTS + EXTENDS edges. Persists the result to the
   * `communities` and `community_members` tables (deleting any prior
   * rows first so the operation is idempotent).
   */
  private runCommunityDetection(): void {
    try {
      const db = getDatabaseSync();

      const symbolRows = db.all<{ id: string; file_id: string | null }>(
        'SELECT id, file_id FROM symbols',
      );
      const symbolIds = symbolRows.map((row) => row.id);
      const fileBySymbol = new Map<string, string | null>();
      for (const row of symbolRows) {
        fileBySymbol.set(row.id, row.file_id);
      }

      const edgeRows = db.all<{ from_id: string; to_id: string; type: string }>(
        "SELECT from_id, to_id, type FROM edges WHERE type IN ('CALLS', 'IMPORTS', 'EXTENDS')",
      );
      const edges = edgeRows.map((row) => ({
        from: row.from_id,
        to: row.to_id,
        type: row.type,
      }));

      const result = detectCommunities(symbolIds, edges, { maxIterations: 10, minCohesion: 0.1 });

      const now = new Date().toISOString();
      const insertCommunity = db.native.prepare(
        `INSERT INTO communities
           (id, name, cohesion, symbol_count, keywords, detection_method, top_entry_symbols, last_indexed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertMember = db.native.prepare(
        `INSERT INTO community_members
           (id, community_id, symbol_id, file_id, weight)
         VALUES (?, ?, ?, ?, ?)`,
      );

      const write = db.native.transaction(() => {
        db.run('DELETE FROM community_members');
        db.run('DELETE FROM communities');
        for (const community of result.communities) {
          const communityId = generateId('community', community.name);
          const topEntrySymbols = JSON.stringify(community.memberSymbolIds.slice(0, 5));
          insertCommunity.run(
            communityId,
            community.name,
            community.cohesion,
            community.memberSymbolIds.length,
            JSON.stringify(community.keywords),
            community.detectionMethod,
            topEntrySymbols,
            now,
            now,
          );
          for (const symbolId of community.memberSymbolIds) {
            insertMember.run(
              generateId('community-member', communityId, symbolId),
              communityId,
              symbolId,
              fileBySymbol.get(symbolId) ?? null,
              1.0,
            );
          }
        }
      });
      write();

      if (result.communities.length > 0) {
        log.info(
          'Community detection produced ' + result.communities.length +
          ' communities (iterations=' + result.iterations +
          ', totalNodes=' + result.totalNodes + ')',
        );
      }
    } catch (err) {
      log.error('Community detection failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  private async rebuildGraphEdges(mode: EdgeRebuildMode, dirtyFileIds: string[] = []): Promise<number> {
    const db = getDatabaseSync();
    const indexedFiles = this.safeGetAllFiles();
    const scope = prepareGraphRebuildScope(mode, dirtyFileIds, indexedFiles);
    const symbols = this.getAllIndexedSymbols();
    const { filesByPath, symbolsById, symbolsByFile } = buildGraphRebuildIndexes(indexedFiles, symbols);
    this.buildModuleResolver(filesByPath);

    const reexportIndex = this.buildReexportIndex(getFileExportsByFileIds());
    const callMetadata: CallEdgeMetadata = {
      callRefsByFileId: this.groupByFileId(getCallRefsByFileIds(scope.rebuildFileIdList)),
      scopeBindingsByFileId: this.groupByFileId(getScopeBindingsByFileIds(scope.rebuildFileIdList)),
      symbolsById,
      classMethodIndex: this.buildClassMethodIndex(symbols),
    };
    const typeRelations = getTypeRelationsByFileIds(scope.fullRebuild ? undefined : scope.rebuildFileIdList);
    const routeMetadata: RouteEdgeMetadata = {
      endpoints: getRouteEndpointsByFileIds(),
      references: getRouteReferencesByFileIds(),
    };

    this.beginGraphWriteBuffer();
    try {
      let edgeCount = 0;
      for (const fileRecord of indexedFiles) {
        if (!scope.rebuildFileIds.has(fileRecord.id)) continue;
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

      if (scope.fullRebuild) {
        edgeCount += this.createConfigEdges(indexedFiles);
      } else {
        edgeCount += this.createConfigEdges(indexedFiles.filter((file) => scope.rebuildFileIds.has(file.id)));
      }
      edgeCount += this.createTypeRelationEdges(typeRelations, symbolsById, symbols);
      edgeCount += this.createRouteReferenceEdges(routeMetadata);

      const totalEdges = commitGraphRebuild({
        db,
        fullRebuild: scope.fullRebuild,
        dirtyFileIds,
        deleteDirtyGraphEdges: (fileIds) => this.deleteGraphEdgesForDirtyFiles(fileIds),
        flushGraphWrites: () => this.flushGraphWriteBuffer(),
        countEdges: () => this.getTableCount('edges'),
      });

      log.info('Rebuilt graph edges: ' + totalEdges + ' (' + edgeCount + ' edge writes)');
      return totalEdges;
    } finally {
      this.resetGraphWriteBuffer();
    }
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
    const edgeTypePlaceholders = GRAPH_EDGE_TYPES.map(() => '?').join(',');
    deleteGraphEvidenceForNodes(ids);
    db.run(
      `DELETE FROM edges
       WHERE type IN (${edgeTypePlaceholders})
         AND (from_id IN (${placeholders}) OR to_id IN (${placeholders}))`,
      [...GRAPH_EDGE_TYPES, ...ids, ...ids],
    );
  }

  private expandDirtyFileSet(fileIds: string[]): string[] {
    if (fileIds.length === 0) return [];
    const dirty = new Set(fileIds);
    const indexedFiles = this.safeGetAllFiles();
    const filesByPath = new Map(indexedFiles.map((file) => [normalizePath(file.path), file]));
    this.buildModuleResolver(filesByPath);
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

  private buildModuleResolver(filesByPath: Map<string, FileRecord>): ModuleResolver {
    this.moduleResolver = new ModuleResolver(loadProjectManifest(this.rootPath), filesByPath);
    return this.moduleResolver;
  }

  private createConfigEdges(indexedFiles: FileRecord[]): number {
    const configs = indexedFiles.filter((file) => file.role === 'config');
    const configuredFiles = indexedFiles.filter((file) => file.role === 'source' || file.role === 'test');
    let edgeCount = 0;

    for (const config of configs) {
      const configDir = posixPath.dirname(normalizePath(config.path));
      // A config is "root-level" if it sits in the project root (dirname is '.' or '')
      const isRootConfig = configDir === '.' || configDir === '';

      for (const configuredFile of configuredFiles) {
        if (!isRootConfig) {
          const filePath = normalizePath(configuredFile.path);
          if (!filePath.startsWith(configDir + '/')) {
            continue;
          }
        }

        edgeCount += this.upsertGraphEdge(
          config.id,
          configuredFile.id,
          'CONFIGURES',
          0.55,
          'project configuration',
          {
            sourceTable: 'files',
            sourceId: config.id,
            fileId: config.id,
          },
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
        {
          sourceTable: 'type_relations',
          sourceId: relation.id,
          fileId: relation.file_id,
        },
      );
    }
    return edgeCount;
  }

  private createRouteReferenceEdges(metadata: RouteEdgeMetadata): number {
    const endpointsByPath = new Map<string, StoredRouteEndpointRow[]>();
    for (const endpoint of metadata.endpoints) {
      const list = endpointsByPath.get(endpoint.route_path) || [];
      list.push(endpoint);
      endpointsByPath.set(endpoint.route_path, list);
    }

    let edgeCount = 0;
    for (const reference of metadata.references) {
      const candidates = endpointsByPath.get(reference.route_path) || [];
      const exact = candidates.find((endpoint) => endpoint.http_method === reference.http_method);
      const endpoint = exact || candidates[0] || null;
      if (!endpoint) {
        this.queueRouteReferenceResolution(reference.id, 'unresolved');
        continue;
      }

      const fromId = reference.caller_symbol_id || reference.file_id;
      const toId = endpoint.symbol_id || endpoint.file_id;
      const exactMethod = Boolean(exact);
      edgeCount += this.upsertGraphEdge(
        fromId,
        toId,
        'REFERENCES',
        exactMethod ? 0.88 : 0.72,
        `${reference.evidence || 'route reference'} -> ${endpoint.http_method} ${endpoint.route_path}`,
        {
          sourceTable: 'route_references',
          sourceId: reference.id,
          fileId: reference.file_id,
          startLine: reference.start_line,
          startColumn: reference.start_column,
        },
      );
      this.queueRouteReferenceResolution(reference.id, exactMethod ? 'resolved' : 'ambiguous');
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

      edgeCount += this.upsertGraphEdge(importer.id, importedFile.id, 'IMPORTS', 0.95, imp.source, {
        sourceTable: 'file_imports',
        fileId: importer.id,
        startLine: imp.startLine ?? 0,
        startColumn: imp.startColumn ?? 0,
      });
      if (importer.role === 'test' && importedFile.role !== 'test') {
        edgeCount += this.upsertGraphEdge(importer.id, importedFile.id, 'TESTS', 0.8, imp.source, {
          sourceTable: 'file_imports',
          fileId: importer.id,
          startLine: imp.startLine ?? 0,
          startColumn: imp.startColumn ?? 0,
        });
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
        edgeCount += this.upsertGraphEdge(importer.id, symbol.id, 'REFERENCES', 0.75, imp.source, {
          sourceTable: 'file_imports',
          fileId: importer.id,
          startLine: imp.startLine ?? 0,
          startColumn: imp.startColumn ?? 0,
        });
        if (localTestSymbols.length > 0) {
          for (const testSymbol of localTestSymbols) {
            edgeCount += this.upsertGraphEdge(testSymbol.id, symbol.id, 'TESTS', 0.82, imp.source, {
              sourceTable: 'file_imports',
              fileId: importer.id,
              startLine: imp.startLine ?? 0,
              startColumn: imp.startColumn ?? 0,
            });
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
        this.queueCallRefResolution(call.id, 'unresolved');
        continue;
      }

      const fromId = caller?.id || file.id;
      edgeCount += this.upsertGraphEdge(
        fromId,
        resolution.symbol.id,
        'CALLS',
        resolution.confidence,
        call.evidence || '',
        {
          sourceTable: 'call_refs',
          sourceId: call.id,
          fileId: call.file_id,
          startLine: call.start_line,
          startColumn: call.start_column,
        },
      );
      this.queueCallRefResolution(call.id, 'resolved');
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

    // Group methods by file ID for O(M+C) instead of O(C*M)
    const methodsByFileId = new Map<string, SymbolRecord[]>();
    for (const method of methods) {
      const list = methodsByFileId.get(method.fileId);
      if (list) list.push(method);
      else methodsByFileId.set(method.fileId, [method]);
    }

    // For each class, only check methods in the same file
    for (const cls of classes) {
      const fileMethods = methodsByFileId.get(cls.fileId) || [];
      const byName = index.get(cls.name) || new Map<string, SymbolRecord[]>();
      for (const method of fileMethods) {
        if (method.startLine >= cls.startLine && method.endLine <= cls.endLine) {
          const list = byName.get(method.name) || [];
          list.push(method);
          byName.set(method.name, list);
        }
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

  private beginGraphWriteBuffer(): void {
    this.graphBuffer.begin();
  }

  private resetGraphWriteBuffer(): void {
    this.graphBuffer.reset();
  }

  private flushGraphWriteBuffer(): void {
    this.graphBuffer.flush();
  }

  private queueCallRefResolution(id: string, status: CallResolutionStatus): void {
    this.graphBuffer.queueCallRefResolution(id, status);
  }

  private queueRouteReferenceResolution(id: string, status: CallResolutionStatus): void {
    this.graphBuffer.queueRouteReferenceResolution(id, status);
  }

  private upsertGraphEdge(
    fromId: string,
    toId: string,
    type: EdgeType,
    confidence: number,
    evidence: string,
    evidenceMeta: GraphEdgeEvidenceMeta = {},
  ): number {
    return this.graphBuffer.upsertEdge(fromId, toId, type, confidence, evidence, evidenceMeta);
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
    const resolved = this.moduleResolver?.resolve(importer, source);
    if (resolved) return resolved;
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
