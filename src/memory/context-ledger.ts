/**
 * Context Ledger
 *
 * Tracks which files, symbols, and chunks were already returned to an agent
 * in a session so later retrieval can prefer deltas over repeated context.
 */

import type { ContextDelta, ContextFeedback, ContextLedgerEntry } from '../shared/types.js';
import { generateId } from '../shared/utils.js';
import { getDatabaseSync, type SqlJsDatabase } from '../storage/database.js';

export interface MarkContextUsedInput {
  sessionId: string;
  taskId?: string;
  repoRoot?: string;
  branch?: string;
  commit?: string;
  query: string;
  returnedFiles?: string[];
  returnedSymbols?: string[];
  returnedChunks?: string[];
  tokenEstimate?: number;
  evidenceIds?: string[];
  evidenceFingerprints?: string[];
  noveltyScore?: number;
  repeatedPenalty?: number;
  agentFeedback?: ContextFeedback;
  feedbackReason?: string;
}

export interface ContextCandidates {
  files?: string[];
  symbols?: string[];
  chunks?: string[];
  evidenceIds?: string[];
}

export interface ContextLedgerPenalty {
  files: Set<string>;
  symbols: Set<string>;
  chunks: Set<string>;
  totalPriorTokens: number;
  evidenceIds: string[];
}

export interface ContextLedgerPruneInput {
  filePaths?: string[];
  symbolKeys?: string[];
  chunkKeys?: string[];
  evidenceIds?: string[];
}

