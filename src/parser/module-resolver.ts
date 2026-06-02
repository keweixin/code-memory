import { posix as posixPath } from 'node:path';
import type { FileRecord } from '../shared/types.js';
import { normalizePath } from '../shared/utils.js';
import type { ProjectManifest } from '../scanner/project-manifest.js';

export class ModuleResolver {
  constructor(
    private readonly manifest: ProjectManifest,
    private readonly filesByPath: Map<string, FileRecord>,
  ) {}

  resolve(importer: FileRecord, source: string): FileRecord | null {
    if (source.startsWith('.')) {
      return this.resolveRelative(importer, source);
    }
    return this.resolveTsconfigPath(source) || this.resolvePackageSource(source);
  }

  private resolveRelative(importer: FileRecord, source: string): FileRecord | null {
    const importerDir = posixPath.dirname(normalizePath(importer.path));
    const rawPath = normalizePath(posixPath.normalize(posixPath.join(importerDir, source)));
    return this.resolveCandidates(rawPath, importer.language === 'typescript');
  }

  private resolveTsconfigPath(source: string): FileRecord | null {
    for (const [pattern, targets] of Object.entries(this.manifest.tsconfigPaths)) {
      const middle = matchPattern(pattern, source);
      if (middle === null && pattern === source) {
        for (const target of targets) {
          const match = this.resolveCandidates(this.withBaseUrl(target), true);
          if (match) return match;
        }
        continue;
      }

      if (middle !== null) {
        for (const target of targets) {
          const match = this.resolveCandidates(this.withBaseUrl(target.replace('*', middle)), true);
          if (match) return match;
        }
      }
    }
    return null;
  }

  private resolvePackageSource(source: string): FileRecord | null {
    const exported = this.manifest.packageExports.get(source);
    if (exported) {
      const match = this.resolveCandidates(exported, true);
      if (match) return match;
    }

    for (const [specifier, target] of this.manifest.packageExports.entries()) {
      const middle = matchPattern(specifier, source);
      if (middle === null) continue;
      const match = this.resolveCandidates(target.replace('*', middle), true);
      if (match) return match;
    }

    return this.resolveCandidates(source, true);
  }

  private resolveCandidates(rawPath: string, preferTypeScript: boolean): FileRecord | null {
    for (const candidate of getImportCandidates(rawPath, preferTypeScript)) {
      const file = this.filesByPath.get(candidate);
      if (file) return file;
    }
    return null;
  }

  private withBaseUrl(target: string): string {
    const normalized = normalizePath(target);
    if (!this.manifest.baseUrlPath || this.manifest.baseUrlPath === '.') return normalized;
    return normalizePath(posixPath.join(this.manifest.baseUrlPath, normalized));
  }
}

function matchPattern(pattern: string, source: string): string | null {
  const starIndex = pattern.indexOf('*');
  if (starIndex === -1) return null;
  const prefix = pattern.slice(0, starIndex);
  const suffix = pattern.slice(starIndex + 1);
  if (!source.startsWith(prefix) || !source.endsWith(suffix)) return null;
  return source.slice(prefix.length, source.length - suffix.length);
}

export function getImportCandidates(rawPath: string, preferTypeScript: boolean): string[] {
  const candidates: string[] = [];
  const add = (candidate: string) => {
    const normalized = normalizePath(candidate);
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };

  const ext = posixPath.extname(rawPath);
  if (ext) {
    const withoutExt = rawPath.slice(0, -ext.length);
    if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      add(withoutExt + '.ts');
      add(withoutExt + '.tsx');
    }
    add(rawPath);
    return candidates;
  }

  const extensions = preferTypeScript
    ? ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
    : ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'];
  for (const candidateExt of extensions) add(rawPath + candidateExt);
  for (const candidateExt of extensions) add(posixPath.join(rawPath, 'index' + candidateExt));
  return candidates;
}
