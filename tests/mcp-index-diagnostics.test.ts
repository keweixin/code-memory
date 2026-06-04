import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';
import { registerAllTools } from '../src/mcp/tool-registry.js';
import { recordWatchSyncFailure, recordWatchSyncSuccess } from '../src/indexer/watch-service.js';

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

function expectDiagnostics(text: string): void {
  const structured = parseStructuredResult(text);
  if (structured) {
    expect(structured).toHaveProperty('status');
    expect(structured).toHaveProperty('freshness');
    expect(structured.freshness).toHaveProperty('indexStatus');
    expect(structured.freshness).toHaveProperty('changedFiles');
    expect(structured.freshness).toHaveProperty('recommendedAction');
    expect(Array.isArray(structured.freshness.changedFiles)).toBe(true);
    expect(String(structured.freshness.indexStatus).length).toBeGreaterThan(0);
    expect(String(structured.freshness.recommendedAction).length).toBeGreaterThan(0);
    return;
  }

  expect(text).toContain('=== Index Diagnostics ===');
  expect(text).toContain('Index status:');
  expect(text).toContain('Schema: v');
  expect(text).toContain('Changed files:');
  expect(text).toContain('Recommended action:');
}

function parseStructuredResult(text: string): {
  status?: string;
  data?: unknown;
  freshness?: {
    indexStatus?: string;
    changedFiles?: string[];
    recommendedAction?: string;
  };
  display?: string;
} | null {
  try {
    return JSON.parse(text) as {
      status?: string;
      data?: unknown;
      freshness?: {
        indexStatus?: string;
        changedFiles?: string[];
        recommendedAction?: string;
      };
      display?: string;
    };
  } catch {
    return null;
  }
}

