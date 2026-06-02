import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';
import { registerPlanContextTool } from '../src/mcp/tools/plan-context.js';
import { registerExplainModuleTool } from '../src/mcp/tools/explain-module.js';
import type { PendingFile } from '../src/indexer/watch-service.js';

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

vi.mock('../src/indexer/watch-service.js', () => {
  let mockPendingFiles: PendingFile[] = [];
  return {
    getActiveWatchState: () => {
      if (mockPendingFiles.length === 0) return undefined;
      return { getPendingFiles: () => mockPendingFiles };
    },
    _setMockPendingFiles: (files: PendingFile[]) => { mockPendingFiles = files; },
  };
});

describe('MCP stale banner coverage', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-stale-banner-'));
    cpSync(fixtureRoot, tempRoot, { recursive: true });
  });

  afterEach(async () => {
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('plan_context inserts stale banner when there are pending files', async () => {
    const { _setMockPendingFiles } = await import('../src/indexer/watch-service.js');
    _setMockPendingFiles([
      { path: 'src/services/AuthService.ts', lastSeenMs: Date.now() - 5_000, indexing: false },
    ]);

    await indexFixture(tempRoot);
    const server = new FakeMcpServer();
    registerPlanContextTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('plan_context')!({
      query: 'login',
      tokenBudget: 4000,
    });
    const text = result.content[0].text;

    const hasBanner = text.includes('Stale file warning') || text.includes('Other pending files');
    expect(hasBanner).toBe(true);
    expect(text).toContain('src/services/AuthService.ts');

    _setMockPendingFiles([]);
  });

  it('explain_module inserts stale banner when there are pending files', async () => {
    const { _setMockPendingFiles } = await import('../src/indexer/watch-service.js');
    _setMockPendingFiles([
      { path: 'src/services/AuthService.ts', lastSeenMs: Date.now() - 5_000, indexing: false },
    ]);

    await indexFixture(tempRoot);
    const server = new FakeMcpServer();
    registerExplainModuleTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('explain_module')!({
      filePath: 'src/services/AuthService.ts',
    });
    const text = result.content[0].text;

    expect(text).toContain('Stale file warning');
    expect(text).toContain('src/services/AuthService.ts');

    _setMockPendingFiles([]);
  });
});
