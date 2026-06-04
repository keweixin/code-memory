import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProjectManifest } from '../src/scanner/project-manifest.js';
import { ModuleResolver } from '../src/parser/module-resolver.js';
import type { FileRecord } from '../src/shared/types.js';

function file(path: string): FileRecord {
  return {
    id: 'file:' + path,
    path,
    language: path.endsWith('.ts') ? 'typescript' : 'javascript',
    role: 'source',
    size: 1,
    hash: path,
    indexedAt: new Date().toISOString(),
    lastCommit: null,
    isGenerated: false,
    isIgnored: false,
    exports: [],
    imports: [],
    summary: null,
    riskLevel: 'low',
  };
}

describe('ModuleResolver', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-module-resolver-'));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('resolves package imports subpaths from package.json imports', () => {
    mkdirSync(join(tempRoot, 'src', 'internal'), { recursive: true });
    writeFileSync(
      join(tempRoot, 'package.json'),
      JSON.stringify({
        name: 'resolver-sample',
        imports: {
          '#internal/*': './src/internal/*.ts',
          '#config': './src/internal/config.ts',
        },
      }, null, 2),
      'utf-8',
    );

    const importer = file('src/app.ts');
    const files = new Map<string, FileRecord>([
      [importer.path, importer],
      ['src/internal/auth.ts', file('src/internal/auth.ts')],
      ['src/internal/config.ts', file('src/internal/config.ts')],
    ]);
    const resolver = new ModuleResolver(loadProjectManifest(tempRoot), files);

    expect(resolver.resolve(importer, '#internal/auth')?.path).toBe('src/internal/auth.ts');
    expect(resolver.resolve(importer, '#config')?.path).toBe('src/internal/config.ts');
  });

  it('resolves non-relative imports through tsconfig baseUrl when paths are absent', () => {
    writeFileSync(
      join(tempRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: 'src',
        },
      }, null, 2),
      'utf-8',
    );

    const importer = file('src/app.ts');
    const files = new Map<string, FileRecord>([
      [importer.path, importer],
      ['src/components/Button.tsx', file('src/components/Button.tsx')],
      ['src/lib/index.ts', file('src/lib/index.ts')],
    ]);
    const resolver = new ModuleResolver(loadProjectManifest(tempRoot), files);

    expect(resolver.resolve(importer, 'components/Button')?.path).toBe('src/components/Button.tsx');
    expect(resolver.resolve(importer, 'lib')?.path).toBe('src/lib/index.ts');
  });
});
