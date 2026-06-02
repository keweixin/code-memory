import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDatabase, getDatabase, getDatabaseSync } from '../src/storage/database.js';
import { traceProcess, type ProcessEntry } from '../src/graph/process-tracer.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { DEFAULT_TOKEN_BUDGETS, type CodeMemoryConfig } from '../src/shared/types.js';

function createConfig(rootPath: string): CodeMemoryConfig {
  return {
    projectName: 'process-tracer-sample',
    rootPath,
    ignore: [...DEFAULT_IGNORE_PATTERNS],
    languages: ['typescript', 'javascript'],
    embedding: {
      provider: 'none',
      model: 'none',
    },
    indexing: {
      workers: 0,
      parseBatchSize: 20,
      edgeMode: 'full',
    },
    llm: null,
    realtime: {
      watch: false,
      debounceMs: 80,
    },
    tokenBudgets: { ...DEFAULT_TOKEN_BUDGETS },
  };
}

function queryRows(sql: string, params: unknown[] = []): unknown[][] {
  const rows = getDatabaseSync().exec(sql, params);
  return rows[0]?.values ?? [];
}

function insertFile(fileId: string, path: string): void {
  getDatabaseSync().run(
    `INSERT INTO files (id, path, language, role, size, hash, indexed_at, exports, imports, search_text)
     VALUES (?, ?, 'typescript', 'source', 1, 'h', 'now', '[]', '[]', ?)`,
    [fileId, path, path],
  );
}

function insertSymbol(id: string, fileId: string, name: string, kind: string, startLine: number): void {
  getDatabaseSync().run(
    `INSERT INTO symbols
      (id, file_id, name, kind, start_line, end_line, range_start, range_end, hash, search_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'h', ?)`,
    [id, fileId, name, kind, startLine, startLine, startLine, startLine, name],
  );
}

function insertEdge(edgeId: string, fromId: string, toId: string, type: 'CALLS' | 'IMPORTS'): void {
  getDatabaseSync().run(
    `INSERT INTO edges (id, from_id, to_id, type, confidence, evidence)
     VALUES (?, ?, ?, ?, 0.9, '')`,
    [edgeId, fromId, toId, type],
  );
}

function insertCallRef(id: string, fileId: string, callerSymbolId: string, calleeName: string): void {
  getDatabaseSync().run(
    `INSERT INTO call_refs
      (id, file_id, caller_symbol_id, callee_name, is_constructor_call, start_line, start_column,
       evidence, resolution_status)
     VALUES (?, ?, ?, ?, 0, 1, 0, '', 'resolved')`,
    [id, fileId, callerSymbolId, calleeName],
  );
}

function insertRouteEndpoint(id: string, fileId: string, symbolId: string, routePath: string, method: string): void {
  getDatabaseSync().run(
    `INSERT INTO route_endpoints
      (id, file_id, symbol_id, route_path, http_method, framework, start_line, start_column, evidence)
     VALUES (?, ?, ?, ?, ?, 'express', 1, 0, '')`,
    [id, fileId, symbolId, routePath, method],
  );
}