export function markContextUsed(input: MarkContextUsedInput, db: SqlJsDatabase = getDatabaseSync()): string {
  const now = new Date().toISOString();
  const id = generateId(
    'context-ledger',
    input.sessionId,
    input.query,
    now,
    JSON.stringify(input.returnedChunks || []),
  );

  db.run(
    `INSERT INTO context_ledger
      (id, session_id, task_id, repo_root, branch, commit_hash, query,
       returned_files, returned_symbols, returned_chunks, token_estimate,
       evidence_ids, evidence_fingerprints, novelty_score, repeated_penalty,
       agent_feedback, feedback_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.sessionId,
      input.taskId || null,
      input.repoRoot || null,
      input.branch || null,
      input.commit || null,
      input.query,
      JSON.stringify(input.returnedFiles || []),
      JSON.stringify(input.returnedSymbols || []),
      JSON.stringify(input.returnedChunks || []),
      input.tokenEstimate || 0,
      JSON.stringify(input.evidenceIds || []),
      JSON.stringify(input.evidenceFingerprints || fingerprintEvidence(input.evidenceIds || [])),
      input.noveltyScore ?? 1.0,
      input.repeatedPenalty ?? 0.0,
      input.agentFeedback || null,
      input.feedbackReason || null,
      now,
    ],
  );

  return id;
}

export function updateContextFeedback(
  id: string,
  feedback: ContextFeedback,
  db: SqlJsDatabase = getDatabaseSync(),
): void {
  db.run('UPDATE context_ledger SET agent_feedback = ? WHERE id = ?', [feedback, id]);
}

export function resetContextSession(
  sessionId: string,
  db: SqlJsDatabase = getDatabaseSync(),
): number {
  db.run('DELETE FROM context_ledger WHERE session_id = ?', [sessionId]);
  return db.getRowsModified();
}

export function pruneContextLedgerReferences(input: ContextLedgerPruneInput): number {
  const removedFiles = new Set(input.filePaths || []);
  const removedSymbols = new Set(input.symbolKeys || []);
  const removedChunks = new Set(input.chunkKeys || []);
  const removedEvidenceIds = new Set(input.evidenceIds || []);
  for (const symbolKey of removedSymbols) removedEvidenceIds.add('symbol:' + symbolKey);
  for (const chunkKey of removedChunks) removedEvidenceIds.add('chunk:' + chunkKey);

  const pathPrefixes = [...removedFiles].map((filePath) => filePath + ':');
  const shouldDropByPath = (value: string) => pathPrefixes.some((prefix) => value.startsWith(prefix));
  if (
    removedFiles.size === 0 &&
    removedSymbols.size === 0 &&
    removedChunks.size === 0 &&
    removedEvidenceIds.size === 0
  ) {
    return 0;
  }

  const db = getDatabaseSync();
  const rows = db.all<{
    id: string;
    returned_files: string;
    returned_symbols: string;
    returned_chunks: string;
    evidence_ids: string;
    evidence_fingerprints: string;
  }>(
    `SELECT id, returned_files, returned_symbols, returned_chunks, evidence_ids, evidence_fingerprints
     FROM context_ledger`,
  );
  const update = db.native.prepare(
    `UPDATE context_ledger
     SET returned_files = ?,
         returned_symbols = ?,
         returned_chunks = ?,
         evidence_ids = ?,
         evidence_fingerprints = ?
     WHERE id = ?`,
  );
  let updated = 0;
  const write = db.native.transaction(() => {
    for (const row of rows) {
      const currentFiles = parseStringArray(row.returned_files);
      const currentSymbols = parseStringArray(row.returned_symbols);
      const currentChunks = parseStringArray(row.returned_chunks);
      const currentEvidenceIds = parseStringArray(row.evidence_ids);
      const currentEvidenceFingerprints = parseStringArray(row.evidence_fingerprints);
      const nextFiles = currentFiles
        .filter((item) => !removedFiles.has(item));
      const nextSymbols = currentSymbols
        .filter((item) => !removedSymbols.has(item) && !shouldDropByPath(item));
      const nextChunks = currentChunks
        .filter((item) => !removedChunks.has(item) && !shouldDropByPath(item));
      const nextEvidenceIds = currentEvidenceIds
        .filter((item) => !removedEvidenceIds.has(item) && !shouldDropByPath(stripEvidencePrefix(item)));
      const nextEvidenceFingerprints = currentEvidenceFingerprints
        .filter((item) => !removedEvidenceIds.has(item) && !shouldDropByPath(stripEvidencePrefix(item)));

      if (
        arraysEqual(nextFiles, currentFiles) &&
        arraysEqual(nextSymbols, currentSymbols) &&
        arraysEqual(nextChunks, currentChunks) &&
        arraysEqual(nextEvidenceIds, currentEvidenceIds) &&
        arraysEqual(nextEvidenceFingerprints, currentEvidenceFingerprints)
      ) {
        continue;
      }

      update.run(
        JSON.stringify(nextFiles),
        JSON.stringify(nextSymbols),
        JSON.stringify(nextChunks),
        JSON.stringify(nextEvidenceIds),
        JSON.stringify(nextEvidenceFingerprints),
        row.id,
      );
      updated++;
    }
  });
  write();
  return updated;
}

export function compactSessionContext(sessionId: string, db: SqlJsDatabase = getDatabaseSync()): {
  sessionId: string;
  entries: number;
  files: string[];
  symbols: string[];
  chunks: string[];
  evidenceIds: string[];
  totalTokens: number;
} {
  const entries = getContextLedgerEntriesForDb(sessionId, db);
  return {
    sessionId,
    entries: entries.length,
    files: unique(entries.flatMap((entry) => entry.returnedFiles)),
    symbols: unique(entries.flatMap((entry) => entry.returnedSymbols)),
    chunks: unique(entries.flatMap((entry) => entry.returnedChunks)),
    evidenceIds: unique(entries.flatMap((entry) => entry.evidenceIds)),
    totalTokens: entries.reduce((sum, entry) => sum + entry.tokenEstimate, 0),
  };
}

export function getContextLedgerEntries(sessionId: string): ContextLedgerEntry[] {
  const db = getDatabaseSync();
  return getContextLedgerEntriesForDb(sessionId, db);
}

export function getContextLedgerEntriesForDb(
  sessionId: string,
  db: SqlJsDatabase = getDatabaseSync(),
): ContextLedgerEntry[] {
  const result = db.exec(
    `SELECT id, session_id, task_id, repo_root, branch, commit_hash, query,
            returned_files, returned_symbols, returned_chunks, token_estimate,
            evidence_ids, evidence_fingerprints, novelty_score, repeated_penalty,
            agent_feedback, feedback_reason, created_at
     FROM context_ledger
     WHERE session_id = ?
     ORDER BY created_at ASC`,
    [sessionId],
  );
  if (!result.length) return [];

  return result[0].values.map((row) => ({
    id: String(row[0]),
    sessionId: String(row[1]),
    taskId: nullableString(row[2]),
    repoRoot: nullableString(row[3]),
    branch: nullableString(row[4]),
    commit: nullableString(row[5]),
    query: String(row[6]),
    returnedFiles: parseStringArray(row[7]),
    returnedSymbols: parseStringArray(row[8]),
    returnedChunks: parseStringArray(row[9]),
    tokenEstimate: Number(row[10]),
    evidenceIds: parseStringArray(row[11]),
    evidenceFingerprints: parseStringArray(row[12]),
    noveltyScore: Number(row[13] ?? 1),
    repeatedPenalty: Number(row[14] ?? 0),
    agentFeedback: row[15] ? String(row[15]) as ContextFeedback : null,
    feedbackReason: nullableString(row[16]),
    createdAt: String(row[17]),
  }));
}

export function getContextDelta(sessionId: string, candidates: ContextCandidates): ContextDelta {
  return getContextDeltaForDb(sessionId, candidates, getDatabaseSync());
}

export function getContextDeltaForDb(
  sessionId: string,
  candidates: ContextCandidates,
  db: SqlJsDatabase = getDatabaseSync(),
): ContextDelta {
  const entries = getContextLedgerEntriesForDb(sessionId, db);
  const seenFiles = new Set(entries.flatMap((entry) => entry.returnedFiles));
  const seenSymbols = new Set(entries.flatMap((entry) => entry.returnedSymbols));
  const seenChunks = new Set(entries.flatMap((entry) => entry.returnedChunks));
  const seenEvidence = new Set(entries.flatMap((entry) => entry.evidenceIds));

  const files = candidates.files || [];
  const symbols = candidates.symbols || [];
  const chunks = candidates.chunks || [];
  const evidenceIds = candidates.evidenceIds || [];
  const repeatedCount = files.filter((item) => seenFiles.has(item)).length
    + symbols.filter((item) => seenSymbols.has(item)).length
    + chunks.filter((item) => seenChunks.has(item)).length
    + evidenceIds.filter((item) => seenEvidence.has(item)).length;
  const totalCount = files.length + symbols.length + chunks.length + evidenceIds.length;
  const noveltyScore = totalCount === 0 ? 1 : Math.max(0, 1 - repeatedCount / totalCount);
  const repeatedPenalty = Number((repeatedCount * 0.08).toFixed(2));

  return {
    newFiles: files.filter((item) => !seenFiles.has(item)),
    repeatedFiles: files.filter((item) => seenFiles.has(item)),
    newSymbols: symbols.filter((item) => !seenSymbols.has(item)),
    repeatedSymbols: symbols.filter((item) => seenSymbols.has(item)),
    newChunks: chunks.filter((item) => !seenChunks.has(item)),
    repeatedChunks: chunks.filter((item) => seenChunks.has(item)),
    newEvidenceIds: evidenceIds.filter((item) => !seenEvidence.has(item)),
    repeatedEvidenceIds: evidenceIds.filter((item) => seenEvidence.has(item)),
    totalPriorTokens: entries.reduce((sum, entry) => sum + entry.tokenEstimate, 0),
    evidenceIds: [...new Set(entries.flatMap((entry) => entry.evidenceIds))],
    noveltyScore,
    repeatedPenalty,
  };
}

export function getContextLedgerPenalty(sessionId: string): ContextLedgerPenalty {
  return getContextLedgerPenaltyForDb(sessionId, getDatabaseSync());
}

export function getContextLedgerPenaltyForDb(
  sessionId: string,
  db: SqlJsDatabase = getDatabaseSync(),
): ContextLedgerPenalty {
  const entries = getContextLedgerEntriesForDb(sessionId, db);
  return {
    files: new Set(entries.flatMap((entry) => entry.returnedFiles)),
    symbols: new Set(entries.flatMap((entry) => entry.returnedSymbols)),
    chunks: new Set(entries.flatMap((entry) => entry.returnedChunks)),
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

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function fingerprintEvidence(evidenceIds: string[]): string[] {
  return evidenceIds.map((id) => 'evidence:' + id);
}

function stripEvidencePrefix(value: string): string {
  if (value.startsWith('evidence:')) return stripEvidencePrefix(value.slice('evidence:'.length));
  if (value.startsWith('symbol:')) return value.slice('symbol:'.length);
  if (value.startsWith('chunk:')) return value.slice('chunk:'.length);
  return value;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
