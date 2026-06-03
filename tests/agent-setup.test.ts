import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setupAgents, uninstallAgents } from '../src/cli/agent-config.js';
import { setupProjectOnboarding, uninstallProjectOnboarding } from '../src/cli/project-onboarding.js';

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
    expect(changes[0].after).toContain('command = "npx"');
    expect(changes[0].after).toContain('"@keweixin/code-memory@latest","serve","--watch","--auto-project"');
    expect(changes[0].after).not.toContain('--project');
    expect(existsSync(changes[0].filePath)).toBe(false);
  });

  it('can generate global runtime MCP config for users with a global install', () => {
    const changes = setupAgents({
      agent: 'codex',
      dryRun: true,
      projectRoot: tempRoot,
      homeDir,
      runtime: 'global',
    });

    expect(changes[0].after).toContain('command = "code-memory"');
    expect(changes[0].after).toContain('"serve","--watch","--auto-project"');
    expect(changes[0].after).not.toContain('--project');
    expect(changes[0].after).not.toContain('@keweixin/code-memory@latest');
  });

  it('can generate local runtime MCP config for development builds', () => {
    const changes = setupAgents({
      agent: 'cursor',
      dryRun: true,
      projectRoot: tempRoot,
      homeDir,
      runtime: 'local',
    });

    const configured = JSON.parse(changes[0].after);
    expect(configured.mcpServers['code-memory'].command).toBe('node');
    expect(configured.mcpServers['code-memory'].args[0]).toContain('index.js');
    expect(configured.mcpServers['code-memory'].args).toEqual(expect.arrayContaining([
      'serve',
      '--watch',
      '--auto-project',
    ]));
    expect(configured.mcpServers['code-memory'].args).not.toContain('@keweixin/code-memory@latest');
  });

  it('can bind generated MCP config to a fixed project when requested', () => {
    const changes = setupAgents({
      agent: 'codex',
      dryRun: true,
      projectRoot: tempRoot,
      homeDir,
      bindProject: true,
    });

    expect(changes[0].after).toContain(`"serve","--watch","--project","${tempRoot.replace(/\\/g, '\\\\')}"`);
    expect(changes[0].after).not.toContain('--auto-project');
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
    expect(configured.mcpServers['code-memory']).toEqual({
      command: 'npx',
      args: ['-y', '@keweixin/code-memory@latest', 'serve', '--watch', '--auto-project'],
    });

    uninstallAgents({ agent: 'cursor', projectRoot: tempRoot, homeDir });
    const cleaned = JSON.parse(readFileSync(join(cursorDir, 'mcp.json'), 'utf-8'));
    expect(cleaned.mcpServers.other.command).toBe('other-mcp');
    expect(cleaned.mcpServers['code-memory']).toBeUndefined();
    expect(cleaned.__codeMemoryMarkerStart).toBeUndefined();
  });

  it('writes project context, skills, and Claude hook idempotently', () => {
    writeFileSync(join(tempRoot, 'AGENTS.md'), '# Project\n\nKeep this line.\n', 'utf-8');

    const first = setupProjectOnboarding({ projectRoot: tempRoot });
    const second = setupProjectOnboarding({ projectRoot: tempRoot });

    expect(first.some((change) => change.changed)).toBe(true);
    expect(second.every((change) => !change.changed)).toBe(true);

    const agents = readFileSync(join(tempRoot, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('CODE_MEMORY_CONTEXT_START');
    expect(agents).toContain('resolve_project -> plan_context -> get_context_pack/search_code -> search_symbols');
    expect(agents).toContain('mark_context_used/get_context_delta');
    expect(agents).toContain('Keep this line.');
    expect(agents.match(/CODE_MEMORY_CONTEXT_START/g)).toHaveLength(1);

    const skill = readFileSync(
      join(tempRoot, '.claude', 'skills', 'code-memory', 'code-memory-impact-analysis.md'),
      'utf-8',
    );
    expect(skill).toContain('## When to use');
    expect(skill).toContain('## Tool Order');
    expect(skill).toContain('## Done checklist');

    const hook = readFileSync(join(tempRoot, '.claude', 'hooks', 'code-memory-pretooluse.mjs'), 'utf-8');
    expect(hook).toContain('hookSpecificOutput');
    expect(hook).toContain('CODE_MEMORY_HOOK_DISABLED');
    expect(hook).toContain('CODE_MEMORY_PRETOOLUSE');
    expect(hook).toContain('HOOK_TIMEOUT_MS = 5000');
    expect(hook).toContain('MAX_OUTPUT_CHARS = 4000');
    expect(hook).toContain("CODE_MEMORY_COMMAND = \"npx\"");

    const settings = JSON.parse(readFileSync(join(tempRoot, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.hooks.PreToolUse[0].matcher).toBe('Bash|Grep|Glob');
  });

  it('upgrades legacy project context marker without removing user content or duplicating blocks', () => {
    writeFileSync(
      join(tempRoot, 'AGENTS.md'),
      [
        '# Project',
        '',
        'User-owned introduction.',
        '',
        '<!-- CODE_MEMORY_PROJECT_CONTEXT_START -->',
        'old generated block',
        '<!-- CODE_MEMORY_PROJECT_CONTEXT_END -->',
        '',
        'User-owned footer.',
        '',
      ].join('\n'),
      'utf-8',
    );

    setupProjectOnboarding({ projectRoot: tempRoot });
    setupProjectOnboarding({ projectRoot: tempRoot });

    const agents = readFileSync(join(tempRoot, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('User-owned introduction.');
    expect(agents).toContain('User-owned footer.');
    expect(agents).not.toContain('CODE_MEMORY_PROJECT_CONTEXT_START');
    expect(agents).not.toContain('old generated block');
    expect(agents.match(/CODE_MEMORY_CONTEXT_START/g)).toHaveLength(1);
  });

  it('writes Claude hook with the selected runtime', () => {
    setupProjectOnboarding({ projectRoot: tempRoot, runtime: 'global' });
    let hook = readFileSync(join(tempRoot, '.claude', 'hooks', 'code-memory-pretooluse.mjs'), 'utf-8');
    expect(hook).toContain("CODE_MEMORY_COMMAND = \"code-memory\"");
    expect(hook).not.toContain('@keweixin/code-memory@latest');

    setupProjectOnboarding({ projectRoot: tempRoot, runtime: 'local' });
    hook = readFileSync(join(tempRoot, '.claude', 'hooks', 'code-memory-pretooluse.mjs'), 'utf-8');
    expect(hook).toContain("CODE_MEMORY_COMMAND = \"node\"");
    expect(hook).toContain('index.js');
    expect(hook).not.toContain("CODE_MEMORY_COMMAND = \"npx\"");
  });

  it('uninstalls project onboarding artifacts without removing user content', () => {
    writeFileSync(join(tempRoot, 'AGENTS.md'), '# Project\n\nKeep this line.\n', 'utf-8');
    mkdirSync(join(tempRoot, '.claude'), { recursive: true });
    writeFileSync(
      join(tempRoot, '.claude', 'settings.json'),
      JSON.stringify({
        customSetting: true,
        hooks: {
          PreToolUse: [{
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo', args: ['keep'] }],
          }],
        },
      }, null, 2),
      'utf-8',
    );

    setupProjectOnboarding({ projectRoot: tempRoot });
    const changes = uninstallProjectOnboarding({ projectRoot: tempRoot });

    expect(changes.some((change) => change.action === 'remove' && change.changed)).toBe(true);
    const agents = readFileSync(join(tempRoot, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('Keep this line.');
    expect(agents).not.toContain('CODE_MEMORY_CONTEXT_START');
    expect(existsSync(join(tempRoot, '.claude', 'skills', 'code-memory'))).toBe(false);
    expect(existsSync(join(tempRoot, '.claude', 'hooks', 'code-memory-pretooluse.mjs'))).toBe(false);

    const settings = JSON.parse(readFileSync(join(tempRoot, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.customSetting).toBe(true);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe('Write');
  });
});
