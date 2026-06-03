import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMcpServer } from '../src/mcp/server.js';
import { registerAllTools } from '../src/mcp/tool-registry.js';
import { closeDatabase } from '../src/storage/database.js';

type ToolResult = Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
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

describe('global MCP server', () => {
  let tempRoot: string;
  let originalCwd: string;
  let originalProjectEnv: string | undefined;
  let originalGlobalHome: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalProjectEnv = process.env.CODE_MEMORY_PROJECT;
    originalGlobalHome = process.env.CODE_MEMORY_GLOBAL_HOME;
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-global-mcp-'));
    process.env.CODE_MEMORY_GLOBAL_HOME = join(tempRoot, 'home');
    delete process.env.CODE_MEMORY_PROJECT;
    process.chdir(tempRoot);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalProjectEnv === undefined) {
      delete process.env.CODE_MEMORY_PROJECT;
    } else {
      process.env.CODE_MEMORY_PROJECT = originalProjectEnv;
    }
    if (originalGlobalHome === undefined) {
      delete process.env.CODE_MEMORY_GLOBAL_HOME;
    } else {
      process.env.CODE_MEMORY_GLOBAL_HOME = originalGlobalHome;
    }
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('starts without a project config or index in cwd', async () => {
    await expect(createMcpServer({ autoProject: true })).resolves.toBeDefined();
  });

  it('registers global tools without a default database and returns bootstrap protocol for missing projects', async () => {
    const server = new FakeMcpServer();
    registerAllTools(server as never);

    expect(server.handlers.has('resolve_project')).toBe(true);
    expect(server.handlers.has('bootstrap_project')).toBe(true);
    expect(server.handlers.has('sync_project')).toBe(true);
    expect(server.handlers.has('register_project')).toBe(true);
    expect(server.handlers.has('plan_context')).toBe(true);

    const resolution = await server.handlers.get('resolve_project')!({});
    expect(resolution.content[0].text).toContain('"status": "needs_bootstrap"');
    expect(resolution.content[0].text).toContain('bootstrap --project');
    const structuredResolution = JSON.parse(resolution.content[0].text) as {
      status: string;
      project: { root: string; dbPath: string };
      data: { resolution: { status: string; indexExists: boolean } };
      nextAction: { tool?: string; command?: string };
    };
    expect(structuredResolution.status).toBe('needs_bootstrap');
    expect(structuredResolution.project.root).toBe(tempRoot);
    expect(structuredResolution.project.dbPath).toContain('.code-memory');
    expect(structuredResolution.data.resolution.indexExists).toBe(false);
    expect(structuredResolution.nextAction.tool).toBe('bootstrap_project');
    expect(structuredResolution.nextAction.command).toContain('bootstrap --project');

    const sync = await server.handlers.get('sync_project')!({ project: tempRoot });
    const structuredSync = JSON.parse(sync.content[0].text) as {
      status: string;
      data: { changed: boolean; resolution: { status: string } };
      nextAction: { tool?: string };
    };
    expect(structuredSync.status).toBe('needs_bootstrap');
    expect(structuredSync.data.changed).toBe(false);
    expect(structuredSync.data.resolution.status).toBe('needs_bootstrap');
    expect(structuredSync.nextAction.tool).toBe('bootstrap_project');

    const plan = await server.handlers.get('plan_context')!({
      query: 'inspect startup flow',
      tokenBudget: 1000,
    });
    expect(plan.isError).not.toBe(true);
    expect(plan.content[0].text).toContain('[CODE-MEMORY BOOTSTRAP PROTOCOL]');
    expect(plan.content[0].text).toContain('bootstrap --project');
  });
});
