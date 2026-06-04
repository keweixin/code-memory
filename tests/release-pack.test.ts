import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('npm package contents', () => {
  it('keeps package files focused on runtime artifacts', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as { files: string[] };
    const paths = pkg.files;

    expect(existsSync('dist')).toBe(true);
    expect(paths).toContain('dist');
    expect(paths).toContain('grammars');
    expect(paths).toContain('README.md');
    expect(paths).toContain('LICENSE');
    expect(paths).toContain('docs/*.md');
    expect(paths.some((path) => path === 'src' || path.startsWith('src/'))).toBe(false);
    expect(paths.some((path) => path === 'tests' || path.startsWith('tests/'))).toBe(false);
    expect(paths.some((path) => path === 'tools' || path.startsWith('tools/'))).toBe(false);
  });
});
