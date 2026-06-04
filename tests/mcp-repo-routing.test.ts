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
type StructuredToolResult<TData = Record<string, unknown>> = {
  status: string;
  project: { root: string; repoName: string; dbPath: string };
  freshness: { indexStatus: string; changedFiles: string[]; recommendedAction: string };
  data: TData;
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

function parseStructured<TData = Record<string, unknown>>(
  result: Awaited<ToolResult>,
): StructuredToolResult<TData> {
  return JSON.parse(result.content[0].text) as StructuredToolResult<TData>;
}

describe('MCP repo routing', () => {
  let tempRoot: string;
  let homeDir: string;
  let originalCwd: string;
  let originalGlobalHome: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
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
    process.chdir(originalCwd);
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
    const structuredDefaultCard = parseStructured<{
      card: { name: string; root_path: string };
    }>(defaultCard);
    expect(structuredDefaultCard.status).toBe('ready');
    expect(structuredDefaultCard.project.root).toBe(firstRoot);
    expect(structuredDefaultCard.data.card.name).toBe('first-project');
    expect(structuredDefaultCard.data.card.root_path).toBe(firstRoot);
    expect(structuredDefaultCard.display).toContain('Name:       first-project');
    expect(structuredDefaultCard.display).toContain(firstRoot);

    const routedCard = await server.handlers.get('get_project_card')!({ repo: 'second' });
    const structuredRoutedCard = parseStructured<{
      card: { name: string; root_path: string };
    }>(routedCard);
    expect(structuredRoutedCard.status).toBe('ready');
    expect(structuredRoutedCard.project.root).toBe(secondRoot);
    expect(structuredRoutedCard.project.repoName).toBe('second');
    expect(structuredRoutedCard.data.card.name).toBe('second-project');
    expect(structuredRoutedCard.data.card.root_path).toBe(secondRoot);
    expect(structuredRoutedCard.display).toContain('Name:       second-project');
    expect(structuredRoutedCard.display).toContain(secondRoot);

    const routedCode = await server.handlers.get('search_code')!({
      repo: 'second',
      query: 'betaOnly',
      searchMode: 'keyword',
      limit: 5,
    });
    const structuredRoutedCode = JSON.parse(routedCode.content[0].text) as { display: string };
    expect(structuredRoutedCode.display).toContain('Search results for: "betaOnly"');
    expect(routedCode.content[0].text).toContain('betaOnly');

    const routedSymbols = await server.handlers.get('search_symbols')!({
      repo: 'second',
      query: 'betaOnly',
      limit: 5,
    });
    const structuredSymbols = parseStructured<{
      query: string;
      resultCount: number;
      results: Array<{ name: string }>;
    }>(routedSymbols);
    expect(structuredSymbols.status).toBe('ready');
    expect(structuredSymbols.project.root).toBe(secondRoot);
    expect(structuredSymbols.project.repoName).toBe('second');
    expect(structuredSymbols.data.query).toBe('betaOnly');
    expect(structuredSymbols.data.resultCount).toBeGreaterThan(0);
    expect(structuredSymbols.data.results.some((symbol) => symbol.name === 'betaOnly')).toBe(true);
    expect(structuredSymbols.nextAction.tool).toBe('find_definition');
    expect(structuredSymbols.display).toContain('Symbol search for: "betaOnly"');

    const routedDefinition = await server.handlers.get('find_definition')!({
      repo: 'second',
      symbolName: 'betaOnly',
    });
    const structuredDefinition = parseStructured<{
      symbolName: string;
      resultCount: number;
      definitions: Array<{ name: string }>;
    }>(routedDefinition);
    expect(structuredDefinition.status).toBe('ready');
    expect(structuredDefinition.project.root).toBe(secondRoot);
    expect(structuredDefinition.project.repoName).toBe('second');
    expect(structuredDefinition.data.symbolName).toBe('betaOnly');
    expect(structuredDefinition.data.resultCount).toBeGreaterThan(0);
    expect(structuredDefinition.data.definitions.some((definition) => definition.name === 'betaOnly')).toBe(true);
    expect(structuredDefinition.nextAction.tool).toBe('find_references');
    expect(structuredDefinition.display).toContain('Definition search for: "betaOnly"');

    const routedReferences = await server.handlers.get('find_references')!({
      repo: 'second',
      symbolName: 'betaOnlyHelper',
    });
    const structuredReferences = parseStructured<{
      symbolName: string;
      resultCount: number;
      references: unknown[];
    }>(routedReferences);
    expect(structuredReferences.status).toBe('ready');
    expect(structuredReferences.project.root).toBe(secondRoot);
    expect(structuredReferences.project.repoName).toBe('second');
    expect(structuredReferences.data.symbolName).toBe('betaOnlyHelper');
    expect(structuredReferences.data.resultCount).toBe(0);
    expect(structuredReferences.display).toContain('No references found for: betaOnlyHelper');
    expect(structuredReferences.display).not.toContain('No symbol found');

    const routedCallGraph = await server.handlers.get('get_call_graph')!({
      repo: 'second',
      symbolName: 'betaOnly',
      depth: 2,
    });
    const structuredCallGraph = parseStructured<{
      symbolName: string;
      found: boolean;
      nodes: Array<{ label: string }>;
      edges: unknown[];
    }>(routedCallGraph);
    expect(structuredCallGraph.status).toBe('ready');
    expect(structuredCallGraph.project.root).toBe(secondRoot);
    expect(structuredCallGraph.project.repoName).toBe('second');
    expect(structuredCallGraph.data.symbolName).toBe('betaOnly');
    expect(structuredCallGraph.data.found).toBe(true);
    expect(structuredCallGraph.data.nodes.some((node) => node.label === 'betaOnlyHelper')).toBe(true);
    expect(structuredCallGraph.data.edges.length).toBeGreaterThan(0);
    expect(structuredCallGraph.display).toContain('Call Graph for: betaOnly');
    expect(structuredCallGraph.display).toContain('betaOnlyHelper');

    const routedDependencyGraph = await server.handlers.get('get_dependency_graph')!({
      repo: 'second',
      filePath: 'src/index.ts',
      depth: 1,
    });
    const structuredDependencyGraph = parseStructured<{
      filePath: string;
      found: boolean;
      nodes: Array<{ label: string }>;
      edges: unknown[];
    }>(routedDependencyGraph);
    expect(structuredDependencyGraph.status).toBe('ready');
    expect(structuredDependencyGraph.project.root).toBe(secondRoot);
    expect(structuredDependencyGraph.project.repoName).toBe('second');
    expect(structuredDependencyGraph.data.filePath).toBe('src/index.ts');
    expect(structuredDependencyGraph.data.found).toBe(true);
    expect(structuredDependencyGraph.data.nodes.some((node) => node.label === 'src/helper.ts')).toBe(true);
    expect(structuredDependencyGraph.data.edges.length).toBeGreaterThan(0);
    expect(structuredDependencyGraph.display).toContain('Dependency Graph for: src/index.ts');
    expect(structuredDependencyGraph.display).toContain('src/helper.ts');

    const routedImpact = await server.handlers.get('impact_analysis')!({
      repo: 'second',
      target: 'betaOnlyHelper',
    });
    expect(routedImpact.content[0].text).toContain('Impact Analysis');
    expect(routedImpact.content[0].text).toContain('betaOnly');
    const structuredImpact = JSON.parse(routedImpact.content[0].text) as {
      status: string;
      project: { root: string; repoName: string };
      data: { target: string; affectedFiles: unknown[]; affectedSymbols: unknown[] };
      nextAction: { tool?: string };
      display: string;
    };
    expect(structuredImpact.status).toBe('ready');
    expect(structuredImpact.project.root).toBe(secondRoot);
    expect(structuredImpact.project.repoName).toBe('second');
    expect(structuredImpact.data.target).toBe('betaOnlyHelper');
    expect(structuredImpact.data.affectedFiles.length + structuredImpact.data.affectedSymbols.length).toBeGreaterThan(0);
    expect(structuredImpact.nextAction.tool).toBe('get_related_tests');
    expect(structuredImpact.display).toContain('=== Impact Analysis ===');

    const routedRelatedTests = await server.handlers.get('get_related_tests')!({
      repo: 'second',
      target: 'src/index.ts',
    });
    const structuredRelatedTests = parseStructured<{
      target: string;
      resultCount: number;
      tests: Array<{ filePath: string; method: string }>;
      runCommand: string;
    }>(routedRelatedTests);
    expect(structuredRelatedTests.status).toBe('ready');
    expect(structuredRelatedTests.project.root).toBe(secondRoot);
    expect(structuredRelatedTests.project.repoName).toBe('second');
    expect(structuredRelatedTests.data.target).toBe('src/index.ts');
    expect(structuredRelatedTests.data.resultCount).toBe(1);
    expect(structuredRelatedTests.data.tests[0].filePath).toBe('src/index.test.ts');
    expect(structuredRelatedTests.data.tests[0].method).toBe('graph (TESTS edge)');
    expect(structuredRelatedTests.nextAction.command).toContain('npx vitest run src/index.test.ts');
    expect(structuredRelatedTests.display).toContain('Related Tests for: src/index.ts');

    const routedRepoMap = await server.handlers.get('get_repo_map')!({
      repo: 'second',
      tokenBudget: 1200,
    });
    const structuredRepoMap = parseStructured<{
      fileCount: number;
      symbolCount: number;
      files: Array<{ path: string; symbols: Array<{ name: string }> }>;
    }>(routedRepoMap);
    expect(structuredRepoMap.status).toBe('ready');
    expect(structuredRepoMap.project.root).toBe(secondRoot);
    expect(structuredRepoMap.project.repoName).toBe('second');
    expect(structuredRepoMap.data.fileCount).toBe(3);
    expect(structuredRepoMap.data.symbolCount).toBeGreaterThan(0);
    expect(structuredRepoMap.data.files.some((file) =>
      file.symbols.some((symbol) => symbol.name === 'betaOnly'))).toBe(true);
    expect(structuredRepoMap.display).toContain('betaOnly');
    expect(structuredRepoMap.display).not.toContain('alphaOnly');

    const routedPlan = await server.handlers.get('plan_context')!({
      repo: 'second',
      query: 'change betaOnly behavior',
      sessionId: 'repo-routing-plan',
      tokenBudget: 1500,
    });
    const structuredPlan = parseStructured<{
      query: string;
      recommendedCall: { tool: string; args: { repo?: string } };
    }>(routedPlan);
    expect(structuredPlan.status).toBe('ready');
    expect(structuredPlan.project.root).toBe(secondRoot);
    expect(structuredPlan.project.repoName).toBe('second');
    expect(structuredPlan.data.query).toBe('change betaOnly behavior');
    expect(structuredPlan.data.recommendedCall.tool).toBe('get_context_pack');
    expect(structuredPlan.data.recommendedCall.args.repo).toBe('second');
    expect(structuredPlan.nextAction.tool).toBe('get_context_pack');
    expect(structuredPlan.display).toContain('Context retrieval plan');
    expect(structuredPlan.display).toContain('Query: change betaOnly behavior');
    expect(structuredPlan.display).toContain('repo: "second"');

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
    const structuredContext = JSON.parse(routedContext.content[0].text) as {
      status: string;
      project: { root: string; repoName: string; dbPath: string };
      data: {
        trustContract: {
          confidence: string;
          allowedNextReads: Array<{ path: string; reason: string; maxLines: string }>;
          discouragedReads: Array<{ pattern: string; reason: string }>;
        };
      };
      nextAction: { tool?: string; reason: string };
      display: string;
    };
    expect(structuredContext.status).toBe('ready');
    expect(structuredContext.project.root).toBe(secondRoot);
    expect(structuredContext.project.repoName).toBe('second');
    expect(structuredContext.data.trustContract.confidence).toBe('ready');
    expect(structuredContext.data.trustContract.allowedNextReads[0].path).toContain('src/');
    expect(structuredContext.data.trustContract.allowedNextReads[0].reason).toBeTruthy();
    expect(structuredContext.data.trustContract.allowedNextReads[0].maxLines).toBeTruthy();
    expect(structuredContext.data.trustContract.discouragedReads[0].pattern).toBe('whole repo grep');
    expect(structuredContext.nextAction.tool).toBe('impact_analysis');
    expect(structuredContext.display).toContain('=== Tool Trust Contract ===');

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
    const structuredRemember = parseStructured<{
      id: string;
      type: string;
      content: string;
      scope: string[];
      confidence: number;
    }>(routedRemember);
    expect(structuredRemember.status).toBe('ready');
    expect(structuredRemember.project.root).toBe(secondRoot);
    expect(structuredRemember.project.repoName).toBe('second');
    expect(structuredRemember.data.type).toBe('decision');
    expect(structuredRemember.data.content).toContain('second repo memory store');
    expect(structuredRemember.data.scope).toEqual(['src/index.ts']);
    expect(structuredRemember.data.confidence).toBe(0.9);
    expect(structuredRemember.display).toContain('Memory saved successfully');
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
      const structuredInvalidate = parseStructured<{
        memoryId: string | null;
        deletedCount: number;
        deleted: Array<{ id: string; type: string }>;
      }>(routedInvalidate);
      expect(structuredInvalidate.status).toBe('ready');
      expect(structuredInvalidate.project.root).toBe(secondRoot);
      expect(structuredInvalidate.data.memoryId).toBe(secondMemories[0].id);
      expect(structuredInvalidate.data.deletedCount).toBe(1);
      expect(structuredInvalidate.data.deleted[0].id).toBe(secondMemories[0].id);
      expect(structuredInvalidate.display).toContain('Deleted memory: ' + secondMemories[0].id);
      expect(getMemoriesByType('decision', secondDb)).toHaveLength(0);
    } finally {
      secondDb.close();
    }
    expect(getMemoriesByType('decision')).toHaveLength(0);
  }, 20_000);

  it('routes registered repo tools without a default startup database', async () => {
    const projectRoot = join(tempRoot, 'global-target');
    await indexProject(projectRoot, 'global-target-project', 'gammaOnly');
    await closeDatabase();
    registerRepo(projectRoot, 'global-target', { homeDir });

    const server = new FakeMcpServer();
    registerAllTools(server as never);

    const resolution = await server.handlers.get('resolve_project')!({ repo: 'global-target' });
    expect(resolution.content[0].text).toContain('"status": "ready"');
    expect(resolution.content[0].text).toContain('"repoName": "global-target"');

    const plan = await server.handlers.get('plan_context')!({
      repo: 'global-target',
      query: 'change gammaOnly behavior',
      tokenBudget: 1500,
    });
    const structuredPlan = parseStructured<{ query: string }>(plan);
    expect(structuredPlan.status).toBe('ready');
    expect(structuredPlan.project.root).toBe(projectRoot);
    expect(structuredPlan.project.repoName).toBe('global-target');
    expect(structuredPlan.data.query).toBe('change gammaOnly behavior');
    expect(structuredPlan.display).toContain('Context retrieval plan');
    expect(structuredPlan.display).toContain('Query: change gammaOnly behavior');

    const search = await server.handlers.get('search_code')!({
      repo: 'global-target',
      query: 'gammaOnly',
      searchMode: 'keyword',
      limit: 5,
    });
    const structuredSearch = JSON.parse(search.content[0].text) as { display: string };
    expect(structuredSearch.display).toContain('Search results for: "gammaOnly"');
    expect(search.content[0].text).toContain('gammaOnly');
  }, 20_000);

  it('routes global tools by explicit project path when server cwd is unrelated', async () => {
    const projectRoot = join(tempRoot, 'project-arg-target');
    const unrelatedCwd = join(tempRoot, 'unrelated-cwd');
    mkdirSync(unrelatedCwd, { recursive: true });
    await indexProject(projectRoot, 'project-arg-target-project', 'deltaOnly');
    await closeDatabase();
    process.chdir(unrelatedCwd);

    const server = new FakeMcpServer();
    registerAllTools(server as never);

    const resolution = await server.handlers.get('resolve_project')!({ project: projectRoot });
    expect(resolution.content[0].text).toContain('"status": "ready"');
    expect(resolution.content[0].text).toContain('"repoName": "project-arg-target"');
    expect(resolution.content[0].text).toContain(projectRoot.replace(/\\/g, '\\\\'));
    expect(resolution.content[0].text).toContain('"indexExists": true');

    const plan = await server.handlers.get('plan_context')!({
      project: projectRoot,
      query: 'change deltaOnly behavior',
      tokenBudget: 1500,
    });
    const structuredPlan = parseStructured<{ query: string }>(plan);
    expect(structuredPlan.status).toBe('ready');
    expect(structuredPlan.project.root).toBe(projectRoot);
    expect(structuredPlan.project.repoName).toBe('project-arg-target');
    expect(structuredPlan.data.query).toBe('change deltaOnly behavior');
    expect(structuredPlan.display).toContain('Context retrieval plan');
    expect(structuredPlan.display).toContain('Query: change deltaOnly behavior');

    const search = await server.handlers.get('search_code')!({
      project: projectRoot,
      query: 'deltaOnly',
      searchMode: 'keyword',
      limit: 5,
    });
    const structuredSearch = JSON.parse(search.content[0].text) as { display: string };
    expect(structuredSearch.display).toContain('Search results for: "deltaOnly"');
    expect(search.content[0].text).toContain('deltaOnly');

    const context = await server.handlers.get('get_context_pack')!({
      project: projectRoot,
      query: 'deltaOnly',
      tokenBudget: 2000,
      levels: 'L4',
      sessionId: 'project-arg-context',
      avoidRepeated: false,
    });
    expect(context.content[0].text).toContain('Context Ledger');
    expect(context.content[0].text).toContain('deltaOnly');

    const marked = await server.handlers.get('mark_context_used')!({
      project: projectRoot,
      sessionId: 'project-arg-ledger',
      query: 'deltaOnly',
      returnedFiles: ['src/index.ts'],
    });
    const structuredMarked = parseStructured<{
      entryId: string;
      sessionId: string;
      query: string;
      returnedFiles: string[];
    }>(marked);
    expect(structuredMarked.status).toBe('ready');
    expect(structuredMarked.project.root).toBe(projectRoot);
    expect(structuredMarked.data.sessionId).toBe('project-arg-ledger');
    expect(structuredMarked.data.query).toBe('deltaOnly');
    expect(structuredMarked.data.returnedFiles).toEqual(['src/index.ts']);
    expect(structuredMarked.display).toContain('Context ledger entry recorded');

    const delta = await server.handlers.get('get_context_delta')!({
      project: projectRoot,
      sessionId: 'project-arg-ledger',
      candidateFiles: ['src/index.ts', 'src/helper.ts'],
    });
    const structuredDelta = parseStructured<{
      delta: { repeatedFiles: string[]; newFiles: string[] };
    }>(delta);
    expect(structuredDelta.status).toBe('ready');
    expect(structuredDelta.project.root).toBe(projectRoot);
    expect(structuredDelta.data.delta.repeatedFiles).toEqual(['src/index.ts']);
    expect(structuredDelta.data.delta.newFiles).toEqual(['src/helper.ts']);
    expect(structuredDelta.display).toContain('Repeated files: src/index.ts');
    expect(structuredDelta.display).toContain('New files: src/helper.ts');
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
