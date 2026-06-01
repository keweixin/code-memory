/**
 * Code Memory Graph — File Repository
 *
 * CRUD operations for the `files` table.
 * JSON fields (exports, imports) are stored as TEXT and
 * parsed back when reading.
 */

import type { FileRecord, ImportInfo } from '../shared/types.js';
import { getDatabaseSync } from './database.js';
import { buildSearchText } from '../shared/search-text.js';

// ── JSON field helpers ──────────────────────────────────────

function serializeFile(record: Partial<FileRecord>): Record<string, unknown> {
  return {
    $id: record.id,
    $path: record.path,
    $language: record.language,
    $role: record.role,
    $size: record.size,
    $hash: record.hash,
    $indexedAt: record.indexedAt,
    $lastCommit: record.lastCommit ?? null,
    $isGenerated: record.isGenerated ? 1 : 0,
    $isIgnored: record.isIgnored ? 1 : 0,
    $exports: JSON.stringify(record.exports ?? []),
    $imports: JSON.stringify(record.imports ?? []),
    $summary: record.summary ?? null,
    $riskLevel: record.riskLevel,
    $searchText: buildSearchText([
      record.path,
      record.language,
      record.role,
      record.summary,
      ...(record.exports ?? []),
      ...(record.imports ?? []).map((imp) => imp.source),
    ]),
  };
}

function deserializeFile(row: Record<string, unknown>): FileRecord {
  return {
    id: row.id as string,
    path: row.path as string,
    language: row.language as FileRecord['language'],
    role: row.role as FileRecord['role'],
    size: row.size as number,
    hash: row.hash as string,
    indexedAt: row.indexed_at as string,
    lastCommit: (row.last_commit as string) ?? null,
    isGenerated: Boolean(row.is_generated),
    isIgnored: Boolean(row.is_ignored),
    exports: JSON.parse(row.exports as string) as string[],
    imports: JSON.parse(row.imports as string) as ImportInfo[],
    summary: (row.summary as string) ?? null,
    riskLevel: row.risk_level as FileRecord['riskLevel'],
  };
}

// ── Repository methods ──────────────────────────────────────

export function upsertFile(file: FileRecord): void {
  const db = getDatabaseSync();
  const p = serializeFile(file);

  db.run(
    `INSERT OR REPLACE INTO files
       (id, path, language, role, size, hash, indexed_at, last_commit,
        is_generated, is_ignored, exports, imports, summary, risk_level, search_text)
     VALUES ($id, $path, $language, $role, $size, $hash, $indexedAt, $lastCommit,
             $isGenerated, $isIgnored, $exports, $imports, $summary, $riskLevel, $searchText)`,
    [
      p.$id, p.$path, p.$language, p.$role, p.$size, p.$hash,
      p.$indexedAt, p.$lastCommit, p.$isGenerated, p.$isIgnored,
      p.$exports, p.$imports, p.$summary, p.$riskLevel, p.$searchText,
    ],
  );
}

export function getFileById(id: string): FileRecord | null {
  const db = getDatabaseSync();
  const stmt = db.prepare('SELECT * FROM files WHERE id = ?');
  stmt.bind([id]);

  let result: FileRecord | null = null;
  if (stmt.step()) {
    result = deserializeFile(stmt.getAsObject());
  }
  stmt.free();
  return result;
}

export function getFileByPath(path: string): FileRecord | null {
  const db = getDatabaseSync();
  const stmt = db.prepare('SELECT * FROM files WHERE path = ?');
  stmt.bind([path]);

  let result: FileRecord | null = null;
  if (stmt.step()) {
    result = deserializeFile(stmt.getAsObject());
  }
  stmt.free();
  return result;
}

export function getAllFiles(): FileRecord[] {
  const db = getDatabaseSync();
  const results: FileRecord[] = [];
  const stmt = db.prepare('SELECT * FROM files');

  while (stmt.step()) {
    results.push(deserializeFile(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

export function getFilesByHash(hash: string): FileRecord[] {
  const db = getDatabaseSync();
  const results: FileRecord[] = [];
  const stmt = db.prepare('SELECT * FROM files WHERE hash = ?');
  stmt.bind([hash]);

  while (stmt.step()) {
    results.push(deserializeFile(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

export function deleteFile(id: string): void {
  const db = getDatabaseSync();
  db.run('DELETE FROM files WHERE id = ?', [id]);
}

/**
 * Return files whose stored hash does not match the expected hash
 * (i.e., they have been modified since last indexing), or files
 * that have not been indexed yet (empty indexed_at).
 *
 * Note: the caller should compute the current hash externally and
 * pass files with mismatching hashes. This method returns files
 * that have never been indexed or have a stale indexed_at.
 */
export function getFilesNeedingIndex(): FileRecord[] {
  const db = getDatabaseSync();
  const results: FileRecord[] = [];
  const stmt = db.prepare(
    "SELECT * FROM files WHERE indexed_at = '' OR indexed_at IS NULL",
  );

  while (stmt.step()) {
    results.push(deserializeFile(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}
