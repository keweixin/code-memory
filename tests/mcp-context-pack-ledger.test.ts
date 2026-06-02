import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';
import { registerGetContextPackTool } from '../src/mcp/tools/get-context-pack.js';
import { getContextLedgerEntries } from '../src/memory/context-ledger.js';

const fixtureRoot = resolve('tests/fixtures/sample-ts-project');

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

function createConfig(rootPath: string): CodeMemoryConfig {
  return {
    projectName: 'sample-ts-project',
    rootPath,
    ignore: [...DEFAULT_IGNORE_PATTERNS],
    languages: ['typescript', 'javascript'],
    embedding: {
      provider: 'none',
      model: 'none',
    },
    llm: null,
    realtime: {
      watch: false,
      debounceMs: 80,
    },
    tokenBudgets: { ...DEFAULT_TOKEN_BUDGETS },
  };
}

async function indexFixture(rootPath: string): Promise<void> {
  const config = createConfig(rootPath);
  mkdirSync(join(rootPath, '.code-memory'), { recursive: true });
  writeFileSync(
    join(rootPath, '.code-memory', 'config.json'),
    JSON.stringify(config, null, 2),
    'utf-8',
  );

  const manager = new IndexManager(rootPath, config);
  await manager.fullIndex();
}

describe('MCP context pack ledger integration', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-context-pack-'));
    cpSync(fixtureRoot, tempRoot, { recursive: true });
  });

  afterEach(async () => {
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('records context packs and can omit repeated snippets for a session', async () => {
    await indexFixture(tempRoot);
    const server = new FakeMcpServer();
    registerGetContextPackTool(server as never, getDatabaseSync());

    const first = await server.handlers.get('get_context_pack')!({
      query: 'login',
      tokenBudget: 12000,
      sessionId: 'session-login',
      avoidRepeated: true,
    });
    const firstText = first.content[0].text;

    expect(firstText).toContain('=== Index Diagnostics ===');
    expect(firstText).toContain('Last indexed commit:');
    expect(firstText).toContain('=== Context Ledger ===');
    expect(firstText).toContain('Ledger entry:');
    expect(firstText).toContain('async login(request: LoginRequest)');

    const second = await server.handlers.get('get_context_pack')!({
      query: 'login',
      tokenBudget: 12000,
      sessionId: 'session-login',
      avoidRepeated: true,
    });
    const secondText = second.content[0].text;

    expect(secondText).toContain('Repeated chunks:');
    expect(secondText).toContain('Repeated context omitted for session session-login.');
    expect(secondText).toContain('Fill-after-omit used 60 ranked candidates');
    expect(secondText).not.toContain('async login(request: LoginRequest)');
    expect(getContextLedgerEntries('session-login')).toHaveLength(2);
  });

  it('fills with new code snippets after omitting lower-level repeated context', async () => {
    await indexFixture(tempRoot);
    const server = new FakeMcpServer();
    registerGetContextPackTool(server as never, getDatabaseSync());

    const first = await server.handlers.get('get_context_pack')!({
      query: 'login',
      tokenBudget: 2000,
      sessionId: 'session-login-fill',
      avoidRepeated: true,
    });
    const firstText = first.content[0].text;

    expect(firstText).toContain('New symbols:');
    expect(firstText).not.toContain('=== Code ===');

    const second = await server.handlers.get('get_context_pack')!({
      query: 'login',
      tokenBudget: 12000,
      sessionId: 'session-login-fill',
      avoidRepeated: true,
    });
    const secondText = second.content[0].text;

    expect(secondText).toContain('Repeated symbols:');
    expect(secondText).toContain('New chunks:');
    expect(secondText).toContain('Repeated context omitted for session session-login-fill.');
    expect(secondText).toContain('Fill-after-omit used 60 ranked candidates');
    expect(secondText).toContain('=== Code ===');
    expect(secondText).toContain('async function issueTokens(payload: TokenPayload): Promise<TokenPair>');
  });

  it('honors the requested maximum context detail level', async () => {
    await indexFixture(tempRoot);
    const server = new FakeMcpServer();
    registerGetContextPackTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('get_context_pack')!({
      query: 'login',
      tokenBudget: 12000,
      levels: 'L2',
    });
    const text = result.content[0].text;

    expect(text).toContain('=== Symbols ===');
    expect(text).not.toContain('=== Code ===');
    expect(text).not.toContain('const user = await findUserByEmail(request.email);');
    expect(text).toContain('[Context: level=L2,');
  });
});
