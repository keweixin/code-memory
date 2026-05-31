import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabase, getDatabaseSync } from '../src/storage/database.js';
import { searchSymbolsFts } from '../src/search/fts-search.js';
import { createCli } from '../src/cli/cli.js';

const fixtureRoot = resolve('tests/fixtures/sample-ts-project');

function createConfig(rootPath: string): CodeMemoryConfig {
  return {
    projectName: 'upgrade-sample',
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

function writeConfig(rootPath: string, config = createConfig(rootPath)): void {
  mkdirSync(join(rootPath, '.code-memory'), { recursive: true });
  writeFileSync(join(rootPath, '.code-memory', 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

function queryRows(sql: string, params: unknown[] = []): unknown[][] {
  const rows = getDatabaseSync().exec(sql, params);
  return rows[0]?.values ?? [];
}

async function indexFixture(rootPath: string): Promise<IndexManager> {
  const config = createConfig(rootPath);
  writeConfig(rootPath, config);
  const manager = new IndexManager(rootPath, config);
  await manager.fullIndex();
  return manager;
}

describe('large-repo storage and graph upgrade contracts', () => {
  let tempRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-upgrade-'));
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('opens a native WAL SQLite database with FTS5 bm25/snippet support', async () => {
    writeConfig(tempRoot);
    await getDatabase(tempRoot);
    const db = getDatabaseSync();

    const journal = db.exec('PRAGMA journal_mode')[0]?.values[0]?.[0];
    expect(String(journal).toLowerCase()).toBe('wal');
    expect(queryRows("SELECT value FROM index_metadata WHERE key = 'schema_version'")[0]?.[0]).toBe('3');

    db.run(
      `INSERT INTO files
        (id, path, language, role, size, hash, indexed_at, exports, imports, search_text)
       VALUES
        ('file:test', 'src/auth.ts', 'typescript', 'source', 1, 'hash', 'now', '[]', '[]', 'src auth')`,
    );
    db.run(
      `INSERT INTO symbols
        (id, file_id, name, kind, start_line, end_line, range_start, range_end, hash, search_text)
       VALUES
        ('sym:test', 'file:test', 'findUserByEmail', 'function', 1, 1, 1, 1, 'hash', 'find user by email')`,
    );

    const fts = db.exec(
      `SELECT bm25(symbols_fts), snippet(symbols_fts, -1, '<<', '>>', '...', 8)
       FROM symbols_fts WHERE symbols_fts MATCH 'find user email'`,
    );
    expect(fts[0]?.values.length).toBe(1);
    expect(String(fts[0].values[0][1])).toContain('<<');
  });

  it('parses each indexed file only once during a full index', async () => {
    cpSync(fixtureRoot, tempRoot, { recursive: true });
    const config = createConfig(tempRoot);
    writeConfig(tempRoot, config);
    const manager = new IndexManager(tempRoot, config);
    const indexFileSpy = vi.spyOn(manager as unknown as { indexFile: () => unknown }, 'indexFile');

    await manager.fullIndex();

    const indexedFiles = Number(queryRows('SELECT COUNT(*) FROM files')[0][0]);
    expect(indexFileSpy.mock.calls.length).toBe(indexedFiles);
  });

  it('rebuilds graph edges from persisted metadata without parsing files again', async () => {
    cpSync(fixtureRoot, tempRoot, { recursive: true });
    const config = createConfig(tempRoot);
    writeConfig(tempRoot, config);
    const manager = new IndexManager(tempRoot, config);
    await manager.fullIndex();

    const indexFileSpy = vi.spyOn(manager as unknown as { indexFile: () => unknown }, 'indexFile');
    getDatabaseSync().run("DELETE FROM edges WHERE type IN ('IMPORTS', 'CALLS', 'REFERENCES', 'TESTS', 'CONFIGURES')");

    const rebuiltEdges = await (manager as unknown as {
      rebuildGraphEdges: (mode: 'full', dirtyFileIds?: string[]) => Promise<number>;
    }).rebuildGraphEdges('full');

    expect(indexFileSpy).not.toHaveBeenCalled();
    expect(rebuiltEdges).toBeGreaterThan(0);
    expect(queryRows('SELECT COUNT(*) FROM call_refs')[0][0]).toBeGreaterThan(0);

    const restoredCalls = queryRows(
      `SELECT ts.name
       FROM edges e
       JOIN symbols ts ON ts.id = e.to_id
       WHERE e.type = 'CALLS' AND ts.name IN ('findUserByEmail', 'verifyPassword', 'issueTokens')`,
    ).map((row) => String(row[0]));
    expect(restoredCalls).toContain('findUserByEmail');
    expect(restoredCalls).toContain('verifyPassword');
    expect(restoredCalls).toContain('issueTokens');

    const dirtyFileId = String(queryRows("SELECT id FROM files WHERE path = 'src/services/AuthService.ts'")[0][0]);
    indexFileSpy.mockClear();
    await (manager as unknown as {
      rebuildGraphEdges: (mode: 'dirty', dirtyFileIds?: string[]) => Promise<number>;
    }).rebuildGraphEdges('dirty', [dirtyFileId]);
    expect(indexFileSpy).not.toHaveBeenCalled();
  });

  it('persists parse metadata and resolves high-confidence receiver calls without global same-name guessing', async () => {
    mkdirSync(join(tempRoot, 'src'), { recursive: true });
    writeFileSync(
      join(tempRoot, 'src', 'services.ts'),
      [
        'export class UserService {',
        '  save(): void {}',
        '  validate(): void {}',
        '  login(): void {',
        '    this.validate();',
        '  }',
        '}',
        'export class OtherService {',
        '  save(): void {}',
        '}',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(tempRoot, 'src', 'run.ts'),
      [
        "import { UserService } from './services.js';",
        'const svc = new UserService();',
        'export function run(obj: any): void {',
        '  svc.save();',
        '  obj.save();',
        '}',
      ].join('\n'),
      'utf-8',
    );
    const config = createConfig(tempRoot);
    writeConfig(tempRoot, config);
    const manager = new IndexManager(tempRoot, config);
    await manager.fullIndex();

    expect(queryRows('SELECT COUNT(*) FROM file_imports')[0][0]).toBeGreaterThan(0);
    expect(queryRows('SELECT COUNT(*) FROM call_refs')[0][0]).toBeGreaterThan(0);
    expect(queryRows('SELECT COUNT(*) FROM scope_bindings WHERE local_name = ?', ['svc'])[0][0]).toBe(1);

    const saveEdges = queryRows(
      `SELECT fs.path, ts.name, e.confidence, e.evidence
       FROM edges e
       JOIN symbols fsym ON fsym.id = e.from_id
       JOIN files fs ON fs.id = fsym.file_id
       JOIN symbols ts ON ts.id = e.to_id
       WHERE e.type = 'CALLS' AND ts.name = 'save'
       ORDER BY e.confidence DESC`,
    );

    expect(saveEdges).toHaveLength(1);
    expect(saveEdges[0][0]).toBe('src/run.ts');
    expect(Number(saveEdges[0][2])).toBeGreaterThanOrEqual(0.8);
    expect(String(saveEdges[0][3])).toContain('svc.save');

    const unresolvedObjSave = queryRows(
      "SELECT resolution_status FROM call_refs WHERE receiver_name = 'obj' AND member_name = 'save'",
    );
    expect(unresolvedObjSave[0]?.[0]).toBe('unresolved');
  });

  it('resolves barrel, alias, and namespace re-exports from structured export metadata', async () => {
    mkdirSync(join(tempRoot, 'src'), { recursive: true });
    writeFileSync(
      join(tempRoot, 'src', 'auth-core.ts'),
      [
        'export function issueTokens(): string {',
        "  return 'token';",
        '}',
        'export function revokeTokens(): void {}',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(tempRoot, 'src', 'barrel.ts'),
      [
        "export { issueTokens as mintTokens } from './auth-core.js';",
        "export * as authNS from './auth-core.js';",
        "export * from './auth-core.js';",
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(tempRoot, 'src', 'use.ts'),
      [
        "import { mintTokens, authNS, revokeTokens } from './barrel.js';",
        'export function run(): void {',
        '  mintTokens();',
        '  authNS.issueTokens();',
        '  revokeTokens();',
        '}',
      ].join('\n'),
      'utf-8',
    );
    const config = createConfig(tempRoot);
    writeConfig(tempRoot, config);
    const manager = new IndexManager(tempRoot, config);
    await manager.fullIndex();

    const barrelId = String(queryRows("SELECT id FROM files WHERE path = 'src/barrel.ts'")[0][0]);
    expect(queryRows("SELECT COUNT(*) FROM file_exports WHERE file_id = ? AND kind = 'reexport_alias'", [barrelId])[0][0]).toBe(1);
    expect(queryRows("SELECT COUNT(*) FROM file_exports WHERE file_id = ? AND kind = 'reexport_namespace'", [barrelId])[0][0]).toBe(1);

    getDatabaseSync().run(
      'UPDATE files SET exports = ? WHERE id = ?',
      [JSON.stringify(['reexportAlias:{malformed-json', 'reexportNamespace:{malformed-json}']), barrelId],
    );
    getDatabaseSync().run("DELETE FROM edges WHERE type IN ('IMPORTS', 'CALLS', 'REFERENCES', 'TESTS', 'CONFIGURES')");

    const indexFileSpy = vi.spyOn(manager as unknown as { indexFile: () => unknown }, 'indexFile');
    await (manager as unknown as {
      rebuildGraphEdges: (mode: 'full', dirtyFileIds?: string[]) => Promise<number>;
    }).rebuildGraphEdges('full');

    expect(indexFileSpy).not.toHaveBeenCalled();
    const callTargets = queryRows(
      `SELECT ts.name, e.evidence
       FROM edges e
       JOIN symbols ts ON ts.id = e.to_id
       WHERE e.type = 'CALLS'
       ORDER BY e.evidence`,
    ).map((row) => `${String(row[0])}:${String(row[1])}`);

    expect(callTargets.some((entry) => entry.includes('issueTokens:authNS.issueTokens'))).toBe(true);
    expect(callTargets.some((entry) => entry.includes('revokeTokens:revokeTokens'))).toBe(true);
    const resolvedReexportCalls = queryRows(
      `SELECT evidence, resolution_status
       FROM call_refs
       WHERE evidence IN ('mintTokens()', 'authNS.issueTokens()', 'revokeTokens()')
       ORDER BY evidence`,
    );
    expect(resolvedReexportCalls).toEqual([
      ['authNS.issueTokens()', 'resolved'],
      ['mintTokens()', 'resolved'],
      ['revokeTokens()', 'resolved'],
    ]);

    const dirty = (manager as unknown as {
      expandDirtyFileSet: (fileIds: string[]) => string[];
    }).expandDirtyFileSet([String(queryRows("SELECT id FROM files WHERE path = 'src/auth-core.ts'")[0][0])]);
    expect(dirty).toContain(barrelId);
  });

  it('matches camelCase symbols through normalized FTS5 search text', async () => {
    cpSync(fixtureRoot, tempRoot, { recursive: true });
    await indexFixture(tempRoot);

    const results = searchSymbolsFts(getDatabaseSync(), {
      query: 'find user email',
      limit: 5,
    });

    expect(results.some((result) => result.name === 'findUserByEmail')).toBe(true);
  });

  it('prints schema and runtime indexing metadata in status json', async () => {
    cpSync(fixtureRoot, tempRoot, { recursive: true });
    const config = createConfig(tempRoot);
    writeConfig(tempRoot, config);
    process.chdir(tempRoot);

    const program = createCli();
    program.exitOverride();
    await program.parseAsync(['node', 'code-memory', 'index', '--full', '--workers', '0']);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const statusProgram = createCli();
    statusProgram.exitOverride();
    await statusProgram.parseAsync(['node', 'code-memory', 'status', '--json']);

    const status = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join('\n')) as {
      schemaVersion: number;
      needsReindex: boolean;
      lastIndexDurationMs: number;
      parseWorkers: number;
      dirtyFiles: number;
      unresolvedCalls: number;
    };

    expect(status.schemaVersion).toBe(3);
    expect(status.needsReindex).toBe(false);
    expect(status.lastIndexDurationMs).toBeGreaterThan(0);
    expect(status.parseWorkers).toBe(0);
    expect(status.dirtyFiles).toBeGreaterThanOrEqual(0);
    expect(status.unresolvedCalls).toBeGreaterThanOrEqual(0);
  });
});
