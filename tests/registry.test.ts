import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findRepo,
  readRegistry,
  registerRepo,
  unregisterRepo,
} from '../src/cli/registry.js';
import { createCli } from '../src/cli/cli.js';

describe('global registry', () => {
  let tempRoot: string;
  let homeDir: string;
  let originalGlobalHome: string | undefined;

  beforeEach(() => {
    originalGlobalHome = process.env.CODE_MEMORY_GLOBAL_HOME;
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-registry-'));
    homeDir = join(tempRoot, 'home');
    process.env.CODE_MEMORY_GLOBAL_HOME = homeDir;
  });

  afterEach(() => {
    if (originalGlobalHome === undefined) {
      delete process.env.CODE_MEMORY_GLOBAL_HOME;
    } else {
      process.env.CODE_MEMORY_GLOBAL_HOME = originalGlobalHome;
    }
    vi.restoreAllMocks();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('registers, finds, and unregisters repositories without duplicates', () => {
    const repoPath = join(tempRoot, 'repo');

    registerRepo(repoPath, 'app', { homeDir });
    registerRepo(repoPath, 'app', { homeDir });

    expect(readRegistry({ homeDir }).repos).toHaveLength(1);
    expect(findRepo('app', { homeDir })?.rootPath).toBe(repoPath);
    expect(unregisterRepo('app', { homeDir })).toBe(1);
    expect(readRegistry({ homeDir }).repos).toHaveLength(0);
  });

  it('register dry-run reports the resolved entry without writing registry.json', async () => {
    const repoPath = join(tempRoot, 'repo');

    const output = await readCliJson(['register', repoPath, '--name', 'app', '--dry-run']) as {
      dryRun: boolean;
      registryPath: string;
      entry: {
        name: string;
        rootPath: string;
      };
    };

    expect(output.dryRun).toBe(true);
    expect(output.registryPath).toBe(resolve(homeDir, 'registry.json'));
    expect(output.entry).toEqual({
      name: 'app',
      rootPath: resolve(repoPath),
    });
    expect(existsSync(resolve(homeDir, 'registry.json'))).toBe(false);
  });

  it('list dry-run reports registry path and entries without changing the registry', async () => {
    const repoPath = join(tempRoot, 'repo');
    registerRepo(repoPath, 'app', { homeDir });
    const before = readRegistry({ homeDir });

    const output = await readCliJson(['list', '--dry-run']) as {
      dryRun: boolean;
      registryPath: string;
      registry: {
        repos: Array<{ name: string; rootPath: string }>;
      };
    };

    expect(output.dryRun).toBe(true);
    expect(output.registryPath).toBe(resolve(homeDir, 'registry.json'));
    expect(output.registry.repos).toEqual(before.repos);
    expect(readRegistry({ homeDir })).toEqual(before);
  });

  it('CLI register is idempotent and unregister dry-run does not remove entries', async () => {
    const repoPath = join(tempRoot, 'repo');

    await runCli(['register', repoPath, '--name', 'app']);
    await runCli(['register', repoPath, '--name', 'app']);
    expect(readRegistry({ homeDir }).repos).toHaveLength(1);

    const preview = await readCliJson(['unregister', 'app', '--dry-run']) as {
      dryRun: boolean;
      match: { name: string; rootPath: string } | null;
    };
    expect(preview.dryRun).toBe(true);
    expect(preview.match?.name).toBe('app');
    expect(preview.match?.rootPath).toBe(resolve(repoPath));
    expect(readRegistry({ homeDir }).repos).toHaveLength(1);
  });
});

async function runCli(args: string[]): Promise<string> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const program = createCli();
    program.exitOverride();
    await program.parseAsync(['node', 'code-memory', ...args]);
    return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
  } finally {
    logSpy.mockRestore();
  }
}

async function readCliJson(args: string[]): Promise<unknown> {
  return JSON.parse(await runCli(args)) as unknown;
}
