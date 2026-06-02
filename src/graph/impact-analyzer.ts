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
import type { EdgeType, ImpactResult, ImpactFile, ImpactSymbol, RiskPoint, SymbolKind } from '../shared/types.js';
import { resolveTargetId } from './target-resolver.js';
import { HIGH_RISK_PATTERNS } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('impact-analyzer');

interface TraversalRow {
  nodeId: string;
  distance: number;
  path: string[];
  edgeTypes: EdgeType[];
}

interface ImpactNodeInfo {
  id: string;
  name: string;
  kind: SymbolKind;
  filePath: string;
}

export class ImpactAnalyzer {
  private db: SqlJsDatabase;

  constructor(db: SqlJsDatabase) {
    this.db = db;
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
    const implementors = this.findImplementors(targetId, 2);
    const tests = this.findRelatedTests(targetId);
    const configs = this.findRelatedConfigs(targetId);
    const risks = this.assessRisks(target, callers, callees, implementors);

    // Build call chain
    const callChain = this.buildCallChain(targetId, callers, callees);

    // Build affected files list
    const affectedFiles = this.buildAffectedFiles(targetId, callers, callees, references, implementors, tests);

    return {
      target,
      affectedFiles,
      affectedSymbols: [...callers, ...callees, ...references, ...implementors],
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
    return this.findImpactSymbolsByTraversal(symbolId, {
      direction: 'incoming',
      edgeTypes: ['CALLS'],
      maxDepth,
      minConfidence: 0.8,
      impactType: 'caller',
      limit: 500,
    });
  }

  /**
   * Find all callees of a symbol (outgoing CALLS edges).
   */
  private findCallees(symbolId: string, maxDepth: number): ImpactSymbol[] {
    return this.findImpactSymbolsByTraversal(symbolId, {
      direction: 'outgoing',
      edgeTypes: ['CALLS'],
      maxDepth,
      minConfidence: 0.8,
      impactType: 'callee',
      limit: 500,
    });
  }

  /**
   * Find all references to a symbol (incoming REFERENCES edges).
   */
  private findReferences(symbolId: string, maxDepth: number): ImpactSymbol[] {
    return this.findImpactSymbolsByTraversal(symbolId, {
      direction: 'incoming',
      edgeTypes: ['REFERENCES'],
      maxDepth,
      minConfidence: 0,
      impactType: 'reference',
      limit: 500,
      includeFiles: true,
    });
  }

  /**
   * Find classes/interfaces that extend or implement the target.
   */
  private findImplementors(symbolId: string, maxDepth: number): ImpactSymbol[] {
    return this.findImpactSymbolsByTraversal(symbolId, {
      direction: 'incoming',
      edgeTypes: ['IMPLEMENTS', 'EXTENDS'],
      maxDepth,
      minConfidence: 0.8,
      impactType: 'implementor',
      limit: 500,
    });
  }

  /**
   * Find test files related to a symbol.
   */
  private findRelatedTests(symbolId: string): ImpactSymbol[] {
    // Direct TESTS edges
    const tests = this.findImpactSymbolsByTraversal(symbolId, {
      direction: 'incoming',
      edgeTypes: ['TESTS'],
      maxDepth: 1,
      minConfidence: 0,
      impactType: 'reference',
      limit: 200,
      includeFiles: true,
    });

    // Also check if the symbol's file has a corresponding test file
    const symInfo = this.getNodeImpactInfo(symbolId);
    if (symInfo) {
      const testFilePaths = this.findTestFilesForPath(symInfo.filePath);
      for (const testPath of testFilePaths) {
        if (!tests.some((t) => t.filePath === testPath)) {
          tests.push({
            name: testPath.split('/').pop() || testPath,
            kind: 'function' as SymbolKind,
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

    try {
      const rows = this.db.exec(
        `SELECT DISTINCT f.path
         FROM edges e
         JOIN files f ON f.id = e.from_id
         WHERE e.to_id = ? AND e.type = 'CONFIGURES'
         ORDER BY f.path`,
        [configuredFileId],
      )[0]?.values ?? [];
      for (const row of rows) configs.push(String(row[0]));
    } catch {
      return configs;
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
    implementors: ImpactSymbol[],
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

    if (implementors.length > 10) {
      risks.push({
        description: `High interface/inheritance impact: ${implementors.length} implementors or subclasses depend on this`,
        severity: 'high',
        filePath: target,
        symbolName: null,
      });
    } else if (implementors.length > 5) {
      risks.push({
        description: `Medium interface/inheritance impact: ${implementors.length} implementors or subclasses depend on this`,
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

  private findImpactSymbolsByTraversal(
    startNodeId: string,
    options: {
      direction: 'incoming' | 'outgoing';
      edgeTypes: EdgeType[];
      maxDepth: number;
      minConfidence: number;
      impactType: ImpactSymbol['impactType'];
      limit: number;
      includeFiles?: boolean;
    },
  ): ImpactSymbol[] {
    const rows = this.recursiveTraverse(startNodeId, options);
    const infoById = this.getImpactNodeInfoById(rows.map((row) => row.nodeId), Boolean(options.includeFiles));
    const seen = new Set<string>();
    const symbols: ImpactSymbol[] = [];

    for (const row of rows) {
      if (seen.has(row.nodeId)) continue;
      seen.add(row.nodeId);
      const info = infoById.get(row.nodeId);
      if (!info) continue;
      symbols.push({
        name: info.name,
        kind: info.kind,
        filePath: info.filePath,
        impactType: options.impactType,
        distance: row.distance,
      });
    }

    return symbols;
  }

  private recursiveTraverse(
    startNodeId: string,
    options: {
      direction: 'incoming' | 'outgoing';
      edgeTypes: EdgeType[];
      maxDepth: number;
      minConfidence: number;
      limit: number;
    },
  ): TraversalRow[] {
    if (options.maxDepth <= 0 || options.limit <= 0 || options.edgeTypes.length === 0) return [];

    const nextNodeExpr = options.direction === 'incoming' ? 'e.from_id' : 'e.to_id';
    const joinColumn = options.direction === 'incoming' ? 'e.to_id' : 'e.from_id';
    const placeholders = options.edgeTypes.map(() => '?').join(',');
    const params: Array<string | number> = [
      startNodeId,
      startNodeId,
      options.maxDepth,
      options.minConfidence,
      ...options.edgeTypes,
      startNodeId,
      options.limit,
    ];

    try {
      const rows = this.db.exec(
        `WITH RECURSIVE walk(node_id, distance, path, edge_types) AS (
           SELECT ? AS node_id, 0 AS distance, '>' || ? || '>' AS path, '' AS edge_types
           UNION ALL
           SELECT ${nextNodeExpr} AS node_id,
                  walk.distance + 1 AS distance,
                  walk.path || ${nextNodeExpr} || '>' AS path,
                  CASE
                    WHEN walk.edge_types = '' THEN e.type
                    ELSE walk.edge_types || ',' || e.type
                  END AS edge_types
           FROM walk
           JOIN edges e ON ${joinColumn} = walk.node_id
           WHERE walk.distance < ?
             AND e.confidence >= ?
             AND e.type IN (${placeholders})
             AND instr(walk.path, '>' || ${nextNodeExpr} || '>') = 0
         )
         SELECT node_id, MIN(distance) AS distance, MIN(path) AS path, MIN(edge_types) AS edge_types
         FROM walk
         WHERE distance > 0 AND node_id != ?
         GROUP BY node_id
         ORDER BY distance ASC, node_id ASC
         LIMIT ?`,
        params,
      )[0]?.values ?? [];

      return rows.map((row) => ({
        nodeId: String(row[0]),
        distance: Number(row[1]),
        path: String(row[2] || '').split('>').filter(Boolean),
        edgeTypes: String(row[3] || '').split(',').filter(Boolean) as EdgeType[],
      }));
    } catch (err) {
      log.warn(`Impact traversal failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private getImpactNodeInfoById(nodeIds: string[], includeFiles: boolean): Map<string, ImpactNodeInfo> {
    const byId = new Map<string, ImpactNodeInfo>();
    const uniqueIds = [...new Set(nodeIds)];
    if (uniqueIds.length === 0) return byId;

    const placeholders = uniqueIds.map(() => '?').join(',');
    try {
      const symbolRows = this.db.exec(
        `SELECT s.id, s.name, s.kind, f.path
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE s.id IN (${placeholders})`,
        uniqueIds,
      )[0]?.values ?? [];
      for (const row of symbolRows) {
        byId.set(String(row[0]), {
          id: String(row[0]),
          name: String(row[1]),
          kind: String(row[2]) as SymbolKind,
          filePath: String(row[3]),
        });
      }

      if (includeFiles) {
        const fileRows = this.db.exec(
          `SELECT id, path, role
           FROM files
           WHERE id IN (${placeholders})`,
          uniqueIds,
        )[0]?.values ?? [];
        for (const row of fileRows) {
          const filePath = String(row[1]);
          byId.set(String(row[0]), {
            id: String(row[0]),
            name: filePath.split('/').pop() || filePath,
            kind: 'module',
            filePath,
          });
        }
      }
    } catch {
      return byId;
    }

    return byId;
  }

  private getSymbolInfo(symbolId: string): { name: string; kind: SymbolKind; filePath: string } | null {
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
          kind: String(row[1]) as SymbolKind,
          filePath,
        };
      }
    } catch { /* not found */ }
    return null;
  }

  private getNodeImpactInfo(nodeId: string): { name: string; kind: SymbolKind; filePath: string } | null {
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
    implementors: ImpactSymbol[],
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

    // Interface implementors and subclasses
    for (const impl of implementors) {
      addFile(impl.filePath, impl.distance <= 1 ? 'direct' : 'indirect', impl.distance, `Implementor/subclass: ${impl.name}`);
    }

    // Test files
    for (const test of tests) {
      addFile(test.filePath, 'direct', 1, `Test: ${test.name}`);
    }

    return Array.from(files.values()).sort((a, b) => a.distance - b.distance);
  }
}
