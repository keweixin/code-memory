import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';
import { registerAllTools } from '../src/mcp/tool-registry.js';

const fixtureRoot = resolve('tests/fixtures/sample-ts-project');

type ToolResult = Promise<{ content: Array<{ type: 'text'; text: string }> }>;
type ToolHandler = (args: Record<string, unknown>) => ToolResult;
type StructuredToolResult = {
  status: string;
  project: { root: string; repoName: string; dbPath: string };
  freshness: { indexStatus: string; changedFiles: string[]; recommendedAction: string };
  data: unknown;
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

function parseStructured(result: Awaited<ToolResult>): StructuredToolResult {
  return JSON.parse(result.content[0].text) as StructuredToolResult;
}

function expectEnvelope(result: StructuredToolResult, projectRoot: string): void {
  expect(result).toHaveProperty('status');
  expect(result).toHaveProperty('project');
  expect(result).toHaveProperty('freshness');
  expect(result).toHaveProperty('data');
  expect(result).toHaveProperty('nextAction');
  expect(result).toHaveProperty('display');
  expect(result.status).toBe('ready');
  expect(result.project.root).toBe(projectRoot);
  expect(result.project.dbPath).toContain('.code-memory');
  expect(Array.isArray(result.freshness.changedFiles)).toBe(true);
  expect(result.nextAction.reason).toBeTruthy();
  expect(typeof result.display).toBe('string');
  expect(result.display.length).toBeGreaterThan(0);
}

describe('MCP core tool result contract', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-core-contract-'));
    cpSync(fixtureRoot, tempRoot, { recursive: true });
  });

  afterEach(async () => {
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('returns parseable CodeMemoryToolResult envelopes for core DB-backed tools', async () => {
    await indexFixture(tempRoot);
    const server = new FakeMcpServer();
    const db = getDatabaseSync();
    registerAllTools(server as never, db);
    const processes = db.all<{ name: string }>('SELECT name FROM processes ORDER BY name');
    expect(processes.length).toBeGreaterThan(0);

    const toolCalls: Array<[string, Record<string, unknown>]> = [
      ['get_project_card', {}],
      ['plan_context', { query: 'debug login failure', tokenBudget: 1500 }],
      ['get_context_pack', { query: 'login', tokenBudget: 3000, levels: 'L3', sessionId: 'core-contract-pack' }],
      ['search_code', { query: 'login', limit: 5, searchMode: 'keyword' }],
      ['search_symbols', { query: 'login', kind: 'method', limit: 5 }],
      ['find_definition', { symbolName: 'AuthService.login' }],
      ['find_references', { symbolName: 'findUserByEmail', maxResults: 5 }],
      ['explain_module', { filePath: 'src/services/AuthService.ts' }],
      ['impact_analysis', { target: 'src/services/AuthService.ts' }],
      ['get_related_tests', { target: 'src/services/AuthService.ts' }],
      ['get_repo_map', { tokenBudget: 2500, directory: 'src/services' }],
      ['get_process', { name: processes[0]!.name }],
      ['get_call_graph', { symbolName: 'AuthService.login', depth: 1 }],
      ['get_dependency_graph', { filePath: 'src/services/AuthService.ts', depth: 1 }],
      ['get_community', { name: db.all<{ name: string }>('SELECT name FROM communities ORDER BY name')[0]!.name }],
      ['get_route_map', {}],
      ['mark_context_used', {
        sessionId: 'core-contract-session',
        query: 'login',
        returnedFiles: ['src/services/AuthService.ts'],
        tokenEstimate: 100,
      }],
      ['get_context_delta', {
        sessionId: 'core-contract-session',
        candidateFiles: ['src/services/AuthService.ts', 'src/services/token-service.ts'],
      }],
      ['avoid_repeated_context', {
        sessionId: 'core-contract-session',
        candidateFiles: ['src/services/AuthService.ts', 'src/services/token-service.ts'],
      }],
      ['explain_why_this_context', {
        sessionId: 'core-contract-session',
        contextId: 'src/services/AuthService.ts',
        contextType: 'file',
      }],
      ['compact_session_context', { sessionId: 'core-contract-session' }],
      ['remember_project_fact', {
        type: 'decision',
        content: 'AuthService.login is covered by auth tests',
        scope: ['src/services/AuthService.ts'],
        confidence: 0.9,
      }],
      ['invalidate_memory', { type: 'decision' }],
      ['reset_context_session', { sessionId: 'core-contract-session' }],
    ];

    for (const [toolName, args] of toolCalls) {
      const handler = server.handlers.get(toolName);
      expect(handler, `${toolName} should be registered`).toBeDefined();
      const result = parseStructured(await handler!(args));
      expectEnvelope(result, tempRoot);
    }
  });
});
