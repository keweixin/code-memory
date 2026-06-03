import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface RealRepoBenchmarkTask {
  id: string;
  type: string;
  query: string;
  expectedFiles: string[];
  expectedSymbols: string[];
}

interface RealRepoBenchmarkConfig {
  name: string;
  repo: string;
  commit: string;
  languageProfile: string[];
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
});
