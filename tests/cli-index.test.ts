import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createCli } from '../src/cli/cli.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { DEFAULT_TOKEN_BUDGETS, type CodeMemoryConfig } from '../src/shared/types.js';
import { closeDatabase } from '../src/storage/database.js';

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

describe('CLI index command', () => {
  let tempRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-index-cli-'));
    cpSync(fixtureRoot, tempRoot, { recursive: true });
    mkdirSync(join(tempRoot, '.code-memory'), { recursive: true });
    writeFileSync(
      join(tempRoot, '.code-memory', 'config.json'),
      '\uFEFF' + JSON.stringify(createConfig(tempRoot), null, 2),
      'utf-8',
    );
    process.chdir(tempRoot);
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error('process.exit ' + code);
    });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('indexes projects whose config file starts with a UTF-8 BOM', async () => {
    const program = createCli();
    program.exitOverride();

    await program.parseAsync(['node', 'code-memory', 'index', '--full']);

    expect(existsSync(join(tempRoot, '.code-memory', 'index.db'))).toBe(true);
  });

  it('reports project identity and retrieval capabilities in status json', async () => {
    const program = createCli();
    program.exitOverride();
    await program.parseAsync(['node', 'code-memory', 'index', '--full']);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const statusProgram = createCli();
    statusProgram.exitOverride();

    await statusProgram.parseAsync(['node', 'code-memory', 'status', '--json']);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    const status = JSON.parse(output) as {
      project: string;
      rootPath: string;
      languages: string[];
      embeddingProvider: string;
      embeddingModel: string;
      vectorSearch: string;
      files: number;
      symbols: number;
      chunks: number;
    };

    expect(status.project).toBe('sample-ts-project');
    expect(status.rootPath).toBe(tempRoot);
    expect(status.languages).toEqual(['typescript', 'javascript']);
    expect(status.embeddingProvider).toBe('none');
    expect(status.embeddingModel).toBe('none');
    expect(status.vectorSearch).toBe('disabled');
    expect(status.files).toBeGreaterThanOrEqual(14);
    expect(status.symbols).toBeGreaterThan(0);
    expect(status.chunks).toBeGreaterThan(0);
  });
});
