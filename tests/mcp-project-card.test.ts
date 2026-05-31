import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';
import { registerGetProjectCardTool } from '../src/mcp/tools/get-project-card.js';

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

describe('MCP project card', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-project-card-'));
    cpSync(fixtureRoot, tempRoot, { recursive: true });
  });

  afterEach(async () => {
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('reports index evidence and vector availability honestly', async () => {
    await indexFixture(tempRoot);
    const db = getDatabaseSync();
    db.run(
      `INSERT OR REPLACE INTO index_metadata (key, value) VALUES
        ('current_commit', 'abc123def456'),
        ('current_branch', 'feature/context-evidence'),
        ('index_completed', '2026-05-31T09:00:00.000Z'),
        ('embedding_provider', 'none'),
        ('embedding_model', 'none')`,
    );

    const server = new FakeMcpServer();
    registerGetProjectCardTool(server as never, db);

    const result = await server.handlers.get('get_project_card')!({});
    const text = result.content[0].text;

    expect(text).toContain('Name:       sample-ts-project');
    expect(text).toContain('Branch:     feature/context-evidence');
    expect(text).toContain('Commit:     abc123def456');
    expect(text).toContain('Index Completed: 2026-05-31T09:00:00.000Z');
    expect(text).toContain('Embedding:  none (none)');
    expect(text).toContain('Vector:     disabled');
  });
});
