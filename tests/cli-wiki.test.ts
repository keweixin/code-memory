import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createCli } from '../src/cli/cli.js';
import { CONFIG_DIR, DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { DEFAULT_TOKEN_BUDGETS, type CodeMemoryConfig } from '../src/shared/types.js';
import { closeDatabase, getDatabase, getDatabaseSync } from '../src/storage/database.js';
import { buildWikiJson, runWiki } from '../src/cli/commands/wiki.js';

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

function setupProjectFromFixture(tempRoot: string): void {
  cpSync(fixtureRoot, tempRoot, { recursive: true });
  mkdirSync(join(tempRoot, CONFIG_DIR), { recursive: true });
  writeFileSync(
    join(tempRoot, CONFIG_DIR, 'config.json'),
    JSON.stringify(createConfig(tempRoot), null, 2),
    'utf-8',
  );
}

describe('CLI wiki command', () => {
  let tempRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-wiki-cli-'));
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('writes wiki.json with all five top-level sections after a full index', async () => {
    setupProjectFromFixture(tempRoot);
    process.chdir(tempRoot);

    const indexProgram = createCli();
    indexProgram.exitOverride();
    await indexProgram.parseAsync(['node', 'code-memory', 'index', '--full']);

    const wikiProgram = createCli();
    wikiProgram.exitOverride();
    await wikiProgram.parseAsync(['node', 'code-memory', 'wiki']);

    const wikiPath = join(tempRoot, CONFIG_DIR, 'wiki.json');
    expect(existsSync(wikiPath)).toBe(true);
    const wiki = JSON.parse(readFileSync(wikiPath, 'utf-8')) as Record<string, unknown>;

    expect(Object.keys(wiki).sort()).toEqual([
      'communities',
      'externalDependencies',
      'processes',
      'project',
      'routes',
    ]);

    const project = wiki.project as Record<string, unknown>;
    expect(typeof project.name).toBe('string');
    expect(typeof project.primaryLanguage).toBe('string');
    expect(typeof project.totalNodes).toBe('number');
    expect(typeof project.totalEdges).toBe('number');
  });

  it('builds an empty wiki structure for a freshly-initialized project with no data', async () => {
    setupProjectFromFixture(tempRoot);
    process.chdir(tempRoot);
    await getDatabase(tempRoot);
    await closeDatabase();

    // Re-open without re-running migrations to read the empty schema.
    await getDatabase(tempRoot);
    try {
      const wiki = await buildWikiJson(getDatabaseSync(), tempRoot);

      expect(wiki.communities).toEqual([]);
      expect(wiki.processes).toEqual([]);
      expect(wiki.routes).toEqual([]);
      expect(wiki.externalDependencies).toEqual([]);
      expect(wiki.project.name).toBe('sample-ts-project');
      expect(wiki.project.totalNodes).toBe(0);
      expect(wiki.project.totalEdges).toBe(0);
      expect(wiki.project.primaryLanguage).toBe('unknown');
    } finally {
      await closeDatabase();
    }
  });

  it('exits with a non-zero code when the index is marked stale', async () => {
    setupProjectFromFixture(tempRoot);
    process.chdir(tempRoot);

    // Create the database so the existsSync check passes, then mark it stale.
    const indexProgram = createCli();
    indexProgram.exitOverride();
    await indexProgram.parseAsync(['node', 'code-memory', 'index', '--full']);
    getDatabaseSync().run(
      `INSERT OR REPLACE INTO index_metadata (key, value) VALUES ('needs_reindex', 'true')`,
    );
    await closeDatabase();

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error('process.exit ' + String(code));
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runWiki()).rejects.toThrow(/process\.exit 1/);

    const errorOutput = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorOutput).toContain('Index is stale');
    expect(errorOutput).toContain('code-memory index');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with a non-zero code when no index exists at the target path', async () => {
    // tempRoot has no .code-memory directory at all.
    process.chdir(tempRoot);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error('process.exit ' + String(code));
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runWiki()).rejects.toThrow(/process\.exit 1/);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorOutput = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorOutput.toLowerCase()).toContain('no code-memory index found');
  });

  it('produces a non-empty summary from package.json description', async () => {
    setupProjectFromFixture(tempRoot);
    // Add a description field to package.json
    const pkgPath = join(tempRoot, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
    pkg.description = 'A sample TypeScript project for testing';
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8');

    process.chdir(tempRoot);
    const indexProgram = createCli();
    indexProgram.exitOverride();
    await indexProgram.parseAsync(['node', 'code-memory', 'index', '--full']);

    const wiki = await buildWikiJson(getDatabaseSync(), tempRoot);
    expect(wiki.project.summary).toBeTruthy();
    expect(wiki.project.summary).toBe('A sample TypeScript project for testing');
  });

  it('exits with an error for path traversal attempts', async () => {
    process.chdir(tempRoot);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error('process.exit ' + String(code));
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runWiki('../etc')).rejects.toThrow(/process\.exit 1/);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorOutput = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorOutput).toBeTruthy();
  });

  it('preserves colons in symbol names within process steps', async () => {
    setupProjectFromFixture(tempRoot);
    process.chdir(tempRoot);

    const indexProgram = createCli();
    indexProgram.exitOverride();
    await indexProgram.parseAsync(['node', 'code-memory', 'index', '--full']);

    const db = getDatabaseSync();

    // Insert a file record
    db.run(
      `INSERT OR REPLACE INTO files (id, path, language, role, size, hash, indexed_at, is_generated, is_ignored, exports, imports, search_text)
       VALUES ('file-colon-test', 'src/iterator.ts', 'typescript', 'source', 100, '', '', 0, 0, '[]', '[]', '')`,
    );

    // Insert a symbol with a colon in the name
    db.run(
      `INSERT OR REPLACE INTO symbols (id, file_id, name, kind, start_byte, end_byte, start_line, end_line, start_column, end_column, range_start, range_end, hash, search_text)
       VALUES ('sym-iterator', 'file-colon-test', 'Symbol.iterator', 'function', 0, 50, 1, 3, 0, 20, 0, 50, '', '')`,
    );

    // Insert a process
    db.run(
      `INSERT OR REPLACE INTO processes (id, name, entry_point, entry_kind, step_count, created_at)
       VALUES ('proc-iterator', 'Iterator Process', 'src/iterator.ts', 'route', 1, '')`,
    );

    // Insert a process step referencing the symbol
    db.run(
      `INSERT OR REPLACE INTO process_steps (id, process_id, step, symbol_id, file_id, label)
       VALUES ('step-1', 'proc-iterator', 1, 'sym-iterator', 'file-colon-test', NULL)`,
    );

    const wiki = await buildWikiJson(db, tempRoot);
    const iteratorProcess = wiki.processes.find((p) => p.name === 'Iterator Process');
    expect(iteratorProcess).toBeDefined();
    expect(iteratorProcess!.steps).toHaveLength(1);
    expect(iteratorProcess!.steps[0]!.name).toBe('Symbol.iterator');
  });
});
