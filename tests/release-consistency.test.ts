import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createCli } from '../src/cli/cli.js';
import { VERSION } from '../src/shared/constants.js';

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function optionFlags(commandName: string): string[] {
  const command = createCli().commands.find((item) => item.name() === commandName);
  expect(command, `missing command ${commandName}`).toBeTruthy();
  return command!.options.flatMap((option) => [option.short, option.long].filter(Boolean));
}

describe('release consistency', () => {
  it('keeps package, lockfile, runtime VERSION, and changelog aligned', () => {
    const pkg = readJson<{ version: string }>('package.json');
    const lock = readJson<{ version: string; packages: Record<string, { version?: string }> }>('package-lock.json');
    const changelog = readFileSync('CHANGELOG.md', 'utf-8');
    const readme = readFileSync('README.md', 'utf-8');
    const releaseDoc = readFileSync('docs/release.md', 'utf-8');

    expect(pkg.version).toBe(VERSION);
    expect(lock.version).toBe(VERSION);
    expect(lock.packages[''].version).toBe(VERSION);
    expect(changelog).toMatch(new RegExp(`^## \\[?${VERSION.replace(/\./g, '\\.')}\\]? - `, 'm'));
    expect(readme).toContain(`Current source version: \`${VERSION}\`.`);
    expect(readme).toContain(`version older than \`${VERSION}\``);
    expect(releaseDoc).toContain(`Current source release target: \`${VERSION}\`.`);
    expect(releaseDoc).toContain(`git tag v${VERSION}`);
  });

  it('keeps README command table aligned with registered CLI commands', () => {
    const readme = readFileSync('README.md', 'utf-8');
    const commandNames = createCli().commands.map((command) => command.name());
    const expectedCommands = [
      'setup',
      'analyze',
      'bootstrap',
      'init',
      'index',
      'sync',
      'repair',
      'upgrade',
      'clean',
      'watch',
      'query',
      'tool',
      'status',
      'doctor',
      'register',
      'unregister',
      'wiki',
    ];

    expect(commandNames).toEqual(expect.arrayContaining(expectedCommands));
    for (const command of expectedCommands) {
      expect(readme, `README missing ${command}`).toContain(`| \`${command}`);
    }
  });

  it('keeps README first-run options aligned with setup and serve', () => {
    const readme = readFileSync('README.md', 'utf-8');

    expect(optionFlags('setup')).toEqual(expect.arrayContaining([
      '--project',
      '--runtime',
      '--bind-project',
      '--print-config',
      '--yes',
      '--no-bootstrap',
      '--dry-run',
    ]));
    expect(optionFlags('serve')).toEqual(expect.arrayContaining([
      '--watch',
      '--project',
      '--auto-project',
      '--auto-bootstrap',
      '--no-bootstrap',
    ]));

    expect(readme).toContain('setup --agent cursor --project .');
    expect(readme).toContain('setup --agent cursor --project . --bind-project');
    expect(readme).toContain('setup --agent cursor --project . --runtime npx');
    expect(readme).toContain('setup --agent cursor --project . --no-bootstrap');
    expect(readme).toContain('serve --watch --auto-project');
    expect(readme).toContain('serve --watch --project . --no-bootstrap');
    expect(readme).toContain('mark_context_used');
    expect(readme).toContain('get_context_delta');
  });

  it('keeps MCP workflow docs aligned with context ledger tools', () => {
    const readme = readFileSync('README.md', 'utf-8');
    const mcpTools = readFileSync('docs/mcp-tools.md', 'utf-8');
    const schemaFreeze = readFileSync('docs/schema-freeze.md', 'utf-8');

    for (const text of [readme, mcpTools]) {
      expect(text).toContain('resolve_project');
      expect(text).toContain('bootstrap_project');
      expect(text).toContain('sync_project');
      expect(text).toContain('register_project');
      expect(text).toContain('plan_context');
      expect(text).toContain('get_context_pack');
      expect(text).toContain('impact_analysis');
      expect(text).toContain('get_related_tests');
      expect(text).toContain('mark_context_used');
      expect(text).toContain('get_context_delta');
      expect(text).toContain('avoid_repeated_context');
    }
    expect(readme).toContain('docs/schema-freeze.md');
    expect(mcpTools).toContain('needs_project_selection');
    expect(mcpTools).toContain('watcherActive');
    expect(mcpTools).toContain('freshness.changedFiles');
    expect(mcpTools).toContain('Do not scrape `display` to discover stale paths.');
    expect(schemaFreeze).toContain('CodeMemoryToolResult');
    expect(schemaFreeze).toContain('code-memory://repo/{name}/schema');
    expect(schemaFreeze).toContain('`freshness.changedFiles` is a machine-readable list of stale indexed paths');
    expect(schemaFreeze).toContain('Watcher pending paths may be used as a fallback only when no stale');
    expect(schemaFreeze).toContain('indexed paths are available.');
  });

  it('keeps release and nightly workflows aligned with real repo benchmark policy', () => {
    const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf-8');
    const realRepoWorkflow = readFileSync('.github/workflows/real-repo-benchmark.yml', 'utf-8');

    expect(releaseWorkflow).toContain('npm run benchmark:real-repos -- --dry-run');
    expect(releaseWorkflow).toContain('workflow_dispatch');
    expect(releaseWorkflow).toContain('git checkout "$TAG"');
    expect(releaseWorkflow).toContain('Release source must be exactly tag v$VERSION');
    expect(releaseWorkflow).toContain('is already published; skipping npm publish.');
    expect(releaseWorkflow).toContain('npm dist-tag add "$PACKAGE_NAME@$VERSION" latest');
    expect(releaseWorkflow).toContain('npm latest verified: $PACKAGE_NAME@$LATEST');
    expect(releaseWorkflow).toContain('NPM_TOKEN is required for release publishing.');
    expect(releaseWorkflow).not.toContain('skipped npm publish');
    expect(realRepoWorkflow).toContain('workflow_dispatch');
    expect(realRepoWorkflow).toContain('npm run benchmark:real-repos -- --fail-on-threshold');
    expect(realRepoWorkflow).toContain('upload-artifact');
  });
});
