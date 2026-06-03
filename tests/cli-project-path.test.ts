import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCli } from '../src/cli/cli.js';
import { getRegistryPath } from '../src/cli/registry.js';

describe('CLI --project routing', () => {
  let tempRoot: string;
  let projectRoot: string;
  let otherRoot: string;
  let homeDir: string;
  let originalCwd: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalHome = process.env.CODE_MEMORY_HOME;
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-project-path-'));
    projectRoot = join(tempRoot, 'target-project');
    otherRoot = join(tempRoot, 'other-cwd');
    homeDir = join(tempRoot, 'home');
    mkdirSync(join(projectRoot, '.code-memory'), { recursive: true });
    mkdirSync(otherRoot, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      join(projectRoot, '.code-memory', 'config.json'),
      JSON.stringify({
        projectName: 'target-project',
        languages: ['typescript'],
        embedding: { provider: 'none', model: 'none' },
      }, null, 2),
      'utf-8',
    );
    process.env.CODE_MEMORY_HOME = homeDir;
    process.chdir(otherRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) {
      delete process.env.CODE_MEMORY_HOME;
    } else {
      process.env.CODE_MEMORY_HOME = originalHome;
    }
    vi.restoreAllMocks();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('doctor --project inspects the explicit project instead of cwd', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createCli();
    program.exitOverride();

    await program.parseAsync(['node', 'code-memory', 'doctor', '--json', '--project', projectRoot]);

    const result = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join('\n')) as {
      projectPath: string;
      checks: Array<{ name: string; status: string }>;
    };
    expect(result.projectPath).toBe(projectRoot);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'config',
      status: 'ok',
    }));
  });

  it('status --project reports the explicit project path when cwd differs', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createCli();
    program.exitOverride();

    await program.parseAsync(['node', 'code-memory', 'status', '--project', projectRoot]);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('No index found');
    expect(output).not.toContain(otherRoot);
  });

  it('register and unregister support --project without relying on cwd', async () => {
    const program = createCli();
    program.exitOverride();

    await program.parseAsync(['node', 'code-memory', 'register', '--project', projectRoot, '--name', 'target']);
    let registry = JSON.parse(readFileSync(getRegistryPath(), 'utf-8')) as {
      repos: Array<{ name: string; rootPath: string }>;
    };
    expect(registry.repos).toContainEqual(expect.objectContaining({
      name: 'target',
      rootPath: projectRoot,
    }));

    await program.parseAsync(['node', 'code-memory', 'unregister', '--project', projectRoot]);
    registry = JSON.parse(readFileSync(getRegistryPath(), 'utf-8')) as {
      repos: Array<{ name: string; rootPath: string }>;
    };
    expect(registry.repos).toEqual([]);
  });

  it('setup --project --no-bootstrap writes agent files into the explicit project', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createCli();
    program.exitOverride();

    await program.parseAsync([
      'node',
      'code-memory',
      'setup',
      '--agent',
      'cursor',
      '--project',
      projectRoot,
      '--no-bootstrap',
      '--no-hooks',
    ]);

    const cursorConfig = JSON.parse(readFileSync(join(projectRoot, '.cursor', 'mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(cursorConfig.mcpServers['code-memory']).toEqual({
      command: 'npx',
      args: ['-y', 'code-memory@latest', 'serve', '--watch', '--project', projectRoot],
    });
    expect(readFileSync(join(projectRoot, 'AGENTS.md'), 'utf-8')).toContain('CODE_MEMORY_CONTEXT_START');
    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Code Memory configuration was written.');
    expect(output).toContain('Bootstrap: skipped');

    await program.parseAsync(['node', 'code-memory', 'uninstall', '--agent', 'cursor', '--project', projectRoot]);

    const cleanedConfig = JSON.parse(readFileSync(join(projectRoot, '.cursor', 'mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(cleanedConfig.mcpServers['code-memory']).toBeUndefined();
    expect(readFileSync(join(projectRoot, 'AGENTS.md'), 'utf-8')).not.toContain('CODE_MEMORY_CONTEXT_START');
  });

  it('wiki --project checks the explicit project instead of cwd', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error('process.exit ' + String(code));
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const program = createCli();
    program.exitOverride();

    await expect(program.parseAsync(['node', 'code-memory', 'wiki', '--project', projectRoot]))
      .rejects.toThrow(/process\.exit 1/);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain(projectRoot);
    expect(output).not.toContain(otherRoot);
  });
});
