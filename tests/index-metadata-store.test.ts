import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexMetadataStore } from '../src/indexer/index-metadata-store.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabase, getDatabaseSync } from '../src/storage/database.js';

function createConfig(rootPath: string): CodeMemoryConfig {
  return {
    projectName: 'metadata-store-sample',
    rootPath,
    ignore: [...DEFAULT_IGNORE_PATTERNS],
    languages: ['typescript', 'javascript'],
    indexing: {
      workers: 0,
      parseBatchSize: 2,
      edgeMode: 'full',
    },
    embedding: {
      provider: 'none',
      model: 'none',
    },
    llm: null,
    realtime: {
      watch: false,
      debounceMs: 80,
    },
    tokenBudgets: { ...DEFAULT_TOKEN_BUDGETS },
  };
}

function writeConfig(rootPath: string, config = createConfig(rootPath)): void {
  mkdirSync(join(rootPath, '.code-memory'), { recursive: true });
  writeFileSync(join(rootPath, '.code-memory', 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

function querySingle(sql: string, params: unknown[] = []): unknown {
  const rows = getDatabaseSync().exec(sql, params);
  return rows[0]?.values?.[0]?.[0];
}

describe('IndexMetadataStore', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-metadata-store-'));
    writeConfig(tempRoot);
    await getDatabase(tempRoot);
  });

  afterEach(async () => {
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('persists and reads a single metadata key', async () => {
    const config = createConfig(tempRoot);
    const manager = new IndexManager(tempRoot, config);
    await manager.fullIndex();
    const store = new IndexMetadataStore(tempRoot, config);

    store.set('custom_key', 'custom_value');
    expect(store.get('custom_key')).toBe('custom_value');
    expect(querySingle('SELECT value FROM index_metadata WHERE key = ?', ['custom_key']))
      .toBe('custom_value');
  });

  it('overwrites an existing metadata key', () => {
    const config = createConfig(tempRoot);
    const store = new IndexMetadataStore(tempRoot, config);
    store.set('overwrite_key', 'first');
    store.set('overwrite_key', 'second');
    expect(store.get('overwrite_key')).toBe('second');
  });

  it('writes a metadata batch in a single transaction', () => {
    const config = createConfig(tempRoot);
    const store = new IndexMetadataStore(tempRoot, config);
    store.setBatch({
      batch_a: '1',
      batch_b: '2',
      batch_c: '3',
    });
    expect(store.get('batch_a')).toBe('1');
    expect(store.get('batch_b')).toBe('2');
    expect(store.get('batch_c')).toBe('3');
  });

  it('getInt parses integer metadata and falls back when the key is missing or invalid', () => {
    const config = createConfig(tempRoot);
    const store = new IndexMetadataStore(tempRoot, config);
    expect(store.getInt('not_set', 42)).toBe(42);
    store.set('a_number', '99');
    expect(store.getInt('a_number', 0)).toBe(99);
    store.set('not_a_number', 'abc');
    expect(store.getInt('not_a_number', 7)).toBe(7);
  });

  it('getBoolean returns true only for the literal string "true"', () => {
    const config = createConfig(tempRoot);
    const store = new IndexMetadataStore(tempRoot, config);
    expect(store.getBoolean('unset')).toBe(false);
    store.set('flag_on', 'true');
    store.set('flag_other', 'TRUE');
    expect(store.getBoolean('flag_on')).toBe(true);
    expect(store.getBoolean('flag_other')).toBe(false);
  });

  it('returns 0 from table counts when the table is empty', () => {
    const config = createConfig(tempRoot);
    const store = new IndexMetadataStore(tempRoot, config);
    expect(store.getTableCount('files')).toBe(0);
    expect(store.getTableCount('symbols')).toBe(0);
    expect(store.getTableCount('edges')).toBe(0);
    expect(store.getTableCount('chunks')).toBe(0);
    expect(store.getTableCount('memories')).toBe(0);
  });

  it('getTableCount returns the actual row count after a real index', async () => {
    mkdirSync(join(tempRoot, 'src'), { recursive: true });
    writeFileSync(
      join(tempRoot, 'src', 'sample.ts'),
      'export function greet(): string { return "hi"; }\n',
      'utf-8',
    );
    const config = createConfig(tempRoot);
    const manager = new IndexManager(tempRoot, config);
    await manager.fullIndex();
    const store = new IndexMetadataStore(tempRoot, config);

    const indexedFileCount = Number(querySingle('SELECT COUNT(*) FROM files') ?? 0);
    expect(indexedFileCount).toBeGreaterThan(0);
    expect(store.getTableCount('files')).toBe(indexedFileCount);
  });

  it('getEmbeddedChunkCount returns 0 when no chunks are embedded', () => {
    const config = createConfig(tempRoot);
    const store = new IndexMetadataStore(tempRoot, config);
    expect(store.getEmbeddedChunkCount()).toBe(0);
  });

  it('getEmbeddedChunkCount falls back to the supplied callback when SQL fails', () => {
    const config = createConfig(tempRoot);
    const store = new IndexMetadataStore(tempRoot, config, () => 123);
    expect(store.getEmbeddedChunkCount()).toBe(0);
  });

  it('getEmbeddedChunkCount uses the fallback when the underlying query throws', async () => {
    await closeDatabase();
    const config = createConfig(tempRoot);
    const store = new IndexMetadataStore(tempRoot, config, () => 123);
    expect(store.getEmbeddedChunkCount()).toBe(123);
  });

  it('getAllIndexedSymbols returns [] when there are no symbols', () => {
    const config = createConfig(tempRoot);
    const store = new IndexMetadataStore(tempRoot, config);
    expect(store.getAllIndexedSymbols()).toEqual([]);
  });

  it('getAllFiles returns [] when the file table is empty', () => {
    const config = createConfig(tempRoot);
    const store = new IndexMetadataStore(tempRoot, config);
    expect(store.getAllFiles()).toEqual([]);
  });

  it('finalizeRun records the project name, languages, and run counters', async () => {
    const config = createConfig(tempRoot);
    const manager = new IndexManager(tempRoot, config);
    await manager.fullIndex();
    const store = new IndexMetadataStore(tempRoot, config);

    store.finalizeRun(
      {
        files: [],
        gitInfo: { currentCommit: 'abc123', currentBranch: 'main' },
        stats: { totalFiles: 0, byLanguage: {}, byRole: {}, skippedSize: 0, skippedBinary: 0 },
      },
      {
        indexedFiles: 5,
        symbols: 50,
        edges: 100,
        chunks: 10,
        durationMs: 1234,
        parseWorkers: 2,
        dirtyFiles: 3,
        scanMs: 100,
        parseMs: 200,
        writeMs: 300,
        edgeMs: 400,
        vectorMs: 500,
        peakRssMb: 128,
      },
      'full',
    );

    expect(store.get('project_name')).toBe('metadata-store-sample');
    expect(store.get('languages')).toBe('typescript,javascript');
    expect(store.get('last_index_mode')).toBe('full');
    expect(store.get('last_run_indexed_files')).toBe('5');
    expect(store.get('last_run_symbols')).toBe('50');
    expect(store.get('last_run_edges')).toBe('100');
    expect(store.get('last_run_chunks')).toBe('10');
    expect(store.get('last_index_duration_ms')).toBe('1234');
    expect(store.get('last_index_scan_ms')).toBe('100');
    expect(store.get('last_index_parse_ms')).toBe('200');
    expect(store.get('last_index_write_ms')).toBe('300');
    expect(store.get('last_index_edge_ms')).toBe('400');
    expect(store.get('last_index_vector_ms')).toBe('500');
    expect(store.get('last_index_peak_rss_mb')).toBe('128');
    expect(store.get('parse_workers')).toBe('2');
    expect(store.get('dirty_files')).toBe('3');
    expect(store.get('current_commit')).toBe('abc123');
    expect(store.get('current_branch')).toBe('main');
    expect(store.get('embedding_provider')).toBe('none');
    expect(store.get('embedding_model')).toBe('none');
    expect(store.get('vector_search')).toBe('disabled');
    expect(store.get('needs_reindex')).toBe('false');
    expect(store.get('is_indexing')).toBe('false');
    expect(store.get('index_completed')).toBeTruthy();
  });

  it('records the run id during the beginRun/markCommitting/completeRun/failRun lifecycle', () => {
    const config = createConfig(tempRoot);
    const store = new IndexMetadataStore(tempRoot, config);
    const runId = 'run-1234';

    store.beginRun(runId, 'full');
    expect(store.get('index_run_id')).toBe(runId);
    expect(store.get('index_status')).toBe('indexing');
    expect(store.get('index_run_mode')).toBe('full');
    expect(store.get('is_indexing')).toBe('true');

    store.markCommitting(runId);
    expect(store.get('index_status')).toBe('committing');

    store.completeRun(runId);
    expect(store.get('index_status')).toBe('completed');
    expect(store.get('is_indexing')).toBe('false');
    expect(store.get('index_completed_at')).toBeTruthy();

    store.failRun(runId, new Error('boom'));
    expect(store.get('index_status')).toBe('failed');
    expect(store.get('last_index_error')).toContain('boom');
  });
});
