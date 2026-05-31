/**
 * Code Memory Graph — Impact Analyzer
 *
 * Analyzes the blast radius of a code change:
 * - Who calls this symbol? (callers)
 * - What does this symbol call? (callees)
 * - What tests cover this? (test coverage)
 * - What config affects this? (configuration)
 * - Risk assessment
 */

import type { SqlJsDatabase } from '../storage/database.js';
import type { ImpactResult, ImpactFile, ImpactSymbol, RiskPoint, RiskLevel } from '../shared/types.js';
import { GraphEngine } from './graph-engine.js';
import { resolveTargetId } from './target-resolver.js';
import { HIGH_RISK_PATTERNS } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('impact-analyzer');

export class ImpactAnalyzer {
  private graphEngine: GraphEngine;
  private db: SqlJsDatabase;

  constructor(db: SqlJsDatabase) {
    this.db = db;
    this.graphEngine = new GraphEngine(db);
  }

  /**
   * Analyze the impact of changing a file or symbol.
   */
  analyze(target: string): ImpactResult {
    log.info(`Analyzing impact for: ${target}`);

    const targetId = resolveTargetId(this.db, target);

    if (!targetId) {
      return {
        target,
        affectedFiles: [],
        affectedSymbols: [],
        relatedTests: [],
        relatedConfigs: [],
        riskPoints: [],
        callChain: [],
      };
    }

    // Collect callers (who depends on this?)
    const callers = this.findCallers(targetId, 3);
    const callees = this.findCallees(targetId, 2);
    const references = this.findReferences(targetId, 2);
    const tests = this.findRelatedTests(targetId);
    const configs = this.findRelatedConfigs(targetId);
    const risks = this.assessRisks(target, callers, callees);

    // Build call chain
    const callChain = this.buildCallChain(targetId, callers, callees);

    // Build affected files list
    const affectedFiles = this.buildAffectedFiles(targetId, callers, callees, references, tests);

    return {
      target,
      affectedFiles,
      affectedSymbols: [...callers, ...callees, ...references],
      relatedTests: tests.map((t) => t.filePath),
      relatedConfigs: configs,
      riskPoints: risks,
      callChain,
    };
  }

  /**
   * Find all callers of a symbol (incoming CALLS edges).
   */
  private findCallers(symbolId: string, maxDepth: number): ImpactSymbol[] {
    const callers: ImpactSymbol[] = [];
    const visited = new Set<string>();

    const bfs = (nodeId: string, depth: number) => {
      if (depth > maxDepth || visited.has(nodeId)) return;
      visited.add(nodeId);

      const edges = this.graphEngine.getIncomingNeighbors(nodeId, 'CALLS');
      for (const edge of edges) {
        const symInfo = this.getSymbolInfo(edge.from);
        if (symInfo && !visited.has(edge.from)) {
          callers.push({
            ...symInfo,
            impactType: 'caller',
            distance: depth,
          });
          bfs(edge.from, depth + 1);
        }
      }
    };

    bfs(symbolId, 1);
    return callers;
  }

  /**
   * Find all callees of a symbol (outgoing CALLS edges).
   */
  private findCallees(symbolId: string, maxDepth: number): ImpactSymbol[] {
    const callees: ImpactSymbol[] = [];
    const visited = new Set<string>();

    const bfs = (nodeId: string, depth: number) => {
      if (depth > maxDepth || visited.has(nodeId)) return;
      visited.add(nodeId);

      const edges = this.graphEngine.getOutgoingNeighbors(nodeId, 'CALLS');
      for (const edge of edges) {
        const symInfo = this.getSymbolInfo(edge.to);
        if (symInfo && !visited.has(edge.to)) {
          callees.push({
            ...symInfo,
            impactType: 'callee',
            distance: depth,
          });
          bfs(edge.to, depth + 1);
        }
      }
    };

    bfs(symbolId, 1);
    return callees;
  }

  /**
   * Find all references to a symbol (incoming REFERENCES edges).
   */
  private findReferences(symbolId: string, maxDepth: number): ImpactSymbol[] {
    const refs: ImpactSymbol[] = [];
    const visited = new Set<string>([symbolId]);

      const edges = this.graphEngine.getIncomingNeighbors(symbolId, 'REFERENCES');
    for (const edge of edges) {
      if (visited.has(edge.from)) continue;
      visited.add(edge.from);

      const symInfo = this.getNodeImpactInfo(edge.from);
      if (symInfo) {
        refs.push({
          ...symInfo,
          impactType: 'reference',
          distance: 1,
        });
      }
    }

    return refs;
  }

