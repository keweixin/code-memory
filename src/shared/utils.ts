/**
 * Code Memory Graph — Utility Functions
 */

import { createHash } from 'node:crypto';

/**
 * Generate a stable ID from a string using SHA-256.
 * Returns first 16 characters of the hex digest for compactness.
 */
export function generateId(...parts: string[]): string {
  const input = parts.join('::');
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Generate a content hash using SHA-256.
 * Returns the full 64-character hex digest for reliable deduplication.
 */
export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Normalize a file path: convert backslashes to forward slashes,
 * remove leading ./, collapse duplicate slashes.
 */
export function normalizePath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '');
}

/**
 * Get the relative path from a base directory to a file.
 * Returns the normalized relative path.
 */
export function relativePath(from: string, to: string): string {
  const normalizedFrom = normalizePath(from).replace(/\/$/, '');
  const normalizedTo = normalizePath(to);

  if (normalizedTo.startsWith(normalizedFrom + '/')) {
    return normalizedTo.slice(normalizedFrom.length + 1);
  }

  return normalizedTo;
}

/**
 * Get the file extension from a path (including the dot).
 */
export function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (lastDot > lastSlash && lastDot > 0) {
    return filePath.slice(lastDot).toLowerCase();
  }
  return '';
}

/**
 * Check if a glob pattern matches a string.
 * Simple implementation supporting *, ?, and ** wildcards.
 */
export function globMatch(pattern: string, str: string): boolean {
  // Normalize
  const normalizedPattern = pattern.replace(/\\/g, '/');
  const normalizedStr = str.replace(/\\/g, '/');

  // Convert glob to regex
  const regexStr = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{DOUBLESTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{DOUBLESTAR\}\}/g, '.*');

  try {
    const regex = new RegExp(`^${regexStr}$`, 'i');
    return regex.test(normalizedStr);
  } catch {
    return false;
  }
}

/**
 * Debounce a function call.
 */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delayMs: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      fn(...args);
      timer = null;
    }, delayMs);
  };
}

/**
 * Safely parse JSON, returning null on failure.
 */
export function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Format a file size in human-readable form.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Format a duration in human-readable form.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
