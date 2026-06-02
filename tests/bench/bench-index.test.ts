import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDatabase } from '../../src/storage/database.js';
import { IndexManager } from '../../src/indexer/index-manager.js';
import { DEFAULT_IGNORE_PATTERNS } from '../../src/shared/constants.js';
import { DEFAULT_TOKEN_BUDGETS } from '../../src/shared/types.js';
import type { CodeMemoryConfig } from '../../src/shared/types.js';

const fixtureRoot = resolve('tests/fixtures/sample-ts-project');

function createConfig(rootPath: string): CodeMemoryConfig {
  return {
    projectName: 'sample-ts-project',
    rootPath,
    ignore: [...DEFAULT_IGNORE_PATTERNS],
    languages: ['typescript', 'javascript'],
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

describe('bench: index', () => {
  let tempRoot: string;

  afterEach(async () => {
    await closeDatabase();
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('measures fullIndex time and memory', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'cm-bench-idx-'));
    cpSync(fixtureRoot, tempRoot, { recursive: true });

    const config = createConfig(tempRoot);
    mkdirSync(join(tempRoot, '.code-memory'), { recursive: true });
    writeFileSync(
      join(tempRoot, '.code-memory', 'config.json'),
      JSON.stringify(config, null, 2),
      'utf-8',
    );

    const memBefore = process.memoryUsage();
    const startMs = performance.now();

    const manager = new IndexManager(tempRoot, config);
    await manager.fullIndex();

    const elapsedMs = performance.now() - startMs;
    const memAfter = process.memoryUsage();

    console.log('=== Index Benchmark ===');
    console.log(`fullIndex time: ${elapsedMs.toFixed(0)}ms`);
    console.log(`Heap delta: ${((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024).toFixed(1)}MB`);
    console.log(`RSS delta: ${((memAfter.rss - memBefore.rss) / 1024 / 1024).toFixed(1)}MB`);

    // Sanity check: index should complete in under 30s for the sample project
    expect(elapsedMs).toBeLessThan(30000);
  });
});
