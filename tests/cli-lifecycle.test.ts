import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCli } from '../src/cli/cli.js';
import { readRegistry } from '../src/cli/registry.js';
import { closeDatabase } from '../src/storage/database.js';
import { readWatchState, writeWatchState } from '../src/indexer/watch-state.js';

describe('CLI lifecycle commands', () => {
  let tempRoot: string;
  let projectRoot: string;
  let homeDir: string;
  let originalCwd: string;
  let originalHome: string | undefined;
  let originalGlobalHome: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalHome = process.env.CODE_MEMORY_HOME;
    originalGlobalHome = process.env.CODE_MEMORY_GLOBAL_HOME;
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-lifecycle-'));
    projectRoot = join(tempRoot, 'sample-project');
    homeDir = join(tempRoot, 'home');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      join(projectRoot, 'src', 'index.ts'),
      [
        'export function greet(name: string): string {',
        '  return `hello ${name}`;',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
    process.env.CODE_MEMORY_HOME = homeDir;
    process.env.CODE_MEMORY_GLOBAL_HOME = homeDir;
    process.chdir(tempRoot);
  });

  afterEach(async () => {
    await closeDatabase();
    process.chdir(originalCwd);
    if (originalHome === undefined) {
      delete process.env.CODE_MEMORY_HOME;
    } else {
      process.env.CODE_MEMORY_HOME = originalHome;
    }
    if (originalGlobalHome === undefined) {
      delete process.env.CODE_MEMORY_GLOBAL_HOME;
    } else {
      process.env.CODE_MEMORY_GLOBAL_HOME = originalGlobalHome;
    }
    vi.restoreAllMocks();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('repair --project bootstraps and registers the project', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createCli();
    program.exitOverride();

    await program.parseAsync(['node', 'code-memory', 'repair', '--project', projectRoot, '--json']);

    const result = lastJsonLog<{
      projectPath: string;
      status: string;
      actions: string[];
    }>(logSpy);
    expect(result).toEqual(expect.objectContaining({
      projectPath: projectRoot,
      status: 'ok',
    }));
    expect(result.actions).toEqual(expect.arrayContaining([
      'Bootstrapped project index.',
      'Registered repo: sample-project -> ' + projectRoot,
    ]));
    expect(existsSync(join(projectRoot, '.code-memory', 'index.db'))).toBe(true);
    expect(readRegistry().repos).toContainEqual(expect.objectContaining({
      name: 'sample-project',
      rootPath: projectRoot,
    }));
  });

  it('upgrade --project bootstraps missing storage and reports schema status', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createCli();
    program.exitOverride();

    await program.parseAsync(['node', 'code-memory', 'upgrade', '--project', projectRoot, '--json']);

    const result = lastJsonLog<{
      projectPath: string;
      status: string;
      actions: string[];
      needsReindex: boolean;
    }>(logSpy);
    expect(result.projectPath).toBe(projectRoot);
    expect(result.status).toMatch(/^(ok|warn)$/);
    expect(typeof result.needsReindex).toBe('boolean');
    expect(result.actions).toContain('Opened database and applied available schema migrations.');
    expect(existsSync(join(projectRoot, '.code-memory', 'index.db'))).toBe(true);
  });

  it('clean --project syncs storage and clears inactive watch state', async () => {
    writeWatchState(projectRoot, {
      active: true,
      pid: 12345,
      startedAt: '2026-01-01T00:00:00.000Z',
      pendingFiles: ['src/index.ts'],
      syncing: true,
      lastSyncAt: null,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createCli();
    program.exitOverride();

    await program.parseAsync(['node', 'code-memory', 'clean', '--project', projectRoot, '--json']);

    const result = lastJsonLog<{
      projectPath: string;
      status: string;
      actions: string[];
    }>(logSpy);
    expect(result).toEqual(expect.objectContaining({
      projectPath: projectRoot,
      status: 'ok',
    }));
    expect(result.actions).toEqual(expect.arrayContaining([
      'Bootstrapped missing index before cleanup.',
      'Cleared inactive watch state.',
      'Vacuumed SQLite database.',
    ]));
    const watchState = readWatchState(projectRoot);
    expect(watchState).toMatchObject({
      active: false,
      pid: null,
      pendingFiles: [],
      syncing: false,
    });
    expect(existsSync(join(projectRoot, '.code-memory', 'index.db'))).toBe(true);
  });
});

function lastJsonLog<T>(logSpy: ReturnType<typeof vi.spyOn<typeof console, 'log'>>): T {
  const text = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
  return JSON.parse(text) as T;
}
