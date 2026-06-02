/**
 * Code Memory Graph — Graph Engine
 *
 * Core graph operations on the SQLite edges table:
 * - Neighbor queries (incoming/outgoing)
 * - Path finding (BFS shortest path)
 * - Reachability checks
 * - Sub-graph extraction
 *
 * Optimized: uses recursive CTEs to avoid N+1 query patterns.
 */

import type { SqlJsDatabase } from '../storage/database.js';
import type { EdgeType, FileRole, GraphNode, GraphEdge, GraphPath, SubGraph, SymbolKind } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('graph-engine');

export class GraphEngine {
  private db: SqlJsDatabase;
  private _supportsRecursiveCte: boolean | null = null;

  constructor(db: SqlJsDatabase) {
    this.db = db;
  }

  /**
   * Check if the database supports recursive CTEs (SQLite 3.8.3+).
   * Cached after first check.
   */
  private supportsRecursiveCte(): boolean {
    if (this._supportsRecursiveCte !== null) return this._supportsRecursiveCte;
    try {
      this.db.exec('WITH RECURSIVE _cte_check(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM _cte_check WHERE x<1) SELECT x FROM _cte_check');
      this._supportsRecursiveCte = true;
    } catch {
      this._supportsRecursiveCte = false;
    }
    return this._supportsRecursiveCte;
  }

  /**
   * Get all outgoing neighbors of a node.
   */
  getOutgoingNeighbors(nodeId: string, edgeType?: EdgeType): GraphEdge[] {
    return this.getEdges(nodeId, 'outgoing', edgeType);
  }

  /**
   * Get all incoming neighbors of a node.
   */
  getIncomingNeighbors(nodeId: string, edgeType?: EdgeType): GraphEdge[] {
    return this.getEdges(nodeId, 'incoming', edgeType);
  }

  /**
   * Get both incoming and outgoing neighbors.
   */
  getAllNeighbors(nodeId: string, edgeType?: EdgeType): GraphEdge[] {
    return [
      ...this.getEdges(nodeId, 'outgoing', edgeType),
      ...this.getEdges(nodeId, 'incoming', edgeType),
    ];
  }

  /**
   * Find the shortest path between two nodes (BFS).
   * Uses a recursive CTE with predecessor tracking when available,
   * falls back to in-memory BFS otherwise.
   */
  findPath(fromId: string, toId: string, maxDepth: number = 5): GraphPath | null {
    if (this.supportsRecursiveCte()) {
      return this.findPathCte(fromId, toId, maxDepth);
    }
    return this.findPathFallback(fromId, toId, maxDepth);
  }

  /**
   * Check if node B is reachable from node A.
   */
  isReachable(fromId: string, toId: string, maxDepth: number = 5): boolean {
    return this.findPath(fromId, toId, maxDepth) !== null;
  }

  /**
   * Extract a sub-graph around a set of center nodes.
   * Uses a recursive CTE to fetch all reachable nodes and edges in one query
   * when available, falls back to per-node BFS otherwise.
   */
  extractSubGraph(centerNodeIds: string[], depth: number = 1, edgeTypes?: EdgeType[]): SubGraph {
    if (this.supportsRecursiveCte()) {
      return this.extractSubGraphCte(centerNodeIds, depth, edgeTypes);
    }
    return this.extractSubGraphFallback(centerNodeIds, depth, edgeTypes);
  }

  /**
   * Get the call graph for a symbol: who it calls and who calls it.
   */
  getCallGraph(symbolId: string, depth: number = 1): SubGraph {
    return this.extractSubGraph([symbolId], depth, ['CALLS']);
  }

  /**
   * Get the dependency graph for a file: what it imports and what imports it.
   */
  getDependencyGraph(fileId: string, depth: number = 1): SubGraph {
    return this.extractSubGraph([fileId], depth, ['IMPORTS']);
  }

  /**
   * Get the inheritance graph: extends/implements relationships.
   */
  getInheritanceGraph(symbolId: string, depth: number = 2): SubGraph {
    return this.extractSubGraph([symbolId], depth, ['EXTENDS', 'IMPLEMENTS']);
  }

