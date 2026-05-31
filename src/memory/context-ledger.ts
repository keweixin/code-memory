/**
 * Context Ledger
 *
 * Tracks which files, symbols, and chunks were already returned to an agent
 * in a session so later retrieval can prefer deltas over repeated context.
 */

import type { ContextDelta, ContextFeedback, ContextLedgerEntry } from '../shared/types.js';
import { generateId } from '../shared/utils.js';
import { getDatabaseSync } from '../storage/database.js';

export interface MarkContextUsedInput {
  sessionId: string;
  query: string;
  returnedFiles?: string[];
  returnedSymbols?: string[];
  returnedChunks?: string[];
  tokenEstimate?: number;
  evidenceIds?: string[];
  agentFeedback?: ContextFeedback;
}

export interface ContextCandidates {
  files?: string[];
  symbols?: string[];
  chunks?: string[];
}

export function markContextUsed(input: MarkContextUsedInput): string {
  const now = new Date().toISOString();
  const id = generateId(
    'context-ledger',
    input.sessionId,
    input.query,
    now,
    JSON.stringify(input.returnedChunks || []),
  );

  const db = getDatabaseSync();
  db.run(
    `INSERT INTO context_ledger
      (id, session_id, query, returned_files, returned_symbols, returned_chunks,
       token_estimate, evidence_ids, agent_feedback, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.sessionId,
      input.query,
      JSON.stringify(input.returnedFiles || []),
      JSON.stringify(input.returnedSymbols || []),
      JSON.stringify(input.returnedChunks || []),
      input.tokenEstimate || 0,
      JSON.stringify(input.evidenceIds || []),
      input.agentFeedback || null,
      now,
    ],
  );

  return id;
}

export function updateContextFeedback(id: string, feedback: ContextFeedback): void {
  const db = getDatabaseSync();
  db.run('UPDATE context_ledger SET agent_feedback = ? WHERE id = ?', [feedback, id]);
}

export function getContextLedgerEntries(sessionId: string): ContextLedgerEntry[] {
  const db = getDatabaseSync();
  const result = db.exec(
    `SELECT id, session_id, query, returned_files, returned_symbols, returned_chunks,
            token_estimate, evidence_ids, agent_feedback, created_at
     FROM context_ledger
     WHERE session_id = ?
     ORDER BY created_at ASC`,
    [sessionId],
  );
  if (!result.length) return [];

  return result[0].values.map((row) => ({
    id: String(row[0]),
    sessionId: String(row[1]),
    query: String(row[2]),
    returnedFiles: parseStringArray(row[3]),
    returnedSymbols: parseStringArray(row[4]),
    returnedChunks: parseStringArray(row[5]),
    tokenEstimate: Number(row[6]),
    evidenceIds: parseStringArray(row[7]),
    agentFeedback: row[8] ? String(row[8]) as ContextFeedback : null,
    createdAt: String(row[9]),
  }));
}

export function getContextDelta(sessionId: string, candidates: ContextCandidates): ContextDelta {
  const entries = getContextLedgerEntries(sessionId);
  const seenFiles = new Set(entries.flatMap((entry) => entry.returnedFiles));
  const seenSymbols = new Set(entries.flatMap((entry) => entry.returnedSymbols));
  const seenChunks = new Set(entries.flatMap((entry) => entry.returnedChunks));

  const files = candidates.files || [];
  const symbols = candidates.symbols || [];
  const chunks = candidates.chunks || [];

  return {
    newFiles: files.filter((item) => !seenFiles.has(item)),
    repeatedFiles: files.filter((item) => seenFiles.has(item)),
    newSymbols: symbols.filter((item) => !seenSymbols.has(item)),
    repeatedSymbols: symbols.filter((item) => seenSymbols.has(item)),
    newChunks: chunks.filter((item) => !seenChunks.has(item)),
    repeatedChunks: chunks.filter((item) => seenChunks.has(item)),
    totalPriorTokens: entries.reduce((sum, entry) => sum + entry.tokenEstimate, 0),
    evidenceIds: [...new Set(entries.flatMap((entry) => entry.evidenceIds))],
  };
}

function parseStringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
