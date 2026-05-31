import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';

const fixtureRoot = resolve('tests/fixtures/module-resolution-project');

function createConfig(rootPath: string): CodeMemoryConfig {
  return {
    projectName: 'module-resolution-project',
    rootPath,
    ignore: [...DEFAULT_IGNORE_PATTERNS],
    languages: ['typescript', 'javascript'],
    indexing: {
      workers: 0,
      parseBatchSize: 20,
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

function queryRows(sql: string, params: unknown[] = []): unknown[][] {
  const rows = getDatabaseSync().exec(sql, params);
  return rows[0]?.values ?? [];
}

describe('module resolution', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-module-resolution-'));
    cpSync(fixtureRoot, tempRoot, { recursive: true });
    const config = createConfig(tempRoot);
    mkdirSync(join(tempRoot, '.code-memory'), { recursive: true });
    writeFileSync(join(tempRoot, '.code-memory', 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
  });

  afterEach(async () => {
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('resolves tsconfig paths into IMPORTS and CALLS graph edges', async () => {
    const config = createConfig(tempRoot);
    const manager = new IndexManager(tempRoot, config);
    await manager.fullIndex();

    const imports = queryRows(`
      SELECT target.path
      FROM edges e
      JOIN files source ON source.id = e.from_id
      JOIN files target ON target.id = e.to_id
      WHERE e.type = 'IMPORTS' AND source.path = 'src/app.ts'
      ORDER BY target.path
    `).map((row) => String(row[0]));

    expect(imports).toEqual([
      'packages/shared/src/index.ts',
      'src/services/auth.ts',
    ]);

    const calls = queryRows(`
      SELECT target.name
      FROM edges e
      JOIN symbols target ON target.id = e.to_id
      JOIN symbols source ON source.id = e.from_id
      WHERE e.type = 'CALLS' AND source.name = 'run'
      ORDER BY target.name
    `).map((row) => String(row[0]));

    expect(calls).toEqual(['login', 'normalizeEmail']);
  });
});
