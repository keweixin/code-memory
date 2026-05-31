import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
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
    packageExports: new Map(),
  };
}