  /**
   * Find test files related to a symbol.
   */
  private findRelatedTests(symbolId: string): ImpactSymbol[] {
    const tests: ImpactSymbol[] = [];

    // Direct TESTS edges
    const testEdges = this.graphEngine.getIncomingNeighbors(symbolId, 'TESTS');
    for (const edge of testEdges) {
      const symInfo = this.getNodeImpactInfo(edge.from);
      if (symInfo) {
        tests.push({
          ...symInfo,
          impactType: 'reference',
          distance: 1,
        });
      }
    }

    // Also check if the symbol's file has a corresponding test file
    const symInfo = this.getNodeImpactInfo(symbolId);
    if (symInfo) {
      const testFilePaths = this.findTestFilesForPath(symInfo.filePath);
      for (const testPath of testFilePaths) {
        if (!tests.some((t) => t.filePath === testPath)) {
          tests.push({
            name: testPath.split('/').pop() || testPath,
            kind: 'function' as any,
            filePath: testPath,
            impactType: 'reference',
            distance: 1,
          });
        }
      }
    }

    return tests;
  }

  /**
   * Find config files related to a symbol.
   */
  private findRelatedConfigs(symbolId: string): string[] {
    const configs: string[] = [];
    const configuredFileId = this.getConfiguredFileId(symbolId);
    if (!configuredFileId) return configs;

    // CONFIGURES edges are file-level: config file -> configured source/test file.
    // Symbol impact needs to inherit the configuration of its containing file.
    const configEdges = this.graphEngine.getIncomingNeighbors(configuredFileId, 'CONFIGURES');
    for (const edge of configEdges) {
      const fileResult = this.db.exec('SELECT path FROM files WHERE id = ?', [edge.from]);
      if (fileResult.length > 0 && fileResult[0].values.length > 0) {
        const path = String(fileResult[0].values[0][0]);
        if (!configs.includes(path)) {
          configs.push(path);
        }
      }
    }

    return configs;
  }

