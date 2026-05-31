/**
 * Code Memory Graph — Ignore Rules
 *
 * Combines .gitignore rules from the project root with default
 * patterns to create a unified file filter.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ignoreFactory from 'ignore';
import type { Ignore } from 'ignore';
import { DEFAULT_IGNORE_PATTERNS } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('ignore-rules');

/**
 * Create a unified Ignore instance from project .gitignore files
 * and the default ignore patterns.
 *
 * Loads `.gitignore` from the project root if it exists.
 * Always includes DEFAULT_IGNORE_PATTERNS.
 * Additional patterns from the user config are also added.
 */
export function createIgnoreRule(
  rootPath: string,
  additionalPatterns: string[] = [],
): Ignore {
  const ig = (ignoreFactory as unknown as () => Ignore)();

  // Always add default patterns
  ig.add(DEFAULT_IGNORE_PATTERNS);
  log.debug(`Added ${DEFAULT_IGNORE_PATTERNS.length} default ignore patterns`);

  // Load .gitignore from project root
  const gitignorePath = join(rootPath, '.gitignore');
  try {
    const gitignore = readFileSync(gitignorePath, 'utf-8');
    ig.add(gitignore);
    log.debug(`Loaded .gitignore from ${gitignorePath}`);
  } catch {
    log.debug('No .gitignore found in project root');
  }

  // Add user-configured patterns
  if (additionalPatterns.length > 0) {
    ig.add(additionalPatterns);
    log.debug(`Added ${additionalPatterns.length} custom ignore patterns`);
  }

  return ig;
}

/**
 * Check whether a relative file path should be ignored.
 *
 * @param relativePath  Path relative to the project root.
 * @param ignore        An Ignore instance from createIgnoreRule().
 * @returns true if the path should be excluded from indexing.
 */
export function isIgnored(relativePath: string, ignore: Ignore): boolean {
  // Normalize Windows backslashes
  const normalized = relativePath.replace(/\\/g, '/');
  return ignore.ignores(normalized);
}
