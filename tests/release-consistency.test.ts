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

    expect(pkg.version).toBe(VERSION);
    expect(lock.version).toBe(VERSION);
    expect(lock.packages[''].version).toBe(VERSION);
    expect(changelog).toMatch(new RegExp(`^## \\[?${VERSION.replace(/\./g, '\\.')}\\]? - `, 'm'));
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
      '--no-bootstrap',
      '--dry-run',
    ]));
    expect(optionFlags('serve')).toEqual(expect.arrayContaining([
      '--watch',
      '--project',
      '--no-bootstrap',
    ]));

    expect(readme).toContain('setup --agent cursor --project .');
    expect(readme).toContain('setup --agent cursor --project . --runtime npx');
    expect(readme).toContain('setup --agent cursor --project . --no-bootstrap');
    expect(readme).toContain('serve --watch --project . --no-bootstrap');
  });
});