  // ============================================================
  // CTE-based optimized implementations
  // ============================================================

  /**
   * CTE-based sub-graph extraction: fetches all reachable nodes and edges
   * in a single recursive CTE query, then batch-loads node info.
   */
  private extractSubGraphCte(centerNodeIds: string[], depth: number, edgeTypes?: EdgeType[]): SubGraph {
    if (centerNodeIds.length === 0) return { nodes: [], edges: [] };

    const edgeTypeFilter = edgeTypes && edgeTypes.length > 0;
    const params: unknown[] = [];

    // Build seed VALUES clause
    const seedValues = centerNodeIds.map((id) => {
      params.push(id);
      return `(?, 0)`;
    }).join(', ');

    // Build edge type filter condition (used in both recursive branches)
    let edgeTypeCondition = '';
    const firstBranchEdgeParams: unknown[] = [];
    const secondBranchEdgeParams: unknown[] = [];
    if (edgeTypeFilter) {
      const placeholders = edgeTypes!.map(() => '?').join(', ');
      edgeTypeCondition = `AND e.type IN (${placeholders})`;
      for (const t of edgeTypes!) {
        firstBranchEdgeParams.push(t);
        secondBranchEdgeParams.push(t);
      }
    }

    params.push(depth); // depth param for first branch
    params.push(...firstBranchEdgeParams);
    params.push(depth); // depth param for second branch
    params.push(...secondBranchEdgeParams);

    // CTE traverses both outgoing and incoming edges
    const finalSql = `
      WITH RECURSIVE graph_traverse(id, depth) AS (
        VALUES ${seedValues}
        UNION ALL
        SELECT e.to_id, gt.depth + 1
        FROM graph_traverse gt
        JOIN edges e ON e.from_id = gt.id
        WHERE gt.depth < ? ${edgeTypeCondition}
        UNION ALL
        SELECT e.from_id, gt.depth + 1
        FROM graph_traverse gt
        JOIN edges e ON e.to_id = gt.id
        WHERE gt.depth < ? ${edgeTypeCondition}
      )
      SELECT DISTINCT id FROM graph_traverse
    `;

    let discoveredIds: string[];
    try {
      const results = this.db.exec(finalSql, params);
      discoveredIds = results.length > 0
        ? results[0].values.map((row) => String(row[0]))
        : [...centerNodeIds];
    } catch (err) {
      log.warn(`CTE sub-graph extraction failed, falling back: ${err instanceof Error ? err.message : String(err)}`);
      this._supportsRecursiveCte = false;
      return this.extractSubGraphFallback(centerNodeIds, depth, edgeTypes);
    }

    // Batch-load all node info in one query
    const nodeMap = this.batchGetNodeInfo(discoveredIds);

    // Fetch all edges between discovered nodes in one query
    const edges = this.batchGetEdges(discoveredIds, edgeTypes);

    return {
      nodes: Array.from(nodeMap.values()),
      edges,
    };
  }

