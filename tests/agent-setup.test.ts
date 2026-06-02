import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setupAgents, uninstallAgents } from '../src/cli/agent-config.js';

describe('agent setup and uninstall', () => {
  let tempRoot: string;
  let homeDir: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-agent-'));
    homeDir = join(tempRoot, 'home');
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('dry-run reports codex changes without writing files', () => {
    const changes = setupAgents({
      agent: 'codex',
      dryRun: true,
      projectRoot: tempRoot,
      homeDir,
    });

    expect(changes).toHaveLength(1);
    expect(changes[0].changed).toBe(true);
    expect(changes[0].after).toContain('CODE_MEMORY_START');
    expect(changes[0].after).toContain('args = ["serve", "--watch"]');
    expect(existsSync(changes[0].filePath)).toBe(false);
  });

  it('is idempotent for markdown marker blocks and uninstall only removes code-memory content', () => {
    writeFileSync(join(tempRoot, 'CLAUDE.md'), '# Project\n\nKeep this line.\n', 'utf-8');

    setupAgents({ agent: 'claude', projectRoot: tempRoot, homeDir });
    const first = readFileSync(join(tempRoot, 'CLAUDE.md'), 'utf-8');
    setupAgents({ agent: 'claude', projectRoot: tempRoot, homeDir });
    const second = readFileSync(join(tempRoot, 'CLAUDE.md'), 'utf-8');

    expect(second).toBe(first);
    expect(second.match(/CODE_MEMORY_START/g)).toHaveLength(1);

    uninstallAgents({ agent: 'claude', projectRoot: tempRoot, homeDir });
    const after = readFileSync(join(tempRoot, 'CLAUDE.md'), 'utf-8');
    expect(after).toContain('Keep this line.');
    expect(after).not.toContain('CODE_MEMORY_START');
    expect(after).not.toContain('code-memory');
  });

  it('writes valid JSON MCP config and removes only the code-memory server', () => {
    const cursorDir = join(tempRoot, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      join(cursorDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          other: { command: 'other-mcp' },
        },
      }, null, 2),
      'utf-8',
    );

    setupAgents({ agent: 'cursor', projectRoot: tempRoot, homeDir });
    const configured = JSON.parse(readFileSync(join(cursorDir, 'mcp.json'), 'utf-8'));
    expect(configured.__codeMemoryMarkerStart).toBe('<!-- CODE_MEMORY_START -->');
    expect(configured.mcpServers.other.command).toBe('other-mcp');
    expect(configured.mcpServers['code-memory'].args).toEqual(['serve', '--watch']);

    uninstallAgents({ agent: 'cursor', projectRoot: tempRoot, homeDir });
    const cleaned = JSON.parse(readFileSync(join(cursorDir, 'mcp.json'), 'utf-8'));
    expect(cleaned.mcpServers.other.command).toBe('other-mcp');
    expect(cleaned.mcpServers['code-memory']).toBeUndefined();
    expect(cleaned.__codeMemoryMarkerStart).toBeUndefined();
  });
});
