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

  it('does not treat string literals inside exported declarations as re-export sources', async () => {
    mkdirSync(join(tempRoot, 'src', 'risk'), { recursive: true });
    writeFileSync(
      join(tempRoot, 'src', 'risk', 'literal-export.ts'),
      [
        'export function issueTokens(): string {',
        "  return 'token';",
        '}',
      ].join('\n'),
      'utf-8',
    );

    await indexFixture(tempRoot);

    const reexportNoise = queryRows(
      `SELECT fe.exported_name, fe.source, fe.kind
       FROM file_exports fe
       JOIN files f ON f.id = fe.file_id
       WHERE f.path = 'src/risk/literal-export.ts'
         AND fe.kind LIKE 'reexport%'`,
    );
    expect(reexportNoise).toHaveLength(0);
  });

  it('links project configs into symbol-level impact analysis', async () => {
    await indexFixture(tempRoot);

    const analyzer = new ImpactAnalyzer(getDatabaseSync());
    const impact = analyzer.analyze('AuthService');

    expect(impact.relatedConfigs).toEqual(['package.json', 'tsconfig.json']);
  });

  it('resolves qualified class method targets in impact analysis', async () => {
    await indexFixture(tempRoot);

    const analyzer = new ImpactAnalyzer(getDatabaseSync());
    const impact = analyzer.analyze('AuthService.login');

    expect(impact.affectedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'src/services/AuthService.ts',
          impactType: 'direct',
          distance: 0,
        }),
      ]),
    );
    expect(impact.affectedSymbols.map((symbol) => symbol.name)).toEqual(
      expect.arrayContaining(['findUserByEmail', 'verifyPassword', 'issueTokens']),
    );
    expect(impact.relatedConfigs).toEqual(['package.json', 'tsconfig.json']);
  });

  it('packs real code snippets for high-detail context requests', async () => {
    await indexFixture(tempRoot);

    const db = getDatabaseSync();
    db.run(
      `INSERT OR REPLACE INTO index_metadata (key, value) VALUES
        ('current_commit', 'abc123def456'),
        ('current_branch', 'feature/context-evidence'),
        ('index_completed', '2026-05-31T09:00:00.000Z'),
        ('embedding_provider', 'none')`,
    );

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
    expect(pack.projectCard).toMatchObject({
      currentCommit: 'abc123def456',
      currentBranch: 'feature/context-evidence',
      indexCompleted: '2026-05-31T09:00:00.000Z',
      vectorSearch: 'disabled',
    });
    expect(pack.codeSnippets.length).toBeGreaterThan(0);
    const formatted = packer.formatAsText(pack);
    expect(formatted).toContain('Commit: abc123def456');
    expect(formatted).toContain('Branch: feature/context-evidence');
    expect(formatted).toContain('Index Completed: 2026-05-31T09:00:00.000Z');
    expect(formatted).toContain('Vector Search: disabled');
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

  it('applies file filters to keyword symbol and file search results', async () => {
    await indexFixture(tempRoot);

    const db = getDatabaseSync();
    const search = new HybridSearchEngine(db);
    const symbolResults = await search.searchCode('login', {
      limit: 20,
      searchMode: 'keyword',
      fileFilter: 'src/services/AuthService.ts',
    });

    expect(symbolResults.length).toBeGreaterThan(0);
    expect(symbolResults.every((result) => result.filePath === 'src/services/AuthService.ts')).toBe(true);

    const fileResults = await search.searchCode('README', {
      limit: 20,
      searchMode: 'keyword',
      fileFilter: 'src/**',
    });

    expect(fileResults).toHaveLength(0);
  });

  it('resolves aliased named imports when building CALLS edges', async () => {
    writeFileSync(
      join(tempRoot, 'src/services/alias-login.ts'),
      [
        "import { findUserByEmail as lookupUser } from '../repositories/user-repository.js';",
        '',
        'export async function aliasLookup(email: string) {',
        '  return lookupUser(email);',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    await indexFixture(tempRoot);

    const aliasCalls = queryRows(
      `SELECT callee.name
       FROM edges e
       JOIN symbols caller ON caller.id = e.from_id
       JOIN symbols callee ON callee.id = e.to_id
       JOIN files caller_file ON caller_file.id = caller.file_id
       JOIN files callee_file ON callee_file.id = callee.file_id
       WHERE e.type = 'CALLS'
         AND caller.name = 'aliasLookup'
         AND caller_file.path = 'src/services/alias-login.ts'
         AND callee_file.path = 'src/repositories/user-repository.ts'
       ORDER BY callee.name`,
    ).map(([name]) => String(name));

    expect(aliasCalls).toEqual(['findUserByEmail']);
  });

  it('resolves multiple import statements from the same source when building CALLS edges', async () => {
    writeFileSync(
      join(tempRoot, 'src/services/split-import-login.ts'),
      [
        "import { findUserByEmail } from '../repositories/user-repository.js';",
        "import { findUserById } from '../repositories/user-repository.js';",
        '',
        'export async function splitImportLookup(email: string, id: string) {',
        '  await findUserByEmail(email);',
        '  return findUserById(id);',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    await indexFixture(tempRoot);

    const splitImportCalls = queryRows(
      `SELECT callee.name
       FROM edges e
       JOIN symbols caller ON caller.id = e.from_id
       JOIN symbols callee ON callee.id = e.to_id
       JOIN files caller_file ON caller_file.id = caller.file_id
       JOIN files callee_file ON callee_file.id = callee.file_id
       WHERE e.type = 'CALLS'
         AND caller.name = 'splitImportLookup'
         AND caller_file.path = 'src/services/split-import-login.ts'
         AND callee_file.path = 'src/repositories/user-repository.ts'
       ORDER BY callee.name`,
    ).map(([name]) => String(name));

    expect(splitImportCalls).toEqual(['findUserByEmail', 'findUserById']);
  });

  it('does not treat side-effect imports as callable symbol bindings', async () => {
    writeFileSync(
      join(tempRoot, 'src/services/runtime-setup.ts'),
      [
        'export function configureRuntime() {',
        "  return 'configured';",
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(tempRoot, 'src/services/side-effect-login.ts'),
      [
        "import './runtime-setup.js';",
        '',
        'export function sideEffectLogin() {',
        '  return configureRuntime();',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    await indexFixture(tempRoot);

    const fileImportEdges = queryRows(
      `SELECT imported.path
       FROM edges e
       JOIN files importer ON importer.id = e.from_id
       JOIN files imported ON imported.id = e.to_id
       WHERE e.type = 'IMPORTS'
         AND importer.path = 'src/services/side-effect-login.ts'
       ORDER BY imported.path`,
    ).map(([path]) => String(path));
    expect(fileImportEdges).toEqual(['src/services/runtime-setup.ts']);

    const falseReferences = queryRows(
      `SELECT target.name
       FROM edges e
       JOIN files source_file ON source_file.id = e.from_id
       JOIN symbols target ON target.id = e.to_id
       WHERE e.type = 'REFERENCES'
         AND source_file.path = 'src/services/side-effect-login.ts'
         AND target.name = 'configureRuntime'`,
    );
    expect(falseReferences).toHaveLength(0);

    const falseCalls = queryRows(
      `SELECT callee.name
       FROM edges e
       JOIN symbols caller ON caller.id = e.from_id
       JOIN symbols callee ON callee.id = e.to_id
       JOIN files caller_file ON caller_file.id = caller.file_id
       WHERE e.type = 'CALLS'
         AND caller.name = 'sideEffectLogin'
         AND caller_file.path = 'src/services/side-effect-login.ts'
         AND callee.name = 'configureRuntime'`,
    );
    expect(falseCalls).toHaveLength(0);
  });

  it('does not use type-only imports as runtime callable bindings', async () => {
    writeFileSync(
      join(tempRoot, 'src/services/type-only-runtime.ts'),
      [
        "import type { UserRecord } from '../repositories/user-repository.js';",
        '',
        'export function typeOnlyRuntime() {',
        '  return UserRecord();',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    await indexFixture(tempRoot);

    const typeReferences = queryRows(
      `SELECT target.name
       FROM edges e
       JOIN files source_file ON source_file.id = e.from_id
       JOIN symbols target ON target.id = e.to_id
       WHERE e.type = 'REFERENCES'
         AND source_file.path = 'src/services/type-only-runtime.ts'
         AND target.name = 'UserRecord'`,
    );
    expect(typeReferences).toHaveLength(1);

    const falseTypeCalls = queryRows(
      `SELECT callee.name
       FROM edges e
       JOIN symbols caller ON caller.id = e.from_id
       JOIN symbols callee ON callee.id = e.to_id
       JOIN files caller_file ON caller_file.id = caller.file_id
       WHERE e.type = 'CALLS'
         AND caller.name = 'typeOnlyRuntime'
         AND caller_file.path = 'src/services/type-only-runtime.ts'
         AND callee.name = 'UserRecord'`,
    );
    expect(falseTypeCalls).toHaveLength(0);
  });

  it('resolves default imports to exported callees when building CALLS edges', async () => {
    writeFileSync(
      join(tempRoot, 'src/services/default-token.ts'),
      [
        'export default function issueDefaultToken(userId: string) {',
        "  return `default_${userId}`;",
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(tempRoot, 'src/services/default-login.ts'),
      [
        "import makeToken from './default-token.js';",
        '',
        'export function defaultLogin(userId: string) {',
        '  return makeToken(userId);',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    await indexFixture(tempRoot);

    const defaultCalls = queryRows(
      `SELECT callee.name
       FROM edges e
       JOIN symbols caller ON caller.id = e.from_id
       JOIN symbols callee ON callee.id = e.to_id
       JOIN files caller_file ON caller_file.id = caller.file_id
       JOIN files callee_file ON callee_file.id = callee.file_id
       WHERE e.type = 'CALLS'
         AND caller.name = 'defaultLogin'
         AND caller_file.path = 'src/services/default-login.ts'
         AND callee_file.path = 'src/services/default-token.ts'
       ORDER BY callee.name`,
    ).map(([name]) => String(name));

    expect(defaultCalls).toEqual(['issueDefaultToken']);
  });

  it('indexes anonymous default function exports and resolves default imports to them', async () => {
    writeFileSync(
      join(tempRoot, 'src/services/anonymous-token.ts'),
      [
        'export default function(userId: string) {',
        "  return `anonymous_${userId}`;",
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(tempRoot, 'src/services/anonymous-login.ts'),
      [
        "import makeAnonymousToken from './anonymous-token.js';",
        '',
        'export function anonymousDefaultLogin(userId: string) {',
        '  return makeAnonymousToken(userId);',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    await indexFixture(tempRoot);

    const defaultSymbols = queryRows(
      `SELECT s.id, s.name, s.kind, s.start_line, s.end_line
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE f.path = 'src/services/anonymous-token.ts'
         AND s.name = 'default'
         AND s.kind = 'function'`,
    );
    expect(defaultSymbols).toHaveLength(1);

    const chunks = queryRows(
      'SELECT content, start_line, end_line FROM chunks WHERE symbol_id = ?',
      [String(defaultSymbols[0][0])],
    );
    expect(chunks).toHaveLength(1);
    expect(String(chunks[0][0])).toContain('export default function');
    expect(chunks[0][1]).toBe(1);

    const defaultCalls = queryRows(
      `SELECT callee.name
       FROM edges e
       JOIN symbols caller ON caller.id = e.from_id
       JOIN symbols callee ON callee.id = e.to_id
       JOIN files caller_file ON caller_file.id = caller.file_id
       JOIN files callee_file ON callee_file.id = callee.file_id
       WHERE e.type = 'CALLS'
         AND caller.name = 'anonymousDefaultLogin'
         AND caller_file.path = 'src/services/anonymous-login.ts'
         AND callee_file.path = 'src/services/anonymous-token.ts'
       ORDER BY callee.name`,
    ).map(([name]) => String(name));

    expect(defaultCalls).toEqual(['default']);
  });

  it('resolves mixed default and named imports when building CALLS edges', async () => {
    writeFileSync(
      join(tempRoot, 'src/services/mixed-token.ts'),
      [
        'export default function issueMixedToken(userId: string) {',
        "  return `mixed_${userId}`;",
        '}',
        '',
        'export function revokeMixedToken(userId: string) {',
        '  return userId;',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(tempRoot, 'src/services/mixed-login.ts'),
      [
        "import makeMixedToken, { revokeMixedToken } from './mixed-token.js';",
        '',
        'export function mixedLogin(userId: string) {',
        '  revokeMixedToken(userId);',
        '  return makeMixedToken(userId);',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    await indexFixture(tempRoot);

    const mixedCalls = queryRows(
      `SELECT callee.name
       FROM edges e
       JOIN symbols caller ON caller.id = e.from_id
       JOIN symbols callee ON callee.id = e.to_id
       JOIN files caller_file ON caller_file.id = caller.file_id
       JOIN files callee_file ON callee_file.id = callee.file_id
       WHERE e.type = 'CALLS'
         AND caller.name = 'mixedLogin'
         AND caller_file.path = 'src/services/mixed-login.ts'
         AND callee_file.path = 'src/services/mixed-token.ts'
       ORDER BY callee.name`,
    ).map(([name]) => String(name));

    expect(mixedCalls).toEqual(['issueMixedToken', 'revokeMixedToken']);
  });

  it('resolves namespace imports when building CALLS edges', async () => {
    writeFileSync(
      join(tempRoot, 'src/services/namespace-login.ts'),
      [
        "import * as users from '../repositories/user-repository.js';",
        '',
        'export async function namespaceLookup(email: string) {',
        '  return users.findUserByEmail(email);',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    await indexFixture(tempRoot);

    const namespaceCalls = queryRows(
      `SELECT callee.name
       FROM edges e
       JOIN symbols caller ON caller.id = e.from_id
       JOIN symbols callee ON callee.id = e.to_id
       JOIN files caller_file ON caller_file.id = caller.file_id
       JOIN files callee_file ON callee_file.id = callee.file_id
       WHERE e.type = 'CALLS'
         AND caller.name = 'namespaceLookup'
         AND caller_file.path = 'src/services/namespace-login.ts'
         AND callee_file.path = 'src/repositories/user-repository.ts'
       ORDER BY callee.name`,
    ).map(([name]) => String(name));

    expect(namespaceCalls).toEqual(['findUserByEmail']);
  });

  it('resolves named imports through barrel re-exports when building CALLS edges', async () => {
    writeFileSync(
      join(tempRoot, 'src/services/user-barrel.ts'),
      [
        "export { findUserByEmail } from '../repositories/user-repository.js';",
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(tempRoot, 'src/services/barrel-login.ts'),
      [
        "import { findUserByEmail } from './user-barrel.js';",
        '',
        'export async function barrelLookup(email: string) {',
        '  return findUserByEmail(email);',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    await indexFixture(tempRoot);

    const barrelCalls = queryRows(
      `SELECT callee.name
       FROM edges e
       JOIN symbols caller ON caller.id = e.from_id
       JOIN symbols callee ON callee.id = e.to_id
       JOIN files caller_file ON caller_file.id = caller.file_id
       JOIN files callee_file ON callee_file.id = callee.file_id
       WHERE e.type = 'CALLS'
         AND caller.name = 'barrelLookup'
         AND caller_file.path = 'src/services/barrel-login.ts'
         AND callee_file.path = 'src/repositories/user-repository.ts'
       ORDER BY callee.name`,
    ).map(([name]) => String(name));

    expect(barrelCalls).toEqual(['findUserByEmail']);
  });

  it('resolves aliased barrel re-exports when building CALLS edges', async () => {
    writeFileSync(
      join(tempRoot, 'src/services/token-barrel.ts'),
      [
        "export { issueTokens as createTokens } from './token-service.js';",
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(tempRoot, 'src/services/alias-barrel-login.ts'),
      [
        "import { createTokens } from './token-barrel.js';",
        '',
        'export async function aliasBarrelLogin(userId: string, email: string) {',
        '  return createTokens({ userId, email });',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    await indexFixture(tempRoot);

    const aliasBarrelCalls = queryRows(
      `SELECT callee.name
       FROM edges e
       JOIN symbols caller ON caller.id = e.from_id
       JOIN symbols callee ON callee.id = e.to_id
       JOIN files caller_file ON caller_file.id = caller.file_id
       JOIN files callee_file ON callee_file.id = callee.file_id
       WHERE e.type = 'CALLS'
         AND caller.name = 'aliasBarrelLogin'
         AND caller_file.path = 'src/services/alias-barrel-login.ts'
         AND callee_file.path = 'src/services/token-service.ts'
       ORDER BY callee.name`,
    ).map(([name]) => String(name));

    expect(aliasBarrelCalls).toEqual(['issueTokens']);
  });

  it('resolves namespace barrel re-exports when building CALLS edges', async () => {
    writeFileSync(
      join(tempRoot, 'src/services/user-api-barrel.ts'),
      [
        "export * as userApi from '../repositories/user-repository.js';",
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(tempRoot, 'src/services/namespace-barrel-login.ts'),
      [
        "import { userApi } from './user-api-barrel.js';",
        '',
        'export async function namespaceBarrelLookup(email: string) {',
        '  return userApi.findUserByEmail(email);',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    await indexFixture(tempRoot);

    const namespaceBarrelCalls = queryRows(
      `SELECT callee.name
       FROM edges e
       JOIN symbols caller ON caller.id = e.from_id
       JOIN symbols callee ON callee.id = e.to_id
       JOIN files caller_file ON caller_file.id = caller.file_id
       JOIN files callee_file ON callee_file.id = callee.file_id
       WHERE e.type = 'CALLS'
         AND caller.name = 'namespaceBarrelLookup'
         AND caller_file.path = 'src/services/namespace-barrel-login.ts'
         AND callee_file.path = 'src/repositories/user-repository.ts'
       ORDER BY callee.name`,
    ).map(([name]) => String(name));

    expect(namespaceBarrelCalls).toEqual(['findUserByEmail']);
  });

  it('rejects vector-only search when no vector provider is available', async () => {
    await indexFixture(tempRoot);

    const db = getDatabaseSync();
    const search = new HybridSearchEngine(db);

    await expect(search.search({
      query: 'login',
      searchMode: 'vector',
    })).rejects.toThrow('configure an embedding provider');
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

  it('full re-index removes stale files, symbols, and chunks', async () => {
    await indexFixture(tempRoot);

    const manager = new IndexManager(tempRoot, createConfig(tempRoot));
    writeFileSync(
      join(tempRoot, 'src/services/AuthService.ts'),
      [
        'export class AuthService {',
        '  async logout(userId: string): Promise<void> {',
        '    console.error(userId);',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
    rmSync(join(tempRoot, 'src/services/token-service.ts'), { force: true });

    await manager.fullIndex();

    const staleLoginSymbols = queryRows(
      `SELECT s.name
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE s.name = 'login'
         AND f.path = 'src/services/AuthService.ts'`,
    );
    expect(staleLoginSymbols).toHaveLength(0);

    const staleLoginChunks = queryRows(
      `SELECT c.id
       FROM chunks c
       JOIN symbols s ON s.id = c.symbol_id
       JOIN files f ON f.id = c.file_id
       WHERE s.name = 'login'
         AND f.path = 'src/services/AuthService.ts'`,
    );
    expect(staleLoginChunks).toHaveLength(0);

    const staleDeletedFile = queryRows(
      `SELECT path FROM files WHERE path = 'src/services/token-service.ts'`,
    );
    expect(staleDeletedFile).toHaveLength(0);
  });

  it('keeps incremental run stats separate from current index totals', async () => {
    await indexFixture(tempRoot);

    writeFileSync(
      join(tempRoot, 'src/services/incremental-service.ts'),
      [
        'export function incrementalProbe() {',
        "  return 'indexed';",
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    const manager = new IndexManager(tempRoot, createConfig(tempRoot));
    const status = await manager.incrementalIndex();

    const fileCount = Number(queryRows('SELECT COUNT(*) FROM files')[0][0]);
    const symbolCount = Number(queryRows('SELECT COUNT(*) FROM symbols')[0][0]);
    const edgeCount = Number(queryRows('SELECT COUNT(*) FROM edges')[0][0]);
    const chunkCount = Number(queryRows('SELECT COUNT(*) FROM chunks')[0][0]);
    const metadata = new Map(
      queryRows('SELECT key, value FROM index_metadata').map(([key, value]) => [
        String(key),
        String(value),
      ]),
    );

    expect(status.indexedFiles).toBe(fileCount);
    expect(status.totalSymbols).toBe(symbolCount);
    expect(status.totalEdges).toBe(edgeCount);
    expect(status.totalChunks).toBe(chunkCount);
    expect(Number(metadata.get('indexed_files'))).toBe(fileCount);
    expect(Number(metadata.get('total_symbols'))).toBe(symbolCount);
    expect(Number(metadata.get('total_edges'))).toBe(edgeCount);
    expect(Number(metadata.get('total_chunks'))).toBe(chunkCount);
    expect(metadata.get('last_index_mode')).toBe('incremental');
    expect(Number(metadata.get('last_run_indexed_files'))).toBe(1);
    expect(Number(metadata.get('last_run_symbols'))).toBe(1);
    expect(Number(metadata.get('last_run_chunks'))).toBe(1);
    expect(Number(metadata.get('last_run_edges'))).toBe(edgeCount);
  });
});
