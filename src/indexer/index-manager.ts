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
import { join, resolve } from 'node:path';
import * as posixPath from 'node:path/posix';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { CodeMemoryConfig, IndexStatus, FileRecord, SymbolRecord, EdgeRecord, ChunkRecord, ParseResult, ImportInfo, EdgeType } from '../shared/types.js';
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
import { CONFIG_DIR, VECTORS_DIR } from '../shared/constants.js';
import { EmbeddingGenerator } from './embedding-generator.js';
import {
  addVectors,
  deleteVectors,
  getEmbeddingDimensions,
  initVectorStore,
  resetVectorStore,
  type VectorRecord,
} from '../search/vector-search.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('index-manager');

interface ResolvedImportSymbol {
  symbol: SymbolRecord;
  resolutionNames: string[];
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

export class IndexManager {
  private rootPath: string;
  private config: CodeMemoryConfig;
  private db: SqlJsDatabase | null = null;
  private embeddingGenerator: EmbeddingGenerator | null = null;
  private vectorStoreReady = false;
  private embeddedVectorCount = 0;

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
    const files = scanResult.files;
    log.info('Discovered ' + files.length + ' files to index');

    await this.pruneFilesNotInFullScan(files);

    let indexedCount = 0, totalSymbols = 0, totalChunks = 0, skipped = 0;

    for (let i = 0; i < files.length; i++) {
      const discovered = files[i];
      try {
        const result = await this.indexFile(discovered);
        if (!result) { skipped++; continue; }
        await this.removeFileFromIndex(result.fileId);
        this.storeParseResult(result, discovered);
        await this.indexChunkVectors(result, discovered);
        indexedCount++; totalSymbols += result.symbols.length;
        totalChunks += result.chunks.length;

        if (indexedCount % 50 === 0) {
          log.info('Progress: ' + indexedCount + '/' + files.length +
            ' (' + totalSymbols + ' symbols)');
        }
      } catch (err) {
        log.error('Failed to index: ' + discovered.relativePath, err);
        skipped++;
      }
    }

    const totalEdges = await this.rebuildGraphEdges(scanResult.files);
    this.updateFinalMetadata(scanResult, {
      indexedFiles: indexedCount,
      symbols: totalSymbols,
      edges: totalEdges,
      chunks: totalChunks,
    }, 'full');
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
    await this.prepareVectorStore(forceAll);

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

    let indexedCount = 0, totalSymbols = 0, totalChunks = 0;

    // Check existing files for changes
    for (const [relPath, prevFile] of prevFileMap) {
      const currentFile = currentFileMap.get(relPath);
      if (!currentFile) {
        await this.removeFileFromIndex(prevFile.id);
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
          await this.removeFileFromIndex(prevFile.id);
          this.storeParseResult(result, currentFile);
          await this.indexChunkVectors(result, currentFile);
          indexedCount++; totalSymbols += result.symbols.length;
          totalChunks += result.chunks.length;
        }
      }
    }

    // Index new files
    for (const [relPath, currentFile] of currentFileMap) {
      if (!prevFileMap.has(relPath)) {
        const result = await this.indexFile(currentFile);
        if (result) {
          this.storeParseResult(result, currentFile);
          await this.indexChunkVectors(result, currentFile);
          indexedCount++; totalSymbols += result.symbols.length;
          totalChunks += result.chunks.length;
        }
      }
    }

