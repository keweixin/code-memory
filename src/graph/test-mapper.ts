/**
 * Code Memory Graph — Test Mapper
 *
 * Identifies relationships between source code and test files.
 * Uses multiple heuristics:
 * 1. Direct TESTS edges from the graph
 * 2. Naming convention matching (foo.test.ts ↔ foo.ts)
 * 3. Directory structure matching (src/ → tests/)
 * 4. Symbol name matching (describe/test blocks → function names)
 */

import type { SqlJsDatabase } from '../storage/database.js';
import type { SymbolRecord, SymbolKind } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('test-mapper');

export interface TestMapping {
  sourceFile: string;
  sourceSymbols: string[];
  testFile: string;
  testSymbols: string[];
  confidence: number;
  matchMethod: 'graph_edge' | 'naming_convention' | 'directory_structure' | 'symbol_match';
}

export class TestMapper {
  private db: SqlJsDatabase;

  constructor(db: SqlJsDatabase) {
    this.db = db;
  }

  /**
   * Find test files related to a given source file or symbol.
   */
  findRelatedTests(target: string): TestMapping[] {
    const mappings: TestMapping[] = [];

    // Method 1: Graph edges
    const graphMappings = this.findByGraphEdges(target);
    mappings.push(...graphMappings);

    // Method 2: Naming convention
    const namingMappings = this.findByNamingConvention(target);
    for (const nm of namingMappings) {
      if (!mappings.some((m) => m.testFile === nm.testFile)) {
        mappings.push(nm);
      }
    }

    // Method 3: Directory structure
    const dirMappings = this.findByDirectoryStructure(target);
    for (const dm of dirMappings) {
      if (!mappings.some((m) => m.testFile === dm.testFile)) {
        mappings.push(dm);
      }
    }

    return mappings;
  }

  /**
   * Get a list of all test files that cover a given source file.
   */
  getTestCoverage(sourceFile: string): string[] {
    const mappings = this.findRelatedTests(sourceFile);
    return [...new Set(mappings.map((m) => m.testFile))];
  }

  /**
   * Get all source files covered by a given test file.
   */
  getTestedFiles(testFile: string): string[] {
    const allFiles = this.getAllFiles();
    const covered: string[] = [];

    for (const file of allFiles) {
      if (file.role !== 'source') continue;

      const tests = this.findRelatedTests(file.path);
      if (tests.some((t) => t.testFile === testFile)) {
        covered.push(file.path);
      }
    }

    return covered;
  }

  /**
   * Get a coverage summary: which source files have tests and which don't.
   */
  getCoverageSummary(): { covered: string[]; uncovered: string[]; coveragePercent: number } {
    const allSourceFiles = this.getAllFiles().filter((f) => f.role === 'source');
    const covered: string[] = [];
    const uncovered: string[] = [];

    for (const file of allSourceFiles) {
      const tests = this.getTestCoverage(file.path);
      if (tests.length > 0) {
        covered.push(file.path);
      } else {
        uncovered.push(file.path);
      }
    }

    const total = covered.length + uncovered.length;
    const coveragePercent = total > 0 ? Math.round((covered.length / total) * 100) : 0;

    return { covered, uncovered, coveragePercent };
  }

  // ============================================================
  // Private
  // ============================================================

  private findByGraphEdges(target: string): TestMapping[] {
    const mappings: TestMapping[] = [];

    // Find file ID for target
    const fileResults = this.db.exec(
      'SELECT id, path FROM files WHERE path LIKE ? OR id LIKE ?',
      [`%${target}%`, `%${target}%`],
    );

    if (!fileResults.length) return mappings;

    for (const row of fileResults[0].values) {
      const fileId = String(row[0]);
      const filePath = String(row[1]);

      // Look for TESTS edges from this file
      const edgeResults = this.db.exec(
        "SELECT from_id, to_id FROM edges WHERE type = 'TESTS' AND (from_id = ? OR to_id = ?)",
        [fileId, fileId],
      );

      if (edgeResults.length > 0) {
        for (const edgeRow of edgeResults[0].values) {
          const testId = String(edgeRow[0]);
          const testFilePath = this.getFilePathById(testId);

          if (testFilePath && this.isTestFile(testFilePath)) {
            mappings.push({
              sourceFile: filePath,
              sourceSymbols: [],
              testFile: testFilePath,
              testSymbols: [],
              confidence: 1.0,
              matchMethod: 'graph_edge',
            });
          }
        }
      }
    }

    return mappings;
  }

  private findByNamingConvention(target: string): TestMapping[] {
    const mappings: TestMapping[] = [];

    // Try all common test naming patterns
    const cleanTarget = target.replace(/\.[^.]+$/, ''); // remove extension
    const patterns = [
      `${cleanTarget}.test`,
      `${cleanTarget}.spec`,
      `__tests__/${target.split('/').pop()}`,
    ];

    for (const pattern of patterns) {
      const results = this.db.exec(
        'SELECT path FROM files WHERE path LIKE ? AND role = ?',
        [`%${pattern}%`, 'test'],
      );

      if (results.length > 0) {
        for (const row of results[0].values) {
          const testPath = String(row[0]);
          mappings.push({
            sourceFile: target,
            sourceSymbols: [],
            testFile: testPath,
            testSymbols: [],
            confidence: 0.8,
            matchMethod: 'naming_convention',
          });
        }
      }
    }

    return mappings;
  }

  private findByDirectoryStructure(target: string): TestMapping[] {
    const mappings: TestMapping[] = [];

    // Try replacing src/ with tests/ or appending /__tests__/
    const alternatives = [
      target.replace(/^src\//, 'tests/').replace(/^src\//, 'test/'),
      target.replace(/^app\//, 'tests/app/'),
    ];

    for (const alt of alternatives) {
      const results = this.db.exec(
        'SELECT path FROM files WHERE path LIKE ? AND role = ?',
        [`%${alt.replace(/\.[^.]+$/, '')}%`, 'test'],
      );

      if (results.length > 0) {
        for (const row of results[0].values) {
          const testPath = String(row[0]);
          mappings.push({
            sourceFile: target,
            sourceSymbols: [],
            testFile: testPath,
            testSymbols: [],
            confidence: 0.6,
            matchMethod: 'directory_structure',
          });
        }
      }
    }

    return mappings;
  }

  private getFilePathById(id: string): string | null {
    try {
      const results = this.db.exec('SELECT path FROM files WHERE id = ?', [id]);
      if (results.length > 0 && results[0].values.length > 0) {
        return String(results[0].values[0][0]);
      }
    } catch { /* not found */ }
    return null;
  }

  private isTestFile(path: string): boolean {
    const testPatterns = ['.test.', '.spec.', '/tests/', '/__tests__/', 'test/', 'spec/'];
    return testPatterns.some((p) => path.includes(p));
  }

  private getAllFiles(): Array<{ path: string; role: string; language: string }> {
    try {
      const results = this.db.exec('SELECT path, role, language FROM files');
      if (results.length > 0) {
        return results[0].values.map((row) => ({
          path: String(row[0]),
          role: String(row[1]),
          language: String(row[2]),
        }));
      }
    } catch { /* empty */ }
    return [];
  }
}
