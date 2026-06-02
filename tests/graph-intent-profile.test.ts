import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDatabase, getDatabase } from '../src/storage/database.js';
import { bfsExpand } from '../src/search/graph-search.js';
import { HybridSearchEngine } from '../src/search/hybrid-search.js';

function edge(id: string, fromId: string, toId: string, type: string): void {
  getDatabaseSyncForTest().run(
    'INSERT INTO edges (id, from_id, to_id, type, confidence, evidence) VALUES (?, ?, ?, ?, 1.0, ?)',
    [id, fromId, toId, type, `${fromId} ${type} ${toId}`],
  );
}

function getDatabaseSyncForTest() {
  return globalThis.__codeMemoryTestDb!;
}

declare global {
  var __codeMemoryTestDb: Awaited<ReturnType<typeof getDatabase>> | undefined;
}

describe('intent-aware graph edge profiles', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-graph-intent-'));
    globalThis.__codeMemoryTestDb = await getDatabase(tempRoot);
  });

  afterEach(async () => {
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
    globalThis.__codeMemoryTestDb = undefined;
  });

  it('uses the debug profile to restrict graph expansion edge types', () => {
    edge('e-call', 'seed', 'call', 'CALLS');
    edge('e-ref', 'seed', 'ref', 'REFERENCES');
    edge('e-import', 'seed', 'imported', 'IMPORTS');
    edge('e-config', 'seed', 'config', 'CONFIGURES');
    edge('e-route-ref', 'seed', 'route-ref', 'ROUTE_REFERENCES');
    edge('e-extends', 'seed', 'base', 'EXTENDS');
    edge('e-tests', 'seed', 'test', 'TESTS');

    const expanded = bfsExpand(getDatabaseSyncForTest(), {
      startNodeIds: ['seed'],
      direction: 'both',
      intent: 'debug',
      maxHops: 1,
      maxNodes: 20,
    });

    expect(expanded.map((result) => result.nodeId).sort()).toEqual([
      'call',
      'config',
      'imported',
      'ref',
      'route-ref',
    ]);
  });

  it('defaults refactor expansion to incoming references, calls, imports, and tests', () => {
    edge('e-in-call', 'caller', 'seed', 'CALLS');
    edge('e-in-ref', 'referencer', 'seed', 'REFERENCES');
    edge('e-in-import', 'importer', 'seed', 'IMPORTS');
    edge('e-in-test', 'test', 'seed', 'TESTS');
    edge('e-out-call', 'seed', 'callee', 'CALLS');
    edge('e-in-config', 'config', 'seed', 'CONFIGURES');

    const expanded = bfsExpand(getDatabaseSyncForTest(), {
      startNodeIds: ['seed'],
      direction: 'both',
      intent: 'refactor',
      maxHops: 1,
      maxNodes: 20,
    });

    expect(expanded.map((result) => result.nodeId).sort()).toEqual([
      'caller',
      'importer',
      'referencer',
      'test',
    ]);
  });

  it('includes graph profile diagnostics when hybrid graph expansion is intent-routed', async () => {
    const db = getDatabaseSyncForTest();
    db.run(
      `INSERT INTO files
        (id, path, language, role, size, hash, indexed_at, exports, imports, risk_level, search_text)
       VALUES
        ('file-seed', 'src/seed.ts', 'typescript', 'source', 1, 'hash-seed', 'now', '[]', '[]', 'low', 'login seed'),
        ('file-route', 'src/route.ts', 'typescript', 'source', 1, 'hash-route', 'now', '[]', '[]', 'low', 'route handler')`,
    );
    db.run(
      `INSERT INTO symbols
        (id, file_id, name, kind, start_byte, end_byte, start_line, end_line,
         start_column, end_column, range_start, range_end, hash, search_text)
       VALUES
        ('seed', 'file-seed', 'login', 'function', 1, 2, 1, 1, 0, 5, 1, 1, 'hash-login', 'login seed'),
        ('route-ref', 'file-route', 'saveUser', 'function', 1, 2, 1, 1, 0, 8, 1, 1, 'hash-save', 'save user route')`,
    );
    edge('e-route-ref', 'seed', 'route-ref', 'ROUTE_REFERENCES');

    const results = await new HybridSearchEngine(db).search({
      query: 'login',
      searchMode: 'graph',
      intent: 'route',
      limit: 5,
    });

    expect(results.some((result) => result.id === 'route-ref')).toBe(true);
    expect(results[0].diagnostics).toMatchObject({
      graphUsed: true,
      intent: 'route',
      graphProfile: {
        name: 'route',
        edgeTypes: ['ROUTE_ENDPOINT', 'ROUTE_REFERENCES', 'CALLS'],
      },
    });
  });
});
