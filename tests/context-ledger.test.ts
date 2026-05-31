import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDatabase, getDatabase } from '../src/storage/database.js';
import {
  getContextDelta,
  getContextLedgerEntries,
  markContextUsed,
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
      query: 'fix login',
      returnedFiles: ['src/services/AuthService.ts'],
      returnedSymbols: ['login'],
      returnedChunks: ['chunk-login'],
      tokenEstimate: 320,
      evidenceIds: ['symbol:login'],
    });

    updateContextFeedback(entryId, 'useful');

    const entries = getContextLedgerEntries('session-1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: entryId,
      sessionId: 'session-1',
      query: 'fix login',
      tokenEstimate: 320,
      agentFeedback: 'useful',
    });

    const delta = getContextDelta('session-1', {
      files: ['src/services/AuthService.ts', 'src/services/token-service.ts'],
      symbols: ['login', 'issueTokens'],
      chunks: ['chunk-login', 'chunk-token'],
    });

    expect(delta.repeatedFiles).toEqual(['src/services/AuthService.ts']);
    expect(delta.newFiles).toEqual(['src/services/token-service.ts']);
    expect(delta.repeatedSymbols).toEqual(['login']);
    expect(delta.newSymbols).toEqual(['issueTokens']);
    expect(delta.repeatedChunks).toEqual(['chunk-login']);
    expect(delta.newChunks).toEqual(['chunk-token']);
    expect(delta.totalPriorTokens).toBe(320);
  });
});
