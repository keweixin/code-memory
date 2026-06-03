import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadServeConfig, ServeCommandError, startServer } from '../src/cli/commands/serve.js';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';

function createConfig(rootPath: string): CodeMemoryConfig {
  return {
    projectName: 'serve-sample',
    rootPath,
    ignore: [...DEFAULT_IGNORE_PATTERNS],
    languages: ['typescript', 'javascript'],
    embedding: {
      provider: 'none',
      model: 'none',
    },
    llm: null,
    realtime: {
      watch: true,
      debounceMs: 80,
    },
    tokenBudgets: { ...DEFAULT_TOKEN_BUDGETS },
  };
}

describe('CLI serve command', () => {
  let tempRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-serve-'));
    process.chdir(tempRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('classifies a missing config separately from runtime startup failures', () => {
    expect(() => loadServeConfig(tempRoot)).toThrowError(ServeCommandError);
    try {
      loadServeConfig(tempRoot);
    } catch (err) {
      expect(err).toMatchObject({
        code: 'CONFIG_MISSING',
        message: 'Missing config. Run "code-memory setup --project ." for full AI onboarding, or omit --no-bootstrap so serve can initialize automatically.',
      });
    }
  });

  it('classifies invalid config JSON', () => {
    mkdirSync(join(tempRoot, '.code-memory'), { recursive: true });
    writeFileSync(join(tempRoot, '.code-memory', 'config.json'), '{ bad json', 'utf-8');

    try {
      loadServeConfig(tempRoot);
    } catch (err) {
      expect(err).toBeInstanceOf(ServeCommandError);
      expect(err).toMatchObject({ code: 'CONFIG_INVALID_JSON' });
      expect(String((err as Error).message)).toContain('Config JSON is invalid');
    }
  });

  it('classifies nested-invalid config schema before startup', () => {
    mkdirSync(join(tempRoot, '.code-memory'), { recursive: true });
    writeFileSync(
      join(tempRoot, '.code-memory', 'config.json'),
      JSON.stringify({
        ...createConfig(tempRoot),
        embedding: {},
        realtime: {},
        tokenBudgets: {},
      }),
      'utf-8',
    );

    expect(() => loadServeConfig(tempRoot)).toThrowError(ServeCommandError);
    try {
      loadServeConfig(tempRoot);
    } catch (err) {
      expect(err).toMatchObject({ code: 'CONFIG_INVALID_SCHEMA' });
    }
  });

  it('classifies watcher startup failures without relabeling them as missing config', async () => {
    mkdirSync(join(tempRoot, '.code-memory'), { recursive: true });
    writeFileSync(
      join(tempRoot, '.code-memory', 'config.json'),
      JSON.stringify(createConfig(tempRoot), null, 2),
      'utf-8',
    );

    await expect(startServer(
      { watch: true, bootstrap: false },
      {
        startIndexWatcher: () => {
          throw new Error('watch backend unavailable');
        },
        startMcpServer: async () => {},
      },
    )).rejects.toMatchObject({
      code: 'WATCH_START_FAILED',
      message: 'Failed to start the index watcher.',
    });
  });

  it('auto-bootstraps before loading config when serve --watch starts cold', async () => {
    await expect(startServer(
      { watch: true },
      {
        bootstrapProject: async ({ project }) => {
          mkdirSync(join(project, '.code-memory'), { recursive: true });
          writeFileSync(
            join(project, '.code-memory', 'config.json'),
            JSON.stringify(createConfig(project), null, 2),
            'utf-8',
          );
        },
        startIndexWatcher: () => {},
        startMcpServer: async () => {},
      },
    )).resolves.toBeUndefined();

    expect(existsSync(join(tempRoot, '.code-memory', 'config.json'))).toBe(true);
  });

  it('keeps --no-bootstrap strict for cold serve startup', async () => {
    await expect(startServer(
      { watch: true, bootstrap: false },
      {
        bootstrapProject: async () => {
          throw new Error('should not bootstrap');
        },
        startMcpServer: async () => {},
      },
    )).rejects.toMatchObject({
      code: 'CONFIG_MISSING',
      message: 'Missing config. Run "code-memory setup --project ." for full AI onboarding, or omit --no-bootstrap so serve can initialize automatically.',
    });
  });

  it('rejects --no-mcp as an unsupported transport', async () => {
    await expect(startServer({ mcp: false })).rejects.toMatchObject({
      code: 'UNSUPPORTED_TRANSPORT',
      message: '--no-mcp is not supported yet. code-memory serve currently supports MCP stdio only.',
    });
  });

  it('keeps exported MCP lifecycle free of direct process.exit calls', () => {
    const serverSource = readFileSync(join(originalCwd, 'src/mcp/server.ts'), 'utf-8');
    expect(serverSource).not.toContain('process.exit(');
  });
});
