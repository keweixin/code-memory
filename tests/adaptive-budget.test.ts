import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BUDGET_TIERS,
  applyOutputCharBudget,
  countIndexedNodes,
  filterLowValueFiles,
  getAdaptiveBudget,
  isLowValueFile,
} from '../src/search/context-budget.js';
import {
  closeDatabase,
  getDatabase,
  getDatabaseSync,
} from '../src/storage/database.js';

describe('getAdaptiveBudget', () => {
  it('returns tiny for very small projects', () => {
    expect(getAdaptiveBudget(0).tier).toBe('tiny');
    expect(getAdaptiveBudget(0)).toEqual({ tier: 'tiny', ...BUDGET_TIERS.tiny });
  });

  it('returns tiny for nodes just below 500', () => {
    expect(getAdaptiveBudget(499).tier).toBe('tiny');
  });

  it('crosses into small at 500 nodes', () => {
    expect(getAdaptiveBudget(500).tier).toBe('small');
  });

  it('returns small for nodes just below 2000', () => {
    expect(getAdaptiveBudget(1999).tier).toBe('small');
  });

  it('crosses into medium at 2000 nodes', () => {
    expect(getAdaptiveBudget(2000).tier).toBe('medium');
  });

  it('returns medium for nodes just below 10000', () => {
    expect(getAdaptiveBudget(9999).tier).toBe('medium');
  });

  it('crosses into large at 10000 nodes', () => {
    expect(getAdaptiveBudget(10000).tier).toBe('large');
  });

  it('returns large for nodes just below 50000', () => {
    expect(getAdaptiveBudget(49999).tier).toBe('large');
  });

  it('crosses into huge at 50000 nodes', () => {
    expect(getAdaptiveBudget(50000).tier).toBe('huge');
  });

  it('stays huge for very large projects', () => {
    expect(getAdaptiveBudget(1000000).tier).toBe('huge');
  });

  it('exposes BUDGET_TIERS values matching the spec', () => {
    expect(BUDGET_TIERS.tiny).toEqual({
      maxOutputChars: 13000,
      maxFiles: 4,
      maxCharsPerFile: 3800,
      excludeLowValueFiles: true,
      includeRelationships: false,
    });
    expect(BUDGET_TIERS.small).toEqual({
      maxOutputChars: 18000,
      maxFiles: 5,
      maxCharsPerFile: 3800,
      excludeLowValueFiles: true,
      includeRelationships: false,
    });
    expect(BUDGET_TIERS.medium).toEqual({
      maxOutputChars: 28000,
      maxFiles: 10,
      maxCharsPerFile: 6500,
      excludeLowValueFiles: false,
      includeRelationships: true,
    });
    expect(BUDGET_TIERS.large).toEqual({
      maxOutputChars: 35000,
      maxFiles: 12,
      maxCharsPerFile: 7000,
      excludeLowValueFiles: false,
      includeRelationships: true,
    });
    expect(BUDGET_TIERS.huge).toEqual({
      maxOutputChars: 38000,
      maxFiles: 14,
      maxCharsPerFile: 7000,
      excludeLowValueFiles: false,
      includeRelationships: true,
    });
  });
});

describe('isLowValueFile', () => {
  it('identifies test files', () => {
    expect(isLowValueFile('foo.test.ts')).toBe(true);
    expect(isLowValueFile('foo.spec.tsx')).toBe(true);
  });

  it('does not flag regular source files', () => {
    expect(isLowValueFile('foo.ts')).toBe(false);
    expect(isLowValueFile('src/foo.ts')).toBe(false);
  });

  it('identifies files under __tests__/ or __mocks__/', () => {
    expect(isLowValueFile('__tests__/foo.ts')).toBe(true);
    expect(isLowValueFile('__mocks__/bar.ts')).toBe(true);
    expect(isLowValueFile('src/__tests__/foo.ts')).toBe(true);
  });

  it('identifies mock/fixture/stub files', () => {
    expect(isLowValueFile('mock-helper.ts')).toBe(true);
    expect(isLowValueFile('fixture.json')).toBe(true);
    expect(isLowValueFile('src/stub.js')).toBe(true);
    expect(isLowValueFile('mock.ts')).toBe(true);
  });

  it('does not flag files where mock/fixture/stub is only a substring', () => {
    expect(isLowValueFile('mocking.ts')).toBe(false);
  });

  it('does not flag directories that merely contain "tests"', () => {
    expect(isLowValueFile('tests/e2e/setup.ts')).toBe(false);
  });
});