  /**
   * CTE-based shortest path finding using predecessor tracking.
   * The CTE builds a predecessor map, then we reconstruct the path.
   */
  private findPathCte(fromId: string, toId: string, maxDepth: number): GraphPath | null {
    const params: unknown[] = [fromId, maxDepth];

    const cteSql = `
      WITH RECURSIVE path_search(id, predecessor, edge_from, edge_to, edge_type, edge_confidence, depth) AS (
        SELECT ?, NULL, NULL, NULL, NULL, NULL, 0
        UNION ALL
        SELECT e.to_id, ps.id, e.from_id, e.to_id, e.type, e.confidence, ps.depth + 1
        FROM path_search ps
        JOIN edges e ON e.from_id = ps.id
        WHERE ps.depth < ?
          AND e.to_id NOT IN (SELECT id FROM path_search)
      )
      SELECT id, predecessor, edge_from, edge_to, edge_type, edge_confidence, depth
      FROM path_search
    `;

    let rows: Array<{ id: string; predecessor: string | null; edge_from: string | null; edge_to: string | null; edge_type: string | null; edge_confidence: number | null; depth: number }>;
    try {
      const results = this.db.exec(cteSql, params);
      if (results.length === 0 || results[0].values.length === 0) return null;

      rows = results[0].values.map((row) => ({
        id: String(row[0]),
        predecessor: row[1] !== null ? String(row[1]) : null,
        edge_from: row[2] !== null ? String(row[2]) : null,
        edge_to: row[3] !== null ? String(row[3]) : null,
        edge_type: row[4] !== null ? String(row[4]) : null,
        edge_confidence: row[5] !== null ? Number(row[5]) : null,
        depth: Number(row[6]),
      }));
    } catch (err) {
      log.warn(`CTE path finding failed, falling back: ${err instanceof Error ? err.message : String(err)}`);
      this._supportsRecursiveCte = false;
      return this.findPathFallback(fromId, toId, maxDepth);
    }

    // Find the target node in results
    const targetRow = rows.find((r) => r.id === toId);
    if (!targetRow) return null;

    // Reconstruct path by following predecessors backwards
    const pathIds: string[] = [toId];
    const pathEdges: GraphEdge[] = [];
    let current = targetRow;

    while (current.predecessor !== null) {
      pathIds.unshift(current.predecessor);
      if (current.edge_from !== null && current.edge_to !== null && current.edge_type !== null) {
        pathEdges.unshift({
          from: current.edge_from,
          to: current.edge_to,
          type: current.edge_type as EdgeType,
          confidence: current.edge_confidence ?? 1.0,
        });
      }
      const pred = rows.find((r) => r.id === current.predecessor);
      if (!pred) break;
      current = pred;
    }

    // Batch-load node info for path
    const nodeMap = this.batchGetNodeInfo(pathIds);
    const nodes = pathIds.map((id) => nodeMap.get(id) ?? this.getNodeInfoFallback(id));

    return {
      nodes,
      edges: pathEdges,
      totalWeight: pathEdges.reduce((sum, e) => sum + (1 - e.confidence), 0),
    };
  }

  // ============================================================
  // Fallback implementations (original BFS approach)
  // ============================================================

  private findPathFallback(fromId: string, toId: string, maxDepth: number): GraphPath | null {
    const visited = new Set<string>();
    const queue: Array<{ id: string; path: string[]; edges: GraphEdge[] }> = [
      { id: fromId, path: [fromId], edges: [] },
    ];
    visited.add(fromId);

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current.id === toId) {
        const nodeMap = this.batchGetNodeInfo(current.path);
        const nodes = current.path.map((id) => nodeMap.get(id) ?? this.getNodeInfoFallback(id));
        return {
          nodes,
          edges: current.edges,
          totalWeight: current.edges.reduce((sum, e) => sum + (1 - e.confidence), 0),
        };
      }

      if (current.path.length >= maxDepth + 1) continue;