describe('process-tracer', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-process-'));
    mkdirSync(join(tempRoot, '.code-memory'), { recursive: true });
    await getDatabase(tempRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('produces ordered steps from an HTTP route entry', () => {
    insertFile('file:app', 'src/app.ts');
    insertFile('file:user-svc', 'src/user-service.ts');
    insertSymbol('sym:getUser', 'file:app', 'getUser', 'function', 10);
    insertSymbol('sym:findUser', 'file:user-svc', 'findUser', 'function', 20);
    insertSymbol('sym:format', 'file:user-svc', 'format', 'function', 30);
    insertRouteEndpoint('re:getUser', 'file:app', 'sym:getUser', '/api/users/:id', 'GET');
    insertEdge('e1', 'sym:getUser', 'sym:findUser', 'CALLS');
    insertEdge('e2', 'sym:findUser', 'sym:format', 'CALLS');

    const entry: ProcessEntry = {
      symbolId: 'sym:getUser',
      name: 'GET /api/users/:id',
      entryKind: 'route',
      framework: 'express',
    };
    const result = traceProcess(entry, getDatabaseSync());

    expect(result.entrySymbolId).toBe('sym:getUser');
    expect(result.steps.map((s) => s.symbolId)).toEqual([
      'sym:getUser',
      'sym:findUser',
      'sym:format',
    ]);
    expect(result.steps[0]?.step).toBe(1);
    expect(result.steps[0]?.label).toBe('function:getUser:line=10');
    expect(result.steps[1]?.edgeId).toBe('e1');
    expect(result.depthReached).toBe(2);
    expect(result.visitedSymbolIds.size).toBe(3);
  });

  it('treats a function named main as a valid entry point', () => {
    insertFile('file:cli', 'src/cli.ts');
    insertSymbol('sym:main', 'file:cli', 'main', 'function', 1);
    insertSymbol('sym:helper', 'file:cli', 'helper', 'function', 5);
    insertEdge('e-main-1', 'sym:main', 'sym:helper', 'CALLS');

    const entry: ProcessEntry = {
      symbolId: 'sym:main',
      name: 'main',
      entryKind: 'main',
    };
    const result = traceProcess(entry, getDatabaseSync());

    expect(result.steps.map((s) => s.symbolId)).toEqual(['sym:main', 'sym:helper']);
    expect(result.steps[0]?.label).toBe('function:main:line=1');
  });

  it('respects maxDepth and stops once the limit is reached', () => {
    insertFile('file:chain', 'src/chain.ts');
    let prevId = 'sym:level0';
    insertSymbol(prevId, 'file:chain', 'level0', 'function', 1);
    for (let i = 1; i <= 15; i++) {
      const id = `sym:level${i}`;
      insertSymbol(id, 'file:chain', `level${i}`, 'function', i + 1);
      insertEdge(`e-${i}`, prevId, id, 'CALLS');
      prevId = id;
    }

    const entry: ProcessEntry = {
      symbolId: 'sym:level0',
      name: 'deep-chain',
      entryKind: 'main',
    };
    const result = traceProcess(entry, getDatabaseSync(), { maxDepth: 5 });

    // entry (step 1) + up to 5 children (steps 2..6) = at most 6 steps
    expect(result.steps.length).toBeLessThanOrEqual(6);
    expect(result.visitedSymbolIds.size).toBeLessThanOrEqual(6);
    expect(result.depthReached).toBeLessThanOrEqual(5);
  });

  it('stops at a terminal node that contains a throw call', () => {
    insertFile('file:handler', 'src/handler.ts');
    insertFile('file:fail', 'src/fail.ts');
    insertSymbol('sym:handler', 'file:handler', 'handler', 'function', 1);
    insertSymbol('sym:doWork', 'file:handler', 'doWork', 'function', 10);
    insertSymbol('sym:badOp', 'file:fail', 'badOp', 'function', 5);
    insertSymbol('sym:cleanup', 'file:fail', 'cleanup', 'function', 20);
    insertEdge('e-h-d', 'sym:handler', 'sym:doWork', 'CALLS');
    insertEdge('e-d-b', 'sym:doWork', 'sym:badOp', 'CALLS');
    insertEdge('e-b-c', 'sym:badOp', 'sym:cleanup', 'CALLS');
    insertCallRef('cr:badOp', 'file:fail', 'sym:badOp', 'throw');

    const entry: ProcessEntry = {
      symbolId: 'sym:handler',
      name: 'handler',
      entryKind: 'main',
    };
    const result = traceProcess(entry, getDatabaseSync());

    const visited = [...result.visitedSymbolIds];
    expect(visited).toContain('sym:badOp');
    expect(visited).not.toContain('sym:cleanup');
    expect(result.steps.length).toBe(3);
  });

  it('re-indexing processes is idempotent: no duplicate processes after a second pass', async () => {
    const config = createConfig(tempRoot);
    const manager = new IndexManager(tempRoot, config);

    // Stub the indexer to do nothing — we only want to exercise the
    // process detection stage on our hand-rolled mock data.
    vi.spyOn(manager as unknown as {
      rebuildGraphEdges: () => Promise<number>;
    }, 'rebuildGraphEdges').mockResolvedValue(0);

    insertFile('file:app', 'src/app.ts');
    insertSymbol('sym:alpha', 'file:app', 'alpha', 'function', 1);
    insertSymbol('sym:beta', 'file:app', 'beta', 'function', 5);
    insertEdge('e1', 'sym:alpha', 'sym:beta', 'CALLS');
    insertRouteEndpoint('re:1', 'file:app', 'sym:alpha', '/api/alpha', 'GET');

    await (manager as unknown as {
      runProcessAndCommunityDetection: () => Promise<void>;
    }).runProcessAndCommunityDetection();
    const firstCount = Number(queryRows('SELECT COUNT(*) FROM processes')[0]?.[0] ?? 0);
    expect(firstCount).toBe(1);

    await (manager as unknown as {
      runProcessAndCommunityDetection: () => Promise<void>;
    }).runProcessAndCommunityDetection();
    const secondCount = Number(queryRows('SELECT COUNT(*) FROM processes')[0]?.[0] ?? 0);
    expect(secondCount).toBe(1);

    const stepCount = Number(
      queryRows('SELECT COUNT(*) FROM process_steps ps JOIN processes p ON p.id = ps.process_id')[0]?.[0] ?? 0,
    );
    expect(stepCount).toBe(2);
  });
});
