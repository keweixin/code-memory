import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { safeJsonParse, normalizePath } from '../shared/utils.js';

export interface ProjectManifest {
  rootPath: string;
  baseUrl: string;
  baseUrlPath: string;
  tsconfigPaths: Record<string, string[]>;
  packageExports: Map<string, string>;
}

interface TsConfigJson {
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
}

interface PackageJson {
  name?: string;
  exports?: string | Record<string, unknown>;
  main?: string;
  module?: string;
  types?: string;
}

const PACKAGE_SCAN_IGNORES = new Set([
  '.code-memory',
  '.git',
  'dist',
  'node_modules',
]);

export function loadProjectManifest(rootPath: string): ProjectManifest {
  const tsconfigPath = resolve(rootPath, 'tsconfig.json');
  const tsconfig = existsSync(tsconfigPath)
    ? safeJsonParse<TsConfigJson>(readFileSync(tsconfigPath, 'utf-8'))
    : null;
  const baseUrl = resolve(rootPath, tsconfig?.compilerOptions?.baseUrl || '.');

  return {
    rootPath,
    baseUrl,
    baseUrlPath: normalizePath(relative(rootPath, baseUrl)),
    tsconfigPaths: tsconfig?.compilerOptions?.paths || {},
    packageExports: loadPackageExports(rootPath),
  };
}

function loadPackageExports(rootPath: string): Map<string, string> {
  const exportsBySpecifier = new Map<string, string>();
  for (const packageJsonPath of findPackageJsonFiles(rootPath)) {
    const pkg = safeJsonParse<PackageJson>(readFileSync(packageJsonPath, 'utf-8'));
    if (!pkg?.name) continue;

    const packageDir = dirname(packageJsonPath);
    const packageRelDir = normalizePath(relative(rootPath, packageDir));
    const add = (specifier: string, target: unknown) => {
      const targetPath = extractExportTarget(target);
      if (!targetPath) return;
      exportsBySpecifier.set(
        specifier,
        normalizePath(join(packageRelDir, targetPath)),
      );
    };

    if (typeof pkg.exports === 'string') {
      add(pkg.name, pkg.exports);
    } else if (pkg.exports && typeof pkg.exports === 'object') {
      for (const [subpath, target] of Object.entries(pkg.exports)) {
        const specifier = subpath === '.'
          ? pkg.name
          : pkg.name + '/' + subpath.replace(/^\.\//, '');
        add(specifier, target);
      }
    }

    if (!exportsBySpecifier.has(pkg.name)) {
      add(pkg.name, pkg.module || pkg.main || pkg.types || './index');
    }
  }
  return exportsBySpecifier;
}

function findPackageJsonFiles(rootPath: string): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!PACKAGE_SCAN_IGNORES.has(entry.name)) visit(join(dir, entry.name));
        continue;
      }
      if (entry.isFile() && entry.name === 'package.json') {
        files.push(join(dir, entry.name));
      }
    }
  };

  if (existsSync(rootPath) && statSync(rootPath).isDirectory()) visit(rootPath);
  return files;
}

function extractExportTarget(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return extractExportTarget(record.import) ||
    extractExportTarget(record.require) ||
    extractExportTarget(record.default) ||
    extractExportTarget(record.types);
}
