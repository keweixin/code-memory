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
    const text = result.content[0].text;

    expect(text).toContain('=== Index Diagnostics ===');
    expect(text).toContain('Recommended action:');
    expect(text).toContain('Context retrieval plan');
    expect(text).toContain('Intent: debug');
    expect(text).toContain('Ledger prior entries: 1');
    expect(text).toContain('Ledger prior tokens: 321');
    expect(text).toContain('pre-pack rerank penalty');
    expect(text).toContain('Recommended next call:');
  });
});
