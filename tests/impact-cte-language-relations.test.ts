import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig, EdgeType, SymbolKind } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { ImpactAnalyzer } from '../src/graph/impact-analyzer.js';
import { GraphEngine } from '../src/graph/graph-engine.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabase, getDatabaseSync } from '../src/storage/database.js';

function createConfig(rootPath: string, languages: CodeMemoryConfig['languages'] = ['typescript']): CodeMemoryConfig {
  return {
    projectName: 'impact-cte-language-relations',
    rootPath,
    ignore: [...DEFAULT_IGNORE_PATTERNS],
    languages,
    embedding: {
      provider: 'none',
      model: 'none',
    },
    indexing: {
      workers: 0,
      parseBatchSize: 100,
    },
    llm: null,
    realtime: {
      watch: false,
      debounceMs: 80,
    },
    tokenBudgets: { ...DEFAULT_TOKEN_BUDGETS },
  };
}

function writeConfig(rootPath: string, config = createConfig(rootPath)): void {
  mkdirSync(join(rootPath, '.code-memory'), { recursive: true });
  writeFileSync(join(rootPath, '.code-memory', 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

function queryRows(sql: string, params: unknown[] = []): unknown[][] {
  return getDatabaseSync().exec(sql, params)[0]?.values ?? [];
}

function insertFile(id: string, path: string): void {
  getDatabaseSync().run(
    `INSERT INTO files
      (id, path, language, role, size, hash, indexed_at, exports, imports, search_text)
     VALUES (?, ?, 'typescript', 'source', 1, ?, 'now', '[]', '[]', ?)`,
    [id, path, `${id}:hash`, path.replace(/[/.]/g, ' ')],
  );
}

function insertSymbol(id: string, fileId: string, name: string, kind: SymbolKind = 'function'): void {
  getDatabaseSync().run(
    `INSERT INTO symbols
      (id, file_id, name, kind, start_line, end_line, range_start, range_end, hash, search_text)
     VALUES (?, ?, ?, ?, 1, 1, 1, 1, ?, ?)`,
    [id, fileId, name, kind, `${id}:hash`, name],
  );
}

function insertEdge(fromId: string, toId: string, type: EdgeType, confidence = 1): void {
  getDatabaseSync().run(
    `INSERT INTO edges (id, from_id, to_id, type, confidence, evidence)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [`edge:${fromId}:${toId}:${type}`, fromId, toId, type, confidence, `${fromId} -> ${toId}`],
  );
}

describe('impact analyzer CTE traversal and language type relations', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-impact-cte-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('uses recursive SQL impact traversal instead of GraphEngine neighbor loops', async () => {
    writeConfig(tempRoot);
    await getDatabase(tempRoot);

    insertFile('file:target', 'src/target.ts');
    insertFile('file:caller1', 'src/caller1.ts');
    insertFile('file:caller2', 'src/caller2.ts');
    insertFile('file:callee', 'src/callee.ts');
    insertFile('file:low', 'src/low-confidence.ts');
    insertSymbol('sym:target', 'file:target', 'Service');
    insertSymbol('sym:caller1', 'file:caller1', 'callerOne');
    insertSymbol('sym:caller2', 'file:caller2', 'callerTwo');
    insertSymbol('sym:callee', 'file:callee', 'callee');
    insertSymbol('sym:low', 'file:low', 'lowConfidenceCaller');

    insertEdge('sym:caller1', 'sym:target', 'CALLS', 0.95);
    insertEdge('sym:caller2', 'sym:caller1', 'CALLS', 0.95);
    insertEdge('sym:low', 'sym:target', 'CALLS', 0.4);
    insertEdge('sym:target', 'sym:callee', 'CALLS', 0.95);

    const incomingSpy = vi.spyOn(GraphEngine.prototype, 'getIncomingNeighbors');
    const outgoingSpy = vi.spyOn(GraphEngine.prototype, 'getOutgoingNeighbors');

    const impact = new ImpactAnalyzer(getDatabaseSync()).analyze('Service');

    expect(incomingSpy).not.toHaveBeenCalled();
    expect(outgoingSpy).not.toHaveBeenCalled();
    expect(impact.affectedSymbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'callerOne', impactType: 'caller', distance: 1 }),
        expect.objectContaining({ name: 'callerTwo', impactType: 'caller', distance: 2 }),
        expect.objectContaining({ name: 'callee', impactType: 'callee', distance: 1 }),
      ]),
    );
    expect(impact.affectedSymbols.map((symbol) => symbol.name)).not.toContain('lowConfidenceCaller');
  });

  it('includes implementors and subclasses from EXTENDS/IMPLEMENTS in impact analysis', async () => {
    writeConfig(tempRoot);
    await getDatabase(tempRoot);

    insertFile('file:contract', 'src/contract.ts');
    insertFile('file:impl', 'src/impl.ts');
    insertFile('file:sub', 'src/sub.ts');
    insertSymbol('sym:contract', 'file:contract', 'Contract', 'interface');
    insertSymbol('sym:impl', 'file:impl', 'ConcreteService', 'class');
    insertSymbol('sym:sub', 'file:sub', 'ChildContract', 'interface');
    insertEdge('sym:impl', 'sym:contract', 'IMPLEMENTS', 0.9);
    insertEdge('sym:sub', 'sym:contract', 'EXTENDS', 0.9);

    const impact = new ImpactAnalyzer(getDatabaseSync()).analyze('Contract');

    expect(impact.affectedSymbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'ConcreteService', impactType: 'implementor', distance: 1 }),
        expect.objectContaining({ name: 'ChildContract', impactType: 'implementor', distance: 1 }),
      ]),
    );
    expect(impact.affectedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'src/impl.ts', impactType: 'direct' }),
        expect.objectContaining({ path: 'src/sub.ts', impactType: 'direct' }),
      ]),
    );
  });

  it('indexes Python inheritance into EXTENDS edges', async () => {
    mkdirSync(join(tempRoot, 'src'), { recursive: true });
    writeFileSync(
      join(tempRoot, 'src', 'models.py'),
      [
        'class BaseModel:',
        '    pass',
        '',
        'class UserModel(BaseModel):',
        '    pass',
        '',
        'def helper():',
        '    pass',
        '',
        'def run():',
        '    helper()',
      ].join('\n'),
      'utf-8',
    );
    const config = createConfig(tempRoot, ['python']);
    writeConfig(tempRoot, config);

    await new IndexManager(tempRoot, config).fullIndex();

    const edges = queryRows(
      `SELECT child.name, parent.name, e.type, e.evidence
       FROM edges e
       JOIN symbols child ON child.id = e.from_id
       JOIN symbols parent ON parent.id = e.to_id
       WHERE e.type = 'EXTENDS'
       ORDER BY child.name, parent.name`,
    );
    expect(edges).toEqual([
      ['UserModel', 'BaseModel', 'EXTENDS', 'UserModel extends BaseModel'],
    ]);

    const callEdges = queryRows(
      `SELECT callee.name
       FROM edges e
       JOIN symbols caller ON caller.id = e.from_id
       JOIN symbols callee ON callee.id = e.to_id
       WHERE e.type = 'CALLS' AND caller.name = 'run'
       ORDER BY callee.name`,
    ).map(([name]) => String(name));
    expect(callEdges).toContain('helper');
  });

  it('indexes same-file Go implicit interface implementations into IMPLEMENTS edges', async () => {
    mkdirSync(join(tempRoot, 'pkg'), { recursive: true });
    writeFileSync(
      join(tempRoot, 'pkg', 'store.go'),
      [
        'package pkg',
        '',
        'type Saver interface {',
        '  Save() error',
        '}',
        '',
        'type Loader interface {',
        '  Load() error',
        '}',
        '',
        'type Store struct {}',
        '',
        'func (s *Store) Save() error {',
        '  return nil',
        '}',
        '',
        'func helper() {}',
        '',
        'func Run() {',
        '  helper()',
        '}',
      ].join('\n'),
      'utf-8',
    );
    const config = createConfig(tempRoot, ['go']);
    writeConfig(tempRoot, config);

    await new IndexManager(tempRoot, config).fullIndex();

    const edges = queryRows(
      `SELECT impl.name, iface.name, e.type, e.evidence
       FROM edges e
       JOIN symbols impl ON impl.id = e.from_id
       JOIN symbols iface ON iface.id = e.to_id
       WHERE e.type = 'IMPLEMENTS'
       ORDER BY iface.name`,
    );
    expect(edges).toEqual([
      ['Store', 'Saver', 'IMPLEMENTS', 'Store implicitly implements Saver'],
    ]);

    const callEdges = queryRows(
      `SELECT callee.name
       FROM edges e
       JOIN symbols caller ON caller.id = e.from_id
       JOIN symbols callee ON callee.id = e.to_id
       WHERE e.type = 'CALLS' AND caller.name = 'Run'
       ORDER BY callee.name`,
    ).map(([name]) => String(name));
    expect(callEdges).toContain('helper');
  });
});
