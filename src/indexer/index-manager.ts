/**
 * Code Memory Graph — Index Manager
 *
 * Coordinates the full indexing pipeline:
 *   scan project -> parse files -> store records -> update metadata
 *
 * Supports both full (re-index everything) and incremental (changed files only)
 * indexing strategies.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { CodeMemoryConfig, IndexStatus, FileRecord, SymbolRecord, EdgeRecord, ChunkRecord, ParseResult } from '../shared/types.js';
import type { DiscoveredFile } from '../scanner/file-discovery.js';
import { initTreeSitter } from '../parser/parser-registry.js';
import { parseFile, resolveParserLanguage } from '../parser/tree-sitter-parser.js';
import { scanProject } from '../scanner/project-scanner.js';
import { getFileContentHash, getFileLastCommit } from '../scanner/git-integration.js';
import { getDatabase, getDatabaseSync, saveDatabase } from '../storage/database.js';
import { upsertFile, getAllFiles, deleteFile } from '../storage/file-repository.js';
import { upsertSymbol, deleteSymbolsByFileId } from '../storage/symbol-repository.js';
import { upsertEdge, deleteEdgesByNodeId } from '../storage/edge-repository.js';
import { upsertChunk, deleteChunksByFileId } from '../storage/chunk-repository.js';
import { generateId, normalizePath } from '../shared/utils.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('index-manager');

export class IndexManager {
  private rootPath: string;
  private config: CodeMemoryConfig;
  private db: SqlJsDatabase | null = null;

  constructor(rootPath: string, config: CodeMemoryConfig) {
    this.rootPath = resolve(rootPath);
    this.config = config;
  }

  async fullIndex(): Promise<IndexStatus> {
    log.info('Starting full index of: ' + this.rootPath);
    const startTime = Date.now();

    await this.ensureDb();
    await initTreeSitter();

    this.setMetadata('is_indexing', 'true');

    log.info('Scanning project files...');
    const scanResult = scanProject(this.rootPath, this.config);
    const files = scanResult.files;
    log.info('Discovered ' + files.length + ' files to index');

    let indexedCount = 0, totalSymbols = 0, totalEdges = 0, totalChunks = 0, skipped = 0;

    for (let i = 0; i < files.length; i++) {
      const discovered = files[i];
      try {
        const result = await this.indexFile(discovered);
        if (!result) { skipped++; continue; }
        this.storeParseResult(result, discovered);
        indexedCount++; totalSymbols += result.symbols.length;
        totalEdges += result.edges.length; totalChunks += result.chunks.length;

        if (indexedCount % 50 === 0) {
          log.info('Progress: ' + indexedCount + '/' + files.length +
            ' (' + totalSymbols + ' symbols)');
        }
      } catch (err) {
        log.error('Failed to index: ' + discovered.relativePath, err);
        skipped++;
      }
    }

    this.updateFinalMetadata(scanResult, files.length, indexedCount, totalSymbols, totalEdges);
    await saveDatabase();

    const elapsed = Date.now() - startTime;
    log.info('Full index done in ' + (elapsed / 1000).toFixed(1) + 's: ' +
      indexedCount + ' files, ' + totalSymbols + ' symbols, ' + totalEdges + ' edges');

    return this.buildStatus(indexedCount, totalSymbols, totalEdges, totalChunks);
  }

  async incrementalIndex(forceAll: boolean = false): Promise<IndexStatus> {
    log.info('Starting incremental index of: ' + this.rootPath);
    await this.ensureDb();
    await initTreeSitter();

    this.setMetadata('is_indexing', 'true');
    const scanResult = scanProject(this.rootPath, this.config);

    const currentFileMap = new Map<string, DiscoveredFile>();
    for (const f of scanResult.files) {
      currentFileMap.set(normalizePath(f.relativePath), f);
    }

    const prevFiles = this.safeGetAllFiles();
    const prevFileMap = new Map<string, FileRecord>();
    for (const pf of prevFiles) {
      prevFileMap.set(normalizePath(pf.path), pf);
    }

    let indexedCount = 0, totalSymbols = 0, totalEdges = 0, totalChunks = 0;

    // Check existing files for changes
    for (const [relPath, prevFile] of prevFileMap) {
      const currentFile = currentFileMap.get(relPath);
      if (!currentFile) {
        this.removeFileFromIndex(prevFile.id);
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
        const result = await this.indexFile(currentFile);
        if (result) {
          this.removeFileFromIndex(prevFile.id);
          this.storeParseResult(result, currentFile);
          indexedCount++; totalSymbols += result.symbols.length;
          totalEdges += result.edges.length; totalChunks += result.chunks.length;
        }
      }
    }

    // Index new files
    for (const [relPath, currentFile] of currentFileMap) {
      if (!prevFileMap.has(relPath)) {
        const result = await this.indexFile(currentFile);
        if (result) {
          this.storeParseResult(result, currentFile);
          indexedCount++; totalSymbols += result.symbols.length;
          totalEdges += result.edges.length; totalChunks += result.chunks.length;
        }
      }
    }

    this.updateFinalMetadata(scanResult, scanResult.files.length, 0, 0, 0);
    this.setMetadata('is_indexing', 'false');
    if (forceAll) {
      this.setMetadata('last_full_index', new Date().toISOString());
    }
    await saveDatabase();

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
    if (!parserLang) return null;

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

  private storeParseResult(result: ParseResult, discovered: DiscoveredFile): void {
    const now = new Date().toISOString();

    let hash = '';
    try { hash = getFileContentHash(discovered.path); } catch {}

    const lastCommit = getFileLastCommit(this.rootPath, discovered.path);

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
    upsertFile(fileRecord);

    for (const sym of result.symbols) { upsertSymbol(sym); }
    for (const edge of result.edges) { try { upsertEdge(edge); } catch {} }
    for (const chunk of result.chunks) { upsertChunk(chunk); }
  }

  private removeFileFromIndex(fileId: string): void {
    try {
      deleteSymbolsByFileId(fileId);
      deleteEdgesByNodeId(fileId);
      deleteChunksByFileId(fileId);
      deleteFile(fileId);
    } catch (err) {
      log.error('Failed to remove file from index: ' + fileId, err);
    }
  }

  private updateFinalMetadata(
    scanResult: ReturnType<typeof scanProject>,
    totalFiles: number,
    indexedFiles: number,
    totalSymbols: number,
    totalEdges: number,
  ): void {
    const now = new Date().toISOString();
    this.setMetadata('last_full_index', now);
    this.setMetadata('last_incremental_index', now);
    this.setMetadata('total_files', String(totalFiles));
    this.setMetadata('indexed_files', String(indexedFiles));
    this.setMetadata('total_symbols', String(totalSymbols));
    this.setMetadata('total_edges', String(totalEdges));
    this.setMetadata('current_commit', scanResult.gitInfo.currentCommit ?? '');
    this.setMetadata('current_branch', scanResult.gitInfo.currentBranch ?? '');
    this.setMetadata('embedding_provider', this.config.embedding.provider);
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

    return {
      projectPath: this.rootPath,
      totalFiles: totalFiles > 0 ? totalFiles : recentIndexed,
      indexedFiles: indexedFiles > 0 ? indexedFiles : recentIndexed,
      totalSymbols: totalSymbols > 0 ? totalSymbols : recentSymbols,
      totalEdges: totalEdges > 0 ? totalEdges : recentEdges,
      totalChunks: totalChunks > 0 ? totalChunks : recentChunks,
      totalMemories: 0,
      lastFullIndex: this.getMetadata('last_full_index'),
      lastIncrementalIndex: this.getMetadata('last_incremental_index'),
      currentCommit: this.getMetadata('current_commit'),
      currentBranch: this.getMetadata('current_branch'),
      embeddingProvider: this.getMetadata('embedding_provider'),
      isIndexing: this.getMetadata('is_indexing') === 'true',
    };
  }
}
