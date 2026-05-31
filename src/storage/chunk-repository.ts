/**
 * Code Memory Graph — Chunk Repository
 *
 * CRUD operations for the `chunks` table.
 * Chunks represent discrete code segments used for
 * embedding and retrieval.
 */

import type { ChunkRecord } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';
import { getDatabaseSync } from './database.js';

const log = createLogger('chunk-repo');

// ── Serialization ───────────────────────────────────────────

function serializeChunk(record: Partial<ChunkRecord>): Record<string, unknown> {
  return {
    $id: record.id,
    $fileId: record.fileId,
    $symbolId: record.symbolId ?? null,
    $contentHash: record.contentHash,
    $content: record.content,
    $tokenCount: record.tokenCount,
    $summary: record.summary ?? null,
    $embeddingId: record.embeddingId ?? null,
  };
}

function deserializeChunk(row: Record<string, unknown>): ChunkRecord {
  return {
    id: row.id as string,
    fileId: row.file_id as string,
    symbolId: (row.symbol_id as string) ?? null,
    contentHash: row.content_hash as string,
    content: row.content as string,
    tokenCount: row.token_count as number,
    summary: (row.summary as string) ?? null,
    embeddingId: (row.embedding_id as string) ?? null,
  };
}

// ── Repository methods ──────────────────────────────────────

export function upsertChunk(chunk: ChunkRecord): void {
  const db = getDatabaseSync();
  const p = serializeChunk(chunk);

  db.run(
    `INSERT OR REPLACE INTO chunks
       (id, file_id, symbol_id, content_hash, content, token_count, summary, embedding_id)
     VALUES ($id, $fileId, $symbolId, $contentHash, $content, $tokenCount, $summary, $embeddingId)`,
    [
      p.$id, p.$fileId, p.$symbolId, p.$contentHash, p.$content,
      p.$tokenCount, p.$summary, p.$embeddingId,
    ],
  );
}

export function getChunksByFileId(fileId: string): ChunkRecord[] {
  const db = getDatabaseSync();
  const results: ChunkRecord[] = [];
  const stmt = db.prepare('SELECT * FROM chunks WHERE file_id = ?');
  stmt.bind([fileId]);

  while (stmt.step()) {
    results.push(deserializeChunk(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

export function getChunksByContentHash(hash: string): ChunkRecord[] {
  const db = getDatabaseSync();
  const results: ChunkRecord[] = [];
  const stmt = db.prepare('SELECT * FROM chunks WHERE content_hash = ?');
  stmt.bind([hash]);

  while (stmt.step()) {
    results.push(deserializeChunk(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

export function deleteChunksByFileId(fileId: string): void {
  const db = getDatabaseSync();
  db.run('DELETE FROM chunks WHERE file_id = ?', [fileId]);
}
