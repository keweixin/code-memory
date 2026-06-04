import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';
import { registerGetRouteMapTool } from '../src/mcp/tools/get-route-map.js';

type ToolResult = Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
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

function createConfig(rootPath: string): CodeMemoryConfig {
  return {
    projectName: 'route-mapping-sample',
    rootPath,
    ignore: [...DEFAULT_IGNORE_PATTERNS],
    languages: ['typescript', 'javascript', 'python'],
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

function writeConfig(rootPath: string, config = createConfig(rootPath)): void {
  mkdirSync(join(rootPath, '.code-memory'), { recursive: true });
  writeFileSync(join(rootPath, '.code-memory', 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

function queryRows(sql: string, params: unknown[] = []): unknown[][] {
  const rows = getDatabaseSync().exec(sql, params);
  return rows[0]?.values ?? [];
}

function writeRouteSample(rootPath: string): void {
  mkdirSync(join(rootPath, 'src', 'app', 'api', 'user', 'save'), { recursive: true });
  mkdirSync(join(rootPath, 'src'), { recursive: true });

  writeFileSync(
    join(rootPath, 'src', 'client.ts'),
    [
      'export async function saveUser(): Promise<void> {',
      "  await fetch('/api/user/save', { method: 'POST' });",
      '}',
      '',
      'export async function checkHealth(): Promise<void> {',
      "  await fetch('/api/health');",
      '}',
      '',
      'export async function loadOrders(): Promise<void> {',
      "  await fetch('/api/orders');",
      '}',
      '',
      'export async function missingRoute(): Promise<void> {',
      "  await fetch('/api/missing', { method: 'DELETE' });",
      '}',
    ].join('\n'),
    'utf-8',
  );

  writeFileSync(
    join(rootPath, 'src', 'app', 'api', 'user', 'save', 'route.ts'),
    [
      'export async function POST(): Promise<Response> {',
      '  return Response.json({ ok: true });',
      '}',
    ].join('\n'),
    'utf-8',
  );

  writeFileSync(
    join(rootPath, 'src', 'api.py'),
    [
      'from fastapi import APIRouter, FastAPI',
      '',
      'app = FastAPI()',
      'router = APIRouter(prefix="/health")',
      '',
      '@router.get("/")',
      'async def health():',
      '    return {"ok": True}',
      '',
      'app.include_router(router, prefix="/api")',
    ].join('\n'),
    'utf-8',
  );

  writeFileSync(
    join(rootPath, 'src', 'express.js'),
    [
      'import express from "express";',
      '',
      'const app = express();',
      '',
      'export function listOrders(req, res) {',
      '  res.json([]);',
      '}',
      '',
      'app.get("/api/orders", listOrders);',
    ].join('\n'),
    'utf-8',
  );
}

async function indexRouteSample(rootPath: string): Promise<IndexManager> {
  writeRouteSample(rootPath);
  const config = createConfig(rootPath);
  writeConfig(rootPath, config);
  const manager = new IndexManager(rootPath, config);
  await manager.fullIndex();
  return manager;
}

describe('route mapping metadata and graph edges', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-routes-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('extracts route endpoints and fetch references across Next.js and FastAPI files', async () => {
    await indexRouteSample(tempRoot);

    const endpoints = queryRows(
      `SELECT route_path, http_method, framework
       FROM route_endpoints
       ORDER BY route_path, http_method`,
    );
    expect(endpoints).toEqual([
      ['/api/health', 'GET', 'fastapi'],
      ['/api/orders', 'GET', 'express'],
      ['/api/user/save', 'POST', 'next_app_router'],
    ]);

    const references = queryRows(
      `SELECT route_path, http_method, resolution_status
       FROM route_references
       ORDER BY route_path, http_method`,
    );
    expect(references).toEqual([
      ['/api/health', 'GET', 'resolved'],
      ['/api/missing', 'DELETE', 'unresolved'],
      ['/api/orders', 'GET', 'resolved'],
      ['/api/user/save', 'POST', 'resolved'],
    ]);

    const routeEdges = queryRows(
      `SELECT caller.name, target.name, e.confidence
       FROM edges e
       JOIN graph_edge_evidence gee ON gee.edge_id = e.id
       LEFT JOIN symbols caller ON caller.id = e.from_id
       LEFT JOIN symbols target ON target.id = e.to_id
       WHERE e.type = 'REFERENCES' AND gee.source_table = 'route_references'
       ORDER BY caller.name, target.name`,
    );
    expect(routeEdges).toEqual([
      ['checkHealth', 'health', 0.88],
      ['loadOrders', 'listOrders', 0.88],
      ['saveUser', 'POST', 0.88],
    ]);
  });

  it('rebuilds route graph edges from route metadata without parsing source files', async () => {
    const manager = await indexRouteSample(tempRoot);
    const indexFileSpy = vi.spyOn(manager as unknown as { indexFile: () => unknown }, 'indexFile');

    getDatabaseSync().run(
      `DELETE FROM edges
       WHERE id IN (
         SELECT edge_id FROM graph_edge_evidence WHERE source_table = 'route_references'
       )`,
    );
    getDatabaseSync().run("DELETE FROM graph_edge_evidence WHERE source_table = 'route_references'");
    expect(queryRows("SELECT COUNT(*) FROM graph_edge_evidence WHERE source_table = 'route_references'")[0][0]).toBe(0);

    await (manager as unknown as {
      rebuildGraphEdges: (mode: 'full', dirtyFileIds?: string[]) => Promise<number>;
    }).rebuildGraphEdges('full');

    expect(indexFileSpy).not.toHaveBeenCalled();
    const restored = queryRows(
      `SELECT caller.name, target.name
       FROM edges e
       JOIN graph_edge_evidence gee ON gee.edge_id = e.id
       LEFT JOIN symbols caller ON caller.id = e.from_id
       LEFT JOIN symbols target ON target.id = e.to_id
       WHERE e.type = 'REFERENCES' AND gee.source_table = 'route_references'
       ORDER BY caller.name, target.name`,
    );
    expect(restored).toEqual([
      ['checkHealth', 'health'],
      ['loadOrders', 'listOrders'],
      ['saveUser', 'POST'],
    ]);
  });

  it('formats route endpoints and resolved references through the MCP tool', async () => {
    await indexRouteSample(tempRoot);
    const server = new FakeMcpServer();
    registerGetRouteMapTool(server as never, getDatabaseSync());

    const result = await server.handlers.get('get_route_map')!({
      route: '/api/user/save',
    });
    const structured = parseStructured<{
      route: string;
      endpointCount: number;
      referenceCount: number;
      endpoints: Array<{ route_path: string; http_method: string; framework: string; file_path: string }>;
      references: Array<{ route_path: string; http_method: string; resolution_status: string; file_path: string }>;
    }>(result);

    expect(structured.status).toBe('ready');
    expect(structured.project.root).toBe(tempRoot);
    expect(structured.data.route).toBe('/api/user/save');
    expect(structured.data.endpointCount).toBe(1);
    expect(structured.data.referenceCount).toBe(1);
    expect(structured.data.endpoints[0]).toMatchObject({
      route_path: '/api/user/save',
      http_method: 'POST',
      framework: 'next_app_router',
      file_path: 'src/app/api/user/save/route.ts',
    });
    expect(structured.data.references[0]).toMatchObject({
      route_path: '/api/user/save',
      http_method: 'POST',
      resolution_status: 'resolved',
      file_path: 'src/client.ts',
    });
    expect(structured.display).toContain('POST /api/user/save [next_app_router] src/app/api/user/save/route.ts:1 (POST)');
    expect(structured.display).toContain('POST /api/user/save [resolved] src/client.ts:2 (saveUser)');
    expect(structured.display).not.toContain('/api/missing');
  });
});
