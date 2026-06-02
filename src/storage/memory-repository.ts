/**
 * Code Memory Graph — Memory Repository
 *
 * CRUD operations for the `memories` table.
 * Memories store project-level knowledge that persists across
 * sessions — architectural decisions, user preferences,
 * branch-specific context, etc.
 *
 * JSON fields (scope, evidence, invalidation_rules) are stored
 * as TEXT and parsed back when reading.
 */

import type { MemoryRecord, MemoryType, InvalidationRule } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';
import { getDatabaseSync } from './database.js';

const log = createLogger('memory-repo');

// ── Serialization ───────────────────────────────────────────

function serializeMemory(record: Partial<MemoryRecord>): Record<string, unknown> {
  return {
    $id: record.id,
    $type: record.type,
    $content: record.content,
    $scope: JSON.stringify(record.scope ?? []),
    $evidence: JSON.stringify(record.evidence ?? []),
    $confidence: record.confidence,
    $createdCommit: record.createdCommit ?? null,
    $lastValidatedCommit: record.lastValidatedCommit ?? null,
    $invalidationRules: JSON.stringify(record.invalidationRules ?? []),
    $createdAt: record.createdAt,
    $updatedAt: record.updatedAt,
  };
}

function deserializeMemory(row: Record<string, unknown>): MemoryRecord {
  return {
    id: row.id as string,
    type: row.type as MemoryType,
    content: row.content as string,
    scope: JSON.parse(row.scope as string) as string[],
    evidence: JSON.parse(row.evidence as string) as string[],
    confidence: row.confidence as number,
    createdCommit: (row.created_commit as string) ?? null,
    lastValidatedCommit: (row.last_validated_commit as string) ?? null,
    invalidationRules: JSON.parse(row.invalidation_rules as string) as InvalidationRule[],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// ── Repository methods ──────────────────────────────────────

export function createMemory(memory: MemoryRecord): void {
  const db = getDatabaseSync();
  const p = serializeMemory(memory);

  db.run(
    `INSERT INTO memories
       (id, type, content, scope, evidence, confidence,
        created_commit, last_validated_commit, invalidation_rules,
        created_at, updated_at)
     VALUES ($id, $type, $content, $scope, $evidence, $confidence,
             $createdCommit, $lastValidatedCommit, $invalidationRules,
             $createdAt, $updatedAt)`,
    [
      p.$id, p.$type, p.$content, p.$scope, p.$evidence, p.$confidence,
      p.$createdCommit, p.$lastValidatedCommit, p.$invalidationRules,
      p.$createdAt, p.$updatedAt,
    ],
  );
}

export function getMemoryById(id: string): MemoryRecord | null {
  const db = getDatabaseSync();
  const stmt = db.prepare('SELECT * FROM memories WHERE id = ?');
  stmt.bind([id]);

  let result: MemoryRecord | null = null;
  if (stmt.step()) {
    result = deserializeMemory(stmt.getAsObject());
  }
  stmt.free();
  return result;
}

export function getMemoriesByType(type: MemoryType): MemoryRecord[] {
  const db = getDatabaseSync();
  const results: MemoryRecord[] = [];
  const stmt = db.prepare('SELECT * FROM memories WHERE type = ?');
  stmt.bind([type]);

  while (stmt.step()) {
    results.push(deserializeMemory(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

/**
 * Get memories whose scope array includes the given file path.
 * Since scope is stored as a JSON array, we use LIKE with
 * surrounding quotes to match individual path entries.
 */
export function getMemoriesByScope(filePath: string): MemoryRecord[] {
  const db = getDatabaseSync();
  const results: MemoryRecord[] = [];
  // Match the path as a JSON array element: ["path/to/file"]
  // Using LIKE with quoted path to avoid partial matches
  const scopePattern = `%"${filePath}"%`;
  const stmt = db.prepare('SELECT * FROM memories WHERE scope LIKE ?');
  stmt.bind([scopePattern]);

  while (stmt.step()) {
    results.push(deserializeMemory(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

/**
 * Partial update of a memory record.
 * Only the provided fields are updated; others remain unchanged.
 */
export function updateMemory(id: string, updates: Partial<MemoryRecord>): void {
  const db = getDatabaseSync();

  // Build SET clause dynamically from provided fields
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (updates.content !== undefined) {
    setClauses.push('content = ?');
    values.push(updates.content);
  }
  if (updates.scope !== undefined) {
    setClauses.push('scope = ?');
    values.push(JSON.stringify(updates.scope));
  }
  if (updates.evidence !== undefined) {
    setClauses.push('evidence = ?');
    values.push(JSON.stringify(updates.evidence));
  }
  if (updates.confidence !== undefined) {
    setClauses.push('confidence = ?');
    values.push(updates.confidence);
  }
  if (updates.lastValidatedCommit !== undefined) {
    setClauses.push('last_validated_commit = ?');
    values.push(updates.lastValidatedCommit);
  }
  if (updates.invalidationRules !== undefined) {
    setClauses.push('invalidation_rules = ?');
    values.push(JSON.stringify(updates.invalidationRules));
  }
  if (updates.updatedAt !== undefined) {
    setClauses.push('updated_at = ?');
    values.push(updates.updatedAt);
  }
  if (updates.type !== undefined) {
    setClauses.push('type = ?');
    values.push(updates.type);
  }

  if (setClauses.length === 0) {
    return; // Nothing to update
  }

  values.push(id);
  const sql = `UPDATE memories SET ${setClauses.join(', ')} WHERE id = ?`;
  db.run(sql, values);
}

export function deleteMemory(id: string): void {
  const db = getDatabaseSync();
  db.run('DELETE FROM memories WHERE id = ?', [id]);
}

/**
 * Invalidate memories that are stale based on their invalidation rules.
 *
 * A memory is invalidated if any of its `commit`-type invalidation
 * rules reference a commit that is not the current one, AND the
 * memory has not been validated against the current commit.
 *
 * Returns the number of memories deleted.
 */
export function invalidateExpiredMemories(currentCommit: string): number {
  const db = getDatabaseSync();

  // Get all memories that have commit-type invalidation rules
  const stmt = db.prepare('SELECT * FROM memories');
  const toDelete: string[] = [];

  while (stmt.step()) {
    const row = stmt.getAsObject();
    const memory = deserializeMemory(row);

    // Skip memories already validated against this commit
    if (memory.lastValidatedCommit === currentCommit) {
      continue;
    }

    // Check commit-type invalidation rules
    const hasCommitRule = memory.invalidationRules.some(
      (rule) => rule.type === 'commit',
    );

    if (hasCommitRule && memory.lastValidatedCommit !== null && memory.lastValidatedCommit !== currentCommit) {
      toDelete.push(memory.id);
    }
  }
  stmt.free();

  // Delete expired memories
  for (const id of toDelete) {
    db.run('DELETE FROM memories WHERE id = ?', [id]);
  }

  if (toDelete.length > 0) {
    log.info(`Invalidated ${toDelete.length} expired memories`);
  }

  return toDelete.length;
}