  private getConfiguredFileId(nodeId: string): string | null {
    try {
      const fileResult = this.db.exec('SELECT id FROM files WHERE id = ?', [nodeId]);
      if (fileResult.length > 0 && fileResult[0].values.length > 0) {
        return String(fileResult[0].values[0][0]);
      }

      const symbolResult = this.db.exec('SELECT file_id FROM symbols WHERE id = ?', [nodeId]);
      if (symbolResult.length > 0 && symbolResult[0].values.length > 0) {
        return String(symbolResult[0].values[0][0]);
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * Assess risk points for a change.
   */
  private assessRisks(
    target: string,
    callers: ImpactSymbol[],
    callees: ImpactSymbol[],
  ): RiskPoint[] {
    const risks: RiskPoint[] = [];

    // Check if the target matches high-risk patterns
    for (const pattern of HIGH_RISK_PATTERNS) {
      if (pattern.test(target)) {
        risks.push({
          description: `Target matches high-risk pattern: ${pattern.source}`,
          severity: 'high',
          filePath: target,
          symbolName: null,
        });
        break;
      }
    }

    // High caller count = high impact
    if (callers.length > 10) {
      risks.push({
        description: `High impact: ${callers.length} callers depend on this`,
        severity: 'high',
        filePath: target,
        symbolName: null,
      });
    } else if (callers.length > 5) {
      risks.push({
        description: `Medium impact: ${callers.length} callers depend on this`,
        severity: 'medium',
        filePath: target,
        symbolName: null,
      });
    }

    // Deep call chain = complex impact
    const maxDepth = Math.max(
      ...callers.map((c) => c.distance),
      ...callees.map((c) => c.distance),
      0,
    );
    if (maxDepth >= 3) {
      risks.push({
        description: `Deep call chain (depth ${maxDepth}): changes may propagate far`,
        severity: 'medium',
        filePath: target,
        symbolName: null,
      });
    }

    return risks;
  }

  /**
   * Build a human-readable call chain.
   */
  private buildCallChain(
    targetId: string,
    callers: ImpactSymbol[],
    callees: ImpactSymbol[],
  ): string[] {
    const chains: string[] = [];
    const targetInfo = this.getNodeImpactInfo(targetId);

    // Caller chain: who → target
    for (const caller of callers.slice(0, 5)) {
      chains.push(`${caller.name} → ${targetInfo?.name || targetId}`);
    }

    // Callee chain: target → who
    for (const callee of callees.slice(0, 5)) {
      chains.push(`${targetInfo?.name || targetId} → ${callee.name}`);
    }

    return chains;
  }

  // ============================================================
  // Helpers
  // ============================================================

  private getSymbolInfo(symbolId: string): { name: string; kind: any; filePath: string } | null {
    try {
      const result = this.db.exec(
        'SELECT name, kind, file_id FROM symbols WHERE id = ?',
        [symbolId],
      );
      if (result.length > 0 && result[0].values.length > 0) {
        const row = result[0].values[0];
        let filePath = '';
        try {
          const fileResult = this.db.exec('SELECT path FROM files WHERE id = ?', [String(row[2])]);
          if (fileResult.length > 0 && fileResult[0].values.length > 0) {
            filePath = String(fileResult[0].values[0][0]);
          }
        } catch { /* use empty */ }

        return {
          name: String(row[0]),
          kind: String(row[1]),
          filePath,
        };
      }
    } catch { /* not found */ }
    return null;
  }

  private getNodeImpactInfo(nodeId: string): { name: string; kind: any; filePath: string } | null {
    const symbolInfo = this.getSymbolInfo(nodeId);
    if (symbolInfo) return symbolInfo;

    try {
      const result = this.db.exec('SELECT path, role FROM files WHERE id = ?', [nodeId]);
      if (result.length > 0 && result[0].values.length > 0) {
        const row = result[0].values[0];
        const filePath = String(row[0]);
        return {
          name: filePath.split('/').pop() || filePath,
          kind: 'module',
          filePath,
        };
      }
    } catch { /* not a file */ }
    return null;
  }

  private findTestFilesForPath(sourcePath: string): string[] {
    // Try common test file naming conventions
    const testPaths: string[] = [];
    const base = sourcePath.replace(/\.[^.]+$/, '');

    // Same directory: *.test.ts, *.spec.ts
    testPaths.push(`${base}.test.ts`);
    testPaths.push(`${base}.spec.ts`);
    testPaths.push(`${base}.test.js`);
    testPaths.push(`${base}.spec.js`);

    // __tests__ directory
    const dir = sourcePath.substring(0, sourcePath.lastIndexOf('/'));
    const fileName = sourcePath.substring(sourcePath.lastIndexOf('/') + 1);
    testPaths.push(`${dir}/__tests__/${fileName}`);

    // Verify which test files actually exist in the index
    const existing: string[] = [];
    for (const testPath of testPaths) {
      try {
        const result = this.db.exec('SELECT 1 FROM files WHERE path = ?', [testPath]);
        if (result.length > 0 && result[0].values.length > 0) {
          existing.push(testPath);
        }
      } catch { /* skip */ }
    }

    return existing;
  }

  private buildAffectedFiles(
    targetId: string,
    callers: ImpactSymbol[],
    callees: ImpactSymbol[],
    references: ImpactSymbol[],
    tests: ImpactSymbol[],
  ): ImpactFile[] {
    const files = new Map<string, ImpactFile>();

    const addFile = (filePath: string, impactType: 'direct' | 'indirect', distance: number, reason: string) => {
      if (!filePath) return;
      const existing = files.get(filePath);
      if (!existing || existing.distance > distance) {
        files.set(filePath, { path: filePath, impactType, distance, reason });
      }
    };

    // Target's own file
    const targetInfo = this.getNodeImpactInfo(targetId);
    if (targetInfo) {
      addFile(targetInfo.filePath, 'direct', 0, 'Target file');
    }

    // Callers' files
    for (const caller of callers) {
      addFile(caller.filePath, caller.distance <= 1 ? 'direct' : 'indirect', caller.distance, `Caller: ${caller.name}`);
    }

    // Callees' files
    for (const callee of callees) {
      addFile(callee.filePath, callee.distance <= 1 ? 'direct' : 'indirect', callee.distance, `Callee: ${callee.name}`);
    }

    // References' files
    for (const ref of references) {
      addFile(ref.filePath, 'indirect', ref.distance, `Reference: ${ref.name}`);
    }

    // Test files
    for (const test of tests) {
      addFile(test.filePath, 'direct', 1, `Test: ${test.name}`);
    }

    return Array.from(files.values()).sort((a, b) => a.distance - b.distance);
  }
}
