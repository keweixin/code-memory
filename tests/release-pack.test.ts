import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function runNpm(args: string[]): string {
  if (process.env.npm_execpath) {
    return execFileSync(process.execPath, [process.env.npm_execpath, ...args], { encoding: 'utf-8' });
  }
  return execFileSync('npm', args, { encoding: 'utf-8', shell: process.platform === 'win32' });
}

describe('npm package contents', () => {
  it('does not publish source fixtures or tools', () => {
    const output = runNpm(['pack', '--dry-run', '--json']);
    const [{ files }] = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
    const paths = files.map((file) => file.path);

    expect(paths.some((path) => path.startsWith('dist/'))).toBe(true);
    expect(paths.some((path) => path.startsWith('grammars/'))).toBe(true);
    expect(paths).toContain('README.md');
    expect(paths).toContain('LICENSE');
    expect(paths).toContain('package.json');
    expect(paths.some((path) => path.startsWith('src/'))).toBe(false);
    expect(paths.some((path) => path.startsWith('tests/fixtures/'))).toBe(false);
    expect(paths.some((path) => path.startsWith('tools/'))).toBe(false);
  });
});
