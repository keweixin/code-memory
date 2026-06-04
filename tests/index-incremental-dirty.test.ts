import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { DEFAULT_TOKEN_BUDGETS, type CodeMemoryConfig } from '../src/shared/types.js';
import type { DiscoveredFile } from '../src/scanner/file-discovery.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';
import { getContextLedgerEntries, markContextUsed } from '../src/memory/context-ledger.js';
import { collectInvariants } from '../src/storage/invariants.js';

function createConfig(rootPath: string): CodeMemoryConfig {
  return {
    projectName: 'incremental-dirty-test',
    rootPath,
    ignore: [...DEFAULT_IGNORE_PATTERNS],
    languages: ['typescript'],
    indexing: {
      workers: 0,
      parseBatchSize: 10,
      edgeMode: 'dirty',
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

function queryValue(sql: string, params: unknown[] = []): unknown {
  return getDatabaseSync().exec(sql, params)[0]?.values[0]?.[0];
}

function helperSymbolKey(): string {
  const row = getDatabaseSync().get<{
    path: string;
    name: string;
    kind: string;
    start_line: number;
    end_line: number;
  }>(
    `SELECT f.path, s.name, s.kind, s.start_line, s.end_line
     FROM symbols s
     JOIN files f ON f.id = s.file_id
     WHERE f.path = 'src/helper.ts' AND s.name = 'helper'
     LIMIT 1`,
  );
  if (!row) throw new Error('missing helper symbol');
  return [row.path, row.name, row.kind, row.start_line, row.end_line].join(':');
}

function helperChunkKey(): string {
  const row = getDatabaseSync().get<{
    path: string;
    symbol_name: string;
    start_line: number;
    end_line: number;
  }>(
    `SELECT f.path, COALESCE(s.name, 'file') AS symbol_name, c.start_line, c.end_line
     FROM chunks c
     JOIN files f ON f.id = c.file_id
     LEFT JOIN symbols s ON s.id = c.symbol_id
     WHERE f.path = 'src/helper.ts'
     LIMIT 1`,
  );
  if (!row) throw new Error('missing helper chunk');
  return [row.path, row.symbol_name || 'file', row.start_line, row.end_line].join(':');
}

describe('incremental dirty indexing', () => {
  let tempRoot: string;

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeDatabase();
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('parses only changed files while expanding dirty graph rebuild to direct importers', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-incremental-dirty-'));
    mkdirSync(join(tempRoot, 'src'), { recursive: true });
    writeFileSync(
      join(tempRoot, 'src', 'core.ts'),
      [
        'export function core(): string {',
        "  return 'v1';",
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(tempRoot, 'src', 'importer.ts'),
      [
        "import { core } from './core.js';",
        'export function run(): string {',
        '  return core();',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
    const config = createConfig(tempRoot);
    writeConfig(tempRoot, config);
    await new IndexManager(tempRoot, config).fullIndex();

    const manager = new IndexManager(tempRoot, config);
    const indexFileSpy = vi.spyOn(manager as unknown as {
      indexFile(discovered: DiscoveredFile): Promise<unknown>;
    }, 'indexFile');
    writeFileSync(
      join(tempRoot, 'src', 'core.ts'),
      [
        'export function core(): string {',
        "  return 'v2';",
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    await manager.incrementalIndex({ changedPaths: [join(tempRoot, 'src', 'core.ts')] });

    expect(indexFileSpy).toHaveBeenCalledTimes(1);
    expect(indexFileSpy.mock.calls[0]?.[0].relativePath).toBe('src/core.ts');
    expect(queryValue("SELECT value FROM index_metadata WHERE key = 'last_incremental_planner'")).toBe('path-aware');
    expect(Number(queryValue("SELECT value FROM index_metadata WHERE key = 'dirty_files'"))).toBe(2);
    expect(Number(queryValue("SELECT COUNT(*) FROM edges WHERE type = 'CALLS'"))).toBe(1);
  });

  it('cleans context ledger references when a file is deleted during incremental indexing', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-delete-ledger-'));
    mkdirSync(join(tempRoot, 'src'), { recursive: true });
    writeFileSync(
      join(tempRoot, 'src', 'helper.ts'),
      [
        'export function helper(): string {',
        "  return 'world';",
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(tempRoot, 'src', 'index.ts'),
      [
        "import { helper } from './helper.js';",
        'export function hello(): string {',
        '  return helper();',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
    const config = createConfig(tempRoot);
    writeConfig(tempRoot, config);
    await new IndexManager(tempRoot, config).fullIndex();

    const symbolKey = helperSymbolKey();
    const chunkKey = helperChunkKey();
    markContextUsed({
      sessionId: 'delete-session',
      query: 'helper context',
      returnedFiles: ['src/helper.ts'],
      returnedSymbols: [symbolKey],
      returnedChunks: [chunkKey],
      evidenceIds: ['symbol:' + symbolKey, 'chunk:' + chunkKey],
      tokenEstimate: 42,
    });

    unlinkSync(join(tempRoot, 'src', 'helper.ts'));
    await new IndexManager(tempRoot, config).incrementalIndex({
      changedPaths: [join(tempRoot, 'src', 'helper.ts')],
    });

    const [entry] = getContextLedgerEntries('delete-session');
    expect(entry.returnedFiles).not.toContain('src/helper.ts');
    expect(entry.returnedSymbols).not.toContain(symbolKey);
    expect(entry.returnedChunks).not.toContain(chunkKey);
    expect(entry.evidenceIds).not.toContain('symbol:' + symbolKey);
    expect(entry.evidenceIds).not.toContain('chunk:' + chunkKey);
    expect(Number(queryValue("SELECT COUNT(*) FROM files WHERE path = 'src/helper.ts'"))).toBe(0);
    expect(Number(queryValue("SELECT COUNT(*) FROM call_refs WHERE file_id NOT IN (SELECT id FROM files)"))).toBe(0);

    const invariants = collectInvariants(getDatabaseSync());
    expect(Number(queryValue("SELECT COUNT(*) FROM symbols WHERE file_id NOT IN (SELECT id FROM files)"))).toBe(0);
    expect(Number(queryValue("SELECT COUNT(*) FROM chunks WHERE file_id NOT IN (SELECT id FROM files)"))).toBe(0);
    expect(invariants).toContainEqual(expect.objectContaining({
      name: 'context-ledger-stale-references',
      status: 'ok',
      count: 0,
    }));
    expect(invariants).toContainEqual(expect.objectContaining({
      name: 'dangling-edges',
      status: 'ok',
      count: 0,
    }));
  });

  it('renames files without returning orphaned old paths or stale chunks', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-rename-lifecycle-'));
    mkdirSync(join(tempRoot, 'src'), { recursive: true });
    const oldPath = join(tempRoot, 'src', 'helper.ts');
    const newPath = join(tempRoot, 'src', 'helper-renamed.ts');
    writeFileSync(
      oldPath,
      [
        'export function helper(): string {',
        "  return 'world';",
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(tempRoot, 'src', 'index.ts'),
      [
        "import { helper } from './helper.js';",
        'export function hello(): string {',
        '  return helper();',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
    const config = createConfig(tempRoot);
    writeConfig(tempRoot, config);
    await new IndexManager(tempRoot, config).fullIndex();

    renameSync(oldPath, newPath);
    writeFileSync(
      join(tempRoot, 'src', 'index.ts'),
      [
        "import { helper } from './helper-renamed.js';",
        'export function hello(): string {',
        '  return helper();',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    await new IndexManager(tempRoot, config).incrementalIndex({
      changedPaths: [oldPath, newPath, join(tempRoot, 'src', 'index.ts')],
    });

    expect(Number(queryValue("SELECT COUNT(*) FROM files WHERE path = 'src/helper.ts'"))).toBe(0);
    expect(Number(queryValue("SELECT COUNT(*) FROM files WHERE path = 'src/helper-renamed.ts'"))).toBe(1);
    expect(Number(queryValue(
      `SELECT COUNT(*)
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE f.path = 'src/helper.ts'`,
    ))).toBe(0);
    expect(Number(queryValue(
      `SELECT COUNT(*)
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE f.path = 'src/helper-renamed.ts' AND s.name = 'helper'`,
    ))).toBeGreaterThan(0);
    expect(Number(queryValue(
      `SELECT COUNT(*)
       FROM chunks c
       JOIN files f ON f.id = c.file_id
       WHERE f.path = 'src/helper.ts'`,
    ))).toBe(0);
    expect(Number(queryValue(
      `SELECT COUNT(*)
       FROM chunks c
       JOIN files f ON f.id = c.file_id
       WHERE f.path = 'src/helper-renamed.ts'`,
    ))).toBeGreaterThan(0);

    const invariants = collectInvariants(getDatabaseSync());
    expect(invariants).toContainEqual(expect.objectContaining({
      name: 'dangling-edges',
      status: 'ok',
      count: 0,
    }));
  });

  it('does not rebuild graph edges when path-aware changes are ignored', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-incremental-noop-'));
    mkdirSync(join(tempRoot, 'src'), { recursive: true });
    mkdirSync(join(tempRoot, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(
      join(tempRoot, 'src', 'main.ts'),
      'export function main(): string { return "ok"; }\n',
      'utf-8',
    );
    writeFileSync(
      join(tempRoot, 'node_modules', 'pkg', 'ignored.ts'),
      'export const ignored = true;\n',
      'utf-8',
    );
    const config = createConfig(tempRoot);
    writeConfig(tempRoot, config);
    await new IndexManager(tempRoot, config).fullIndex();

    const manager = new IndexManager(tempRoot, config);
    const indexFileSpy = vi.spyOn(manager as unknown as {
      indexFile(discovered: DiscoveredFile): Promise<unknown>;
    }, 'indexFile');
    const rebuildSpy = vi.spyOn(manager as unknown as {
      rebuildGraphEdges(mode: string, dirtyFileIds?: string[]): Promise<number>;
    }, 'rebuildGraphEdges');

    await manager.incrementalIndex({
      changedPaths: [join(tempRoot, 'node_modules', 'pkg', 'ignored.ts')],
    });

    expect(indexFileSpy).not.toHaveBeenCalled();
    expect(rebuildSpy).not.toHaveBeenCalled();
    expect(queryValue("SELECT value FROM index_metadata WHERE key = 'last_incremental_planner'")).toBe('noop');
    expect(Number(queryValue("SELECT value FROM index_metadata WHERE key = 'dirty_files'"))).toBe(0);
  });
});
