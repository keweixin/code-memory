import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDatabase, getDatabase } from '../src/storage/database.js';
import {
  getContextDelta,
  getContextLedgerEntries,
  markContextUsed,
  resetContextSession,
  updateContextFeedback,
} from '../src/memory/context-ledger.js';

describe('context ledger', () => {
  let tempRoot: string;

  afterEach(async () => {
    await closeDatabase();
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('records returned context and identifies repeated candidates', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-ledger-'));
    await getDatabase(tempRoot);

    const entryId = markContextUsed({
      sessionId: 'session-1',
      taskId: 'task-login',
      repoRoot: tempRoot,
      branch: 'main',
      commit: 'abc123',
      query: 'fix login',
      returnedFiles: ['src/services/AuthService.ts'],
      returnedSymbols: ['login'],
      returnedChunks: ['chunk-login'],
      tokenEstimate: 320,
      evidenceIds: ['symbol:login'],
      evidenceFingerprints: ['hash:login'],
      noveltyScore: 0.75,
      repeatedPenalty: 0.16,
    });

    updateContextFeedback(entryId, 'useful');

    const entries = getContextLedgerEntries('session-1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: entryId,
      sessionId: 'session-1',
      taskId: 'task-login',
      repoRoot: tempRoot,
      branch: 'main',
      commit: 'abc123',
      query: 'fix login',
      tokenEstimate: 320,
      evidenceFingerprints: ['hash:login'],
      noveltyScore: 0.75,
      repeatedPenalty: 0.16,
      agentFeedback: 'useful',
    });

    const delta = getContextDelta('session-1', {
      files: ['src/services/AuthService.ts', 'src/services/token-service.ts'],
      symbols: ['login', 'issueTokens'],
      chunks: ['chunk-login', 'chunk-token'],
      evidenceIds: ['symbol:login', 'symbol:token'],
    });

    expect(delta.repeatedFiles).toEqual(['src/services/AuthService.ts']);
    expect(delta.newFiles).toEqual(['src/services/token-service.ts']);
    expect(delta.repeatedSymbols).toEqual(['login']);
    expect(delta.newSymbols).toEqual(['issueTokens']);
    expect(delta.repeatedChunks).toEqual(['chunk-login']);
    expect(delta.newChunks).toEqual(['chunk-token']);
    expect(delta.repeatedEvidenceIds).toEqual(['symbol:login']);
    expect(delta.newEvidenceIds).toEqual(['symbol:token']);
    expect(delta.totalPriorTokens).toBe(320);
    expect(delta.noveltyScore).toBeLessThan(1);
    expect(delta.repeatedPenalty).toBeGreaterThan(0);
  });

  it('can reset a session ledger', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-ledger-reset-'));
    await getDatabase(tempRoot);

    markContextUsed({
      sessionId: 'session-reset',
      query: 'first',
      returnedFiles: ['a.ts'],
    });

    expect(getContextLedgerEntries('session-reset')).toHaveLength(1);
    expect(resetContextSession('session-reset')).toBe(1);
    expect(getContextLedgerEntries('session-reset')).toHaveLength(0);
  });
});
