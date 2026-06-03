import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabase, getDatabaseSync, openExistingDatabase } from '../src/storage/database.js';
import { registerAllTools } from '../src/mcp/tool-registry.js';
import { registerRepo } from '../src/cli/registry.js';
import { getMemoriesByType } from '../src/storage/memory-repository.js';

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

describe('MCP repo routing', () => {
  let tempRoot: string;
  let homeDir: string;
  let originalGlobalHome: string | undefined;

  beforeEach(() => {
    originalGlobalHome = process.env.CODE_MEMORY_GLOBAL_HOME;
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-mcp-repo-routing-'));
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

  it('routes core MCP tools to a registered repo without breaking the default db', async () => {
    const firstRoot = join(tempRoot, 'first');
    const secondRoot = join(tempRoot, 'second');
    await indexProject(firstRoot, 'first-project', 'alphaOnly');
    await closeDatabase();
    await indexProject(secondRoot, 'second-project', 'betaOnly');
    await closeDatabase();
    registerRepo(secondRoot, 'second', { homeDir });

    await getDatabase(firstRoot);
    const server = new FakeMcpServer();
    registerAllTools(server as never, getDatabaseSync());

    const routedResolution = await server.handlers.get('resolve_project')!({ repo: 'second' });
    expect(routedResolution.content[0].text).toContain('"status": "ready"');
    expect(routedResolution.content[0].text).toContain('"repoName": "second"');
    expect(routedResolution.content[0].text).toContain('"indexExists": true');

    const defaultCard = await server.handlers.get('get_project_card')!({});
    expect(defaultCard.content[0].text).toContain('Name:       first-project');
    expect(defaultCard.content[0].text).toContain(firstRoot);

    const routedCard = await server.handlers.get('get_project_card')!({ repo: 'second' });
    expect(routedCard.content[0].text).toContain('Name:       second-project');
    expect(routedCard.content[0].text).toContain(secondRoot);

    const routedCode = await server.handlers.get('search_code')!({
      repo: 'second',
      query: 'betaOnly',
      searchMode: 'keyword',
      limit: 5,
    });
    expect(routedCode.content[0].text).toContain('Search results for: "betaOnly"');
    expect(routedCode.content[0].text).toContain('betaOnly');

    const routedSymbols = await server.handlers.get('search_symbols')!({
      repo: 'second',
      query: 'betaOnly',
      limit: 5,
    });
    expect(routedSymbols.content[0].text).toContain('Symbol search for: "betaOnly"');
    expect(routedSymbols.content[0].text).toContain('betaOnly');

    const routedDefinition = await server.handlers.get('find_definition')!({
      repo: 'second',
      symbolName: 'betaOnly',
    });
    expect(routedDefinition.content[0].text).toContain('Definition search for: "betaOnly"');
    expect(routedDefinition.content[0].text).toContain('betaOnly');

    const routedReferences = await server.handlers.get('find_references')!({
      repo: 'second',
      symbolName: 'betaOnlyHelper',
    });
    expect(routedReferences.content[0].text).toContain('No references found for: betaOnlyHelper');
    expect(routedReferences.content[0].text).not.toContain('No symbol found');

    const routedCallGraph = await server.handlers.get('get_call_graph')!({
      repo: 'second',
      symbolName: 'betaOnly',
      depth: 2,
    });
    expect(routedCallGraph.content[0].text).toContain('Call Graph for: betaOnly');
    expect(routedCallGraph.content[0].text).toContain('betaOnlyHelper');

    const routedDependencyGraph = await server.handlers.get('get_dependency_graph')!({
      repo: 'second',
      filePath: 'src/index.ts',
      depth: 1,
    });
    expect(routedDependencyGraph.content[0].text).toContain('Dependency Graph for: src/index.ts');
    expect(routedDependencyGraph.content[0].text).toContain('src/helper.ts');

    const routedImpact = await server.handlers.get('impact_analysis')!({
      repo: 'second',
      target: 'betaOnlyHelper',
    });
    expect(routedImpact.content[0].text).toContain('Impact Analysis');
    expect(routedImpact.content[0].text).toContain('betaOnly');

    const routedRelatedTests = await server.handlers.get('get_related_tests')!({
      repo: 'second',
      target: 'src/index.ts',
    });
    expect(routedRelatedTests.content[0].text).toContain('Related Tests for: src/index.ts');
    expect(routedRelatedTests.content[0].text).toContain('src/index.test.ts');

    const routedRepoMap = await server.handlers.get('get_repo_map')!({
      repo: 'second',
      tokenBudget: 1200,
    });
    expect(routedRepoMap.content[0].text).toContain('betaOnly');
    expect(routedRepoMap.content[0].text).not.toContain('alphaOnly');

    const routedPlan = await server.handlers.get('plan_context')!({
      repo: 'second',
      query: 'change betaOnly behavior',
      sessionId: 'repo-routing-plan',
      tokenBudget: 1500,
    });
    expect(routedPlan.content[0].text).toContain('Context retrieval plan');
    expect(routedPlan.content[0].text).toContain('Query: change betaOnly behavior');
    expect(routedPlan.content[0].text).toContain('repo: "second"');

    const routedContext = await server.handlers.get('get_context_pack')!({
      repo: 'second',
      query: 'betaOnly',
      tokenBudget: 2000,
      levels: 'L4',
      sessionId: 'repo-routing-context',
      avoidRepeated: false,
    });
    expect(routedContext.content[0].text).toContain('Context Ledger');
    expect(routedContext.content[0].text).toContain('betaOnly');

    const routedRepeatedContext = await server.handlers.get('get_context_pack')!({
      repo: 'second',
      query: 'betaOnly',
      tokenBudget: 2000,
      levels: 'L4',
      sessionId: 'repo-routing-context',
      avoidRepeated: true,
    });
    expect(routedRepeatedContext.content[0].text).toContain('Repeated context omitted');

    const defaultSearchAfterRoutedCall = await server.handlers.get('search_code')!({
      query: 'alphaOnly',
      searchMode: 'keyword',
      limit: 5,
    });
    expect(defaultSearchAfterRoutedCall.content[0].text).toContain('alphaOnly');

    const routedRemember = await server.handlers.get('remember_project_fact')!({
      repo: 'second',
      type: 'decision',
      content: 'betaOnly uses the second repo memory store',
      scope: ['src/index.ts'],
      confidence: 0.9,
    });
    expect(routedRemember.content[0].text).toContain('Memory saved successfully');
    expect(getMemoriesByType('decision')).toHaveLength(0);

    const secondDb = openExistingDatabase(secondRoot);
    try {
      const secondMemories = getMemoriesByType('decision', secondDb);
      expect(secondMemories).toHaveLength(1);
      expect(secondMemories[0].content).toContain('second repo memory store');

      const routedInvalidate = await server.handlers.get('invalidate_memory')!({
        repo: 'second',
        memoryId: secondMemories[0].id,
      });
      expect(routedInvalidate.content[0].text).toContain('Deleted memory: ' + secondMemories[0].id);
      expect(getMemoriesByType('decision', secondDb)).toHaveLength(0);
    } finally {
      secondDb.close();
    }
    expect(getMemoriesByType('decision')).toHaveLength(0);
  }, 20_000);
});

async function indexProject(rootPath: string, projectName: string, symbolName: string): Promise<void> {
  mkdirSync(join(rootPath, 'src'), { recursive: true });
  mkdirSync(join(rootPath, '.code-memory'), { recursive: true });
  writeFileSync(
    join(rootPath, 'src', 'helper.ts'),
    `export function ${symbolName}Helper(): string {\n  return "${symbolName}";\n}\n`,
    'utf-8',
  );
  writeFileSync(
    join(rootPath, 'src', 'index.ts'),
    `import { ${symbolName}Helper } from "./helper";\n\nexport function ${symbolName}(): string {\n  return ${symbolName}Helper();\n}\n`,
    'utf-8',
  );
  writeFileSync(
    join(rootPath, 'src', 'index.test.ts'),
    `import { ${symbolName} } from "./index";\n\nit("${symbolName}", () => {\n  expect(${symbolName}()).toBe("${symbolName}");\n});\n`,
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
