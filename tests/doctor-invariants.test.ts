import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { createCli } from '../src/cli/cli.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';

function createConfig(rootPath: string): CodeMemoryConfig {
  return {
    projectName: 'doctor-invariants-sample',
    rootPath,
    ignore: [...DEFAULT_IGNORE_PATTERNS],
    languages: ['typescript', 'javascript'],
    indexing: {
      workers: 0,
      parseBatchSize: 10,
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

function writeProject(rootPath: string): CodeMemoryConfig {
  mkdirSync(join(rootPath, 'src'), { recursive: true });
  writeFileSync(join(rootPath, 'src', 'helper.ts'), 'export function helper(): string { return "world"; }\n', 'utf-8');
  writeFileSync(
    join(rootPath, 'src', 'index.ts'),
    [
      "import { helper } from './helper.js';",
      'export function hello(): string {',
      '  return helper();',
      '}',
    ].join('\n'),
    'utf-8',
  );
  const config = createConfig(rootPath);
  mkdirSync(join(rootPath, '.code-memory'), { recursive: true });
  writeFileSync(join(rootPath, '.code-memory', 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
  return config;
}

async function indexProject(rootPath: string): Promise<void> {
  const config = writeProject(rootPath);
  const manager = new IndexManager(rootPath, config);
  await manager.fullIndex();
}

async function runDoctorJson(): Promise<{ checks: Array<{ name: string; status: string; count?: number }> }> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const program = createCli();
  program.exitOverride();
  await program.parseAsync(['node', 'code-memory', 'doctor', '--json']);
  return JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join('\n')) as {
    checks: Array<{ name: string; status: string; count?: number }>;
  };
}

describe('doctor invariants', () => {
  let tempRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-doctor-invariants-'));
    process.chdir(tempRoot);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('reports dangling graph edges', async () => {
    await indexProject(tempRoot);

    getDatabaseSync().run(
      "INSERT INTO edges (id, from_id, to_id, type, confidence, evidence) VALUES ('bad-edge', 'missing-a', 'missing-b', 'CALLS', 1, 'bad')",
    );

    const result = await runDoctorJson();
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'dangling-edges',
      status: 'error',
      count: 1,
    }));
  });

  it('reports invalid symbol line ranges', async () => {
    await indexProject(tempRoot);

    getDatabaseSync().run(
      "UPDATE symbols SET start_line = end_line + 1, range_start = end_line + 1 WHERE name = 'hello'",
    );

    const result = await runDoctorJson();
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'symbol-line-ranges',
      status: 'error',
      count: 1,
    }));
  });

  it('reports invalid chunk byte ranges and empty content hashes', async () => {
    await indexProject(tempRoot);

    getDatabaseSync().run(
      "UPDATE chunks SET start_byte = end_byte, content_hash = '' WHERE id = (SELECT id FROM chunks LIMIT 1)",
    );

    const result = await runDoctorJson();
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'chunk-byte-ranges',
      status: 'error',
      count: 1,
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'chunk-content-hashes',
      status: 'error',
      count: 1,
    }));
  });

  it('reports evidence-backed graph edges missing graph evidence rows', async () => {
    await indexProject(tempRoot);

    getDatabaseSync().run(
      "DELETE FROM graph_edge_evidence WHERE edge_id = (SELECT id FROM edges WHERE type = 'CALLS' LIMIT 1)",
    );

    const result = await runDoctorJson();
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'evidence-backed-graph-edges',
      status: 'error',
      count: 1,
    }));
  });

  it('reports context governor health checks', async () => {
    await indexProject(tempRoot);

    const result = await runDoctorJson();
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'parse-metadata-present',
      status: 'ok',
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'parse-metadata-file-links',
      status: 'ok',
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'context-ledger-entries',
      status: 'ok',
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'memories',
      status: 'ok',
    }));
  });

  it('reports parse metadata rows pointing at missing files', async () => {
    await indexProject(tempRoot);

    const db = getDatabaseSync();
    db.run('PRAGMA foreign_keys = OFF');
    db.run(
      `INSERT INTO call_refs
       (id, file_id, callee_name, start_line, start_column, resolution_status)
       VALUES ('bad-call-ref', 'missing-file', 'helper', 1, 0, 'unresolved')`,
    );
    db.run('PRAGMA foreign_keys = ON');

    const result = await runDoctorJson();
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'parse-metadata-file-links',
      status: 'error',
      count: 1,
    }));
  });
});
