import { resolve } from 'node:path';

export interface ProjectPathOptions {
  project?: string;
}

export function resolveProjectPath(options: ProjectPathOptions = {}, fallback?: string): string {
  return resolve(options.project ?? fallback ?? process.env.CODE_MEMORY_PROJECT ?? process.cwd());
}
