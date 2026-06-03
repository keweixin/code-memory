import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';
import { registerCodeMemoryResources } from '../src/mcp/resources.js';

const fixtureRoot = resolve('tests/fixtures/sample-ts-project');

type ResourceResult = Promise<{ contents: Array<{ uri: string; mimeType?: string; text?: string }> }>;
type ResourceHandler = (uri: URL, variables?: Record<string, string | string[]>) => ResourceResult;

class FakeMcpServer {
  readonly resources = new Map<string, ResourceHandler>();

  registerResource(
    name: string,
    _uriOrTemplate: unknown,
    _config: unknown,
    handler: ResourceHandler,
  ): void {
    this.resources.set(name, handler);
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

describe('MCP resources', () => {
  let tempRoot: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-resources-'));
    cpSync(fixtureRoot, tempRoot, { recursive: true });
    process.chdir(tempRoot);
    await indexFixture(tempRoot);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('registers repo map resources backed by the active database', async () => {
    const server = new FakeMcpServer();
    registerCodeMemoryResources(server as never, getDatabaseSync());

    expect(server.resources.has('code-memory-repos')).toBe(true);
    expect(server.resources.has('code-memory-repo-context')).toBe(true);
    expect(server.resources.has('code-memory-repo-symbols')).toBe(true);
    expect(server.resources.has('code-memory-repo-flows')).toBe(true);
    expect(server.resources.has('code-memory-repo-schema')).toBe(true);
    expect(server.resources.has('code-memory-repo-staleness')).toBe(true);
    expect(server.resources.has('code-memory-repo-routes')).toBe(true);
    expect(server.resources.has('code-memory-repo-tests')).toBe(true);
    expect(server.resources.has('code-memory-repo-communities')).toBe(true);
    expect(server.resources.has('code-memory-repo-memories')).toBe(true);

    const context = await server.resources.get('code-memory-repo-context')!(
      new URL('code-memory://repo/current/context'),
      {},
    );
    expect(context.contents[0].mimeType).toBe('text/markdown');
    expect(context.contents[0].text).toContain('Code Memory Repo Context');
    expect(context.contents[0].text).toContain('resolve_project -> bootstrap_project/sync_project/register_project when needed -> resolve_project -> plan_context');
    expect(context.contents[0].text).toContain('mark_context_used/get_context_delta');

    const symbols = await server.resources.get('code-memory-repo-symbols')!(
      new URL('code-memory://repo/current/symbols'),
      {},
    );
    expect(symbols.contents[0].mimeType).toBe('application/json');
    expect(symbols.contents[0].text).toContain('AuthService');

    const staleness = await server.resources.get('code-memory-repo-staleness')!(
      new URL('code-memory://repo/current/staleness'),
      {},
    );
    expect(staleness.contents[0].mimeType).toBe('application/json');
    expect(staleness.contents[0].text).toContain('indexStatus');

    const tests = await server.resources.get('code-memory-repo-tests')!(
      new URL('code-memory://repo/current/tests'),
      {},
    );
    expect(tests.contents[0].mimeType).toBe('application/json');
    expect(tests.contents[0].text).toContain('"tests"');

    const communities = await server.resources.get('code-memory-repo-communities')!(
      new URL('code-memory://repo/current/communities'),
      {},
    );
    expect(communities.contents[0].mimeType).toBe('application/json');
    expect(communities.contents[0].text).toContain('"communities"');
  });

  it('registers repo map resources without an active database for global MCP mode', async () => {
    const server = new FakeMcpServer();
    registerCodeMemoryResources(server as never);

    expect(server.resources.has('code-memory-repos')).toBe(true);
    expect(server.resources.has('code-memory-repo-context')).toBe(true);

    const context = await server.resources.get('code-memory-repo-context')!(
      new URL('code-memory://repo/current/context'),
      { name: 'current' },
    );

    expect(context.contents[0].mimeType).toBe('text/markdown');
    expect(context.contents[0].text).toContain('Code Memory Repo Context');
    expect(context.contents[0].text).toContain('- Project root: ' + tempRoot);
  });

  it('returns bootstrap protocol from global resources when the project is not indexed', async () => {
    const missingRoot = mkdtempSync(join(tmpdir(), 'code-memory-resources-missing-'));
    const server = new FakeMcpServer();
    registerCodeMemoryResources(server as never);

    try {
      process.chdir(missingRoot);
      const symbols = await server.resources.get('code-memory-repo-symbols')!(
        new URL('code-memory://repo/current/symbols'),
        { name: 'current' },
      );

      expect(symbols.contents[0].mimeType).toBe('application/json');
      expect(symbols.contents[0].text).toContain('project_not_ready');
      expect(symbols.contents[0].text).toContain('bootstrap --project');
    } finally {
      process.chdir(tempRoot);
      rmSync(missingRoot, { recursive: true, force: true });
    }
  });
});
