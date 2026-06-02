import { describe, expect, it } from 'vitest';
import {
  attachStaleBanner,
  extractReferencedPaths,
  formatAge,
  formatStaleBanner,
  formatStaleFooter,
  partitionPending,
  type PendingFile,
} from '../src/mcp/tools/_stale-banner.js';

function makePending(overrides: Partial<PendingFile> = {}): PendingFile {
  return {
    path: 'src/foo.ts',
    lastSeenMs: Date.now() - 5_000,
    indexing: false,
    ...overrides,
  };
}

describe('stale-banner', () => {
  describe('formatAge', () => {
    it('formats sub-second ages in milliseconds', () => {
      expect(formatAge(500)).toBe('500ms');
    });

    it('formats sub-minute ages in seconds', () => {
      expect(formatAge(5_000)).toBe('5s');
    });

    it('formats sub-hour ages in minutes', () => {
      expect(formatAge(65_000)).toBe('1m');
    });

    it('formats ages over an hour in hours', () => {
      expect(formatAge(3_700_000)).toBe('1h');
    });
  });

  describe('formatStaleBanner', () => {
    it('returns empty string for no pending files', () => {
      expect(formatStaleBanner([])).toBe('');
    });

    it('includes the file path and age in the banner', () => {
      const pending: PendingFile[] = [
        { path: 'foo.ts', lastSeenMs: Date.now() - 5_000, indexing: false },
      ];
      const out = formatStaleBanner(pending);
      expect(out).toContain('foo.ts');
      expect(out).toContain('5s ago');
      expect(out).toContain('Stale file warning');
      expect(out).toContain('Read the file directly');
    });

    it('tags files that are currently being indexed', () => {
      const pending: PendingFile[] = [
        { path: 'live.ts', lastSeenMs: Date.now() - 100, indexing: true },
      ];
      const out = formatStaleBanner(pending);
      expect(out).toContain('live.ts');
      expect(out).toContain('[indexing...]');
    });
  });

  describe('formatStaleFooter', () => {
    it('returns empty string for no pending files', () => {
      expect(formatStaleFooter([], 5)).toBe('');
    });

    it('truncates to maxShown and reports the remaining count', () => {
      const pending: PendingFile[] = Array.from({ length: 8 }, (_, i) => ({
        path: `src/file-${i}.ts`,
        lastSeenMs: Date.now() - 1_000,
        indexing: false,
      }));
      const out = formatStaleFooter(pending, 5);
      const lines = out.split('\n');
      const listed = lines.filter((l) => l.includes('src/file-')).length;
      expect(listed).toBe(5);
      expect(out).toContain('...and 3 more');
      expect(out).toContain('Other pending files (not in this response)');
    });

    it('does not show a "more" line when count <= maxShown', () => {
      const pending: PendingFile[] = [
        { path: 'a.ts', lastSeenMs: Date.now() - 1_000, indexing: false },
        { path: 'b.ts', lastSeenMs: Date.now() - 1_000, indexing: false },
      ];
      const out = formatStaleFooter(pending, 5);
      expect(out).not.toContain('...and');
    });

    it('uses nowMs for age calculation when provided', () => {
      const pending: PendingFile[] = [
        { path: 'x.ts', lastSeenMs: 1000, indexing: false },
      ];
      const out = formatStaleFooter(pending, 5, 5000);
      expect(out).toContain('x.ts');
      expect(out).toContain('4s ago');
    });
  });

  describe('attachStaleBanner', () => {
    it('returns the original text when nothing is pending', () => {
      const out = attachStaleBanner('hello world', [], []);
      expect(out).toBe('hello world');
    });

    it('prepends banner and appends footer around the text', () => {
      const banner: PendingFile[] = [
        { path: 'a.ts', lastSeenMs: Date.now() - 1_000, indexing: false },
      ];
      const footer: PendingFile[] = [
        { path: 'b.ts', lastSeenMs: Date.now() - 1_000, indexing: false },
        { path: 'c.ts', lastSeenMs: Date.now() - 1_000, indexing: false },
      ];
      const out = attachStaleBanner('hello', banner, footer);
      const bannerIdx = out.indexOf('Stale file warning');
      const helloIdx = out.indexOf('hello');
      const footerIdx = out.indexOf('Other pending files');
      expect(bannerIdx).toBeGreaterThanOrEqual(0);
      expect(helloIdx).toBeGreaterThan(bannerIdx);
      expect(footerIdx).toBeGreaterThan(helloIdx);
    });
  });

  describe('extractReferencedPaths', () => {
    it('extracts file-like patterns from response text', () => {
      const text = '  - src/index.ts:10-20\n  - tests/foo.test.ts:5\n  Some other content\n';
      const paths = extractReferencedPaths(text);
      expect(paths.has('src/index.ts')).toBe(true);
      expect(paths.has('tests/foo.test.ts')).toBe(true);
    });

    it('returns empty set when no file-like patterns are present', () => {
      const paths = extractReferencedPaths('no files here just text');
      expect(paths.size).toBe(0);
    });

    it('extracts Windows absolute paths', () => {
      const paths = extractReferencedPaths('C:\\Users\\me\\src\\foo.ts');
      expect(paths.has('C:\\Users\\me\\src\\foo.ts')).toBe(true);
    });

    it('extracts git diff style paths', () => {
      const paths = extractReferencedPaths('a/src/foo.ts');
      expect(paths.size).toBeGreaterThan(0);
      const matched = [...paths];
      expect(matched.some((p) => p.includes('src/foo.ts'))).toBe(true);
    });
  });

  describe('partitionPending', () => {
    it('partitions pending files into in-response and not-in-response buckets', () => {
      const pending: PendingFile[] = [
        makePending({ path: 'src/a.ts' }),
        makePending({ path: 'src/b.ts' }),
        makePending({ path: 'src/c.ts' }),
      ];
      const response = 'src/a.ts:1\nsrc/b.ts:5\n';
      const { inResponse, notInResponse } = partitionPending(pending, response);
      expect(inResponse.map((p) => p.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
      expect(notInResponse.map((p) => p.path)).toEqual(['src/c.ts']);
    });
  });
});
