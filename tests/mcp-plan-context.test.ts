import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';
import { registerPlanContextTool } from '../src/mcp/tools/plan-context.js';
import { markContextUsed } from '../src/memory/context-ledger.js';

const fixtureRoot = resolve('tests/fixtures/sample-ts-project');

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

describe('MCP plan_context', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-plan-context-'));
    cpSync(fixtureRoot, tempRoot, { recursive: true });
  });

  afterEach(async () => {
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('returns an intent-aware retrieval plan with ledger state', async () => {
    await indexFixture(tempRoot);
    markContextUsed({
      sessionId: 'plan-session',
      query: 'login',
      returnedFiles: ['src/services/AuthService.ts'],
      tokenEstimate: 321,
    });

    const server = new FakeMcpServer();
    registerPlanContextTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('plan_context')!({
      query: 'debug login failure',
      tokenBudget: 4000,
      sessionId: 'plan-session',
      avoidRepeated: true,
    });
    const structured = parseStructured<{
      query: string;
      intent: string;
      ledger: { priorEntries: number; priorTokens: number };
      recommendedCall: { tool: string };
    }>(result);

    expect(structured.status).toBe('ready');
    expect(structured.project.root).toBe(tempRoot);
    expect(structured.data.query).toBe('debug login failure');
    expect(structured.data.intent).toBe('debug');
    expect(structured.data.ledger.priorEntries).toBe(1);
    expect(structured.data.ledger.priorTokens).toBe(321);
    expect(structured.data.recommendedCall.tool).toBe('get_context_pack');
    expect(structured.nextAction.tool).toBe('get_context_pack');
    expect(structured.display).toContain('=== Index Diagnostics ===');
    expect(structured.display).toContain('Recommended action:');
    expect(structured.display).toContain('Context retrieval plan');
    expect(structured.display).toContain('Intent: debug');
    expect(structured.display).toContain('Ledger prior entries: 1');
    expect(structured.display).toContain('Ledger prior tokens: 321');
    expect(structured.display).toContain('pre-pack rerank penalty');
    expect(structured.display).toContain('Recommended next call:');
  });
});
