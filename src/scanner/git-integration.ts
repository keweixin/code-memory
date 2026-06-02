/**
 * Code Memory Graph — Git Integration
 *
 * Collects git metadata (current commit, branch, recent history)
 * and computes file content hashes. All git commands are run
 * synchronously via child_process.execSync and gracefully handle
 * non-git directories.
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createLogger } from '../shared/logger.js';

const log = createLogger('git-integration');

// ─── Public Types ───────────────────────────────────────────

export interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface GitInfo {
  currentCommit: string | null;
  currentBranch: string | null;
  lastCommits: CommitInfo[];
}

// ─── Git Commands ───────────────────────────────────────────

/**
 * Run a git command in `cwd` and return trimmed stdout.
 * Returns `null` if the command fails (non-git dir, git not installed, etc.).
 */
function gitCommand(cwd: string, args: string): string | null {
  try {
    const result = execSync(`git ${args}`, {
      cwd,
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch {
    return null;
  }
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Collect git metadata for a project directory.
 * Returns null values for all fields when the directory is not
 * inside a git repository.
 */
export function getGitInfo(rootPath: string): GitInfo {
  const currentCommit = gitCommand(rootPath, 'rev-parse HEAD');
  const currentBranch = gitCommand(rootPath, 'rev-parse --abbrev-ref HEAD');

  // Get last 20 commits with hash, message, author, date
  // Uses null-byte separator for safe parsing
  const logFormat = '%H%n%s%n%an%n%aI%x00';
  const logOutput = gitCommand(
    rootPath,
    `log -20 --format=${logFormat}`,
  );

  const lastCommits: CommitInfo[] = [];
  if (logOutput) {
    // The format gives us: hash\nsubject\nauthor\ndate\0 per commit
    // Re-parse with the expected structure
    const chunks = logOutput.split('\0').filter(Boolean);
    for (const chunk of chunks) {
      const lines = chunk.trim().split('\n');
      if (lines.length >= 4) {
        lastCommits.push({
          hash: lines[0],
          message: lines[1],
          author: lines[2],
          date: lines[3],
        });
      }
    }
  }

  if (currentCommit) {
    log.debug(`Git: ${currentBranch} @ ${currentCommit.slice(0, 8)}`);
  } else {
    log.debug('Not a git repository');
  }

  return {
    currentCommit,
    currentBranch,
    lastCommits,
  };
}

/**
 * Get the most recent commit hash that modified a specific file.
 * Returns null if the file has no git history or git is unavailable.
 */
export function getFileLastCommit(
  rootPath: string,
  filePath: string,
): string | null {
  // Use --follow to track renames, --format for just the hash
  const result = gitCommand(
    rootPath,
    `log -1 --follow --format=%H -- ${filePath}`,
  );
  return result || null;
}

/**
 * Compute the SHA-256 content hash of a file.
 * Returns the full 64-character hex digest.
 * Throws if the file cannot be read.
 */
export async function getFileContentHash(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => { hash.update(chunk); });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}
