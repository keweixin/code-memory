/**
 * Graph edge evidence persistence.
 *
 * `edges` is intentionally unique per from/to/type. This table keeps the
 * individual call/import/type evidence rows that led to that edge, so graph
 * rebuilds do not collapse repeated call sites into one opaque string.
 */

import { generateId } from '../shared/utils.js';
import { getDatabaseSync } from './database.js';

export interface GraphEdgeEvidenceInput {
  edgeId: string;
  sourceTable?: string | null;
  sourceId?: string | null;
  fileId?: string | null;
  startLine?: number | null;
  startColumn?: number | null;
  evidence?: string | null;
}

export function insertGraphEvidenceBatch(records: GraphEdgeEvidenceInput[]): void {
  if (records.length === 0) return;
  const db = getDatabaseSync();
  const now = new Date().toISOString();
  const stmt = db.native.prepare(
    `INSERT OR REPLACE INTO graph_edge_evidence
       (id, edge_id, source_table, source_id, file_id, start_line, start_column, evidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const write = db.native.transaction((items: GraphEdgeEvidenceInput[]) => {
    for (const item of items) {
      const id = generateId(
        'graph_edge_evidence',
        item.edgeId,
        item.sourceTable ?? '',
        item.sourceId ?? '',
        item.fileId ?? '',
        String(item.startLine ?? 0),
        String(item.startColumn ?? 0),
        item.evidence ?? '',
      );
      stmt.run(
        id,
        item.edgeId,
        item.sourceTable ?? null,
        item.sourceId ?? null,
        item.fileId ?? null,
        item.startLine ?? 0,
        item.startColumn ?? 0,
        item.evidence ?? null,
        now,
      );
    }
  });
  write(records);
}

export function deleteGraphEvidenceByTypes(edgeTypes: string[]): void {
  if (edgeTypes.length === 0) return;
  const db = getDatabaseSync();
  const placeholders = edgeTypes.map(() => '?').join(',');
  db.run(
    `DELETE FROM graph_edge_evidence
     WHERE edge_id IN (
       SELECT id FROM edges WHERE type IN (${placeholders})
     )`,
    edgeTypes,
  );
}

export function deleteGraphEvidenceForNodes(nodeIds: string[]): void {
  if (nodeIds.length === 0) return;
  const db = getDatabaseSync();
  const placeholders = nodeIds.map(() => '?').join(',');
  db.run(
    `DELETE FROM graph_edge_evidence
     WHERE edge_id IN (
       SELECT id FROM edges
       WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})
     )`,
    [...nodeIds, ...nodeIds],
  );
}
