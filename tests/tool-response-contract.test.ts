import { describe, expect, it } from 'vitest';
import type {
  EvidenceItem,
  ScoreBreakdown,
  SearchResult,
  ToolDiagnostics,
  ToolErrorCode,
  ToolErrorEnvelope,
  ToolSuccessEnvelope,
} from '../src/shared/types.js';
import { TOOL_ERROR_CODES } from '../src/shared/types.js';

describe('tool response contracts', () => {
  it('exposes the shared tool error code set', () => {
    expect(TOOL_ERROR_CODES).toEqual([
      'INDEX_MISSING',
      'VECTOR_UNAVAILABLE',
      'QUERY_TOO_BROAD',
      'NO_RESULTS',
      'STALE_INDEX',
      'SCHEMA_MISMATCH',
    ]);

    const code: ToolErrorCode = 'NO_RESULTS';
    expect(TOOL_ERROR_CODES).toContain(code);
  });

  it('allows tools to expose diagnostics without changing existing result fields', () => {
    const evidence: EvidenceItem = {
      id: 'ev:1',
      kind: 'ast_node',
      filePath: 'src/index.ts',
      startLine: 1,
      endLine: 3,
      contentHash: 'abc123',
      preview: 'export function hello()',
      confidence: 0.9,
    };
    const scoreBreakdown: ScoreBreakdown = {
      keyword: 0.7,
      vector: 0,
      graph: 0.2,
      evidence: 0.9,
      ledgerPenalty: 0,
    };
    const diagnostics: ToolDiagnostics = {
      schemaVersion: 5,
      indexCommit: 'abc123',
      vectorUsed: false,
      graphUsed: true,
      repeatedContextOmitted: 0,
      staleIndex: false,
    };

    const result: SearchResult = {
      id: 'sym:hello',
      name: 'hello',
      kind: 'function',
      filePath: 'src/index.ts',
      score: 0.91,
      sources: ['keyword', 'graph'],
      snippet: 'export function hello() {}',
      lineRange: [1, 3],
      columnRange: [0, 1],
      evidence: [evidence],
      scoreBreakdown,
      diagnostics,
    };

    expect(result.evidence?.[0]).toEqual(evidence);
    expect(result.scoreBreakdown?.keyword).toBe(0.7);
    expect(result.diagnostics?.graphUsed).toBe(true);
  });

  it('supports success and error envelopes with diagnostics', () => {
    const diagnostics: ToolDiagnostics = {
      schemaVersion: 5,
      vectorUsed: false,
      graphUsed: false,
      repeatedContextOmitted: 0,
    };
    const success: ToolSuccessEnvelope<{ value: string }> = {
      ok: true,
      data: { value: 'ready' },
      diagnostics,
    };
    const failure: ToolErrorEnvelope = {
      ok: false,
      error: {
        code: 'INDEX_MISSING',
        message: 'No index found.',
      },
      diagnostics,
    };

    expect(success.data.value).toBe('ready');
    expect(failure.error.code).toBe('INDEX_MISSING');
  });
});
