import type { SqlJsDatabase } from './database.js';

const EVIDENCE_BACKED_EDGE_TYPES = [
  'IMPORTS',
  'CALLS',
  'REFERENCES',
  'TESTS',
  'CONFIGURES',
  'EXTENDS',
  'IMPLEMENTS',
  'ROUTE_ENDPOINT',
  'ROUTE_REFERENCES',
] as const;

export interface InvariantCheck {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
  count?: number;
}

export function collectInvariants(db: SqlJsDatabase): InvariantCheck[] {
  return [
    countCheck(db, 'symbol-line-ranges', `
      SELECT COUNT(*)
      FROM symbols
      WHERE start_line > end_line
    `, 'error', 'All symbol line ranges are ordered.'),
    countCheck(db, 'chunk-byte-ranges', `
      SELECT COUNT(*)
      FROM chunks
      WHERE start_byte >= end_byte
    `, 'error', 'All chunk byte ranges are non-empty and ordered.'),
    countCheck(db, 'chunk-content-hashes', `
      SELECT COUNT(*)
      FROM chunks
      WHERE content_hash IS NULL OR LENGTH(TRIM(content_hash)) = 0
    `, 'error', 'All chunks have content hashes.'),
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
    countCheck(db, 'evidence-backed-graph-edges', `
      SELECT COUNT(*)
      FROM edges e
      WHERE e.type IN (${sqlStringList(EVIDENCE_BACKED_EDGE_TYPES)})
        AND NOT EXISTS (
          SELECT 1
          FROM graph_edge_evidence gee
          WHERE gee.edge_id = e.id
        )
    `, 'error', 'All evidence-backed graph edges have evidence rows.'),
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
    countCheck(db, 'parse-metadata-present', `
      SELECT CASE
        WHEN (SELECT COUNT(*) FROM files WHERE role = 'source') > 0
         AND (
          (SELECT COUNT(*) FROM file_imports) +
          (SELECT COUNT(*) FROM file_exports) +
          (SELECT COUNT(*) FROM call_refs)
         ) = 0
        THEN 1 ELSE 0 END
    `, 'warn', 'Parse metadata is present for graph rebuilds.'),
    countCheck(db, 'parse-metadata-file-links', `
      SELECT COUNT(*) FROM (
        SELECT file_id FROM file_imports
        UNION ALL SELECT file_id FROM file_exports
        UNION ALL SELECT file_id FROM call_refs
        UNION ALL SELECT file_id FROM scope_bindings
        UNION ALL SELECT file_id FROM type_relations
        UNION ALL SELECT file_id FROM route_endpoints
        UNION ALL SELECT file_id FROM route_references
      ) metadata
      WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.id = metadata.file_id)
    `, 'error', 'All parse metadata rows point to indexed files.'),
    contextLedgerStaleReferencesCheck(db),
    tableCount(db, 'context-ledger-entries', 'context_ledger', 'Context ledger table is available.'),
    tableCount(db, 'memories', 'memories', 'Project memory table is available.'),
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

function sqlStringList(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(', ');
}

function tableCount(
  db: SqlJsDatabase,
  name: string,
  table: string,
  message: string,
): InvariantCheck {
  const count = Number(db.exec(`SELECT COUNT(*) FROM ${table}`)[0]?.values[0]?.[0] ?? 0);
  return { name, status: 'ok', message, count };
}

function contextLedgerStaleReferencesCheck(db: SqlJsDatabase): InvariantCheck {
  const files = new Set(db.all<{ path: string }>('SELECT path FROM files').map((row) => row.path));
  const symbols = new Set<string>();
  for (const row of db.all<{
    id: string;
    path: string;
    name: string;
    kind: string;
    start_line: number;
    end_line: number;
  }>(
    `SELECT s.id, f.path, s.name, s.kind, s.start_line, s.end_line
     FROM symbols s
     JOIN files f ON f.id = s.file_id`,
  )) {
    symbols.add(row.id);
    symbols.add([row.path, row.name, row.kind, row.start_line, row.end_line].join(':'));
  }
  const chunks = new Set<string>();
  for (const row of db.all<{
    id: string;
    path: string;
    symbol_name: string | null;
    start_line: number;
    end_line: number;
  }>(
    `SELECT c.id, f.path, COALESCE(s.name, 'file') AS symbol_name, c.start_line, c.end_line
     FROM chunks c
     JOIN files f ON f.id = c.file_id
     LEFT JOIN symbols s ON s.id = c.symbol_id`,
  )) {
    chunks.add(row.id);
    chunks.add([row.path, row.symbol_name || 'file', row.start_line, row.end_line].join(':'));
  }

  const rows = db.all<{
    returned_files: string;
    returned_symbols: string;
    returned_chunks: string;
    evidence_ids: string;
    evidence_fingerprints: string;
  }>(
    `SELECT returned_files, returned_symbols, returned_chunks, evidence_ids, evidence_fingerprints
     FROM context_ledger`,
  );

  let count = 0;
  for (const row of rows) {
    count += parseStringArray(row.returned_files)
      .filter((item) => !files.has(item))
      .length;
    count += parseStringArray(row.returned_symbols)
      .filter((item) => !symbols.has(item))
      .length;
    count += parseStringArray(row.returned_chunks)
      .filter((item) => !chunks.has(item))
      .length;
    count += parseStringArray(row.evidence_ids)
      .filter((item) => !evidenceTargetExists(item, symbols, chunks))
      .length;
    count += parseStringArray(row.evidence_fingerprints)
      .filter((item) => !evidenceTargetExists(item, symbols, chunks))
      .length;
  }

  return count === 0
    ? { name: 'context-ledger-stale-references', status: 'ok', message: 'Context ledger references indexed files, symbols, and chunks.', count }
    : { name: 'context-ledger-stale-references', status: 'warn', message: `${count} stale reference(s) found.`, count };
}

function parseStringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function evidenceTargetExists(value: string, symbols: Set<string>, chunks: Set<string>): boolean {
  const normalized = stripEvidencePrefix(value);
  return symbols.has(normalized) || chunks.has(normalized);
}

function stripEvidencePrefix(value: string): string {
  if (value.startsWith('evidence:')) return stripEvidencePrefix(value.slice('evidence:'.length));
  if (value.startsWith('symbol:')) return value.slice('symbol:'.length);
  if (value.startsWith('chunk:')) return value.slice('chunk:'.length);
  return value;
}
