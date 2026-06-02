import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabase, getDatabaseSync } from '../src/storage/database.js';
import { registerGetUnifiedRepoMapTool } from '../src/mcp/tools/get-unified-repo-map.js';
import { registerRepo } from '../src/cli/registry.js';

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

interface DepSet {
  packages: string[];
}

function createConfig(rootPath: string, projectName: string): CodeMemoryConfig {
  return {
    projectName,
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

async function indexRepo(
  rootPath: string,
  projectName: string,
  symbolName: string,
  deps: DepSet,
): Promise<void> {
  mkdirSync(join(rootPath, 'src'), { recursive: true });
  mkdirSync(join(rootPath, '.code-memory'), { recursive: true });

  const importLines = deps.packages
    .map((pkg, index) => {
      const local = `dep${index}`;
      return `import ${local} from "${pkg}";`;
    })
    .join('\n');
  const depUsage = deps.packages
    .map((_pkg, index) => `dep${index}`)
    .join(', ');

  writeFileSync(
    join(rootPath, 'src', 'helper.ts'),
    `${importLines}\n\nexport function ${symbolName}Helper(): string {\n  return ${depUsage ? `${depUsage}.toString()` : '""'};\n}\n`,
    'utf-8',
  );
  writeFileSync(
    join(rootPath, 'src', 'index.ts'),
    `import { ${symbolName}Helper } from "./helper";\n\nexport function ${symbolName}(): string {\n  return ${symbolName}Helper();\n}\n`,
    'utf-8',
  );

  const config = createConfig(rootPath, projectName);
  writeFileSync(
    join(rootPath, '.code-memory', 'config.json'),
    JSON.stringify(config, null, 2),
    'utf-8',
  );

  const manager = new IndexManager(rootPath, config);
  await manager.fullIndex();
}

describe('MCP unified repo map', () => {
  let tempRoot: string;
  let homeDir: string;
  let originalGlobalHome: string | undefined;

  beforeEach(() => {
    originalGlobalHome = process.env.CODE_MEMORY_GLOBAL_HOME;
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-unified-repo-map-'));
    homeDir = join(tempRoot, 'home');
    process.env.CODE_MEMORY_GLOBAL_HOME = homeDir;
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

  it('aggregates overviews across multiple registered repos', async () => {
    const rootA = join(tempRoot, 'repoA');
    const rootB = join(tempRoot, 'repoB');
    await indexRepo(rootA, 'project-a', 'alphaOnly', { packages: [] });
    await closeDatabase();
    await indexRepo(rootB, 'project-b', 'betaOnly', { packages: [] });
    await closeDatabase();

    registerRepo(rootA, 'repoA', { homeDir });
    registerRepo(rootB, 'repoB', { homeDir });

    await getDatabase(rootA);
    const server = new FakeMcpServer();
    registerGetUnifiedRepoMapTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('get_unified_repo_map')!({});
    const text = result.content[0].text;

    expect(text).toContain('=== Unified Repository Map ===');
    expect(text).toContain('Repository: repoA');
    expect(text).toContain(resolve(rootA));
    expect(text).toContain('Language: typescript');
    expect(text).toContain('Repository: repoB');
    expect(text).toContain(resolve(rootB));
    expect(text).toContain('--- Cross-repo suggestions ---');
  });

  it('respects the optional repos filter', async () => {
    const rootA = join(tempRoot, 'repoA');
    const rootB = join(tempRoot, 'repoB');
    await indexRepo(rootA, 'project-a', 'alphaOnly', { packages: [] });
    await closeDatabase();
    await indexRepo(rootB, 'project-b', 'betaOnly', { packages: [] });
    await closeDatabase();

    registerRepo(rootA, 'repoA', { homeDir });
    registerRepo(rootB, 'repoB', { homeDir });

    await getDatabase(rootA);
    const server = new FakeMcpServer();
    registerGetUnifiedRepoMapTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('get_unified_repo_map')!({
      repos: ['repoA'],
    });
    const text = result.content[0].text;

    expect(text).toContain('Repository: repoA');
    expect(text).not.toContain('Repository: repoB');
  });

  it('emits cross-repo suggestions for shared external dependencies', async () => {
    const rootA = join(tempRoot, 'repoA');
    const rootB = join(tempRoot, 'repoB');
    const rootC = join(tempRoot, 'repoC');
    await indexRepo(rootA, 'project-a', 'alphaOnly', {
      packages: ['lodash', 'axios'],
    });
    await closeDatabase();
    await indexRepo(rootB, 'project-b', 'betaOnly', {
      packages: ['lodash', 'axios'],
    });
    await closeDatabase();
    await indexRepo(rootC, 'project-c', 'gammaOnly', {
      packages: ['lodash'],
    });
    await closeDatabase();

    registerRepo(rootA, 'repoA', { homeDir });
    registerRepo(rootB, 'repoB', { homeDir });
    registerRepo(rootC, 'repoC', { homeDir });

    await getDatabase(rootA);
    const server = new FakeMcpServer();
    registerGetUnifiedRepoMapTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('get_unified_repo_map')!({});
    const text = result.content[0].text;

    expect(text).toContain('- lodash (3 repos)');
    expect(text).not.toContain('- axios');
  });

  it('returns a graceful empty response when no repos are registered', async () => {
    const defaultRoot = join(tempRoot, 'default');
    mkdirSync(defaultRoot, { recursive: true });
    mkdirSync(join(defaultRoot, '.code-memory'), { recursive: true });
    writeFileSync(
      join(defaultRoot, '.code-memory', 'config.json'),
      JSON.stringify(createConfig(defaultRoot, 'default'), null, 2),
      'utf-8',
    );
    await getDatabase(defaultRoot);

    const server = new FakeMcpServer();
    registerGetUnifiedRepoMapTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('get_unified_repo_map')!({});
    const text = result.content[0].text;

    expect(text).toContain('=== Unified Repository Map ===');
    expect(text).toContain('No registered repositories found');
    expect(text).toContain('--- Cross-repo suggestions ---');
  });

  it('filters repos case-insensitively', async () => {
    const rootA = join(tempRoot, 'repoA');
    await indexRepo(rootA, 'project-a', 'alphaOnly', { packages: [] });
    await closeDatabase();

    registerRepo(rootA, 'Payment-Service', { homeDir });

    await getDatabase(rootA);
    const server = new FakeMcpServer();
    registerGetUnifiedRepoMapTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('get_unified_repo_map')!({
      repos: ['payment-service'],
    });
    const text = result.content[0].text;

    expect(text).toContain('Repository: Payment-Service');
  });

  it('filters repos by substring match', async () => {
    const rootA = join(tempRoot, 'repoA');
    await indexRepo(rootA, 'project-a', 'alphaOnly', { packages: [] });
    await closeDatabase();

    registerRepo(rootA, 'payment-service', { homeDir });

    await getDatabase(rootA);
    const server = new FakeMcpServer();
    registerGetUnifiedRepoMapTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('get_unified_repo_map')!({
      repos: ['payment'],
    });
    const text = result.content[0].text;

    expect(text).toContain('Repository: payment-service');
  });
});
