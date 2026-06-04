import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';

function createConfig(rootPath: string): CodeMemoryConfig {
  return {
    projectName: 'graph-evidence-sample',
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

function writeSampleProject(rootPath: string): void {
  mkdirSync(join(rootPath, 'src'), { recursive: true });
  writeFileSync(
    join(rootPath, 'src', 'helpers.ts'),
    [
      'export function save(): string {',
      "  return 'ok';",
      '}',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(
    join(rootPath, 'src', 'run.ts'),
    [
      "import { save } from './helpers.js';",
      'export function run(): void {',
      '  save();',
      '  save();',
      '}',
    ].join('\n'),
    'utf-8',
  );
}

function queryRows(sql: string, params: unknown[] = []): unknown[][] {
  const rows = getDatabaseSync().exec(sql, params);
  return rows[0]?.values ?? [];
}

describe('graph edge evidence', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-graph-evidence-'));
    writeSampleProject(tempRoot);
    writeConfig(tempRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('keeps per-call-site evidence when repeated calls collapse to one graph edge', async () => {
    const config = createConfig(tempRoot);
    const manager = new IndexManager(tempRoot, config);

    await manager.fullIndex();

    const rows = queryRows(
      `SELECT COUNT(DISTINCT e.id), COUNT(gee.id)
       FROM edges e
       JOIN graph_edge_evidence gee ON gee.edge_id = e.id
       JOIN symbols target ON target.id = e.to_id
       WHERE e.type = 'CALLS'
         AND target.name = 'save'
         AND gee.source_table = 'call_refs'`,
    );

    expect(Number(rows[0]?.[0])).toBe(1);
    expect(Number(rows[0]?.[1])).toBe(2);
  });

  it('keeps parser provenance and file-line evidence for call graph edges', async () => {
    const config = createConfig(tempRoot);
    const manager = new IndexManager(tempRoot, config);

    await manager.fullIndex();

    const rows = queryRows(
      `SELECT e.confidence, gee.source_table, gee.source_id, f.path, gee.start_line, gee.evidence
       FROM edges e
       JOIN graph_edge_evidence gee ON gee.edge_id = e.id
       JOIN files f ON f.id = gee.file_id
       JOIN symbols target ON target.id = e.to_id
       WHERE e.type = 'CALLS'
         AND target.name = 'save'
       ORDER BY gee.start_line`,
    );

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Number(row[0])).toBeGreaterThanOrEqual(0.9);
      expect(row[1]).toBe('call_refs');
      expect(String(row[2])).toBeTruthy();
      expect(row[3]).toBe('src/run.ts');
      expect(Number(row[4])).toBeGreaterThan(0);
      expect(String(row[5])).toContain('save()');
    }

    const heuristicCallEdges = queryRows(
      `SELECT COUNT(*)
       FROM edges e
       JOIN graph_edge_evidence gee ON gee.edge_id = e.id
       JOIN symbols target ON target.id = e.to_id
       WHERE e.type = 'CALLS'
         AND target.name = 'save'
         AND gee.source_table = 'graph_builder'`,
    );
    expect(Number(heuristicCallEdges[0]?.[0] ?? 0)).toBe(0);
  });

  it('links import graph evidence back to the exact file_imports row', async () => {
    const config = createConfig(tempRoot);
    const manager = new IndexManager(tempRoot, config);

    await manager.fullIndex();

    const rows = queryRows(
      `SELECT e.confidence, gee.source_table, gee.source_id, f.path, gee.start_line, gee.evidence, fi.source
       FROM edges e
       JOIN graph_edge_evidence gee ON gee.edge_id = e.id
       JOIN files f ON f.id = gee.file_id
       LEFT JOIN file_imports fi ON fi.id = gee.source_id
       WHERE e.type = 'IMPORTS'
       ORDER BY f.path, gee.start_line`,
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Number(row[0])).toBeGreaterThanOrEqual(0.9);
      expect(row[1]).toBe('file_imports');
      expect(row[2]).toEqual(expect.any(String));
      expect(row[2]).not.toBe('');
      expect(row[3]).toBe('src/run.ts');
      expect(Number(row[4])).toBeGreaterThan(0);
      expect(String(row[5])).toBe('./helpers.js');
      expect(row[6]).toBe('./helpers.js');
    }
  });

  it('rolls back graph edge deletion when rebuild flushing fails', async () => {
    const config = createConfig(tempRoot);
    const manager = new IndexManager(tempRoot, config);
    await manager.fullIndex();

    const beforeCallEdges = Number(queryRows("SELECT COUNT(*) FROM edges WHERE type = 'CALLS'")[0]?.[0] ?? 0);
    const beforeEvidence = Number(queryRows('SELECT COUNT(*) FROM graph_edge_evidence')[0]?.[0] ?? 0);
    expect(beforeCallEdges).toBeGreaterThan(0);
    expect(beforeEvidence).toBeGreaterThan(0);

    vi.spyOn(manager as unknown as { flushGraphWriteBuffer: () => void }, 'flushGraphWriteBuffer')
      .mockImplementation(() => {
        throw new Error('forced graph flush failure');
      });

    await expect((manager as unknown as {
      rebuildGraphEdges: (mode: 'full', dirtyFileIds?: string[]) => Promise<number>;
    }).rebuildGraphEdges('full')).rejects.toThrow('forced graph flush failure');

    expect(Number(queryRows("SELECT COUNT(*) FROM edges WHERE type = 'CALLS'")[0]?.[0] ?? 0)).toBe(beforeCallEdges);
    expect(Number(queryRows('SELECT COUNT(*) FROM graph_edge_evidence')[0]?.[0] ?? 0)).toBe(beforeEvidence);
  });
});
