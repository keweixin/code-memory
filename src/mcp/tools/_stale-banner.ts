/**
 * Stale File Banner — warns the agent when an MCP tool's response
 * references a file that the file watcher has flagged as "pending sync".
 *
 * The banner is built from the watch-service's `getPendingFiles()` output.
 * It has two parts:
 *   - a top "⚠️" banner listing pending files that are referenced by the
 *     current response
 *   - a bottom footer listing additional pending files (capped) that are
 *     not referenced by this response
 *
 * If no files are pending, both parts are empty strings and `attachStaleBanner`
 * is a no-op (returns the original text unchanged).
 */

import type { PendingFile } from '../../indexer/watch-service.js';

export type { PendingFile };

const FILE_PATH_REGEX = /(?:^|[\s>:"'])([A-Za-z]:[\\/][^\s"'<>|]+\.[A-Za-z0-9]{1,10})|([a-zA-Z0-9_][a-zA-Z0-9_./\\-]*\.[a-zA-Z0-9]{1,10})/gm;

export function extractReferencedPaths(text: string): Set<string> {
  const matches = text.matchAll(FILE_PATH_REGEX);
  const paths = new Set<string>();
  for (const match of matches) {
    const captured = match[1] || match[2];
    if (captured) {
      paths.add(captured);
    }
  }
  return paths;
}

export function partitionPending(
  pending: PendingFile[],
  responseText: string,
): { inResponse: PendingFile[]; notInResponse: PendingFile[] } {
  const referenced = extractReferencedPaths(responseText);
  const inResponse: PendingFile[] = [];
  const notInResponse: PendingFile[] = [];
  for (const file of pending) {
    if (referenced.has(file.path)) {
      inResponse.push(file);
    } else {
      notInResponse.push(file);
    }
  }
  return { inResponse, notInResponse };
}

export function formatStaleBanner(pending: PendingFile[], nowMs?: number): string {
  if (pending.length === 0) return '';
  const now = nowMs ?? Date.now();
  const lines = [
    '⚠️  Stale file warning:',
    'The following files were modified but the index has not caught up yet.',
    'For accurate content, Read the file directly:',
    '',
  ];
  for (const file of pending) {
    const ageMs = now - file.lastSeenMs;
    const ageStr = formatAge(ageMs);
    const indexingTag = file.indexing ? ' [indexing...]' : '';
    lines.push(`  - ${file.path} (${ageStr} ago)${indexingTag}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function formatStaleFooter(pending: PendingFile[], maxShown = 5, nowMs?: number): string {
  if (pending.length === 0) return '';
  const now = nowMs ?? Date.now();
  const shown = pending.slice(0, maxShown);
  const remaining = pending.length - shown.length;
  const lines = ['', '--- Other pending files (not in this response) ---'];
  for (const file of shown) {
    const ageMs = now - file.lastSeenMs;
    lines.push(`  - ${file.path} (${formatAge(ageMs)} ago)`);
  }
  if (remaining > 0) {
    lines.push(`  ...and ${remaining} more`);
  }
  return lines.join('\n');
}

export function formatAge(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

export function formatMemoryStaleBanner(staleCount: number): string {
  if (staleCount <= 0) return '';
  return [
    `[CODE-MEMORY CRITICAL ALERT]: ${staleCount} project design memories linked to this module have expired or gone STALE due to local code mutations.`,
    '-> MANDATORY ACTION: Call invalidate_memory to clear obsolete context, then remember_project_fact to refresh the ledger.',
    '',
  ].join('\n');
}

export function attachStaleBanner(
  text: string,
  pendingInResponse: PendingFile[],
  pendingNotInResponse: PendingFile[],
  nowMs?: number,
  staleMemoriesCount: number = 0,
): string {
  const banner = formatStaleBanner(pendingInResponse, nowMs);
  const footer = formatStaleFooter(pendingNotInResponse, 5, nowMs);
  const memoryBanner = formatMemoryStaleBanner(staleMemoriesCount);
  const parts = [banner, memoryBanner, text, footer].filter(Boolean);
  return parts.join('\n');
}
