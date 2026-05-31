/**
 * Code Memory Graph — Edge Repository
 *
 * CRUD operations for the `edges` table.
 * Edges represent directed relationships between nodes
 * (files and symbols) in the code graph.
 */

import type { EdgeRecord, EdgeType } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';
import { getDatabaseSync } from './database.js';

const log = createLogger('edge-repo');

// ── Serialization ───────────────────────────────────────────

function serializeEdge(record: Partial<EdgeRecord>): Record<string, unknown> {
  return {
    $id: record.id,
    $fromId: record.fromId,
    $toId: record.toId,
    $type: record.type,
    $confidence: record.confidence,
    $evidence: record.evidence ?? null,
  };
}

function deserializeEdge(row: Record<string, unknown>): EdgeRecord {
  return {
    id: row.id as string,
    fromId: row.from_id as string,
    toId: row.to_id as string,
    type: row.type as EdgeType,
    confidence: row.confidence as number,
    evidence: (row.evidence as string) ?? null,
  };
}

// ── Repository methods ──────────────────────────────────────

export function upsertEdge(edge: EdgeRecord): void {
  const db = getDatabaseSync();
  const p = serializeEdge(edge);

  db.run(
    `INSERT OR REPLACE INTO edges
       (id, from_id, to_id, type, confidence, evidence)
     VALUES ($id, $fromId, $toId, $type, $confidence, $evidence)`,
    [p.$id, p.$fromId, p.$toId, p.$type, p.$confidence, p.$evidence],
  );
}

export function upsertEdges(edges: EdgeRecord[]): void {
  if (edges.length === 0) return;
  const db = getDatabaseSync();
  const stmt = db.native.prepare(
    `INSERT OR REPLACE INTO edges
       (id, from_id, to_id, type, confidence, evidence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const write = db.native.transaction((records: EdgeRecord[]) => {
    for (const edge of records) {
      stmt.run(edge.id, edge.fromId, edge.toId, edge.type, edge.confidence, edge.evidence ?? null);
    }
  });
  write(edges);
}

export function getOutgoingEdges(fromId: string, type?: EdgeType): EdgeRecord[] {
  const db = getDatabaseSync();
  const results: EdgeRecord[] = [];

  let stmt;
  if (type) {
    stmt = db.prepare(
      'SELECT * FROM edges WHERE from_id = ? AND type = ?',
    );
    stmt.bind([fromId, type]);
  } else {
    stmt = db.prepare(
      'SELECT * FROM edges WHERE from_id = ?',
    );
    stmt.bind([fromId]);
  }

  while (stmt.step()) {
    results.push(deserializeEdge(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

export function getIncomingEdges(toId: string, type?: EdgeType): EdgeRecord[] {
  const db = getDatabaseSync();
  const results: EdgeRecord[] = [];

  let stmt;
  if (type) {
    stmt = db.prepare(
      'SELECT * FROM edges WHERE to_id = ? AND type = ?',
    );
    stmt.bind([toId, type]);
  } else {
    stmt = db.prepare(
      'SELECT * FROM edges WHERE to_id = ?',
    );
    stmt.bind([toId]);
  }

  while (stmt.step()) {
    results.push(deserializeEdge(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

/**
 * Get neighboring node IDs in the specified direction(s).
 * Returns unique node IDs (not edges).
 *
 * - 'out': returns toIds of outgoing edges
 * - 'in': returns fromIds of incoming edges
 * - 'both': returns union of both
 */
export function getNeighbors(
  nodeId: string,
  direction: 'in' | 'out' | 'both',
  type?: EdgeType,
): string[] {
  const db = getDatabaseSync();
  const neighborSet = new Set<string>();

  const typeFilter = type ? ' AND type = ?' : '';

  if (direction === 'out' || direction === 'both') {
    const sql = `SELECT to_id FROM edges WHERE from_id = ?${typeFilter}`;
    const stmt = db.prepare(sql);
    const params = type ? [nodeId, type] : [nodeId];
    stmt.bind(params);
    while (stmt.step()) {
      neighborSet.add(stmt.getAsObject().to_id as string);
    }
    stmt.free();
  }

  if (direction === 'in' || direction === 'both') {
    const sql = `SELECT from_id FROM edges WHERE to_id = ?${typeFilter}`;
    const stmt = db.prepare(sql);
    const params = type ? [nodeId, type] : [nodeId];
    stmt.bind(params);
    while (stmt.step()) {
      neighborSet.add(stmt.getAsObject().from_id as string);
    }
    stmt.free();
  }

  return Array.from(neighborSet);
}

/**
 * Delete all edges connected to a node (both incoming and outgoing).
 */
export function deleteEdgesByNodeId(nodeId: string): void {
  const db = getDatabaseSync();
  db.run('DELETE FROM edges WHERE from_id = ? OR to_id = ?', [nodeId, nodeId]);
}

/**
 * Check whether a specific edge exists.
 */
export function edgeExists(fromId: string, toId: string, type: EdgeType): boolean {
  const db = getDatabaseSync();
  const stmt = db.prepare(
    'SELECT 1 FROM edges WHERE from_id = ? AND to_id = ? AND type = ? LIMIT 1',
  );
  stmt.bind([fromId, toId, type]);

  const exists = stmt.step();
  stmt.free();
  return exists;
}