      const outEdges = this.getEdges(current.id, 'outgoing');
      for (const edge of outEdges) {
        if (visited.has(edge.to)) continue;
        visited.add(edge.to);
        queue.push({
          id: edge.to,
          path: [...current.path, edge.to],
          edges: [...current.edges, edge],
        });
      }
    }

    return null;
  }

  private extractSubGraphFallback(centerNodeIds: string[], depth: number, edgeTypes?: EdgeType[]): SubGraph {
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const visited = new Set<string>();

    // Add center nodes
    for (const id of centerNodeIds) {
      if (!visited.has(id)) {
        visited.add(id);
        nodes.set(id, this.getNodeInfoFallback(id));
      }
    }

    // BFS expansion
    let frontier = [...centerNodeIds];

    for (let d = 0; d < depth; d++) {
      const nextFrontier: string[] = [];

      for (const nodeId of frontier) {
        const outEdges = this.getEdges(nodeId, 'outgoing');
        const inEdges = this.getEdges(nodeId, 'incoming');

        for (const edge of [...outEdges, ...inEdges]) {
          if (edgeTypes && !edgeTypes.includes(edge.type)) continue;

          edges.push(edge);

          const neighborId = edge.from === nodeId ? edge.to : edge.from;
          if (!visited.has(neighborId)) {
            visited.add(neighborId);
            nodes.set(neighborId, this.getNodeInfoFallback(neighborId));
            nextFrontier.push(neighborId);
          }
        }
      }

      frontier = nextFrontier;
    }

    return {
      nodes: Array.from(nodes.values()),
      edges,
    };
  }

  // ============================================================
  // Batch query helpers
  // ============================================================

  /**
   * Batch-load node info for multiple IDs using a single LEFT JOIN query.
   * Returns a Map of nodeId -> GraphNode.
   */
  private batchGetNodeInfo(nodeIds: string[]): Map<string, GraphNode> {
    const result = new Map<string, GraphNode>();
    if (nodeIds.length === 0) return result;

    // Deduplicate
    const uniqueIds = [...new Set(nodeIds)];
    if (uniqueIds.length === 1) {
      result.set(uniqueIds[0], this.getNodeInfoFallback(uniqueIds[0]));
      return result;
    }

    try {
      // Step 1: Query all symbols with file paths in one LEFT JOIN query
      const placeholders = uniqueIds.map(() => '?').join(', ');
      const params = [...uniqueIds];
      const symSql = `
        SELECT s.id, s.name, s.kind, s.start_line, s.end_line, s.start_column, s.end_column, f.path AS file_path
        FROM symbols s
        LEFT JOIN files f ON f.id = s.file_id
        WHERE s.id IN (${placeholders})
      `;
      const symResults = this.db.exec(symSql, params);

      const foundAsSymbol = new Set<string>();
      if (symResults.length > 0) {
        for (const row of symResults[0].values) {
          const id = String(row[0]);
          foundAsSymbol.add(id);
          result.set(id, {
            id,
            type: 'symbol',
            label: String(row[1]),
            kind: String(row[2]) as SymbolKind,
            filePath: row[7] !== null ? String(row[7]) : null,
            lineRange: [Number(row[3]), Number(row[4])],
            columnRange: [Number(row[5]), Number(row[6])],
          });
        }
      }

      // Step 2: For IDs not found as symbols, query files
      const remainingIds = uniqueIds.filter((id) => !foundAsSymbol.has(id));
      if (remainingIds.length > 0) {
        const filePlaceholders = remainingIds.map(() => '?').join(', ');
        const fileSql = `SELECT id, path, role FROM files WHERE id IN (${filePlaceholders})`;
        const fileResults = this.db.exec(fileSql, remainingIds);

        const foundAsFile = new Set<string>();
        if (fileResults.length > 0) {
          for (const row of fileResults[0].values) {
            const id = String(row[0]);
            foundAsFile.add(id);
            result.set(id, {
              id,
              type: 'file',
              label: String(row[1]),
              kind: String(row[2]) as FileRole,
              filePath: String(row[1]),
              lineRange: null,
              columnRange: null,
            });
          }
        }

        // Step 3: For IDs not found anywhere, create fallback nodes
        for (const id of remainingIds) {
          if (!foundAsFile.has(id)) {
            result.set(id, {
              id,
              type: 'file',
              label: id,
              kind: 'source' as FileRole,
              filePath: null,
              lineRange: null,
              columnRange: null,
            });
          }
        }
      }
    } catch (err) {
      log.warn(`Batch node info query failed, falling back to per-node: ${err instanceof Error ? err.message : String(err)}`);
      for (const id of nodeIds) {
        if (!result.has(id)) {
          result.set(id, this.getNodeInfoFallback(id));
        }
      }
    }

    return result;
  }

  /**
   * Batch-load all edges between a set of node IDs.
   * Returns edges where both endpoints are in the set.
   */
  private batchGetEdges(nodeIds: string[], edgeTypes?: EdgeType[]): GraphEdge[] {
    if (nodeIds.length === 0) return [];

    const edges: GraphEdge[] = [];

    try {
      const placeholders = nodeIds.map(() => '?').join(', ');
      const params: unknown[] = [...nodeIds];

      let sql = `SELECT from_id, to_id, type, confidence FROM edges WHERE from_id IN (${placeholders}) AND to_id IN (${placeholders})`;
      params.push(...nodeIds); // second set for to_id

      if (edgeTypes && edgeTypes.length > 0) {
        const typePlaceholders = edgeTypes.map(() => '?').join(', ');
        sql += ` AND type IN (${typePlaceholders})`;
        params.push(...edgeTypes);
      }

      const results = this.db.exec(sql, params);
      if (results.length > 0) {
        for (const row of results[0].values) {
          edges.push({
            from: String(row[0]),
            to: String(row[1]),
            type: String(row[2]) as EdgeType,
            confidence: Number(row[3]),
          });
        }
      }
    } catch (err) {
      log.warn(`Batch edges query failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return edges;
  }

  // ============================================================
  // Private helpers
  // ============================================================

  private getEdges(nodeId: string, direction: 'incoming' | 'outgoing', edgeType?: EdgeType): GraphEdge[] {
    const edges: GraphEdge[] = [];

    try {
      if (direction === 'outgoing') {
        let sql = 'SELECT from_id, to_id, type, confidence FROM edges WHERE from_id = ?';
        const params: string[] = [nodeId];
        if (edgeType) {
          sql += ' AND type = ?';
          params.push(edgeType);
        }
        const results = this.db.exec(sql, params);
        if (results.length > 0) {
          for (const row of results[0].values) {
            edges.push({
              from: String(row[0]),
              to: String(row[1]),
              type: String(row[2]) as EdgeType,
              confidence: Number(row[3]),
            });
          }
        }
      } else {
        let sql = 'SELECT from_id, to_id, type, confidence FROM edges WHERE to_id = ?';
        const params: string[] = [nodeId];
        if (edgeType) {
          sql += ' AND type = ?';
          params.push(edgeType);
        }
        const results = this.db.exec(sql, params);
        if (results.length > 0) {
          for (const row of results[0].values) {
            edges.push({
              from: String(row[0]),
              to: String(row[1]),
              type: String(row[2]) as EdgeType,
              confidence: Number(row[3]),
            });
          }
        }
      }
    } catch (err) {
      log.warn(`Failed to get edges for ${nodeId}: ${err instanceof Error ? err.message : String(err)}`);
    }

    return edges;
  }

  /**
   * Single-node info lookup (used as fallback and for individual queries).
   */
  private getNodeInfoFallback(nodeId: string): GraphNode {
    // Try as symbol first
    try {
      const symResult = this.db.exec(
        `SELECT name, kind, file_id, start_line, end_line, start_column, end_column
         FROM symbols WHERE id = ?`,
        [nodeId],
      );
      if (symResult.length > 0 && symResult[0].values.length > 0) {
        const row = symResult[0].values[0];
        let filePath: string | null = null;
        try {
          const fileResult = this.db.exec('SELECT path FROM files WHERE id = ?', [String(row[2])]);
          if (fileResult.length > 0 && fileResult[0].values.length > 0) {
            filePath = String(fileResult[0].values[0][0]);
          }
        } catch { /* use null */ }

        return {
          id: nodeId,
          type: 'symbol',
          label: String(row[0]),
          kind: String(row[1]) as SymbolKind,
          filePath,
          lineRange: [Number(row[3]), Number(row[4])],
          columnRange: [Number(row[5]), Number(row[6])],
        };
      }
    } catch { /* try as file */ }

    // Try as file
    try {
      const fileResult = this.db.exec(
        'SELECT path, role FROM files WHERE id = ?',
        [nodeId],
      );
      if (fileResult.length > 0 && fileResult[0].values.length > 0) {
        const row = fileResult[0].values[0];
        return {
          id: nodeId,
          type: 'file',
          label: String(row[0]),
          kind: String(row[1]) as FileRole,
          filePath: String(row[0]),
          lineRange: null,
          columnRange: null,
        };
      }
    } catch { /* fallback */ }

    return {
      id: nodeId,
      type: 'file',
      label: nodeId,
      kind: 'source',
      filePath: null,
      lineRange: null,
      columnRange: null,
    };
  }
}
