import type { SqlJsDatabase } from '../storage/database.js';

export interface ResolvedTargetNode {
  id: string;
  kind: 'file' | 'symbol';
}

/**
 * Resolve a user-facing target string to an indexed file or symbol node id.
 *
 * Resolution order matters: exact file path, exact symbol name, then qualified
 * class/object member names such as AuthService.login.
 */
export function resolveTargetId(db: SqlJsDatabase, target: string): string | null {
  return resolveTargetNode(db, target)?.id ?? null;
}

export function resolveTargetNode(db: SqlJsDatabase, target: string): ResolvedTargetNode | null {
  const fileId = findFileId(db, target);
  if (fileId) return { id: fileId, kind: 'file' };

  const symbolId = findSymbolId(db, target) || findQualifiedSymbolId(db, target);
  if (symbolId) return { id: symbolId, kind: 'symbol' };

  return null;
}

function findFileId(db: SqlJsDatabase, path: string): string | null {
  try {
    const normalizedPath = path.replace(/\\/g, '/');
    const result = db.exec('SELECT id FROM files WHERE path = ?', [normalizedPath]);
    if (result.length > 0 && result[0].values.length > 0) {
      return String(result[0].values[0][0]);
    }
  } catch { /* not found */ }
  return null;
}

function findSymbolId(db: SqlJsDatabase, name: string): string | null {
  try {
    const result = db.exec('SELECT id FROM symbols WHERE name = ? LIMIT 1', [name]);
    if (result.length > 0 && result[0].values.length > 0) {
      return String(result[0].values[0][0]);
    }
  } catch { /* not found */ }
  return null;
}

function findQualifiedSymbolId(db: SqlJsDatabase, name: string): string | null {
  if (name.includes('/') || name.includes('\\') || !name.includes('.')) return null;

  const parts = name.split('.').filter(Boolean);
  if (parts.length < 2) return null;

  const memberName = parts[parts.length - 1];
  const ownerName = parts[parts.length - 2];
  try {
    const result = db.exec(
      `SELECT member.id
       FROM symbols member
       JOIN symbols owner ON owner.file_id = member.file_id
       JOIN files f ON f.id = member.file_id
       WHERE member.name = ?
         AND owner.name = ?
         AND member.start_line >= owner.start_line
         AND member.end_line <= owner.end_line
       ORDER BY CASE f.language
                  WHEN 'typescript' THEN 0
                  WHEN 'javascript' THEN 1
                  ELSE 2
                END,
                (owner.end_line - owner.start_line) ASC,
                member.start_line ASC
       LIMIT 1`,
      [memberName, ownerName],
    );
    if (result.length > 0 && result[0].values.length > 0) {
      return String(result[0].values[0][0]);
    }
  } catch { /* not found */ }
  return null;
}
