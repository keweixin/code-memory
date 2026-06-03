/**
 * Code Memory Graph — Graph Search
 *
 * BFS/DFS traversal of the graph stored in SQLite edges table.
 * Used for: neighbor expansion, path finding, reachability.
 */

import type { SqlJsDatabase } from '../storage/database.js';
import type { EdgeType, SearchIntent } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';
import { getEffectiveGraphEdgeTypes, getIntentGraphProfile } from './intent-router.js';

const log = createLogger('graph-search');

export interface GraphSearchOptions {
  startNodeIds: string[];
  direction: 'outgoing' | 'incoming' | 'both';
  edgeTypes?: EdgeType[];
  maxHops: number;
  maxNodes: number;
  intent?: SearchIntent;
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
  const { startNodeIds, maxHops, maxNodes = 1000 } = options;
  const profile = options.edgeTypes ? null : options.intent ? getIntentGraphProfile(options.intent) : null;
  const direction = profile?.direction ?? options.direction;
  const edgeTypes = options.edgeTypes ?? (profile ? getEffectiveGraphEdgeTypes(profile) : undefined);
  if (startNodeIds.length === 0 || maxHops <= 0 || maxNodes <= 0) return [];

  try {
    const seedSelect = startNodeIds.map(() => 'SELECT ? AS node_id').join(' UNION ALL ');
    const params: Array<string | number> = [...startNodeIds];
    const edgeFilter = edgeTypes && edgeTypes.length > 0
      ? `AND e.type IN (${edgeTypes.map(() => '?').join(',')})`
      : '';

    const outgoing = direction === 'outgoing' || direction === 'both'
      ? `SELECT e.to_id,
                w.distance + 1,
                w.path || e.to_id || '>',
                CASE WHEN w.edge_types = '' THEN e.type ELSE w.edge_types || ',' || e.type END
         FROM walk w JOIN edges e ON e.from_id = w.node_id
         WHERE w.distance < ? ${edgeFilter}
           AND instr(w.path, '>' || e.to_id || '>') = 0`
      : '';
    const incoming = direction === 'incoming' || direction === 'both'
      ? `SELECT e.from_id,
                w.distance + 1,
                w.path || e.from_id || '>',
                CASE WHEN w.edge_types = '' THEN e.type ELSE w.edge_types || ',' || e.type END
         FROM walk w JOIN edges e ON e.to_id = w.node_id
         WHERE w.distance < ? ${edgeFilter}
           AND instr(w.path, '>' || e.from_id || '>') = 0`
      : '';
    const recursiveBranches = [outgoing, incoming].filter(Boolean).join(' UNION ALL ');
    if (!recursiveBranches) return [];

    const branchParams: Array<string | number> = [];
    for (let i = 0; i < (direction === 'both' ? 2 : 1); i++) {
      branchParams.push(maxHops);
      if (edgeTypes) branchParams.push(...edgeTypes);
    }
    params.push(...branchParams);
    params.push(...startNodeIds, maxNodes);

    const sql = `WITH RECURSIVE
      seeds(node_id) AS (${seedSelect}),
      walk(node_id, distance, path, edge_types) AS (
        SELECT node_id, 0, '>' || node_id || '>', ''
        FROM seeds
        UNION ALL
        ${recursiveBranches}
      )
      SELECT node_id, MIN(distance) AS distance, MIN(path) AS path, MIN(edge_types) AS edge_types
      FROM walk
      WHERE distance > 0 AND node_id NOT IN (${startNodeIds.map(() => '?').join(',')})
      GROUP BY node_id
      ORDER BY distance ASC, node_id ASC
      LIMIT ?`;

    const rows = db.exec(sql, params)[0]?.values ?? [];
    return rows.map((row) => ({
      nodeId: String(row[0]),
      distance: Number(row[1]),
      path: String(row[2]).split('>').filter(Boolean),
      edgeTypes: String(row[3] || '').split(',').filter(Boolean) as EdgeType[],
    }));
  } catch (err) {
    log.warn(`SQL graph expansion failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Find the shortest path between two nodes using a recursive CTE.
 * Runs the entire BFS in a single SQL query instead of per-node round-trips.
 */
export function findShortestPath(
  db: SqlJsDatabase,
  fromId: string,
  toId: string,
  edgeTypes?: EdgeType[],
  maxHops: number = 5,
): string[] | null {
  try {
    const edgeFilter = edgeTypes && edgeTypes.length > 0
      ? `AND e.type IN (${edgeTypes.map(() => '?').join(',')})`
      : '';

    const params: Array<string | number> = [
      fromId,   // base: current_id
      fromId,   // base: path_ids
      ',' + fromId + ',', // base: visited (comma-delimited for LIKE check)
    ];

    if (edgeTypes) {
      params.push(...edgeTypes);
    }

    params.push(
      maxHops,  // depth limit
      toId,     // stop when target found
    );

    const sql = `WITH RECURSIVE path_search(
        current_id, depth, path_ids, visited
      ) AS (
        SELECT ?, 0, ?, ?
        UNION ALL
        SELECT
          e.to_id,
          ps.depth + 1,
          ps.path_ids || ',' || e.to_id,
          ps.visited || e.to_id || ','
        FROM path_search ps
        JOIN edges e ON e.from_id = ps.current_id
        WHERE ps.depth < ?
          ${edgeFilter}
          AND ps.visited NOT LIKE '%,' || e.to_id || ',%'
          AND ps.current_id != ?
      )
      SELECT path_ids FROM path_search
      WHERE current_id = ?
      ORDER BY depth LIMIT 1`;

    params.push(toId); // WHERE current_id = ?

    const rows = db.exec(sql, params);
    if (!rows.length || !rows[0].values.length) return null;

    const pathStr = String(rows[0].values[0][0]);
    return pathStr.split(',').filter(Boolean);
  } catch (err) {
    log.warn(`Recursive CTE path search failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Get all nodes reachable from a set of start nodes within N hops,
 * grouped by their relationship type.
 *
 * Uses a single recursive CTE instead of 5 separate bfsExpand calls
 * to reduce edge-table scans from 5 to 1.
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

  if (startNodeIds.length === 0 || hops <= 0) return result;

  try {
    const allEdgeTypes: EdgeType[] = ['CALLS', 'REFERENCES', 'IMPORTS', 'TESTS'];
    const seedSelect = startNodeIds.map(() => 'SELECT ? AS id').join(' UNION ALL ');
    const edgeTypePlaceholders = allEdgeTypes.map(() => '?').join(',');

    const sql = `WITH RECURSIVE
      seeds(id) AS (${seedSelect}),
      graph_expand(id, depth, edge_type, is_outgoing, path) AS (
        SELECT id, 0, NULL, NULL, '>' || id || '>' FROM seeds
        UNION ALL
        SELECT e.to_id, ge.depth + 1, e.type, 1, ge.path || e.to_id || '>'
        FROM graph_expand ge
        JOIN edges e ON e.from_id = ge.id
        WHERE ge.depth < ?
          AND e.type IN (${edgeTypePlaceholders})
          AND instr(ge.path, '>' || e.to_id || '>') = 0
        UNION ALL
        SELECT e.from_id, ge.depth + 1, e.type, 0, ge.path || e.from_id || '>'
        FROM graph_expand ge
        JOIN edges e ON e.to_id = ge.id
        WHERE ge.depth < ?
          AND e.type IN (${edgeTypePlaceholders})
          AND instr(ge.path, '>' || e.from_id || '>') = 0
      )
      SELECT id, edge_type, is_outgoing, MIN(depth) AS depth
      FROM graph_expand
      WHERE depth > 0
      GROUP BY id, edge_type, is_outgoing`;

    const params: Array<string | number> = [
      ...startNodeIds,
      hops, ...allEdgeTypes,
      hops, ...allEdgeTypes,
    ];

    const rows = db.exec(sql, params)[0]?.values ?? [];

    for (const row of rows) {
      const nodeId = String(row[0]);
      const edgeType = String(row[1]);
      const isOutgoing = Number(row[2]) === 1;
      const depth = Number(row[3]);

      if (edgeType === 'CALLS' && !isOutgoing) {
        result.callers.add(nodeId);
      } else if (edgeType === 'CALLS' && isOutgoing) {
        result.callees.add(nodeId);
      } else if (edgeType === 'REFERENCES' && !isOutgoing) {
        result.references.add(nodeId);
      } else if (edgeType === 'IMPORTS' && !isOutgoing && depth <= 1) {
        result.dependents.add(nodeId);
      } else if (edgeType === 'TESTS' && !isOutgoing && depth <= 1) {
        result.tests.add(nodeId);
      }
    }
  } catch (err) {
    log.warn(`SQL context expansion failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}
