import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCli } from '../src/cli/cli.js';

describe('CLI doctor command', () => {
  let tempRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-doctor-'));
    mkdirSync(join(tempRoot, '.code-memory'), { recursive: true });
    writeFileSync(
      join(tempRoot, '.code-memory', 'config.json'),
      JSON.stringify({
        projectName: 'doctor-sample',
        languages: ['typescript', 'javascript'],
        embedding: {
          provider: 'none',
          model: 'none',
        },
      }, null, 2),
      'utf-8',
    );
    process.chdir(tempRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('reports embedding and vector-search status honestly', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createCli();
    program.exitOverride();

    await program.parseAsync(['node', 'code-memory', 'doctor', '--json']);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    const result = JSON.parse(output) as {
      checks: Array<{ name: string; status: string; message: string }>;
    };

    expect(result.checks).toContainEqual({
      name: 'embedding',
      status: 'ok',
      message: 'Embedding provider: none (none).',
    });
    expect(result.checks).toContainEqual({
      name: 'vector-search',
      status: 'warn',
      message: 'Vector search is disabled because embedding provider is none; hybrid search is keyword + graph only.',
    });
  });

  it('accepts config files with a UTF-8 BOM', async () => {
    writeFileSync(
      join(tempRoot, '.code-memory', 'config.json'),
      '\uFEFF\uFEFF' + JSON.stringify({
        projectName: 'doctor-sample',
        languages: ['typescript', 'javascript'],
        embedding: {
          provider: 'none',
          model: 'none',
        },
      }, null, 2),
      'utf-8',
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createCli();
    program.exitOverride();

    await program.parseAsync(['node', 'code-memory', 'doctor', '--json']);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    const result = JSON.parse(output) as {
      checks: Array<{ name: string; status: string; message: string }>;
    };

    expect(result.checks.some((check) => check.name === 'config-json')).toBe(false);
    expect(result.checks).toContainEqual({
      name: 'embedding',
      status: 'ok',
      message: 'Embedding provider: none (none).',
    });
  });
});
