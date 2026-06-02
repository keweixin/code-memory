import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

export interface RegistryEntry {
  name: string;
  rootPath: string;
  registeredAt: string;
}

export interface RegistryFile {
  version: number;
  repos: RegistryEntry[];
}

export interface RegistryOptions {
  homeDir?: string;
}

const REGISTRY_VERSION = 1;

export function getGlobalHome(options: RegistryOptions = {}): string {
  return options.homeDir || process.env.CODE_MEMORY_GLOBAL_HOME || joinHome('.code-memory');
}

export function getRegistryPath(options: RegistryOptions = {}): string {
  return resolve(getGlobalHome(options), 'registry.json');
}

export function readRegistry(options: RegistryOptions = {}): RegistryFile {
  const registryPath = getRegistryPath(options);
  if (!existsSync(registryPath)) return { version: REGISTRY_VERSION, repos: [] };
  try {
    const parsed = JSON.parse(readFileSync(registryPath, 'utf-8')) as RegistryFile;
    return {
      version: Number(parsed.version || REGISTRY_VERSION),
      repos: Array.isArray(parsed.repos) ? parsed.repos.map(normalizeEntry).filter(Boolean) as RegistryEntry[] : [],
    };
  } catch {
    return { version: REGISTRY_VERSION, repos: [] };
  }
}

export function writeRegistry(registry: RegistryFile, options: RegistryOptions = {}): void {
  const registryPath = getRegistryPath(options);
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
}

export function registerRepo(rootPath = process.cwd(), name?: string, options: RegistryOptions = {}): RegistryEntry {
  const resolvedRoot = resolve(rootPath);
  const entry: RegistryEntry = {
    name: name || basename(resolvedRoot),
    rootPath: resolvedRoot,
    registeredAt: new Date().toISOString(),
  };
  const registry = readRegistry(options);
  registry.repos = registry.repos.filter((repo) => repo.name !== entry.name && repo.rootPath !== entry.rootPath);
  registry.repos.push(entry);
  registry.repos.sort((a, b) => a.name.localeCompare(b.name));
  writeRegistry(registry, options);
  return entry;
}

export function unregisterRepo(nameOrPath: string, options: RegistryOptions = {}): number {
  const registry = readRegistry(options);
  const resolved = resolve(nameOrPath);
  const before = registry.repos.length;
  registry.repos = registry.repos.filter((repo) => repo.name !== nameOrPath && repo.rootPath !== resolved);
  writeRegistry(registry, options);
  return before - registry.repos.length;
}

export function findRepo(nameOrPath: string, options: RegistryOptions = {}): RegistryEntry | null {
  const registry = readRegistry(options);
  const resolved = resolve(nameOrPath);
  return registry.repos.find((repo) => repo.name === nameOrPath || repo.rootPath === resolved) || null;
}

function normalizeEntry(value: unknown): RegistryEntry | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (!row.name || !row.rootPath) return null;
  return {
    name: String(row.name),
    rootPath: resolve(String(row.rootPath)),
    registeredAt: String(row.registeredAt || ''),
  };
}

function joinHome(path: string): string {
  return resolve(homedir(), path);
}
