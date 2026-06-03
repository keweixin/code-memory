import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMcpServer } from '../src/mcp/server.js';
import { closeDatabase } from '../src/storage/database.js';

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
});
