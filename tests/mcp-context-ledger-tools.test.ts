import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDatabase, getDatabase } from '../src/storage/database.js';
import { registerContextLedgerTools } from '../src/mcp/tools/context-ledger.js';
import { getContextLedgerEntries } from '../src/memory/context-ledger.js';

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
});