    const totalEdges = await this.rebuildGraphEdges(scanResult.files);
    this.updateFinalMetadata(scanResult, {
      indexedFiles: indexedCount,
      symbols: totalSymbols,
      edges: totalEdges,
      chunks: totalChunks,
    }, forceAll ? 'full' : 'incremental');
    this.setMetadata('is_indexing', 'false');
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
      chunks: [],
      errors: [],
    };
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
    for (const chunk of result.chunks) { upsertChunk(chunk); }
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
    if (this.config.embedding.provider === 'none') return;

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
    const records: VectorRecord[] = [];
    for (const chunk of result.chunks) {
      if (!chunk.symbolId) continue;
      const symbol = symbolsById.get(chunk.symbolId);
      if (!symbol) continue;

      try {
        const vector = await this.embeddingGenerator.generate(chunk.content);
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
      } catch (err) {
        log.warn('Chunk embedding failed for ' + normalizePath(discovered.relativePath) +
          ':' + chunk.startLine + ' - ' + (err instanceof Error ? err.message : String(err)));
      }
    }

    if (records.length > 0) {
      await addVectors(records);
      this.embeddedVectorCount += records.length;
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
    this.setMetadata('current_commit', scanResult.gitInfo.currentCommit ?? '');
    this.setMetadata('current_branch', scanResult.gitInfo.currentBranch ?? '');
    this.setMetadata('embedding_provider', this.config.embedding.provider);
    this.setMetadata('embedding_model', this.config.embedding.model);
    const embeddedChunkCount = this.getEmbeddedChunkCount();
    this.setMetadata('vector_search', embeddedChunkCount > 0 ? 'enabled' : 'disabled');
    this.setMetadata('embedding_dimensions', String(getEmbeddingDimensions(this.config.embedding)));
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

  private async rebuildGraphEdges(files: DiscoveredFile[]): Promise<number> {
    const db = getDatabaseSync();
    db.run("DELETE FROM edges WHERE type IN ('IMPORTS', 'CALLS', 'REFERENCES', 'TESTS', 'CONFIGURES')");

    const indexedFiles = this.safeGetAllFiles();
    const filesByPath = new Map<string, FileRecord>();
    for (const file of indexedFiles) {
      filesByPath.set(normalizePath(file.path), file);
    }

    const symbols = this.getAllIndexedSymbols();
    const symbolsByFile = new Map<string, SymbolRecord[]>();
    for (const symbol of symbols) {
      const list = symbolsByFile.get(symbol.fileId) || [];
      list.push(symbol);
      symbolsByFile.set(symbol.fileId, list);
    }

    let edgeCount = 0;
    for (const discovered of files) {
      const fileRecord = filesByPath.get(normalizePath(discovered.relativePath));
      if (!fileRecord) continue;

      const parsed = await this.indexFile(discovered);
      if (!parsed) continue;

      const importedSymbols = this.createImportEdges(fileRecord, parsed.imports, filesByPath, symbolsByFile);
      edgeCount += importedSymbols.edgeCount;
      edgeCount += this.createCallEdges(fileRecord, parsed, symbolsByFile, importedSymbols.symbolsByName);
    }

    edgeCount += this.createConfigEdges(indexedFiles);

    const totalEdges = this.getTableCount('edges');
    log.info('Rebuilt graph edges: ' + totalEdges);
    return totalEdges;
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

  private createImportEdges(
    importer: FileRecord,
    imports: ImportInfo[],
    filesByPath: Map<string, FileRecord>,
    symbolsByFile: Map<string, SymbolRecord[]>,
  ): { edgeCount: number; symbolsByName: Map<string, SymbolRecord[]> } {
    let edgeCount = 0;
    const symbolsByName = new Map<string, SymbolRecord[]>();
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

      const importedSymbols = this.resolveImportedSymbolBindings(imp, importedFile, filesByPath, symbolsByFile);

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

    return { edgeCount, symbolsByName };
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
    seenFileIds: Set<string> = new Set(),
  ): ResolvedImportSymbol[] {
    if (seenFileIds.has(importedFile.id)) return [];
    seenFileIds.add(importedFile.id);

    const directSymbols = symbolsByFile.get(importedFile.id) || [];
    const directNames = this.getImportedSymbolNames(imp, importedFile, directSymbols);
    const directMatches = this.matchSymbolsByName(directSymbols, directNames);
    if (directMatches.length > 0) {
      return directMatches.map((symbol) => ({ symbol, resolutionNames: [] }));
    }

    const aliasedReexportMatches = this.resolveAliasedReexportSymbols(
      imp,
      importedFile,
      filesByPath,
      symbolsByFile,
      seenFileIds,
    );
    if (aliasedReexportMatches.length > 0) return aliasedReexportMatches;

    const namespaceReexportMatches = this.resolveNamespaceReexportSymbols(
      imp,
      importedFile,
      filesByPath,
      symbolsByFile,
      seenFileIds,
    );
    if (namespaceReexportMatches.length > 0) return namespaceReexportMatches;

    const reexportSources = importedFile.exports
      .filter((exportName) => exportName.startsWith('reexport:'))
      .map((exportName) => exportName.slice('reexport:'.length));

    const reexportedMatches: ResolvedImportSymbol[] = [];
    for (const source of reexportSources) {
      const reexportFile = this.resolveImportTarget(importedFile, source, filesByPath);
      if (!reexportFile) continue;

      const targetSymbols = symbolsByFile.get(reexportFile.id) || [];
      const requestedNames = imp.names.length > 0
        ? imp.names
        : importedFile.exports.filter((exportName) => !exportName.startsWith('reexport:'));
      const names = requestedNames.length > 0
        ? requestedNames
        : targetSymbols.map((symbol) => symbol.name);
      const matches = this.matchSymbolsByName(targetSymbols, names);
      if (matches.length > 0) {
        reexportedMatches.push(
          ...matches.map((symbol) => ({ symbol, resolutionNames: [] })),
        );
        continue;
      }

      reexportedMatches.push(
        ...this.resolveImportedSymbolBindings(imp, reexportFile, filesByPath, symbolsByFile, seenFileIds),
      );
    }

    return reexportedMatches;
  }

  private resolveNamespaceReexportSymbols(
    imp: ImportInfo,
    importedFile: FileRecord,
    filesByPath: Map<string, FileRecord>,
    symbolsByFile: Map<string, SymbolRecord[]>,
    seenFileIds: Set<string>,
  ): ResolvedImportSymbol[] {
    const requestedNames = new Set(imp.names);
    if (imp.defaultName) requestedNames.add(imp.defaultName);
    if (requestedNames.size === 0 && !imp.isNamespace) return [];

    const matches: ResolvedImportSymbol[] = [];
    for (const namespace of this.getReexportNamespaces(importedFile.exports)) {
      if (!imp.isNamespace && !requestedNames.has(namespace.exportedName)) continue;

      const reexportFile = this.resolveImportTarget(importedFile, namespace.source, filesByPath);
      if (!reexportFile || seenFileIds.has(reexportFile.id)) continue;

      const targetSymbols = this.getExportedSymbols(reexportFile, symbolsByFile.get(reexportFile.id) || []);
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
    seenFileIds: Set<string>,
  ): ResolvedImportSymbol[] {
    const requestedNames = new Set(imp.names);
    if (imp.defaultName) requestedNames.add(imp.defaultName);
    if (requestedNames.size === 0 && !imp.isNamespace) return [];

    const matches: ResolvedImportSymbol[] = [];
    for (const alias of this.getReexportAliases(importedFile.exports)) {
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

  private getExportedSymbols(file: FileRecord, symbols: SymbolRecord[]): SymbolRecord[] {
    const exportedNames = new Set(
      file.exports.filter((exportName) => !exportName.startsWith('reexport')),
    );
    const exported = symbols.filter((symbol) => exportedNames.has(symbol.name));
    return exported.length > 0 ? exported : symbols;
  }

  private getReexportAliases(exports: string[]): ReexportAlias[] {
    const aliases: ReexportAlias[] = [];
    for (const exportName of exports) {
      if (!exportName.startsWith('reexportAlias:')) continue;
      try {
        const parsed = JSON.parse(exportName.slice('reexportAlias:'.length)) as Partial<ReexportAlias>;
        if (parsed.source && parsed.importedName && parsed.exportedName) {
          aliases.push({
            source: parsed.source,
            importedName: parsed.importedName,
            exportedName: parsed.exportedName,
          });
        }
      } catch {
        // Ignore malformed legacy export metadata.
      }
    }
    return aliases;
  }

  private getReexportNamespaces(exports: string[]): ReexportNamespace[] {
    const namespaces: ReexportNamespace[] = [];
    for (const exportName of exports) {
      if (!exportName.startsWith('reexportNamespace:')) continue;
      try {
        const parsed = JSON.parse(exportName.slice('reexportNamespace:'.length)) as Partial<ReexportNamespace>;
        if (parsed.source && parsed.exportedName) {
          namespaces.push({
            source: parsed.source,
            exportedName: parsed.exportedName,
          });
        }
      } catch {
        // Ignore malformed legacy export metadata.
      }
    }
    return namespaces;
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

  private createCallEdges(
    file: FileRecord,
    parsed: ParseResult,
    symbolsByFile: Map<string, SymbolRecord[]>,
    importedSymbolsByName: Map<string, SymbolRecord[]>,
  ): number {
    let edgeCount = 0;
    const localSymbols = symbolsByFile.get(file.id) || [];

    for (const call of parsed.calls) {
      const caller = call.callerName
        ? this.findSymbolByNameAndLine(localSymbols, call.callerName, call.callerStartLine)
        : null;
      const callee = this.findCallableSymbol(localSymbols, importedSymbolsByName, call.calleeName);
      if (!callee) continue;

      const fromId = caller?.id || file.id;
      edgeCount += this.upsertGraphEdge(fromId, callee.id, 'CALLS', caller ? 0.92 : 0.72, call.evidence);
    }

    return edgeCount;
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

  private findCallableSymbol(
    localSymbols: SymbolRecord[],
    importedSymbolsByName: Map<string, SymbolRecord[]>,
    calleeName: string,
  ): SymbolRecord | null {
    const local = localSymbols.find((symbol) => symbol.name === calleeName);
    if (local) return local;

    const imported = importedSymbolsByName.get(calleeName);
    if (imported && imported.length > 0) return imported[0];

    return null;
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
