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

  it('resolves workspace package exports into IMPORTS and CALLS graph edges', async () => {
    writeFileSync(
      join(tempRoot, 'packages', 'shared', 'package.json'),
      JSON.stringify({
        name: '@sample/shared',
        type: 'module',
        exports: {
          '.': './src/index.ts',
        },
      }, null, 2),
      'utf-8',
    );
    writeFileSync(
      join(tempRoot, 'src', 'package-app.ts'),
      [
        "import { normalizeEmail } from '@sample/shared';",
        '',
        'export function runPackage(email: string): string {',
        '  return normalizeEmail(email);',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    const config = createConfig(tempRoot);
    const manager = new IndexManager(tempRoot, config);
    await manager.fullIndex();

    const imports = queryRows(`
      SELECT target.path
      FROM edges e
      JOIN files source ON source.id = e.from_id
      JOIN files target ON target.id = e.to_id
      WHERE e.type = 'IMPORTS' AND source.path = 'src/package-app.ts'
      ORDER BY target.path
    `).map((row) => String(row[0]));

    expect(imports).toEqual(['packages/shared/src/index.ts']);

    const calls = queryRows(`
      SELECT target.name
      FROM edges e
      JOIN symbols target ON target.id = e.to_id
      JOIN symbols source ON source.id = e.from_id
      WHERE e.type = 'CALLS' AND source.name = 'runPackage'
      ORDER BY target.name
    `).map((row) => String(row[0]));

    expect(calls).toEqual(['normalizeEmail']);
  });

  it('resolves workspace package wildcard exports into IMPORTS and CALLS graph edges', async () => {
    mkdirSync(join(tempRoot, 'packages', 'shared', 'src', 'features'), { recursive: true });
    writeFileSync(
      join(tempRoot, 'packages', 'shared', 'package.json'),
      JSON.stringify({
        name: '@sample/shared',
        type: 'module',
        exports: {
          '.': './src/index.ts',
          './features/*': {
            import: './src/features/*.ts',
            types: './src/features/*.ts',
          },
        },
      }, null, 2),
      'utf-8',
    );
    writeFileSync(
      join(tempRoot, 'packages', 'shared', 'src', 'features', 'slug.ts'),
      [
        'export function slugify(input: string): string {',
        "  return input.toLowerCase().replaceAll(' ', '-');",
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(tempRoot, 'src', 'package-wildcard-app.ts'),
      [
        "import { slugify } from '@sample/shared/features/slug';",
        '',
        'export function runWildcardPackage(title: string): string {',
        '  return slugify(title);',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    const config = createConfig(tempRoot);
    const manager = new IndexManager(tempRoot, config);
    await manager.fullIndex();

    const imports = queryRows(`
      SELECT target.path
      FROM edges e
      JOIN files source ON source.id = e.from_id
      JOIN files target ON target.id = e.to_id
      WHERE e.type = 'IMPORTS' AND source.path = 'src/package-wildcard-app.ts'
      ORDER BY target.path
    `).map((row) => String(row[0]));

    expect(imports).toEqual(['packages/shared/src/features/slug.ts']);

    const calls = queryRows(`
      SELECT target.name
      FROM edges e
      JOIN symbols target ON target.id = e.to_id
      JOIN symbols source ON source.id = e.from_id
      WHERE e.type = 'CALLS' AND source.name = 'runWildcardPackage'
      ORDER BY target.name
    `).map((row) => String(row[0]));

    expect(calls).toEqual(['slugify']);
  });
});
