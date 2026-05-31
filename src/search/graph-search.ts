/**
 * Code Memory Graph — Graph Search
 *
 * BFS/DFS traversal of the graph stored in SQLite edges table.
 * Used for: neighbor expansion, path finding, reachability.
 */

import type { Database as SqlJsDatabase } from 'sql.js';
import type { EdgeType, EdgeRecord } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('graph-search');

export interface GraphSearchOptions {
  startNodeIds: string[];
  direction: 'outgoing' | 'incoming' | 'both';
  edgeTypes?: EdgeType[];
  maxHops: number;
  maxNodes: number;
}

export interface GraphSearchResult {
  nodeId: string;
  distance: number;
  path: string[];
  edgeTypes: EdgeType[];
}

/**
 * BFS graph traversal from a set of starting nodes.
 * Returns all reachable nodes within maxHops hops.
 */
export function bfsExpand(
  db: SqlJsDatabase,
  options: GraphSearchOptions,
): GraphSearchResult[] {
  const { startNodeIds, direction, edgeTypes, maxHops, maxNodes = 1000 } = options;

  const visited = new Map<string, GraphSearchResult>();
  const queue: Array<{ id: string; distance: number; path: string[]; edgeTypes: EdgeType[] }> = [];

  // Initialize queue with start nodes
  const initialQueue: typeof queue = [];
  for (const id of startNodeIds) {
    initialQueue.push({ id, distance: 0, path: [id], edgeTypes: [] });
    visited.set(id, { nodeId: id, distance: 0, path: [id], edgeTypes: [] });
  }

  let currentQueue = initialQueue;

  for (let hop = 0; hop < maxHops; hop++) {
    const nextQueue: typeof queue = [];

    for (const current of currentQueue) {
      if (visited.size >= maxNodes) break;

      const neighbors = getNeighbors(db, current.id, direction, edgeTypes);

      for (const neighbor of neighbors) {
        if (visited.has(neighbor.id)) continue;
        if (visited.size >= maxNodes) break;

        const newPath = [...current.path, neighbor.id];
        const newEdgeTypes = [...current.edgeTypes, neighbor.edgeType];

        const result: GraphSearchResult = {
          nodeId: neighbor.id,
          distance: hop + 1,
          path: newPath,
          edgeTypes: newEdgeTypes,
        };

        visited.set(neighbor.id, result);
        nextQueue.push({
          id: neighbor.id,
          distance: hop + 1,
          path: newPath,
          edgeTypes: newEdgeTypes,
        });
      }
    }

    currentQueue = nextQueue;
    if (currentQueue.length === 0) break;
  }

  // Return results sorted by distance
  return Array.from(visited.values())
    .filter((r) => r.distance > 0) // Exclude start nodes
    .sort((a, b) => a.distance - b.distance);
}

interface NeighborInfo {
  id: string;
  edgeType: EdgeType;
  confidence: number;
}

/**
 * Get neighbors of a node from the edges table.
 */
function getNeighbors(
  db: SqlJsDatabase,
  nodeId: string,
  direction: 'outgoing' | 'incoming' | 'both',
  edgeTypes?: EdgeType[],
): NeighborInfo[] {
  const neighbors: NeighborInfo[] = [];

  try {
    if (direction === 'outgoing' || direction === 'both') {
      let sql = 'SELECT to_id, type, confidence FROM edges WHERE from_id = ?';
      const params: (string | number)[] = [nodeId];
      if (edgeTypes && edgeTypes.length > 0) {
        const placeholders = edgeTypes.map(() => '?').join(',');
        sql += ` AND type IN (${placeholders})`;
        params.push(...edgeTypes);
      }
      const results = db.exec(sql, params);
      if (results.length > 0) {
        for (const row of results[0].values) {
          neighbors.push({
            id: String(row[0]),
            edgeType: String(row[1]) as EdgeType,
            confidence: Number(row[2]),
          });
        }
      }
    }

    if (direction === 'incoming' || direction === 'both') {
      let sql = 'SELECT from_id, type, confidence FROM edges WHERE to_id = ?';
      const params: (string | number)[] = [nodeId];
      if (edgeTypes && edgeTypes.length > 0) {
        const placeholders = edgeTypes.map(() => '?').join(',');
        sql += ` AND type IN (${placeholders})`;
        params.push(...edgeTypes);
      }
      const results = db.exec(sql, params);
      if (results.length > 0) {
        for (const row of results[0].values) {
          neighbors.push({
            id: String(row[0]),
            edgeType: String(row[1]) as EdgeType,
            confidence: Number(row[2]),
          });
        }
      }
    }
  } catch (err) {
    log.warn(`Failed to get neighbors for ${nodeId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return neighbors;
}

/**
 * Find the shortest path between two nodes using BFS.
 */
export function findShortestPath(
  db: SqlJsDatabase,
  fromId: string,
  toId: string,
  edgeTypes?: EdgeType[],
  maxHops: number = 5,
): string[] | null {
  const visited = new Set<string>();
  const queue: Array<{ id: string; path: string[] }> = [{ id: fromId, path: [fromId] }];
  visited.add(fromId);

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (current.id === toId) {
      return current.path;
    }

    if (current.path.length >= maxHops + 1) continue;

    const neighbors = getNeighbors(db, current.id, 'outgoing', edgeTypes);

    for (const neighbor of neighbors) {
      if (visited.has(neighbor.id)) continue;
      visited.add(neighbor.id);
      queue.push({
        id: neighbor.id,
        path: [...current.path, neighbor.id],
      });
    }
  }

  return null; // No path found
}

/**
 * Get all nodes reachable from a set of start nodes within N hops,
 * grouped by their relationship type.
 */
export function expandContext(
  db: SqlJsDatabase,
  startNodeIds: string[],
  hops: number = 2,
): {
  callers: Set<string>;
  callees: Set<string>;
  references: Set<string>;
  dependents: Set<string>;
  tests: Set<string>;
} {
  const result = {
    callers: new Set<string>(),
    callees: new Set<string>(),
    references: new Set<string>(),
    dependents: new Set<string>(),
    tests: new Set<string>(),
  };

  // Expand callers (incoming CALLS edges)
  const callers = bfsExpand(db, {
    startNodeIds,
    direction: 'incoming',
    edgeTypes: ['CALLS'],
    maxHops: hops,
    maxNodes: 100,
  });
  for (const c of callers) result.callers.add(c.nodeId);

  // Expand callees (outgoing CALLS edges)
  const callees = bfsExpand(db, {
    startNodeIds,
    direction: 'outgoing',
    edgeTypes: ['CALLS'],
    maxHops: hops,
    maxNodes: 100,
  });
  for (const c of callees) result.callees.add(c.nodeId);

  // Expand references (incoming REFERENCES edges)
  const refs = bfsExpand(db, {
    startNodeIds,
    direction: 'incoming',
    edgeTypes: ['REFERENCES'],
    maxHops: hops,
    maxNodes: 100,
  });
  for (const r of refs) result.references.add(r.nodeId);

  // Expand dependents (incoming IMPORTS edges)
  const deps = bfsExpand(db, {
    startNodeIds,
    direction: 'incoming',
    edgeTypes: ['IMPORTS'],
    maxHops: 1,
    maxNodes: 50,
  });
  for (const d of deps) result.dependents.add(d.nodeId);

  // Expand tests (incoming TESTS edges)
  const tests = bfsExpand(db, {
    startNodeIds,
    direction: 'incoming',
    edgeTypes: ['TESTS'],
    maxHops: 1,
    maxNodes: 50,
  });
  for (const t of tests) result.tests.add(t.nodeId);

  return result;
}
