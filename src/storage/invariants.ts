import type { SqlJsDatabase } from './database.js';

export interface InvariantCheck {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
  count?: number;
}

export function collectInvariants(db: SqlJsDatabase): InvariantCheck[] {
  return [
    countCheck(db, 'dangling-edges', `
      SELECT COUNT(*)
      FROM edges e
      WHERE (
        NOT EXISTS (SELECT 1 FROM files f WHERE f.id = e.from_id)
        AND NOT EXISTS (SELECT 1 FROM symbols s WHERE s.id = e.from_id)
      ) OR (
        NOT EXISTS (SELECT 1 FROM files f WHERE f.id = e.to_id)
        AND NOT EXISTS (SELECT 1 FROM symbols s WHERE s.id = e.to_id)
      )
    `, 'error', 'No dangling graph edges.'),
    countCheck(db, 'graph-evidence-without-edge', `
      SELECT COUNT(*)
      FROM graph_edge_evidence gee
      WHERE NOT EXISTS (SELECT 1 FROM edges e WHERE e.id = gee.edge_id)
    `, 'error', 'All graph evidence points to existing edges.'),
    countCheck(db, 'symbols-without-files', `
      SELECT COUNT(*)
      FROM symbols s
      WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.id = s.file_id)
    `, 'error', 'All symbols point to indexed files.'),
    countCheck(db, 'chunks-without-files', `
      SELECT COUNT(*)
      FROM chunks c
      WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.id = c.file_id)
    `, 'error', 'All chunks point to indexed files.'),
    countCheck(db, 'symbols-without-chunks', `
      SELECT COUNT(*)
      FROM symbols s
      WHERE s.kind IN ('function', 'method', 'class', 'interface', 'variable', 'constant')
        AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.symbol_id = s.id)
    `, 'warn', 'All code symbols have context chunks.'),
    countCheck(db, 'unresolved-calls', `
      SELECT COUNT(*)
      FROM call_refs
      WHERE resolution_status != 'resolved'
    `, 'warn', 'All call references resolved.'),
  ];
}

function countCheck(
  db: SqlJsDatabase,
  name: string,
  sql: string,
  nonZeroStatus: 'warn' | 'error',
  okMessage: string,
): InvariantCheck {
  const count = Number(db.exec(sql)[0]?.values[0]?.[0] ?? 0);
  return count === 0
    ? { name, status: 'ok', message: okMessage, count }
    : { name, status: nonZeroStatus, message: `${count} issue(s) found.`, count };
}
