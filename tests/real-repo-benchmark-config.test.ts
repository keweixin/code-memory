import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface RealRepoBenchmarkTask {
  id: string;
  type: string;
  query: string;
  target?: string;
  expectedFiles: string[];
  expectedSymbols: string[];
}

interface RealRepoBenchmarkConfig {
  name: string;
  repo: string;
  commit: string;
  languageProfile: string[];
  sparsePaths: string[];
  minimumMetrics: {
    realRepoKeyFileRecall: number;
    realRepoEvidenceCoverage: number;
    relatedTestRecall: number;
    wrongProjectRouteRate: number;
    staleFailureRate: number;
  };
  tasks: RealRepoBenchmarkTask[];
}

describe('real repo benchmark config', () => {
  it('pins reproducible repos and covers v1 benchmark task classes', () => {
    const configs = JSON.parse(readFileSync(
      join(process.cwd(), 'benchmark', 'real-repos.json'),
      'utf8',
    )) as RealRepoBenchmarkConfig[];

    expect(configs.length).toBeGreaterThanOrEqual(4);

    const taskTypes = new Set<string>();
    const taskIds = new Set<string>();

    for (const config of configs) {
      expect(config.name).toMatch(/^[a-z0-9-]+$/);
      expect(config.repo).toMatch(/^https:\/\/github\.com\/.+\.git$/);
      expect(config.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(config.languageProfile.length).toBeGreaterThan(0);
      expect(config.sparsePaths.length).toBeGreaterThan(0);
      expect(config.sparsePaths).toEqual(expect.arrayContaining(config.tasks.flatMap((task) => task.expectedFiles)));
      expect(config.minimumMetrics.realRepoKeyFileRecall).toBeGreaterThanOrEqual(0.85);
      expect(config.minimumMetrics.realRepoEvidenceCoverage).toBeGreaterThanOrEqual(0.9);
      expect(config.minimumMetrics.relatedTestRecall).toBeGreaterThanOrEqual(0.75);
      expect(config.minimumMetrics.wrongProjectRouteRate).toBe(0);
      expect(config.minimumMetrics.staleFailureRate).toBe(0);
      expect(config.tasks.length).toBeGreaterThan(0);

      for (const task of config.tasks) {
        expect(taskIds.has(task.id)).toBe(false);
        taskIds.add(task.id);
        taskTypes.add(task.type);
        expect(task.query.length).toBeGreaterThan(20);
        expect(task.expectedFiles.length).toBeGreaterThan(0);
        if (task.type === 'related_tests') {
          expect(task.target).toBeTruthy();
          expect(task.target).not.toBe(task.expectedFiles[0]);
        }
      }
    }

    expect(taskTypes).toEqual(new Set([
      'architecture_understanding',
      'bug_location',
      'new_api_parameter',
      'impact_analysis',
      'related_tests',
      'follow_up_delta',
      'stale_sync',
    ]));
  });

  it('keeps primary benchmark metrics sourced from structured tool fields only', () => {
    const script = readFileSync(join(process.cwd(), 'tools', 'benchmark-real-repos.mjs'), 'utf8');

    expect(script).toContain('collectStructuredFacts(structuredResults.map((item) => item.result))');
    expect(script).toContain('structuredResultCoverage');
    expect(script).toContain('textOnlyHitRate');
    expect(script).toContain("if (key === 'display') continue;");
    expect(script).toContain('const foundFiles = task.expectedFiles.filter((file) => containsNormalizedPath(structuredFacts.paths, file));');
    expect(script).toContain('const foundSymbols = task.expectedSymbols.filter((symbol) => containsStringValue(structuredFacts.symbols, symbol));');
    expect(script).toContain('const staleCheckedResults = structuredResults.filter(({ toolName }) => !isProjectManagementTool(toolName));');
    expect(script).toContain('function isProjectManagementTool(toolName)');
    expect(script).toContain('const target = task.target ?? task.expectedSymbols[0] ?? task.expectedFiles[0] ?? task.query;');
    expect(script).toContain('function isInputEchoPath(path)');
    expect(script).toContain("allowedNextReadsRecall: numberEnv('CODE_MEMORY_REAL_REPO_MIN_ALLOWED_NEXT_READS_RECALL', 0.9)");
    expect(script).toContain("exactSnippetCoverage: numberEnv('CODE_MEMORY_REAL_REPO_MIN_EXACT_SNIPPET_COVERAGE', 0.8)");
    expect(script).toContain("fileLineEvidenceCoverage: numberEnv('CODE_MEMORY_REAL_REPO_MIN_FILE_LINE_EVIDENCE_COVERAGE', 0.95)");
    expect(script).toContain('if (failOnThreshold) checkGlobalThresholds(metrics, failures);');
    expect(script).toContain("writeFileSync(join(dir, 'real-repos.latest.json')");
    expect(script).toContain("writeFileSync(join(dir, 'real-repos.summary.md')");
    expect(script).toContain('sanitizeBenchmarkArtifact(output)');
    expect(script).toContain("workRoot: '<benchmark-workdir>'");
    expect(script).not.toContain('const foundFiles = task.expectedFiles.filter((file) => textContainsPath(combinedText, file));');
    expect(script).not.toContain('const foundSymbols = task.expectedSymbols.filter((symbol) => combinedText.includes(symbol));');
  });

  it('keeps full benchmark execution bounded and reproducible', () => {
    const script = readFileSync(join(process.cwd(), 'tools', 'benchmark-real-repos.mjs'), 'utf8');

    expect(script).toContain("options.commandTimeoutMinutes ?? options.timeoutMinutes ?? 45");
    expect(script).toContain('sparse-checkout');
    expect(script).toContain("['sparse-checkout', 'set', '--no-cone', ...sparsePaths]");
    expect(script).toContain("['fetch', '--depth', '1', '--filter=blob:none', 'origin', repo.commit]");
    expect(script).toContain("['checkout', '--force', 'FETCH_HEAD']");
    expect(script).toContain("[real-repos] ${new Date().toISOString()} start:");
    expect(script).toContain("[real-repos] ${new Date().toISOString()} done:");
    expect(script).not.toContain("['clone', '--filter=blob:none', '--no-checkout'");
  });
});
