/**
 * Code Memory Graph — Utility Functions
 */

import { createHash } from 'node:crypto';

/**
 * FNV-1a 32-bit hash — fast, non-cryptographic.
 */
function fnv1aHash(str: string): string {
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  // Convert to unsigned 32-bit and then to hex
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Generate a stable ID from a string using FNV-1a.
 * Two-pass for collision resistance; returns 16 hex chars (same length as before).
 */
export function generateId(...parts: string[]): string {
  const input = parts.join('::');
  const h1 = fnv1aHash(input);
  const h2 = fnv1aHash(h1 + ':' + input);
  return h1 + h2; // 16 hex chars
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

const globCache = new Map<string, RegExp>();
const GLOB_CACHE_MAX_SIZE = 256;

function globToRegex(pattern: string): RegExp {
  let regex = globCache.get(pattern);
  if (regex) return regex;

  // Convert glob to regex
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{DOUBLESTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{DOUBLESTAR\}\}/g, '.*');

  regex = new RegExp(`^${regexStr}$`, 'i');

  if (globCache.size >= GLOB_CACHE_MAX_SIZE) {
    const firstKey = globCache.keys().next().value;
    if (firstKey) globCache.delete(firstKey);
  }
  globCache.set(pattern, regex);
  return regex;
}

/**
 * Check if a glob pattern matches a string.
 * Simple implementation supporting *, ?, and ** wildcards.
 */
export function globMatch(pattern: string, str: string): boolean {
  // Normalize
  const normalizedPattern = pattern.replace(/\\/g, '/');
  const normalizedStr = str.replace(/\\/g, '/');

  try {
    const regex = globToRegex(normalizedPattern);
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
    return JSON.parse(stripUtf8Bom(text)) as T;
  } catch {
    return null;
  }
}

/**
 * Remove a leading UTF-8 BOM so JSON config files created by Windows tools
 * parse consistently.
 */
export function stripUtf8Bom(text: string): string {
  return text.replace(/^\uFEFF+/, '');
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
