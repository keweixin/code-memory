import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Ignore } from 'ignore';
import type { CodeMemoryConfig, FileRecord, FileRole, Language } from '../shared/types.js';
import {
  CONFIG_FILE_PATTERNS,
  DOC_FILE_PATTERNS,
  MAX_FILE_THRESHOLD,
  TEST_FILE_PATTERNS,
} from '../shared/constants.js';
import { normalizePath } from '../shared/utils.js';
import { createIgnoreRule, isIgnored } from '../scanner/ignore-rules.js';
import type { DiscoveredFile } from '../scanner/file-discovery.js';
import { detectLanguage } from '../scanner/language-detector.js';

const MAX_PATH_AWARE_CHANGES = 500;

export interface DirtyFilePlan {
  mode: 'path-aware' | 'fallback-scan' | 'noop';
  changedFiles: DiscoveredFile[];
  deletedFileIds: string[];
  deletedPaths: string[];
  ignoredPaths: string[];
  unsupportedPaths: string[];
  fallbackReason?: string;
}

export function planDirtyFilesFromPaths(
  rootPath: string,
  config: CodeMemoryConfig,
  changedPaths: string[],
  previousFiles: FileRecord[],
): DirtyFilePlan {
  const uniquePaths = normalizeChangedPaths(rootPath, changedPaths);
  if (uniquePaths.length === 0) {
    return emptyPlan('noop');
  }
  if (uniquePaths.length > MAX_PATH_AWARE_CHANGES) {
    return {
      ...emptyPlan('fallback-scan'),
      fallbackReason: `too many changed paths (${uniquePaths.length})`,
    };
  }

  const ignoreRule = createIgnoreRule(rootPath, config.ignore);
  const previousByPath = new Map(previousFiles.map((file) => [normalizePath(file.path), file]));
  const changedFiles: DiscoveredFile[] = [];
  const deletedFileIds: string[] = [];
  const deletedPaths: string[] = [];
  const ignoredPaths: string[] = [];
  const unsupportedPaths: string[] = [];

  for (const relativePath of uniquePaths) {
    if (shouldIgnorePath(relativePath, ignoreRule)) {
      ignoredPaths.push(relativePath);
      continue;
    }

    const absolutePath = resolve(rootPath, relativePath);
    if (isOutsideRoot(rootPath, absolutePath)) {
      unsupportedPaths.push(relativePath);
      continue;
    }

    if (!existsSync(absolutePath)) {
      const previousFile = previousByPath.get(relativePath);
      if (previousFile) {
        deletedFileIds.push(previousFile.id);
        deletedPaths.push(relativePath);
      } else {
        unsupportedPaths.push(relativePath);
      }
      continue;
    }

    let stat;
    try {
      stat = statSync(absolutePath);
    } catch {
      unsupportedPaths.push(relativePath);
      continue;
    }
    if (stat.isDirectory()) {
      return {
        ...emptyPlan('fallback-scan'),
        fallbackReason: `changed path is a directory: ${relativePath}`,
      };
    }
    if (!stat.isFile()) {
      unsupportedPaths.push(relativePath);
      continue;
    }
    if (stat.size > MAX_FILE_THRESHOLD) {
      unsupportedPaths.push(relativePath);
      continue;
    }

    const language = detectLanguage(absolutePath);
    const role = detectFileRole(relativePath, language);
    if (!isIndexable(language, role, config)) {
      unsupportedPaths.push(relativePath);
      continue;
    }

    changedFiles.push({
      path: absolutePath,
      relativePath,
      language,
      size: stat.size,
      role,
    });
  }

  if (changedFiles.length === 0 && deletedFileIds.length === 0) {
    return {
      mode: 'noop',
      changedFiles,
      deletedFileIds,
      deletedPaths,
      ignoredPaths,
      unsupportedPaths,
    };
  }

  return {
    mode: 'path-aware',
    changedFiles,
    deletedFileIds,
    deletedPaths,
    ignoredPaths,
    unsupportedPaths,
  };
}

function normalizeChangedPaths(rootPath: string, changedPaths: string[]): string[] {
  const root = resolve(rootPath);
  const paths = new Set<string>();
  for (const changedPath of changedPaths) {
    if (!changedPath || changedPath.trim().length === 0) continue;
    const resolved = isAbsolute(changedPath) ? resolve(changedPath) : resolve(root, changedPath);
    if (isOutsideRoot(root, resolved)) continue;
    const relativePath = normalizePath(relative(root, resolved));
    if (!relativePath || relativePath === '.') continue;
    paths.add(relativePath);
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

function isOutsideRoot(rootPath: string, absolutePath: string): boolean {
  const relativePath = relative(resolve(rootPath), resolve(absolutePath));
  return relativePath.startsWith('..') || isAbsolute(relativePath);
}

function shouldIgnorePath(relativePath: string, ignoreRule: Ignore): boolean {
  if (isIgnored(relativePath, ignoreRule)) return true;
  const segments = normalizePath(relativePath).split('/');
  for (let i = 1; i < segments.length; i++) {
    if (isIgnored(segments.slice(0, i).join('/'), ignoreRule)) return true;
  }
  return false;
}

function isIndexable(language: Language, role: FileRole, config: CodeMemoryConfig): boolean {
  const configuredLanguages = config.languages.length > 0 ? new Set(config.languages) : null;
  if (configuredLanguages && !configuredLanguages.has(language) && role !== 'config' && role !== 'doc') {
    return false;
  }
  return language !== 'unknown' || role === 'config' || role === 'doc';
}

function detectFileRole(relativePath: string, language: Language): FileRole {
  const normalized = normalizePath(relativePath);
  if (/\.generated?\./i.test(normalized) || /\.gen\./.test(normalized)) return 'generated';
  if (/(?:^|\/)(?:generated|auto-generated)\//i.test(normalized)) return 'generated';
  if (TEST_FILE_PATTERNS.some((pattern) => pattern.test(normalized))) return 'test';
  if (CONFIG_FILE_PATTERNS.some((pattern) => pattern.test(normalized))) return 'config';
  if (DOC_FILE_PATTERNS.some((pattern) => pattern.test(normalized))) return 'doc';
  if (language !== 'unknown') return 'source';
  return 'asset';
}

function emptyPlan(mode: DirtyFilePlan['mode']): DirtyFilePlan {
  return {
    mode,
    changedFiles: [],
    deletedFileIds: [],
    deletedPaths: [],
    ignoredPaths: [],
    unsupportedPaths: [],
  };
}
