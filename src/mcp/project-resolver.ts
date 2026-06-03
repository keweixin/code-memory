import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CONFIG_DIR, CONFIG_FILE, DATABASE_FILE } from '../shared/constants.js';
import { findRepo, readRegistry, type RegistryEntry } from '../cli/registry.js';

export type ProjectResolutionStatus = 'ready' | 'needs_bootstrap' | 'needs_index' | 'unknown';
export type ProjectResolutionNextAction = 'use_code_memory' | 'bootstrap' | 'index' | 'register_or_pass_project';

export interface ResolveProjectInput {
  repo?: string;
  project?: string;
  cwd?: string;
  workspaceRoots?: string[];
}

export interface ProjectResolution {
  projectRoot: string | null;
  gitRoot: string | null;
  repoName: string | null;
  registered: boolean;
  configExists: boolean;
  indexExists: boolean;
  dbPath: string | null;
  indexStatus: ProjectResolutionStatus;
  status: ProjectResolutionStatus;
  nextAction: ProjectResolutionNextAction;
  command: string | null;
  reason: string;
}

export function resolveProject(input: ResolveProjectInput = {}): ProjectResolution {
  const repo = normalize(input.repo);
  if (repo) {
    const registered = findRepo(repo);
    const projectRoot = registered?.rootPath ?? (looksLikePath(repo) ? resolve(repo) : null);
    if (projectRoot) return buildResolution(projectRoot, registered ?? null, 'repo');
    return unresolved('Repository "' + repo + '" is not registered and is not a path.');
  }

  const explicitProject = normalize(input.project);
  if (explicitProject) {
    return buildResolution(resolve(explicitProject), findRepoByRoot(resolve(explicitProject)), 'project');
  }

  const envProject = normalize(process.env.CODE_MEMORY_PROJECT);
  if (envProject) {
    const root = resolve(envProject);
    return buildResolution(root, findRepoByRoot(root), 'CODE_MEMORY_PROJECT');
  }

  for (const workspaceRoot of input.workspaceRoots ?? []) {
    const normalized = normalize(workspaceRoot);
    if (normalized) return buildResolution(resolve(normalized), findRepoByRoot(resolve(normalized)), 'workspace');
  }

  const cwd = resolve(input.cwd ?? process.cwd());
  const codeMemoryRoot = findNearestMarkerRoot(cwd);
  if (codeMemoryRoot) {
    return buildResolution(codeMemoryRoot, findRepoByRoot(codeMemoryRoot), 'nearest .code-memory');
  }

  const gitRoot = findNearestGitRoot(cwd);
  if (gitRoot) {
    return buildResolution(gitRoot, findRepoByRoot(gitRoot), 'nearest git root');
  }

  const registered = findRepoByRoot(cwd) ?? getRegisteredRepos()[0] ?? null;
  if (registered) {
    return buildResolution(registered.rootPath, registered, 'registry');
  }

  return buildResolution(cwd, null, 'cwd');
}

export function formatProjectResolution(resolution: ProjectResolution): string {
  return JSON.stringify({
    projectRoot: resolution.projectRoot,
    gitRoot: resolution.gitRoot,
    repoName: resolution.repoName,
    registered: resolution.registered,
    configExists: resolution.configExists,
    indexExists: resolution.indexExists,
    dbPath: resolution.dbPath,
    indexStatus: resolution.indexStatus,
    status: resolution.status,
    nextAction: resolution.nextAction,
    command: resolution.command,
    reason: resolution.reason,
  }, null, 2);
}

function buildResolution(projectRoot: string, registered: RegistryEntry | null, source: string): ProjectResolution {
  const root = resolve(projectRoot);
  const configPath = join(root, CONFIG_DIR, CONFIG_FILE);
  const dbPath = join(root, CONFIG_DIR, DATABASE_FILE);
  const configExists = existsSync(configPath);
  const indexExists = existsSync(dbPath);
  const gitRoot = findNearestGitRoot(root);
  const status: ProjectResolutionStatus = configExists && indexExists
    ? 'ready'
    : configExists
      ? 'needs_index'
      : 'needs_bootstrap';
  const nextAction: ProjectResolutionNextAction = status === 'ready'
    ? 'use_code_memory'
    : status === 'needs_index'
      ? 'index'
      : 'bootstrap';

  return {
    projectRoot: root,
    gitRoot,
    repoName: registered?.name ?? inferRepoName(root),
    registered: Boolean(registered),
    configExists,
    indexExists,
    dbPath,
    indexStatus: status,
    status,
    nextAction,
    command: getCommand(nextAction, root),
    reason: 'Resolved from ' + source + '.',
  };
}

function unresolved(reason: string): ProjectResolution {
  return {
    projectRoot: null,
    gitRoot: null,
    repoName: null,
    registered: false,
    configExists: false,
    indexExists: false,
    dbPath: null,
    indexStatus: 'unknown',
    status: 'unknown',
    nextAction: 'register_or_pass_project',
    command: 'npx -y code-memory@latest register --project <absolute-project-path>',
    reason,
  };
}

function getCommand(action: ProjectResolutionNextAction, projectRoot: string): string | null {
  if (action === 'use_code_memory') return null;
  if (action === 'index') {
    return 'npx -y code-memory@latest index --full --project ' + JSON.stringify(projectRoot);
  }
  if (action === 'bootstrap') {
    return 'npx -y code-memory@latest bootstrap --project ' + JSON.stringify(projectRoot);
  }
  return 'npx -y code-memory@latest register --project ' + JSON.stringify(projectRoot);
}

function findRepoByRoot(rootPath: string): RegistryEntry | null {
  const root = resolve(rootPath);
  return getRegisteredRepos().find((repo: RegistryEntry) => resolve(repo.rootPath) === root) ?? null;
}

function getRegisteredRepos(): RegistryEntry[] {
  return readRegistry().repos;
}

function findNearestMarkerRoot(startPath: string): string | null {
  return findUp(startPath, (dir) =>
    existsSync(join(dir, CONFIG_DIR, CONFIG_FILE)) ||
    existsSync(join(dir, CONFIG_DIR, DATABASE_FILE)),
  );
}

function findNearestGitRoot(startPath: string): string | null {
  return findUp(startPath, (dir) => existsSync(join(dir, '.git')));
}

function findUp(startPath: string, predicate: (dir: string) => boolean): string | null {
  let current = resolve(startPath);
  while (true) {
    if (predicate(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function looksLikePath(value: string): boolean {
  return value.includes('/') || value.includes('\\') || value === '.' || value.startsWith('~');
}

function inferRepoName(rootPath: string): string {
  return rootPath.split(/[\\/]/).filter(Boolean).pop() ?? 'unknown';
}

function normalize(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
