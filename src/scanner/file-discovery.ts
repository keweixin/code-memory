/**
 * Code Memory Graph — File Discovery
 *
 * Recursively walks the project directory tree, applies ignore rules,
 * detects languages, and classifies file roles. Does NOT read file
 * contents — that is the parser's responsibility.
 */

import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Ignore } from 'ignore';
import type { Language, FileRole } from '../shared/types.js';
import {
  MAX_FILE_THRESHOLD,
  TEST_FILE_PATTERNS,
  CONFIG_FILE_PATTERNS,
  DOC_FILE_PATTERNS,
} from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import { normalizePath } from '../shared/utils.js';
import { detectLanguage } from './language-detector.js';
import { isIgnored } from './ignore-rules.js';

const log = createLogger('file-discovery');

/** Size of the initial byte range checked for binary detection. */
const BINARY_CHECK_BYTES = 8192;

// ─── Public Types ───────────────────────────────────────────

export interface DiscoverOptions {
  /** Only include files matching these languages (omit for all). */
  languages?: Language[];
  /** Skip files larger than this byte threshold. Defaults to MAX_FILE_THRESHOLD. */
  maxFileSize?: number;
  /** Pre-built Ignore instance from createIgnoreRule(). */
  ignoreInstance?: Ignore;
}

export interface DiscoveredFile {
  /** Absolute path to the file. */
  path: string;
  /** Path relative to the project root. */
  relativePath: string;
  /** Detected programming language. */
  language: Language;
  /** File size in bytes. */
  size: number;
  /** Classified role (source, test, config, doc, asset, generated). */
  role: FileRole;
}

// ─── Binary Detection ──────────────────────────────────────

/**
 * Heuristic: a file is considered binary if its first 8 KB contain
 * a null byte. This catches images, compiled objects, fonts, etc.
 * Gracefully handles files that cannot be opened (treats as binary).
 */
function isBinaryFile(filePath: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(BINARY_CHECK_BYTES);
    const bytesRead = readSync(fd, buf, 0, BINARY_CHECK_BYTES, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    // Permission error or other issue — skip the file
    return true;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* noop */ }
    }
  }
}

// ─── Role Detection ─────────────────────────────────────────

/**
 * Classify a file into a role based on its path/name and language.
 */
function detectFileRole(relativePath: string, language: Language): FileRole {
  const normalized = normalizePath(relativePath);

  // Generated files
  if (/\.generated?\./i.test(normalized) || /\.gen\./.test(normalized)) {
    return 'generated';
  }
  if (/(?:^|\/)(?:generated|auto-generated)\//i.test(normalized)) {
    return 'generated';
  }

  // Test files
  if (TEST_FILE_PATTERNS.some((p) => p.test(normalized))) {
    return 'test';
  }

  // Config files
  if (CONFIG_FILE_PATTERNS.some((p) => p.test(normalized))) {
    return 'config';
  }

  // Doc files
  if (DOC_FILE_PATTERNS.some((p) => p.test(normalized))) {
    return 'doc';
  }

  // Assets (images, fonts, etc.) — identified by extension
  const assetExtensions = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
    '.bmp', '.tiff', '.tif', '.avif',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.webm',
    '.zip', '.tar', '.gz', '.rar', '.7z',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  ]);
  const lastDot = normalized.lastIndexOf('.');
  const lastSlash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  const ext = lastDot > lastSlash ? normalized.slice(lastDot).toLowerCase() : '';
  if (assetExtensions.has(ext)) {
    return 'asset';
  }

  // Lock files
  if (ext === '.lock' || /(?:^|\/)(?:package-lock|yarn\.lock|pnpm-lock)\b/.test(normalized)) {
    return 'lock';
  }

  // Everything else with a recognized language is source
  if (language !== 'unknown') {
    return 'source';
  }

  // Unknown language, not an obvious asset — treat as asset
  return 'asset';
}

// ─── File Discovery ─────────────────────────────────────────

/**
 * Recursively discover all project files under `rootPath`,
 * applying ignore rules, language filtering, size limits, and
 * binary detection.
 *
 * Returns files sorted by relative path for deterministic output.
 */
export function discoverFiles(
  rootPath: string,
  options: DiscoverOptions = {},
): DiscoveredFile[] {
  const {
    languages,
    maxFileSize = MAX_FILE_THRESHOLD,
    ignoreInstance,
  } = options;

  const results: DiscoveredFile[] = [];
  const languageSet = languages ? new Set(languages) : null;
  let skippedSize = 0;
  let skippedBinary = 0;

  /**
   * Recursively walk a directory. We use manual recursion instead of
   * `readdirSync({ recursive: true })` so we can prune ignored
   * directories early and avoid descending into them at all.
   */
  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      log.warn(`Cannot read directory ${dir}: ${String(err)}`);
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      // Convert backslashes to forward slashes for consistent ignore matching
      const relPath = relative(rootPath, fullPath).replace(/\\/g, '/');

      // Check ignore rules (applies to both files and directories)
      if (ignoreInstance && isIgnored(relPath, ignoreInstance)) {
        continue;
      }

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        // Detect language early — skip if not in the requested set
        const language = detectLanguage(fullPath);
        if (languageSet && !languageSet.has(language)) {
          continue;
        }

        // Get file size
        let size: number;
        try {
          size = statSync(fullPath).size;
        } catch {
          continue;
        }

        // Skip files above the size threshold
        if (size > maxFileSize) {
          skippedSize++;
          continue;
        }

        // Skip binary files
        if (isBinaryFile(fullPath)) {
          skippedBinary++;
          continue;
        }

        // Determine role
        const role = detectFileRole(relPath, language);

        results.push({
          path: fullPath,
          relativePath: relPath,
          language,
          size,
          role,
        });
      }
    }
  }

  walk(rootPath);

  // Sort by relative path for deterministic output
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  log.info(
    `Discovered ${results.length} files` +
    (skippedSize ? ` (skipped ${skippedSize} oversized)` : '') +
    (skippedBinary ? ` (skipped ${skippedBinary} binary)` : ''),
  );

  return results;
}
