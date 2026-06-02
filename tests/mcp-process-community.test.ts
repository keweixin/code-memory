import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabase, getDatabaseSync } from '../src/storage/database.js';
import { registerGetProcessTool } from '../src/mcp/tools/get-process.js';
import { registerGetCommunityTool } from '../src/mcp/tools/get-community.js';

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

describe('MCP process and community tools', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-proc-comm-'));
    cpSync(fixtureRoot, tempRoot, { recursive: true });
  });

  afterEach(async () => {
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('get_process returns process data after full index', async () => {
    await indexFixture(tempRoot);
    await closeDatabase();
    await getDatabase(tempRoot);

    const db = getDatabaseSync();
    const server = new FakeMcpServer();
    registerGetProcessTool(server as never, db);

    // List all processes to find a valid name
    const processes = db.all<{ name: string }>(
      'SELECT name FROM processes ORDER BY name',
    );
    expect(processes.length).toBeGreaterThan(0);

    const processName = processes[0]!.name;
    const result = await server.handlers.get('get_process')!({ name: processName });
    const text = result.content[0].text;

    expect(text).toContain(`=== Process: ${processName} ===`);
    expect(text).toContain('Entry kind:');
    expect(text).toContain('Step count:');
    expect(text).toContain('--- Steps ---');
  });

  it('get_community returns community data after full index', async () => {
    await indexFixture(tempRoot);
    await closeDatabase();
    await getDatabase(tempRoot);

    const db = getDatabaseSync();
    const server = new FakeMcpServer();
    registerGetCommunityTool(server as never, db);

    // List all communities to find a valid name
    const communities = db.all<{ name: string }>(
      'SELECT name FROM communities ORDER BY name',
    );
    expect(communities.length).toBeGreaterThan(0);

    const communityName = communities[0]!.name;
    const result = await server.handlers.get('get_community')!({ name: communityName });
    const text = result.content[0].text;

    expect(text).toContain(`=== Community: ${communityName} ===`);
    expect(text).toContain('Cohesion:');
    expect(text).toContain('Member count:');
    expect(text).toContain('--- Members ---');
  });

  it('get_process returns error for unknown process', async () => {
    await indexFixture(tempRoot);
    await closeDatabase();
    await getDatabase(tempRoot);

    const db = getDatabaseSync();
    const server = new FakeMcpServer();
    registerGetProcessTool(server as never, db);

    const result = await server.handlers.get('get_process')!({
      name: 'NONEXISTENT_PROCESS_xyz',
    });
    const text = result.content[0].text;

    expect(text).toContain('No process found with name: NONEXISTENT_PROCESS_xyz');
  });

  it('get_community returns error for unknown community', async () => {
    await indexFixture(tempRoot);
    await closeDatabase();
    await getDatabase(tempRoot);

    const db = getDatabaseSync();
    const server = new FakeMcpServer();
    registerGetCommunityTool(server as never, db);

    const result = await server.handlers.get('get_community')!({
      name: 'NONEXISTENT_COMMUNITY_xyz',
    });
    const text = result.content[0].text;

    expect(text).toContain('No community found with name: NONEXISTENT_COMMUNITY_xyz');
  });
});
