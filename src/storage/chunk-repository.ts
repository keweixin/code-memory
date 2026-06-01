/**
 * Code Memory Graph — Chunk Repository
 *
 * CRUD operations for the `chunks` table.
 * Chunks represent discrete code segments used for
 * embedding and retrieval.
 */

import type { ChunkRecord } from '../shared/types.js';
import { getDatabaseSync } from './database.js';

// ── Serialization ───────────────────────────────────────────

function serializeChunk(record: Partial<ChunkRecord>): Record<string, unknown> {
  return {
    $id: record.id,
    $fileId: record.fileId,
    $symbolId: record.symbolId ?? null,
    $startByte: record.startByte,
    $endByte: record.endByte,
    $startLine: record.startLine,
    $endLine: record.endLine,
    $startColumn: record.startColumn,
    $endColumn: record.endColumn,
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
    startByte: row.start_byte as number,
    endByte: row.end_byte as number,
    startLine: row.start_line as number,
    endLine: row.end_line as number,
    startColumn: row.start_column as number,
    endColumn: row.end_column as number,
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
       (id, file_id, symbol_id, start_byte, end_byte, start_line, end_line,
        start_column, end_column, content_hash, content, token_count, summary, embedding_id)
     VALUES ($id, $fileId, $symbolId, $startByte, $endByte, $startLine, $endLine,
             $startColumn, $endColumn, $contentHash, $content, $tokenCount, $summary, $embeddingId)`,
    [
      p.$id, p.$fileId, p.$symbolId,
      p.$startByte, p.$endByte, p.$startLine, p.$endLine,
      p.$startColumn, p.$endColumn, p.$contentHash, p.$content,
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
