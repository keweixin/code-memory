/**
 * Code Memory Graph — Graph Engine
 *
 * Core graph operations on the SQLite edges table:
 * - Neighbor queries (incoming/outgoing)
 * - Path finding (BFS shortest path)
 * - Reachability checks
 * - Sub-graph extraction
 */

import type { Database as SqlJsDatabase } from 'sql.js';
import type { EdgeType, GraphNode, GraphEdge, SubGraph, GraphPath } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('graph-engine');

export class GraphEngine {
  private db: SqlJsDatabase;

  constructor(db: SqlJsDatabase) {
    this.db = db;
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
   */
  findPath(fromId: string, toId: string, maxDepth: number = 5): GraphPath | null {
    const visited = new Set<string>();
    const queue: Array<{ id: string; path: string[]; edges: GraphEdge[] }> = [
      { id: fromId, path: [fromId], edges: [] },
    ];
    visited.add(fromId);

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current.id === toId) {
        const nodes = current.path.map((id) => this.getNodeInfo(id));
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

  /**
   * Check if node B is reachable from node A.
   */
  isReachable(fromId: string, toId: string, maxDepth: number = 5): boolean {
    return this.findPath(fromId, toId, maxDepth) !== null;
  }

  /**
   * Extract a sub-graph around a set of center nodes.
   */
  extractSubGraph(centerNodeIds: string[], depth: number = 1, edgeTypes?: EdgeType[]): SubGraph {
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const visited = new Set<string>();

    // Add center nodes
    for (const id of centerNodeIds) {
      if (!visited.has(id)) {
        visited.add(id);
        nodes.set(id, this.getNodeInfo(id));
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
          // Filter by edge type if specified
          if (edgeTypes && !edgeTypes.includes(edge.type)) continue;

          edges.push(edge);

          const neighborId = edge.from === nodeId ? edge.to : edge.from;
          if (!visited.has(neighborId)) {
            visited.add(neighborId);
            nodes.set(neighborId, this.getNodeInfo(neighborId));
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

  private getNodeInfo(nodeId: string): GraphNode {
    // Try as symbol first
    try {
      const symResult = this.db.exec(
        'SELECT name, kind, file_id FROM symbols WHERE id = ?',
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
          kind: String(row[1]) as any,
          filePath,
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
          kind: String(row[1]) as any,
          filePath: String(row[0]),
        };
      }
    } catch { /* fallback */ }

    return {
      id: nodeId,
      type: 'file',
      label: nodeId,
      kind: 'source',
      filePath: null,
    };
  }
}