describe('filterLowValueFiles', () => {
  it('drops test, spec, mock, fixture, stub files', () => {
    const files = [
      { path: 'src/auth.ts' },
      { path: 'src/auth.test.ts' },
      { path: 'src/auth.spec.ts' },
      { path: 'src/mock-helper.ts' },
      { path: 'src/fixture.json' },
      { path: 'src/stub.js' },
    ];
    const filtered = filterLowValueFiles(files);
    expect(filtered.map((f) => f.path)).toEqual(['src/auth.ts']);
  });

  it('keeps all files when none are low-value', () => {
    const files = [
      { path: 'src/auth.ts' },
      { path: 'src/user.ts' },
    ];
    expect(filterLowValueFiles(files)).toEqual(files);
  });
});

describe('applyOutputCharBudget', () => {
  it('returns the text unchanged when within budget', () => {
    const text = 'hello world';
    expect(applyOutputCharBudget(text, 100)).toBe(text);
  });

  it('truncates and appends a marker when over budget', () => {
    const text = 'a'.repeat(200);
    const out = applyOutputCharBudget(text, 50);
    expect(out.startsWith('a'.repeat(50))).toBe(true);
    expect(out).toContain('truncated');
    expect(out).toContain('150 more chars');
  });

  it('handles exact-length input without truncation', () => {
    const text = 'a'.repeat(50);
    expect(applyOutputCharBudget(text, 50)).toBe(text);
  });
});

describe('countIndexedNodes', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-budget-'));
    mkdirSync(join(tempRoot, '.code-memory'), { recursive: true });
    await getDatabase(tempRoot);
  });

  afterEach(() => {
    try { closeDatabase(); } catch { /* ignore */ }
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns 0 for an empty database', () => {
    const db = getDatabaseSync();
    expect(countIndexedNodes(db)).toBe(0);
  });

  it('counts files only', () => {
    const db = getDatabaseSync();
    db.run(
      `INSERT INTO files (id, path, language, role, size, hash, indexed_at, exports, imports, search_text)
       VALUES (?, ?, 'typescript', 'source', 1, 'h', 'now', '[]', '[]', ?)`,
      ['file:1', 'src/a.ts', 'src/a.ts'],
    );
    expect(countIndexedNodes(db)).toBe(1);
  });

  it('counts symbols only', () => {
    const db = getDatabaseSync();
    db.run(
      `INSERT INTO files (id, path, language, role, size, hash, indexed_at, exports, imports, search_text)
       VALUES (?, ?, 'typescript', 'source', 1, 'h', 'now', '[]', '[]', ?)`,
      ['file:1', 'src/a.ts', 'src/a.ts'],
    );
    db.run(
      `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, range_start, range_end, hash, search_text)
       VALUES (?, ?, ?, 'function', 1, 5, 1, 5, 'h', ?)`,
      ['sym:1', 'file:1', 'foo', 'foo'],
    );
    db.run(
      `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, range_start, range_end, hash, search_text)
       VALUES (?, ?, ?, 'function', 10, 20, 10, 20, 'h', ?)`,
      ['sym:2', 'file:1', 'bar', 'bar'],
    );
    expect(countIndexedNodes(db)).toBe(3);
  });

  it('sums files and symbols across multiple files', () => {
    const db = getDatabaseSync();
    db.run(
      `INSERT INTO files (id, path, language, role, size, hash, indexed_at, exports, imports, search_text)
       VALUES (?, ?, 'typescript', 'source', 1, 'h', 'now', '[]', '[]', ?)`,
      ['file:1', 'src/a.ts', 'src/a.ts'],
    );
    db.run(
      `INSERT INTO files (id, path, language, role, size, hash, indexed_at, exports, imports, search_text)
       VALUES (?, ?, 'typescript', 'source', 1, 'h', 'now', '[]', '[]', ?)`,
      ['file:2', 'src/b.ts', 'src/b.ts'],
    );
    db.run(
      `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, range_start, range_end, hash, search_text)
       VALUES (?, ?, ?, 'function', 1, 5, 1, 5, 'h', ?)`,
      ['sym:1', 'file:1', 'foo', 'foo'],
    );
    db.run(
      `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, range_start, range_end, hash, search_text)
       VALUES (?, ?, ?, 'function', 1, 10, 1, 10, 'h', ?)`,
      ['sym:2', 'file:2', 'bar', 'bar'],
    );
    expect(countIndexedNodes(db)).toBe(4);
  });
});
