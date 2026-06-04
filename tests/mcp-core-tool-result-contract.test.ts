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

type ToolCallCase = {
  name: string;
  args: Record<string, unknown>;
  requiredDataValues?: string[];
};

const dbBackedContractToolNames = [
  'get_project_card',
  'plan_context',
  'get_context_pack',
  'search_code',
  'search_symbols',
  'find_definition',
  'find_references',
  'explain_module',
  'impact_analysis',
  'get_related_tests',
  'get_repo_map',
  'get_process',
  'get_call_graph',
  'get_dependency_graph',
  'get_community',
  'get_route_map',
  'mark_context_used',
  'get_context_delta',
  'avoid_repeated_context',
  'explain_why_this_context',
  'compact_session_context',
  'remember_project_fact',
  'invalidate_memory',
  'reset_context_session',
] as const;

const globalManagementToolNames = [
  'resolve_project',
  'bootstrap_project',
  'sync_project',
  'register_project',
  'get_unified_repo_map',
] as const;

const expectedRegisteredToolNames = [
  ...dbBackedContractToolNames,
  ...globalManagementToolNames,
].sort();

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

function expectCriticalDataValues(result: StructuredToolResult, values: string[] = []): void {
  const machinePayload = JSON.stringify({
    project: result.project,
    freshness: result.freshness,
    data: result.data,
    nextAction: result.nextAction,
  });
  for (const value of values) {
    const encodedValue = JSON.stringify(value).slice(1, -1);
    expect(
      machinePayload.includes(value) || machinePayload.includes(encodedValue),
      `${value} must be present in machine-readable fields, not only display`,
    ).toBe(true);
  }
}

