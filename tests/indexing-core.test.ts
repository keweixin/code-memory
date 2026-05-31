import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { getDatabaseSync, closeDatabase } from '../src/storage/database.js';
import { HybridSearchEngine } from '../src/search/hybrid-search.js';
import { ContextPacker } from '../src/search/context-packer.js';

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

function queryRows(sql: string, params: unknown[] = []): unknown[][] {
  const rows = getDatabaseSync().exec(sql, params);
  return rows[0]?.values ?? [];
}

async function indexFixture(rootPath: string): Promise<void> {
  const config = createConfig(rootPath);
  mkdirSync(join(rootPath, '.code-memory'), { recursive: true });
  writeFileSync(
    join(rootPath, '.code-memory', 'config.json'),
    JSON.stringify(config, null, 2),
    'utf-8',
  );

  const manager = new IndexManager(rootPath, config);
  await manager.fullIndex();
}

describe('core indexing pipeline', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-index-'));
    cpSync(fixtureRoot, tempRoot, { recursive: true });
  });

  afterEach(async () => {
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('indexes TS/JS projects with trustworthy metadata, chunks, and graph edges', async () => {
    await indexFixture(tempRoot);

    const metadata = new Map(
      queryRows('SELECT key, value FROM index_metadata').map(([key, value]) => [
        String(key),
        String(value),
      ]),
    );

    expect(metadata.get('project_name')).toBe('sample-ts-project');
    expect(metadata.get('root_path')).toBe(tempRoot);
    expect(metadata.get('languages')).toBe('typescript,javascript');
    expect(Number(metadata.get('total_chunks'))).toBeGreaterThan(0);

    const loginRows = queryRows(
      `SELECT s.id, s.range_start, s.range_end
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE s.name = 'login' AND f.path = 'src/services/AuthService.ts'`,
    );
    expect(loginRows).toHaveLength(1);
    const [loginId, loginStart, loginEnd] = loginRows[0];
    expect(loginStart).toBe(24);
    expect(loginEnd).toBe(45);

    const chunksForLogin = queryRows(
      'SELECT content FROM chunks WHERE symbol_id = ?',
      [String(loginId)],
    ).map(([content]) => String(content));
    expect(chunksForLogin.join('\n')).toContain('async login(request: LoginRequest)');

    const danglingEdges = queryRows(
      `SELECT e.id
       FROM edges e
       LEFT JOIN symbols from_symbol ON from_symbol.id = e.from_id
       LEFT JOIN symbols to_symbol ON to_symbol.id = e.to_id
       LEFT JOIN files from_file ON from_file.id = e.from_id
       LEFT JOIN files to_file ON to_file.id = e.to_id
       WHERE COALESCE(from_symbol.id, from_file.id) IS NULL
          OR COALESCE(to_symbol.id, to_file.id) IS NULL`,
    );
    expect(danglingEdges).toHaveLength(0);

    const callees = queryRows(
      `SELECT callee.name
       FROM edges e
       JOIN symbols caller ON caller.id = e.from_id
       JOIN symbols callee ON callee.id = e.to_id
       JOIN files caller_file ON caller_file.id = caller.file_id
       WHERE e.type = 'CALLS'
         AND caller.name = 'login'
         AND caller_file.path = 'src/services/AuthService.ts'
       ORDER BY callee.name`,
    ).map(([name]) => String(name));
    expect(callees).toEqual(
      expect.arrayContaining(['findUserByEmail', 'verifyPassword', 'issueTokens']),
    );

    const importedFiles = queryRows(
      `SELECT imported.path
       FROM edges e
       JOIN files importer ON importer.id = e.from_id
       JOIN files imported ON imported.id = e.to_id
       WHERE e.type = 'IMPORTS'
         AND importer.path = 'src/services/AuthService.ts'
       ORDER BY imported.path`,
    ).map(([path]) => String(path));
    expect(importedFiles).toEqual(
      expect.arrayContaining([
        'src/repositories/user-repository.ts',
        'src/utils/password-hasher.ts',
        'src/services/token-service.ts',
      ]),
    );
  });

  it('packs real code snippets for high-detail context requests', async () => {
    await indexFixture(tempRoot);

    const db = getDatabaseSync();
    const search = new HybridSearchEngine(db);
    const packer = new ContextPacker(db);

    const results = await search.searchCode('login', {
      limit: 10,
      searchMode: 'hybrid',
    });
    const pack = await packer.pack('login', results, {
      tokenBudget: 12000,
      includeProjectCard: true,
      includeMemories: false,
    });

    expect(pack.projectCard?.name).toBe('sample-ts-project');
    expect(pack.codeSnippets.length).toBeGreaterThan(0);
    expect(packer.formatAsText(pack)).toContain('async login(request: LoginRequest)');
  });
});
