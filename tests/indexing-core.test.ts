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
import { ImpactAnalyzer } from '../src/graph/impact-analyzer.js';

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
      `SELECT s.id, s.range_start, s.range_end,
              s.start_byte, s.end_byte, s.start_line, s.end_line,
              s.start_column, s.end_column
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE s.name = 'login' AND f.path = 'src/services/AuthService.ts'`,
    );
    expect(loginRows).toHaveLength(1);
    const [
      loginId,
      loginStart,
      loginEnd,
      loginStartByte,
      loginEndByte,
      loginStartLine,
      loginEndLine,
      loginStartColumn,
      loginEndColumn,
    ] = loginRows[0];
    expect(loginStart).toBe(24);
    expect(loginEnd).toBe(45);
    expect(loginStartLine).toBe(24);
    expect(loginEndLine).toBe(45);
    expect(Number(loginStartByte)).toBeGreaterThan(0);
    expect(Number(loginEndByte)).toBeGreaterThan(Number(loginStartByte));
    expect(Number(loginStartColumn)).toBeGreaterThanOrEqual(0);
    expect(Number(loginEndColumn)).toBeGreaterThanOrEqual(0);

    const chunksForLogin = queryRows(
      `SELECT content, start_byte, end_byte, start_line, end_line, start_column, end_column
       FROM chunks WHERE symbol_id = ?`,
      [String(loginId)],
    );
    expect(chunksForLogin.map(([content]) => String(content)).join('\n'))
      .toContain('async login(request: LoginRequest)');
    const loginChunk = chunksForLogin[0];
    expect(loginChunk[3]).toBe(24);
    expect(loginChunk[4]).toBe(45);
    expect(Number(loginChunk[1])).toBe(Number(loginStartByte));
    expect(Number(loginChunk[2])).toBe(Number(loginEndByte));

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

    const testEdges = queryRows(
      `SELECT test_file.path, target_file.path
       FROM edges e
       JOIN files test_file ON test_file.id = e.from_id
       JOIN files target_file ON target_file.id = e.to_id
       WHERE e.type = 'TESTS'
         AND test_file.path = 'tests/auth.test.js'
         AND target_file.path = 'src/services/AuthService.ts'`,
    );
    expect(testEdges).toHaveLength(1);

    const testSymbolEdges = queryRows(
      `SELECT test_symbol.name, target_symbol.name
       FROM edges e
       JOIN symbols test_symbol ON test_symbol.id = e.from_id
       JOIN files test_file ON test_file.id = test_symbol.file_id
       JOIN symbols target_symbol ON target_symbol.id = e.to_id
       JOIN files target_file ON target_file.id = target_symbol.file_id
       WHERE e.type = 'TESTS'
         AND test_file.path = 'tests/auth.test.js'
         AND target_file.path = 'src/services/AuthService.ts'
         AND target_symbol.name = 'AuthService'`,
    );
    expect(testSymbolEdges.length).toBeGreaterThan(0);
  });

  it('indexes project docs/config files and links configs into impact analysis', async () => {
    await indexFixture(tempRoot);

    const projectFiles = queryRows(
      `SELECT path, role
       FROM files
       WHERE path IN ('README.md', 'package.json', 'tsconfig.json')
       ORDER BY path`,
    );
    expect(projectFiles).toEqual([
      ['README.md', 'doc'],
      ['package.json', 'config'],
      ['tsconfig.json', 'config'],
    ]);

    const configEdges = queryRows(
      `SELECT config.path, target.path
       FROM edges e
       JOIN files config ON config.id = e.from_id
       JOIN files target ON target.id = e.to_id
       WHERE e.type = 'CONFIGURES'
         AND target.path = 'src/services/AuthService.ts'
       ORDER BY config.path`,
    );
    expect(configEdges).toEqual([
      ['package.json', 'src/services/AuthService.ts'],
      ['tsconfig.json', 'src/services/AuthService.ts'],
    ]);

    const analyzer = new ImpactAnalyzer(getDatabaseSync());
    const impact = analyzer.analyze('src/services/AuthService.ts');
    expect(impact.relatedConfigs).toEqual(['package.json', 'tsconfig.json']);
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
    expect(pack.projectCard?.rootPath).toBe(tempRoot);
    expect(pack.projectCard?.languages).toEqual(['typescript', 'javascript']);
    expect(pack.codeSnippets.length).toBeGreaterThan(0);
    const formatted = packer.formatAsText(pack);
    expect(formatted).toContain('async login(request: LoginRequest)');
    expect(formatted).toMatch(/AuthService\.ts:24:\d+-45:\d+/);
  });

  it('uses keyword seeds but returns graph-sourced results in graph search mode', async () => {
    await indexFixture(tempRoot);

    const db = getDatabaseSync();
    const search = new HybridSearchEngine(db);
    const results = await search.searchCode('login', {
      limit: 10,
      searchMode: 'graph',
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.some((result) => result.sources.includes('graph'))).toBe(true);
    expect(results.every((result) => !result.sources.includes('keyword'))).toBe(true);
  });

  it('rejects vector-only search while embeddings are not wired', async () => {
    await indexFixture(tempRoot);

    const db = getDatabaseSync();
    const search = new HybridSearchEngine(db);

    await expect(search.search({
      query: 'login',
      searchMode: 'vector',
    })).rejects.toThrow('Vector search is not available');
  });

  it('indexes TSX components with real symbols and chunks', async () => {
    const componentDir = join(tempRoot, 'src/components');
    mkdirSync(componentDir, { recursive: true });
    writeFileSync(
      join(componentDir, 'LoginPanel.tsx'),
      [
        'import { AuthService } from "../services/AuthService.js";',
        '',
        'export interface LoginPanelProps {',
        '  title: string;',
        '}',
        '',
        'export function LoginPanel(props: LoginPanelProps) {',
        '  const service = new AuthService();',
        '  return <section><h1>{props.title}</h1><button>Login</button></section>;',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    await indexFixture(tempRoot);

    const tsxSymbols = queryRows(
      `SELECT s.id, s.name, s.start_line, s.end_line
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE f.path = 'src/components/LoginPanel.tsx'
       ORDER BY s.name`,
    );
    expect(tsxSymbols.map(([, name]) => String(name))).toEqual(
      expect.arrayContaining(['LoginPanel', 'LoginPanelProps']),
    );

    const loginPanel = tsxSymbols.find(([, name]) => String(name) === 'LoginPanel');
    expect(loginPanel).toBeDefined();
    expect(loginPanel?.[2]).toBe(7);

    const chunks = queryRows(
      'SELECT content, start_line, end_line FROM chunks WHERE symbol_id = ?',
      [String(loginPanel?.[0])],
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(String(chunks[0][0])).toContain('return <section>');
    expect(chunks[0][1]).toBe(7);
  });
});
