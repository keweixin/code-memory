import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase } from '../src/storage/database.js';
import { runMcpToolFromCli } from '../src/cli/commands/tool.js';

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

describe('CLI MCP tool mirror', () => {
  let tempRoot: string;
  let originalGlobalHome: string | undefined;

  beforeEach(async () => {
    originalGlobalHome = process.env.CODE_MEMORY_GLOBAL_HOME;
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-cli-tool-'));
    process.env.CODE_MEMORY_GLOBAL_HOME = join(tempRoot, 'global-home');
    cpSync(fixtureRoot, tempRoot, { recursive: true });
    await indexFixture(tempRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeDatabase();
    if (originalGlobalHome === undefined) {
      delete process.env.CODE_MEMORY_GLOBAL_HOME;
    } else {
      process.env.CODE_MEMORY_GLOBAL_HOME = originalGlobalHome;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('lists mirrored MCP tools', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runMcpToolFromCli(undefined, {
      project: tempRoot,
      list: true,
    });

    const output = logSpy.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).toContain('plan_context');
    expect(output).toContain('search_symbols');
    expect(output).toContain('impact_analysis');
    expect(output).toContain('mark_context_used');
    expect(output).toContain('before sending more context');
    expect(output).toContain('bootstrap_project');
    expect(output).toContain('sync_project');
    expect(output).toContain('register_project');
    expect(output.match(/resolve_project\t/g)).toHaveLength(1);
    expect(output.match(/resolve_project\t.*WHEN TO USE/g)).toHaveLength(1);
  });

  it('runs an MCP tool handler through the CLI mirror', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runMcpToolFromCli('search_symbols', {
      project: tempRoot,
      args: JSON.stringify({ query: 'AuthService', limit: 2 }),
    });

    const output = logSpy.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).toContain('Symbol search for: "AuthService"');
    expect(output).toContain('AuthService');
    expect(output).toContain('[Next:');
  });

  it('runs resolve_project for a missing project without requiring an index first', async () => {
    const missingRoot = mkdtempSync(join(tmpdir(), 'code-memory-cli-tool-missing-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await runMcpToolFromCli('resolve_project', {
        project: missingRoot,
        args: '{}',
      });

      const output = logSpy.mock.calls.map(([line]) => String(line)).join('\n');
      expect(output).toContain('"status": "needs_bootstrap"');
      expect(output).toContain('bootstrap --project');
      expect(output).toContain(missingRoot.replace(/\\/g, '\\\\'));
    } finally {
      rmSync(missingRoot, { recursive: true, force: true });
    }
  });

  it('runs register_project without requiring an index first', async () => {
    const missingRoot = mkdtempSync(join(tmpdir(), 'code-memory-cli-tool-register-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await runMcpToolFromCli('register_project', {
        project: missingRoot,
        args: JSON.stringify({ name: 'cli-tool-register' }),
      });

      const output = logSpy.mock.calls.map(([line]) => String(line)).join('\n');
      expect(output).toContain('register_project complete');
      expect(output).toContain('Registered repo: cli-tool-register ->');
      expect(output).toContain(missingRoot.replace(/\\/g, '\\\\'));
    } finally {
      rmSync(missingRoot, { recursive: true, force: true });
    }
  });
});
