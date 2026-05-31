/**
 * Code Memory Graph — Project Scanner Coordinator
 *
 * Orchestrates the full scan pipeline:
 *   create ignore rules → discover files → collect git info → compute stats
 *
 * The scanner does NOT read file contents — that is the parser's job.
 */

import type { CodeMemoryConfig, Language, FileRole } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';
import { createIgnoreRule } from './ignore-rules.js';
import { discoverFiles, type DiscoveredFile, type DiscoverOptions } from './file-discovery.js';
import { getGitInfo, type GitInfo } from './git-integration.js';

const log = createLogger('scanner');

// ─── Public Types ───────────────────────────────────────────

export interface ScanStats {
  totalFiles: number;
  byLanguage: Record<string, number>;
  byRole: Record<string, number>;
  skippedSize: number;
  skippedBinary: number;
}

export interface ScanResult {
  files: DiscoveredFile[];
  gitInfo: GitInfo;
  stats: ScanStats;
}

// ─── Stats Computation ──────────────────────────────────────

function computeStats(files: DiscoveredFile[]): ScanStats {
  const byLanguage: Record<string, number> = {};
  const byRole: Record<string, number> = {};

  for (const file of files) {
    byLanguage[file.language] = (byLanguage[file.language] || 0) + 1;
    byRole[file.role] = (byRole[file.role] || 0) + 1;
  }

  return {
    totalFiles: files.length,
    byLanguage,
    byRole,
    skippedSize: 0,   // populated from discoverFiles log output
    skippedBinary: 0,  // populated from discoverFiles log output
  };
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Scan a project directory and return discovered files, git info,
 * and aggregate statistics.
 *
 * @param rootPath  Absolute path to the project root.
 * @param config    The loaded CodeMemoryConfig (from .code-memory/config.json).
 */
export function scanProject(
  rootPath: string,
  config: CodeMemoryConfig,
): ScanResult {
  const startTime = Date.now();
  log.info(`Scanning project: ${rootPath}`);

  // 1. Build ignore rules
  const ignoreInstance = createIgnoreRule(rootPath, config.ignore);
  log.debug('Ignore rules created');

  // 2. Discover files
  const discoverOptions: DiscoverOptions = {
    languages: config.languages.length > 0 ? config.languages : undefined,
    ignoreInstance,
  };
  const files = discoverFiles(rootPath, discoverOptions);
  log.info(`Discovered ${files.length} files`);

  // 3. Collect git metadata
  const gitInfo = getGitInfo(rootPath);
  if (gitInfo.currentBranch) {
    log.info(`Branch: ${gitInfo.currentBranch} @ ${gitInfo.currentCommit?.slice(0, 8) ?? 'n/a'}`);
  }

  // 4. Compute statistics
  const stats = computeStats(files);

  const elapsed = Date.now() - startTime;
  log.info(
    `Scan complete in ${elapsed}ms — ` +
    `${stats.totalFiles} files, ` +
    `${Object.keys(stats.byLanguage).length} languages`,
  );

  // Log breakdown by language
  const langEntries = Object.entries(stats.byLanguage)
    .sort((a, b) => b[1] - a[1]);
  for (const [lang, count] of langEntries) {
    log.debug(`  ${lang}: ${count} files`);
  }

  // Log breakdown by role
  const roleEntries = Object.entries(stats.byRole)
    .sort((a, b) => b[1] - a[1]);
  for (const [role, count] of roleEntries) {
    log.debug(`  ${role}: ${count} files`);
  }

  return { files, gitInfo, stats };
}

// Re-export sub-module types for convenience
export type { DiscoveredFile, DiscoverOptions } from './file-discovery.js';
export type { GitInfo, CommitInfo } from './git-integration.js';
