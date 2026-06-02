import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { DEFAULT_TOKEN_BUDGETS, type CodeMemoryConfig } from '../src/shared/types.js';

const fixtureRoot = resolve('tests/fixtures/sample-ts-project');
const cliPath = resolve('dist/index.js');

function writeConfig(rootPath: string): void {
  const config: CodeMemoryConfig = {
    projectName: 'worker-parity',
    rootPath,
    ignore: [...DEFAULT_IGNORE_PATTERNS],
    languages: ['typescript', 'javascript'],
    indexing: {
      workers: 'auto',
      parseBatchSize: 100,
      edgeMode: 'full',
    },
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
  mkdirSync(join(rootPath, '.code-memory'), { recursive: true });
  writeFileSync(join(rootPath, '.code-memory', 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

function runCli(cwd: string, args: string[]): string {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function statusJson(cwd: string): {
  files: number;
  symbols: number;
  chunks: number;
  edges: number;
  parseWorkers: number;
} {
  const stdout = runCli(cwd, ['status', '--json']);
  return JSON.parse(stdout.slice(stdout.indexOf('{'))) as {
    files: number;
    symbols: number;
    chunks: number;
    edges: number;
    parseWorkers: number;
  };
}

describe.runIf(existsSync(cliPath))('CLI worker parity', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('produces the same index counts with main-thread parsing and worker parsing', () => {
    const worker0Root = mkdtempSync(join(tmpdir(), 'code-memory-worker0-'));
    const worker2Root = mkdtempSync(join(tmpdir(), 'code-memory-worker2-'));
    roots.push(worker0Root, worker2Root);
    cpSync(fixtureRoot, worker0Root, { recursive: true });
    cpSync(fixtureRoot, worker2Root, { recursive: true });
    writeConfig(worker0Root);
    writeConfig(worker2Root);

    runCli(worker0Root, ['index', '--full', '--workers', '0']);
    runCli(worker2Root, ['index', '--full', '--workers', '2']);

    const worker0 = statusJson(worker0Root);
    const worker2 = statusJson(worker2Root);
    expect(worker0.parseWorkers).toBe(0);
    expect(worker2.parseWorkers).toBe(2);
    expect({
      files: worker2.files,
      symbols: worker2.symbols,
      chunks: worker2.chunks,
      edges: worker2.edges,
    }).toEqual({
      files: worker0.files,
      symbols: worker0.symbols,
      chunks: worker0.chunks,
      edges: worker0.edges,
    });
  }, 30_000);
});
