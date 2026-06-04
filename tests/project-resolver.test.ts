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
    expect(resolution.command).toContain('npx -y @keweixin/code-memory@latest bootstrap --project');
    expect(resolution.projectRoot).toBe(projectRoot);
  });

  it('requires project selection when multiple registry repos exist and cwd has no project identity', () => {
    const firstRoot = readyProject('first-target');
    const secondRoot = readyProject('second-target');
    const unrelatedCwd = join(tempRoot, 'unrelated');
    mkdirSync(unrelatedCwd, { recursive: true });
    registerRepo(firstRoot, 'first-target', { homeDir });
    registerRepo(secondRoot, 'second-target', { homeDir });

    const resolution = resolveProject({ cwd: unrelatedCwd });

    expect(resolution.status).toBe('needs_project_selection');
    expect(resolution.nextAction).toBe('choose_project');
    expect(resolution.projectRoot).toBeNull();
    expect(resolution.candidates).toEqual([
      expect.objectContaining({
        name: 'first-target',
        root: firstRoot,
        indexStatus: 'fresh',
        registered: true,
      }),
      expect.objectContaining({
        name: 'second-target',
        root: secondRoot,
        indexStatus: 'fresh',
        registered: true,
      }),
    ]);
  });

  it('does not require selection when repo, project, env, or workspace roots identify the project', () => {
    const firstRoot = readyProject('first-explicit');
    const secondRoot = readyProject('second-explicit');
    const envRoot = readyProject('env-explicit');
    const workspaceRoot = readyProject('workspace-explicit');
    const unrelatedCwd = join(tempRoot, 'unrelated-explicit');
    mkdirSync(unrelatedCwd, { recursive: true });
    registerRepo(firstRoot, 'first-explicit', { homeDir });
    registerRepo(secondRoot, 'second-explicit', { homeDir });

    expect(resolveProject({ repo: 'second-explicit', cwd: unrelatedCwd }).projectRoot).toBe(secondRoot);
    expect(resolveProject({ project: firstRoot, cwd: unrelatedCwd }).projectRoot).toBe(firstRoot);

    process.env.CODE_MEMORY_PROJECT = envRoot;
    expect(resolveProject({ cwd: unrelatedCwd }).projectRoot).toBe(envRoot);

    delete process.env.CODE_MEMORY_PROJECT;
    expect(resolveProject({ cwd: unrelatedCwd, workspaceRoots: [workspaceRoot] }).projectRoot).toBe(workspaceRoot);
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
    expect(resolution.command).toContain('npx -y @keweixin/code-memory@latest sync --project');
  });

  it('does not report stale just because code-memory storage is untracked', () => {
    const projectRoot = readyProject('self-storage-target');
    execSync('git init', { cwd: projectRoot, stdio: 'ignore' });

    const resolution = resolveProject({ project: projectRoot });

    expect(resolution.status).toBe('ready');
    expect(resolution.indexStatus).toBe('fresh');
    expect(resolution.nextAction).toBe('use_code_memory');
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
