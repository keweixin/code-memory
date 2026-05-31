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
  writeFileSync(join(rootPath, 'src', 'index.ts'), 'export function hello(): string { return "world"; }\n', 'utf-8');
  const config = createConfig(rootPath);
  mkdirSync(join(rootPath, '.code-memory'), { recursive: true });
  writeFileSync(join(rootPath, '.code-memory', 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
  return config;
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
    const config = writeProject(tempRoot);
    const manager = new IndexManager(tempRoot, config);
    await manager.fullIndex();

    getDatabaseSync().run(
      "INSERT INTO edges (id, from_id, to_id, type, confidence, evidence) VALUES ('bad-edge', 'missing-a', 'missing-b', 'CALLS', 1, 'bad')",
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createCli();
    program.exitOverride();
    await program.parseAsync(['node', 'code-memory', 'doctor', '--json']);

    const result = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join('\n')) as {
      checks: Array<{ name: string; status: string; count?: number }>;
    };
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'dangling-edges',
      status: 'error',
      count: 1,
    }));
  });
});
