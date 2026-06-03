import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerRepo } from '../src/cli/registry.js';
import { resolveProject } from '../src/mcp/project-resolver.js';

describe('ProjectResolver', () => {
  let tempRoot: string;
  let homeDir: string;
  let originalGlobalHome: string | undefined;
  let originalProjectEnv: string | undefined;

  beforeEach(() => {
    originalGlobalHome = process.env.CODE_MEMORY_GLOBAL_HOME;
    originalProjectEnv = process.env.CODE_MEMORY_PROJECT;
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-resolver-'));
    homeDir = join(tempRoot, 'home');
    process.env.CODE_MEMORY_GLOBAL_HOME = homeDir;
    delete process.env.CODE_MEMORY_PROJECT;
  });

  afterEach(() => {
    if (originalGlobalHome === undefined) {
      delete process.env.CODE_MEMORY_GLOBAL_HOME;
    } else {
      process.env.CODE_MEMORY_GLOBAL_HOME = originalGlobalHome;
    }
    if (originalProjectEnv === undefined) {
      delete process.env.CODE_MEMORY_PROJECT;
    } else {
      process.env.CODE_MEMORY_PROJECT = originalProjectEnv;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('resolves by precedence: repo > project > env > cwd marker > registry', () => {
    const repoRoot = readyProject('repo-target');
    const projectRoot = readyProject('project-target');
    const envRoot = readyProject('env-target');
    const cwdRoot = readyProject('cwd-target');
    const nestedCwd = join(cwdRoot, 'src', 'nested');
    mkdirSync(nestedCwd, { recursive: true });
    registerRepo(repoRoot, 'repo-target', { homeDir });

    process.env.CODE_MEMORY_PROJECT = envRoot;

    expect(resolveProject({ repo: 'repo-target', project: projectRoot, cwd: nestedCwd }).projectRoot).toBe(repoRoot);
    expect(resolveProject({ project: projectRoot, cwd: nestedCwd }).projectRoot).toBe(projectRoot);
    expect(resolveProject({ cwd: nestedCwd }).projectRoot).toBe(envRoot);

    delete process.env.CODE_MEMORY_PROJECT;
    expect(resolveProject({ cwd: nestedCwd }).projectRoot).toBe(cwdRoot);

    const unrelatedCwd = join(tempRoot, 'unrelated');
    mkdirSync(unrelatedCwd, { recursive: true });
    expect(resolveProject({ cwd: unrelatedCwd }).projectRoot).toBe(repoRoot);
  });

  it('returns an actionable bootstrap command for an uninitialized project', () => {
    const projectRoot = join(tempRoot, 'new-project');
    mkdirSync(projectRoot, { recursive: true });

    const resolution = resolveProject({ project: projectRoot });

    expect(resolution.status).toBe('needs_bootstrap');
    expect(resolution.configExists).toBe(false);
    expect(resolution.indexExists).toBe(false);
    expect(resolution.nextAction).toBe('bootstrap');
    expect(resolution.command).toContain('npx -y code-memory@latest bootstrap --project');
    expect(resolution.projectRoot).toBe(projectRoot);
  });

  it('reports stale when a ready git project has changed files', () => {
    const projectRoot = readyProject('stale-target');
    execSync('git init', { cwd: projectRoot, stdio: 'ignore' });
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src', 'changed.ts'), 'export const changed = true;\n', 'utf-8');

    const resolution = resolveProject({ project: projectRoot });

    expect(resolution.status).toBe('stale');
    expect(resolution.indexStatus).toBe('stale');
    expect(resolution.nextAction).toBe('sync');
    expect(resolution.command).toContain('npx -y code-memory@latest sync --project');
  });

  function readyProject(name: string): string {
    const root = join(tempRoot, name);
    const codeMemoryDir = join(root, '.code-memory');
    mkdirSync(codeMemoryDir, { recursive: true });
    writeFileSync(join(codeMemoryDir, 'config.json'), '{}', 'utf-8');
    writeFileSync(join(codeMemoryDir, 'index.db'), '', 'utf-8');
    return root;
  }
});
