import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDatabase, getDatabase, getDatabaseSync, openExistingDatabase } from '../src/storage/database.js';
import { registerContextLedgerTools } from '../src/mcp/tools/context-ledger.js';
import { getContextLedgerEntries, getContextLedgerEntriesForDb } from '../src/memory/context-ledger.js';

type ToolResult = Promise<{ content: Array<{ type: 'text'; text: string }> }>;
type ToolHandler = (args: Record<string, unknown>) => ToolResult;
type StructuredToolResult<TData = Record<string, unknown>> = {
  status: string;
  project: { root: string; repoName: string; dbPath: string };
  freshness: { indexStatus: string; changedFiles: string[]; recommendedAction: string };
  data: TData;
  nextAction: { tool?: string; command?: string; reason: string };
  display: string;
};

class FakeMcpServer {
  readonly handlers = new Map<string, ToolHandler>();

  tool(
    name: string,
    _description: string,
    _schema: unknown,
    handler: ToolHandler,
  ): void {
    this.handlers.set(name, handler);
  }
}

function parseStructured<TData = Record<string, unknown>>(
  result: Awaited<ToolResult>,
): StructuredToolResult<TData> {
  return JSON.parse(result.content[0].text) as StructuredToolResult<TData>;
}

describe('MCP context ledger tools', () => {
  let tempRoot: string;

  afterEach(async () => {
    await closeDatabase();
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('applies feedback to the ledger entry that contains the explained context', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-ledger-tools-'));
    await getDatabase(tempRoot);

    const server = new FakeMcpServer();
    registerContextLedgerTools(server as never);

    await server.handlers.get('mark_context_used')!({
      sessionId: 'session-feedback',
      query: 'first search',
      returnedFiles: ['src/services/AuthService.ts'],
      tokenEstimate: 100,
    });
    await server.handlers.get('mark_context_used')!({
      sessionId: 'session-feedback',
      query: 'second search',
      returnedFiles: ['src/services/token-service.ts'],
      tokenEstimate: 200,
    });

    const result = await server.handlers.get('explain_why_this_context')!({
      sessionId: 'session-feedback',
      contextId: 'src/services/AuthService.ts',
      contextType: 'file',
      feedback: 'stale',
    });
    const structured = parseStructured<{
      contextId: string;
      repeated: boolean;
      seenCount: number;
      priorTokens: number;
      seenEntries: Array<{ query: string; agentFeedback: string | null }>;
    }>(result);

    expect(structured.data.contextId).toBe('src/services/AuthService.ts');
    expect(structured.data.repeated).toBe(true);
    expect(structured.data.seenCount).toBe(1);
    expect(structured.data.priorTokens).toBe(300);
    expect(structured.data.seenEntries[0].query).toBe('first search');
    expect(structured.data.seenEntries[0].agentFeedback).toBe('stale');
    expect(structured.display).toContain('src/services/AuthService.ts is repeated for session session-feedback');
    expect(structured.display).toContain('query="first search" feedback=stale');

    const entries = getContextLedgerEntries('session-feedback');
    expect(entries.map((entry) => [entry.query, entry.agentFeedback])).toEqual([
      ['first search', 'stale'],
      ['second search', null],
    ]);
  });

  it('routes ledger tools to the requested repo without mixing sessions across databases', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-ledger-routing-'));
    const firstRoot = join(tempRoot, 'first');
    const secondRoot = join(tempRoot, 'second');

    await getDatabase(secondRoot);
    await closeDatabase();
    await getDatabase(firstRoot);

    const server = new FakeMcpServer();
    registerContextLedgerTools(server as never, getDatabaseSync());

    await server.handlers.get('mark_context_used')!({
      sessionId: 'same-session',
      query: 'default repo context',
      returnedFiles: ['src/alpha.ts'],
      tokenEstimate: 10,
    });
    await server.handlers.get('mark_context_used')!({
      repo: secondRoot,
      sessionId: 'same-session',
      query: 'second repo context',
      returnedFiles: ['src/beta.ts'],
      tokenEstimate: 20,
    });

    const defaultDelta = await server.handlers.get('get_context_delta')!({
      sessionId: 'same-session',
      candidateFiles: ['src/beta.ts'],
    });
    const structuredDefaultDelta = parseStructured<{
      delta: { newFiles: string[]; repeatedFiles: string[]; totalPriorTokens: number };
    }>(defaultDelta);
    expect(structuredDefaultDelta.project.root).toBe(firstRoot);
    expect(structuredDefaultDelta.data.delta.newFiles).toEqual(['src/beta.ts']);
    expect(structuredDefaultDelta.data.delta.totalPriorTokens).toBe(10);
    expect(structuredDefaultDelta.display).toContain('New files: src/beta.ts');
    expect(structuredDefaultDelta.display).toContain('Prior tokens: 10');

    const routedDelta = await server.handlers.get('get_context_delta')!({
      repo: secondRoot,
      sessionId: 'same-session',
      candidateFiles: ['src/beta.ts'],
    });
    const structuredRoutedDelta = parseStructured<{
      delta: { newFiles: string[]; repeatedFiles: string[]; totalPriorTokens: number };
    }>(routedDelta);
    expect(structuredRoutedDelta.project.root).toBe(secondRoot);
    expect(structuredRoutedDelta.data.delta.repeatedFiles).toEqual(['src/beta.ts']);
    expect(structuredRoutedDelta.data.delta.totalPriorTokens).toBe(20);
    expect(structuredRoutedDelta.display).toContain('Repeated files: src/beta.ts');
    expect(structuredRoutedDelta.display).toContain('Prior tokens: 20');

    const routedRepeatCheck = await server.handlers.get('avoid_repeated_context')!({
      repo: secondRoot,
      sessionId: 'same-session',
      candidateFiles: ['src/beta.ts', 'src/gamma.ts'],
    });
    const structuredRepeatCheck = parseStructured<{
      keep: { files: string[] };
      drop: { files: string[] };
    }>(routedRepeatCheck);
    expect(structuredRepeatCheck.project.root).toBe(secondRoot);
    expect(structuredRepeatCheck.data.keep.files).toEqual(['src/gamma.ts']);
    expect(structuredRepeatCheck.data.drop.files).toEqual(['src/beta.ts']);
    expect(structuredRepeatCheck.display).toContain('Keep files: src/gamma.ts');
    expect(structuredRepeatCheck.display).toContain('Drop repeated files: src/beta.ts');

    const routedExplanation = await server.handlers.get('explain_why_this_context')!({
      repo: secondRoot,
      sessionId: 'same-session',
      contextId: 'src/beta.ts',
      contextType: 'file',
      feedback: 'useful',
    });
    const structuredExplanation = parseStructured<{
      contextId: string;
      repeated: boolean;
      seenEntries: Array<{ agentFeedback: string | null }>;
    }>(routedExplanation);
    expect(structuredExplanation.project.root).toBe(secondRoot);
    expect(structuredExplanation.data.contextId).toBe('src/beta.ts');
    expect(structuredExplanation.data.repeated).toBe(true);
    expect(structuredExplanation.data.seenEntries[0].agentFeedback).toBe('useful');
    expect(structuredExplanation.display).toContain('src/beta.ts is repeated for session same-session');
    expect(structuredExplanation.display).toContain('feedback=useful');

    const defaultCompact = await server.handlers.get('compact_session_context')!({
      sessionId: 'same-session',
    });
    const structuredDefaultCompact = parseStructured<{ files: string[] }>(defaultCompact);
    expect(structuredDefaultCompact.project.root).toBe(firstRoot);
    expect(structuredDefaultCompact.data.files).toEqual(['src/alpha.ts']);
    expect(structuredDefaultCompact.display).toContain('Files: src/alpha.ts');
    expect(structuredDefaultCompact.display).not.toContain('src/beta.ts');

    const routedCompact = await server.handlers.get('compact_session_context')!({
      repo: secondRoot,
      sessionId: 'same-session',
    });
    const structuredRoutedCompact = parseStructured<{ files: string[] }>(routedCompact);
    expect(structuredRoutedCompact.project.root).toBe(secondRoot);
    expect(structuredRoutedCompact.data.files).toEqual(['src/beta.ts']);
    expect(structuredRoutedCompact.display).toContain('Files: src/beta.ts');
    expect(structuredRoutedCompact.display).not.toContain('src/alpha.ts');

    const routedReset = await server.handlers.get('reset_context_session')!({
      repo: secondRoot,
      sessionId: 'same-session',
    });
    const structuredReset = parseStructured<{ removed: number }>(routedReset);
    expect(structuredReset.project.root).toBe(secondRoot);
    expect(structuredReset.data.removed).toBe(1);
    expect(structuredReset.display).toContain('Removed ledger entries: 1');

    const secondDb = openExistingDatabase(secondRoot);
    try {
      expect(getContextLedgerEntriesForDb('same-session', secondDb)).toHaveLength(0);
    } finally {
      secondDb.close();
    }
    expect(getContextLedgerEntries('same-session').map((entry) => entry.returnedFiles)).toEqual([
      ['src/alpha.ts'],
    ]);
  });
});
