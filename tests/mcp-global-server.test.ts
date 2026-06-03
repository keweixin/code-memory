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

  beforeEach(() => {
    originalCwd = process.cwd();
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-global-mcp-'));
    process.chdir(tempRoot);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
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
    expect(server.handlers.has('plan_context')).toBe(true);

    const resolution = await server.handlers.get('resolve_project')!({});
    expect(resolution.content[0].text).toContain('"status": "needs_bootstrap"');
    expect(resolution.content[0].text).toContain('bootstrap --project');

    const plan = await server.handlers.get('plan_context')!({
      query: 'inspect startup flow',
      tokenBudget: 1000,
    });
    expect(plan.isError).not.toBe(true);
    expect(plan.content[0].text).toContain('[CODE-MEMORY BOOTSTRAP PROTOCOL]');
    expect(plan.content[0].text).toContain('bootstrap --project');
  });
});
