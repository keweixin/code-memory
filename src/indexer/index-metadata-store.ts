/**
 * Code Memory Graph — Index Metadata Store
 *
 * Centralizes all reads/writes to the `index_metadata` table and the
 * `files`/`symbols`/`edges`/`chunks`/`memories` aggregate counts, plus the
 * run-lifecycle helpers that wrap the `index-run-lifecycle` module.
 *
 * The class is intentionally stateless across instances: each call resolves
 * the singleton SQLite database through `getDatabaseSync()`. This mirrors
 * the original `IndexManager` private methods and lets the manager class
 * delegate without taking on the responsibility of all DB IO.
 */

import type { CodeMemoryConfig, FileRecord, SymbolRecord } from '../shared/types.js';
import { getEmbeddingDimensions } from '../search/vector-search.js';
import { countUnresolvedCalls } from '../storage/parse-metadata-repository.js';
import { getDatabaseSync } from '../storage/database.js';
import { getAllFiles } from '../storage/file-repository.js';
import type { ScanResult } from '../scanner/project-scanner.js';
import { createLogger } from '../shared/logger.js';
import {
  beginIndexRunMetadata,
  completedIndexRunMetadata,
  committingIndexRunMetadata,
  failedIndexRunMetadata,
  type IndexRunMode,
} from './index-run-lifecycle.js';

const log = createLogger('index-metadata-store');

export type MetadataTable = 'files' | 'symbols' | 'edges' | 'chunks' | 'memories';

export interface IndexRunStats {
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
}

export class IndexMetadataStore {
  constructor(
    private readonly rootPath: string,
    private readonly config: CodeMemoryConfig,
    private readonly fallbackEmbeddedVectorCount: () => number = () => 0,
  ) {}

  getRootPath(): string {
    return this.rootPath;
  }

  getConfig(): CodeMemoryConfig {
    return this.config;
  }

  set(key: string, value: string): void {
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

  setBatch(entries: Record<string, string>): void {
    try {
      const db = getDatabaseSync();
      const stmt = db.native.prepare(
        'INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)',
      );
      const write = db.native.transaction((items: Array<[string, string]>) => {
        for (const [key, value] of items) stmt.run(key, value);
      });
      write(Object.entries(entries));
    } catch (err) {
      log.error('Failed to set metadata batch', err);
    }
  }

  get(key: string): string | null {
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

  getInt(key: string, fallback: number): number {
    const raw = this.get(key);
    if (raw === null) return fallback;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  getBoolean(key: string): boolean {
    return this.get(key) === 'true';
  }

  getTableCount(table: MetadataTable): number {
    try {
      const db = getDatabaseSync();
      const result = db.exec(`SELECT COUNT(*) FROM ${table}`);
      return result.length > 0 ? Number(result[0].values[0][0]) : 0;
    } catch {
      return 0;
    }
  }

  getEmbeddedChunkCount(): number {
    try {
      const db = getDatabaseSync();
      const result = db.exec('SELECT COUNT(*) FROM chunks WHERE embedding_id IS NOT NULL');
      return result.length > 0 ? Number(result[0].values[0][0]) : 0;
    } catch {
      return this.fallbackEmbeddedVectorCount();
    }
  }

  getAllIndexedSymbols(): SymbolRecord[] {
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

  getAllFiles(): FileRecord[] {
    try {
      return getAllFiles();
    } catch {
      return [];
    }
  }

  beginRun(runId: string, mode: IndexRunMode): void {
    this.setBatch(beginIndexRunMetadata(runId, mode));
  }

  markCommitting(runId: string): void {
    this.setBatch(committingIndexRunMetadata(runId));
  }

  completeRun(runId: string): void {
    this.setBatch(completedIndexRunMetadata(runId));
  }

  failRun(runId: string, err: unknown): void {
    this.setBatch(failedIndexRunMetadata(runId, err));
  }

  finalizeRun(scanResult: ScanResult, runStats: IndexRunStats, mode: 'full' | 'incremental'): void {
    const now = new Date().toISOString();
    const totalFiles = scanResult.stats.totalFiles || scanResult.files.length;
    const indexedFiles = this.getTableCount('files');
    const totalSymbols = this.getTableCount('symbols');
    const totalEdges = this.getTableCount('edges');
    const totalChunks = this.getTableCount('chunks');
    this.set('project_name', this.config.projectName);
    this.set('root_path', this.rootPath);
    this.set('languages', this.config.languages.join(','));
    this.set(mode === 'full' ? 'last_full_index' : 'last_incremental_index', now);
    this.set('total_files', String(totalFiles));
    this.set('indexed_files', String(indexedFiles));
    this.set('total_symbols', String(totalSymbols));
    this.set('total_edges', String(totalEdges));
    this.set('total_chunks', String(totalChunks));
    this.set('last_index_mode', mode);
    this.set('last_run_indexed_files', String(runStats.indexedFiles));
    this.set('last_run_symbols', String(runStats.symbols));
    this.set('last_run_edges', String(runStats.edges));
    this.set('last_run_chunks', String(runStats.chunks));
    this.set('last_index_duration_ms', String(runStats.durationMs));
    this.set('last_index_scan_ms', String(runStats.scanMs ?? 0));
    this.set('last_index_parse_ms', String(runStats.parseMs ?? 0));
    this.set('last_index_write_ms', String(runStats.writeMs ?? 0));
    this.set('last_index_edge_ms', String(runStats.edgeMs ?? 0));
    this.set('last_index_vector_ms', String(runStats.vectorMs ?? 0));
    this.set('last_index_community_ms', String(runStats.communityMs ?? 0));
    this.set('last_index_process_ms', String(runStats.processMs ?? 0));
    this.set('last_index_peak_rss_mb', String(runStats.peakRssMb ?? 0));
    this.set('parse_workers', String(runStats.parseWorkers));
    this.set('dirty_files', String(runStats.dirtyFiles));
    this.set('unresolved_calls', String(countUnresolvedCalls()));
    this.set('current_commit', scanResult.gitInfo.currentCommit ?? '');
    this.set('current_branch', scanResult.gitInfo.currentBranch ?? '');
    this.set('embedding_provider', this.config.embedding.provider);
    this.set('embedding_model', this.config.embedding.model);
    const embeddedChunkCount = this.getEmbeddedChunkCount();
    this.set('vector_search', embeddedChunkCount > 0 ? 'enabled' : 'disabled');
    this.set('embedding_dimensions', String(getEmbeddingDimensions(this.config.embedding)));
    this.set('needs_reindex', 'false');
    this.set('is_indexing', 'false');
    this.set('index_completed', now);
  }
}