describe('MCP core tool result contract', () => {
  let tempRoot: string;
  let originalGlobalHome: string | undefined;

  beforeEach(() => {
    originalGlobalHome = process.env.CODE_MEMORY_GLOBAL_HOME;
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-core-contract-'));
    process.env.CODE_MEMORY_GLOBAL_HOME = join(tempRoot, 'home');
    cpSync(fixtureRoot, tempRoot, { recursive: true });
  });

  afterEach(async () => {
    if (originalGlobalHome === undefined) {
      delete process.env.CODE_MEMORY_GLOBAL_HOME;
    } else {
      process.env.CODE_MEMORY_GLOBAL_HOME = originalGlobalHome;
    }
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

    expect([...server.handlers.keys()].sort()).toEqual(expectedRegisteredToolNames);

    const processName = processes[0]!.name;
    const communityName = db.all<{ name: string }>('SELECT name FROM communities ORDER BY name')[0]!.name;
    const toolCalls: ToolCallCase[] = [
      { name: 'get_project_card', args: {}, requiredDataValues: ['sample-ts-project'] },
      {
        name: 'plan_context',
        args: { query: 'debug login failure', tokenBudget: 1500 },
        requiredDataValues: ['debug login failure', 'get_context_pack'],
      },
      {
        name: 'get_context_pack',
        args: { query: 'login', tokenBudget: 3000, levels: 'L3', sessionId: 'core-contract-pack' },
        requiredDataValues: ['login', 'core-contract-pack'],
      },
      {
        name: 'search_code',
        args: { query: 'login', limit: 5, searchMode: 'keyword' },
        requiredDataValues: ['login'],
      },
      {
        name: 'search_symbols',
        args: { query: 'login', kind: 'method', limit: 5 },
        requiredDataValues: ['login'],
      },
      {
        name: 'find_definition',
        args: { symbolName: 'AuthService.login' },
        requiredDataValues: ['AuthService.login', 'AuthService.ts'],
      },
      {
        name: 'find_references',
        args: { symbolName: 'findUserByEmail', maxResults: 5 },
        requiredDataValues: ['findUserByEmail'],
      },
      {
        name: 'explain_module',
        args: { filePath: 'src/services/AuthService.ts' },
        requiredDataValues: ['src/services/AuthService.ts', 'AuthService'],
      },
      {
        name: 'impact_analysis',
        args: { target: 'src/services/AuthService.ts' },
        requiredDataValues: ['src/services/AuthService.ts'],
      },
      {
        name: 'get_related_tests',
        args: { target: 'src/services/AuthService.ts' },
        requiredDataValues: ['src/services/AuthService.ts', 'tests/auth.test.ts'],
      },
      {
        name: 'get_repo_map',
        args: { tokenBudget: 2500, directory: 'src/services' },
        requiredDataValues: ['src/services', 'AuthService.ts'],
      },
      { name: 'get_process', args: { name: processName }, requiredDataValues: [processName] },
      {
        name: 'get_call_graph',
        args: { symbolName: 'AuthService.login', depth: 1 },
        requiredDataValues: ['AuthService.login'],
      },
      {
        name: 'get_dependency_graph',
        args: { filePath: 'src/services/AuthService.ts', depth: 1 },
        requiredDataValues: ['src/services/AuthService.ts'],
      },
      { name: 'get_community', args: { name: communityName }, requiredDataValues: [communityName] },
      { name: 'get_route_map', args: {} },
      {
        name: 'mark_context_used',
        args: {
          sessionId: 'core-contract-session',
          query: 'login',
          returnedFiles: ['src/services/AuthService.ts'],
          tokenEstimate: 100,
        },
        requiredDataValues: ['core-contract-session', 'login', 'src/services/AuthService.ts'],
      },
      {
        name: 'get_context_delta',
        args: {
          sessionId: 'core-contract-session',
          candidateFiles: ['src/services/AuthService.ts', 'src/services/token-service.ts'],
        },
        requiredDataValues: ['core-contract-session', 'src/services/token-service.ts'],
      },
      {
        name: 'avoid_repeated_context',
        args: {
          sessionId: 'core-contract-session',
          candidateFiles: ['src/services/AuthService.ts', 'src/services/token-service.ts'],
        },
        requiredDataValues: ['core-contract-session', 'src/services/token-service.ts'],
      },
      {
        name: 'explain_why_this_context',
        args: {
          sessionId: 'core-contract-session',
          contextId: 'src/services/AuthService.ts',
          contextType: 'file',
        },
        requiredDataValues: ['core-contract-session', 'src/services/AuthService.ts'],
      },
      {
        name: 'compact_session_context',
        args: { sessionId: 'core-contract-session' },
        requiredDataValues: ['core-contract-session'],
      },
      {
        name: 'remember_project_fact',
        args: {
          type: 'decision',
          content: 'AuthService.login is covered by auth tests',
          scope: ['src/services/AuthService.ts'],
          confidence: 0.9,
        },
        requiredDataValues: ['decision', 'AuthService.login', 'src/services/AuthService.ts'],
      },
      { name: 'invalidate_memory', args: { type: 'decision' }, requiredDataValues: ['decision'] },
      {
        name: 'reset_context_session',
        args: { sessionId: 'core-contract-session' },
        requiredDataValues: ['core-contract-session'],
      },
    ];
    expect(toolCalls.map(({ name }) => name).sort()).toEqual([...dbBackedContractToolNames].sort());

    for (const { name: toolName, args, requiredDataValues } of toolCalls) {
      const handler = server.handlers.get(toolName);
      expect(handler, `${toolName} should be registered`).toBeDefined();
      const result = parseStructured(await handler!(args));
      expectEnvelope(result, tempRoot);
      expectCriticalDataValues(result, requiredDataValues);
    }
  });

  it('returns machine-readable envelopes for global project management tools', async () => {
    const server = new FakeMcpServer();
    registerAllTools(server as never);

    const resolveMissing = parseStructured(await server.handlers.get('resolve_project')!({ project: tempRoot }));
    expect(resolveMissing.status).toBe('needs_bootstrap');
    expect(resolveMissing.project.root).toBe(tempRoot);
    expect(resolveMissing.nextAction.tool).toBe('bootstrap_project');
    expectCriticalDataValues(resolveMissing, [tempRoot, 'needs_bootstrap', 'bootstrap_project']);

    const bootstrap = parseStructured(await server.handlers.get('bootstrap_project')!({
      project: tempRoot,
      embedding: 'none',
      workers: '1',
    }));
    expect(bootstrap.status).toBe('ready');
    expect(bootstrap.project.root).toBe(tempRoot);
    expect(bootstrap.nextAction.tool).toBe('plan_context');
    expectCriticalDataValues(bootstrap, [tempRoot, 'ready']);

    const sync = parseStructured(await server.handlers.get('sync_project')!({
      project: tempRoot,
      workers: '1',
    }));
    expect(sync.status).toBe('ready');
    expect(sync.project.root).toBe(tempRoot);
    expect(sync.nextAction.tool).toBe('plan_context');
    expectCriticalDataValues(sync, [tempRoot, 'ready']);

    const registered = parseStructured(await server.handlers.get('register_project')!({
      project: tempRoot,
      name: 'contract-project',
    }));
    expect(registered.status).toBe('ready');
    expect(registered.project.root).toBe(tempRoot);
    expect(registered.nextAction.tool).toBe('plan_context');
    expectCriticalDataValues(registered, [tempRoot, 'contract-project', 'ready']);
  }, 20_000);
});
