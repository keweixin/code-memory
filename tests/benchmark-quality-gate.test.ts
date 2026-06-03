import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('benchmark quality gate', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-benchmark-gate-'));
    mkdirSync(tempRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('passes benchmark outputs that meet minimum quality thresholds', () => {
    const files = writeBenchmarkFiles({
      contextKeyFileRecall: 0.375,
      contextEvidenceCoverage: 0.4,
      contextSymbolRecall: 0.5,
      agentKeyFileRecall: 0.6,
      agentEvidenceCoverage: 0.6,
    });

    const output = execFileSync(process.execPath, [
      'tools/benchmark-quality-gate.mjs',
      '--index', files.index,
      '--context', files.context,
      '--agent', files.agent,
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(output).toContain('Benchmark quality gate passed.');
  });

  it('fails when context or agent recall regresses below the floor', () => {
    const files = writeBenchmarkFiles({
      contextKeyFileRecall: 0.1,
      contextEvidenceCoverage: 0.4,
      contextSymbolRecall: 0.5,
      agentKeyFileRecall: 0.2,
      agentEvidenceCoverage: 0.6,
    });

    expect(() => execFileSync(process.execPath, [
      'tools/benchmark-quality-gate.mjs',
      '--index', files.index,
      '--context', files.context,
      '--agent', files.agent,
    ], { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' })).toThrow();
  });

  function writeBenchmarkFiles(metrics: {
    contextKeyFileRecall: number;
    contextEvidenceCoverage: number;
    contextSymbolRecall: number;
    agentKeyFileRecall: number;
    agentEvidenceCoverage: number;
  }): { index: string; context: string; agent: string } {
    const index = join(tempRoot, 'benchmark-index.json');
    const context = join(tempRoot, 'benchmark-context.json');
    const agent = join(tempRoot, 'benchmark-agent.json');

    writeFileSync(index, 'npm script header\n' + JSON.stringify({
      files: 50,
      parseThroughputFilesPerSec: 25,
      peakRssMb: 300,
    }) + '\npost-json log line\n', 'utf8');
    writeFileSync(context, 'context benchmark log\n' + JSON.stringify({
      benchmark: 'context',
      status: 'complete',
      metrics: {
        keyFileRecall: metrics.contextKeyFileRecall,
        evidenceCoverage: metrics.contextEvidenceCoverage,
        symbolRecall: metrics.contextSymbolRecall,
        tokenWasteRatio: 0,
      },
    }) + '\n', 'utf8');
    writeFileSync(agent, 'agent benchmark log\n' + JSON.stringify({
      benchmark: 'agent',
      status: 'measured',
      metrics: {
        taskSuccess: true,
        keyFileRecall: metrics.agentKeyFileRecall,
        evidenceCoverage: metrics.agentEvidenceCoverage,
        hallucinatedSymbolRate: 0,
        staleFailureRate: 0,
      },
    }) + '\nagent post-json log\n', 'utf8');

    return { index, context, agent };
  }
});