describe('MCP registry index diagnostics', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-mcp-diagnostics-'));
    cpSync(fixtureRoot, tempRoot, { recursive: true });
  });

  afterEach(async () => {
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('adds index diagnostics to registry-registered read and ledger tools', async () => {
    await indexFixture(tempRoot);
    const server = new FakeMcpServer();
    registerAllTools(server as never, getDatabaseSync());

    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['get_project_card', {}, '=== Project Identity Card ==='],
      ['search_symbols', { query: 'login', kind: 'method', limit: 5 }, 'Symbol search for: "login"'],
      ['find_definition', { symbolName: 'AuthService.login' }, 'Definition search for: "AuthService.login"'],
      ['get_dependency_graph', { filePath: 'src/services/AuthService.ts', depth: 1 }, '=== Dependency Graph for: src/services/AuthService.ts ==='],
      ['get_context_delta', { sessionId: 'diagnostics-session', candidateFiles: ['src/services/AuthService.ts'] }, 'Context delta'],
    ];

    for (const [toolName, args, expectedBody] of cases) {
      const result = await server.handlers.get(toolName)!(args);
      const text = result.content[0].text;
      const structured = parseStructuredResult(text);

      expectDiagnostics(text);
      expect(structured?.display ?? text).toContain(expectedBody);
    }
  });

  it('does not duplicate diagnostics for tools that already format them internally', async () => {
    await indexFixture(tempRoot);
    const server = new FakeMcpServer();
    registerAllTools(server as never, getDatabaseSync());

    const result = await server.handlers.get('search_code')!({
      query: 'login',
      limit: 5,
      searchMode: 'keyword',
    });
    const text = result.content[0].text;

    expectDiagnostics(text);
    const structured = JSON.parse(text) as { display: string };
    expect(structured.display.match(/=== Index Diagnostics ===/g)).toHaveLength(1);
    expect(structured.display).toContain('Search results for: "login"');
  });

  it('surfaces watch sync failures in MCP index diagnostics until the next successful watch sync', async () => {
    await indexFixture(tempRoot);
    await recordWatchSyncFailure(tempRoot, new Error('simulated watch failure'));

    const server = new FakeMcpServer();
    registerAllTools(server as never, getDatabaseSync());

    const failedResult = await server.handlers.get('get_project_card')!({});
    const failedText = failedResult.content[0].text;
    const failedStructured = parseStructuredResult(failedText);

    expectDiagnostics(failedText);
    expect(failedStructured?.status).toBe('stale');
    expect(failedStructured?.freshness?.indexStatus).toBe('failed');
    expect(failedStructured?.freshness?.recommendedAction).toBe('inspect watch error and run code-memory sync after fixing it');

    await recordWatchSyncSuccess(tempRoot);

    const recoveredResult = await server.handlers.get('get_project_card')!({});
    const recoveredText = recoveredResult.content[0].text;
    const recoveredStructured = parseStructuredResult(recoveredText);

    expect(recoveredStructured?.status).toBe('ready');
    expect(recoveredStructured?.freshness?.indexStatus).toBe('fresh');
  });

  it('reports stale file paths from DB-backed MCP tools until sync refreshes the index', async () => {
    execSync('git init', { cwd: tempRoot, stdio: 'ignore' });
    execSync('git config user.email code-memory-test@example.com', { cwd: tempRoot, stdio: 'ignore' });
    execSync('git config user.name "Code Memory Test"', { cwd: tempRoot, stdio: 'ignore' });
    writeFileSync(join(tempRoot, '.gitignore'), '.code-memory/\n', 'utf-8');
    execSync('git add .', { cwd: tempRoot, stdio: 'ignore' });
    execSync('git commit -m initial', { cwd: tempRoot, stdio: 'ignore' });

    await indexFixture(tempRoot);

    const targetFile = join(tempRoot, 'src', 'services', 'AuthService.ts');
    const originalContent = readFileSync(targetFile, 'utf-8');
    const updatedContent = originalContent.replace('Invalid credentials', 'Invalid login');
    expect(updatedContent).not.toBe(originalContent);
    writeFileSync(targetFile, updatedContent, 'utf-8');

    const server = new FakeMcpServer();
    const db = getDatabaseSync();
    registerAllTools(server as never, db);

    const staleResult = await server.handlers.get('search_code')!({
      query: 'login',
      limit: 5,
      searchMode: 'keyword',
    });
    const staleStructured = parseStructuredResult(staleResult.content[0].text);
    expect(staleStructured?.status).toBe('stale');
    expect(staleStructured?.freshness?.indexStatus).toBe('stale');
    expect(staleStructured?.freshness?.changedFiles).toEqual(['src/services/AuthService.ts']);
    expect(staleStructured?.freshness?.recommendedAction).toBe('run code-memory sync');

    await new IndexManager(tempRoot, createConfig(tempRoot)).incrementalIndex();

    const freshResult = await server.handlers.get('search_code')!({
      query: 'login',
      limit: 5,
      searchMode: 'keyword',
    });
    const freshStructured = parseStructuredResult(freshResult.content[0].text);
    expect(freshStructured?.status).toBe('ready');
    expect(freshStructured?.freshness?.indexStatus).toBe('fresh');
    expect(freshStructured?.freshness?.changedFiles).toEqual([]);
  });

  it('does not return orphaned paths from MCP tools after rename and delete sync', async () => {
    mkdirSync(join(tempRoot, 'src', 'lifecycle'), { recursive: true });
    const oldHelperPath = join(tempRoot, 'src', 'lifecycle', 'helper.ts');
    const newHelperPath = join(tempRoot, 'src', 'lifecycle', 'helper-renamed.ts');
    const deletedPath = join(tempRoot, 'src', 'lifecycle', 'deleted.ts');
    writeFileSync(
      oldHelperPath,
      [
        'export function lifecycleHelper(): string {',
        "  return 'renamed';",
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      deletedPath,
      [
        'export function deletedOnly(): string {',
        "  return 'delete-me';",
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );

    await indexFixture(tempRoot);

    renameSync(oldHelperPath, newHelperPath);
    unlinkSync(deletedPath);
    await new IndexManager(tempRoot, createConfig(tempRoot)).incrementalIndex({
      changedPaths: [oldHelperPath, newHelperPath, deletedPath],
    });

    const server = new FakeMcpServer();
    registerAllTools(server as never, getDatabaseSync());

    const renamedResult = await server.handlers.get('search_code')!({
      query: 'lifecycleHelper',
      limit: 5,
      searchMode: 'keyword',
    });
    const renamedStructured = parseStructuredResult(renamedResult.content[0].text) as {
      data?: { resultCount?: number };
      freshness?: { indexStatus?: string };
    } | null;
    const renamedMachineData = JSON.stringify(renamedStructured?.data);
    expect(renamedStructured?.freshness?.indexStatus).toBe('fresh');
    expect(renamedStructured?.data?.resultCount).toBeGreaterThan(0);
    expect(renamedMachineData).toContain('src/lifecycle/helper-renamed.ts');
    expect(renamedMachineData).not.toContain('src/lifecycle/helper.ts');

    const deletedResult = await server.handlers.get('search_code')!({
      query: 'deletedOnly',
      limit: 5,
      searchMode: 'keyword',
    });
    const deletedStructured = parseStructuredResult(deletedResult.content[0].text);
    const deletedMachineData = JSON.stringify(deletedStructured?.data);
    expect(deletedStructured?.freshness?.indexStatus).toBe('fresh');
    expect(deletedMachineData).not.toContain('src/lifecycle/deleted.ts');

    const repoMapResult = await server.handlers.get('get_repo_map')!({
      directory: 'src/lifecycle',
      tokenBudget: 1000,
    });
    const repoMapStructured = parseStructuredResult(repoMapResult.content[0].text);
    const repoMapMachineData = JSON.stringify(repoMapStructured?.data);
    expect(repoMapMachineData).toContain('src/lifecycle/helper-renamed.ts');
    expect(repoMapMachineData).not.toContain('src/lifecycle/helper.ts');
    expect(repoMapMachineData).not.toContain('src/lifecycle/deleted.ts');
  });
});
