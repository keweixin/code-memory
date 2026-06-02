import type { SqlJsDatabase } from '../storage/database.js';
import { SCHEMA_VERSION } from '../storage/schema.js';
import { getContextLedgerPenaltyForDb, type ContextLedgerPenalty } from '../memory/context-ledger.js';
import type { SearchResult } from '../shared/types.js';

const LEDGER_FILE_PENALTY = 0.15;
const LEDGER_SYMBOL_PENALTY = 0.35;
const LEDGER_CHUNK_PENALTY = 0.60;
const MAX_LEDGER_PENALTY = 0.85;

export interface LedgerPenaltyResult {
  results: SearchResult[];
  penalizedResults: number;
  totalPriorTokens: number;
}

export function applyLedgerPenalties(
  db: SqlJsDatabase,
  results: SearchResult[],
  options: { sessionId?: string; avoidRepeated?: boolean },
): LedgerPenaltyResult {
  if (!options.sessionId || !options.avoidRepeated || results.length === 0) {
    return { results, penalizedResults: 0, totalPriorTokens: 0 };
  }

  const ledger = getContextLedgerPenaltyForDb(options.sessionId, db);
  let penalizedResults = 0;
  const reranked = results.map((result) => {
    const ledgerPenalty = computeLedgerPenalty(result, ledger);
    if (ledgerPenalty <= 0) return result;

    penalizedResults += 1;
    return {
      ...result,
      score: Math.max(0, result.score - ledgerPenalty),
      scoreBreakdown: {
        ...(result.scoreBreakdown || {}),
        ledgerPenalty,
        finalScore: Math.max(0, result.score - ledgerPenalty),
      },
    };
  });

  reranked.sort((a, b) => b.score - a.score);
  for (const result of reranked) {
    result.diagnostics = {
      ...(result.diagnostics || {
        schemaVersion: SCHEMA_VERSION,
        vectorUsed: result.sources.includes('vector'),
        graphUsed: result.sources.includes('graph'),
        repeatedContextOmitted: 0,
      }),
      repeatedContextPenalized: penalizedResults,
      totalPriorContextTokens: ledger.totalPriorTokens,
    };
  }

  return {
    results: reranked,
    penalizedResults,
    totalPriorTokens: ledger.totalPriorTokens,
  };
}

function computeLedgerPenalty(result: SearchResult, ledger: ContextLedgerPenalty): number {
  let penalty = 0;

  if (result.filePath && ledger.files.has(result.filePath)) {
    penalty += LEDGER_FILE_PENALTY;
  }

  if (ledger.symbols.has(result.id) || matchesLedgerContextKey(ledger.symbols, result)) {
    penalty += LEDGER_SYMBOL_PENALTY;
  }

  if (ledger.chunks.has(result.id) || matchesLedgerContextKey(ledger.chunks, result)) {
    penalty += LEDGER_CHUNK_PENALTY;
  }

  return Math.min(penalty, MAX_LEDGER_PENALTY);
}

function matchesLedgerContextKey(keys: Set<string>, result: SearchResult): boolean {
  if (!result.filePath) return false;
  const filePrefix = result.filePath + ':';

  for (const key of keys) {
    if (key === result.id) return true;
    if (!key.startsWith(filePrefix)) continue;
    if (result.kind === 'file') return true;
    if (key.includes(':' + result.name + ':') || key.includes(':' + result.name + '|')) {
      return true;
    }
  }

  return false;
}
