import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDatabase, getDatabase, getDatabaseSync, openExistingDatabase } from '../src/storage/database.js';
import { registerContextLedgerTools } from '../src/mcp/tools/context-ledger.js';
import { getContextLedgerEntries, getContextLedgerEntriesForDb } from '../src/memory/context-ledger.js';

type ToolResult = Promise<{ content: Array<{ type: 'text'; text: string }> }>;
type ToolHandler = (args: Record<string, unknown>) => ToolResult;

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
    const text = result.content[0].text;

    expect(text).toContain('src/services/AuthService.ts is repeated for session session-feedback');
    expect(text).toContain('query="first search" feedback=stale');

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
    expect(defaultDelta.content[0].text).toContain('New files: src/beta.ts');
    expect(defaultDelta.content[0].text).toContain('Prior tokens: 10');

    const routedDelta = await server.handlers.get('get_context_delta')!({
      repo: secondRoot,
      sessionId: 'same-session',
      candidateFiles: ['src/beta.ts'],
    });
    expect(routedDelta.content[0].text).toContain('Repeated files: src/beta.ts');
    expect(routedDelta.content[0].text).toContain('Prior tokens: 20');

    const routedRepeatCheck = await server.handlers.get('avoid_repeated_context')!({
      repo: secondRoot,
      sessionId: 'same-session',
      candidateFiles: ['src/beta.ts', 'src/gamma.ts'],
    });
    expect(routedRepeatCheck.content[0].text).toContain('Keep files: src/gamma.ts');
    expect(routedRepeatCheck.content[0].text).toContain('Drop repeated files: src/beta.ts');

    const routedExplanation = await server.handlers.get('explain_why_this_context')!({
      repo: secondRoot,
      sessionId: 'same-session',
      contextId: 'src/beta.ts',
      contextType: 'file',
      feedback: 'useful',
    });
    expect(routedExplanation.content[0].text).toContain('src/beta.ts is repeated for session same-session');
    expect(routedExplanation.content[0].text).toContain('feedback=useful');

    const defaultCompact = await server.handlers.get('compact_session_context')!({
      sessionId: 'same-session',
    });
    expect(defaultCompact.content[0].text).toContain('Files: src/alpha.ts');
    expect(defaultCompact.content[0].text).not.toContain('src/beta.ts');

    const routedCompact = await server.handlers.get('compact_session_context')!({
      repo: secondRoot,
      sessionId: 'same-session',
    });
    expect(routedCompact.content[0].text).toContain('Files: src/beta.ts');
    expect(routedCompact.content[0].text).not.toContain('src/alpha.ts');

    const routedReset = await server.handlers.get('reset_context_session')!({
      repo: secondRoot,
      sessionId: 'same-session',
    });
    expect(routedReset.content[0].text).toContain('Removed ledger entries: 1');

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
