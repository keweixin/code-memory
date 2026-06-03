import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CONFIG_DIR, DATABASE_FILE } from '../shared/constants.js';
import type { SqlJsDatabase } from '../storage/database.js';
import { getDbFilePath, openExistingDatabase } from '../storage/database.js';
import { findRepo } from '../cli/registry.js';
import { DatabaseRouter, ProjectNotReadyError } from './database-router.js';
import { formatProjectResolution, type ProjectResolution } from './project-resolver.js';

export interface RoutedDatabase {
  db: SqlJsDatabase;
  projectRoot: string;
  isDefault: boolean;
  close(): void;
}

export async function withRepoDatabase<T>(
  repo: string | undefined,
  defaultDb: SqlJsDatabase | undefined,
  callback: (db: SqlJsDatabase, projectRoot: string) => Promise<T> | T,
): Promise<T> {
  const router = new DatabaseRouter(defaultDb);
  try {
    return await router.withResolvedProject({ repo }, async (routed) =>
      callback(routed.db, routed.projectRoot));
  } catch (err) {
    if (err instanceof ProjectNotReadyError) {
      return createBootstrapProtocolResult(err.resolution) as T;
    }
    throw err;
  }
}

export function openRoutedDatabase(repo: string | undefined, defaultDb: SqlJsDatabase): RoutedDatabase {
  if (!repo) {
    return {
      db: defaultDb,
      projectRoot: getDefaultProjectRoot(),
      isDefault: true,
      close() {
        // The default MCP connection is owned by server lifecycle shutdown.
      },
    };
  }

  const projectRoot = resolveRepoRoot(repo);
  const db = openExistingDatabase(projectRoot);
  return {
    db,
    projectRoot,
    isDefault: false,
    close() {
      db.close();
    },
  };
}

export function createBootstrapProtocolResult(resolution: ProjectResolution): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{
      type: 'text',
      text: [
        '[CODE-MEMORY BOOTSTRAP PROTOCOL]',
        formatProjectResolution(resolution),
        '',
        resolution.command
          ? 'Next command: ' + resolution.command
          : 'Next action: ' + resolution.nextAction,
      ].join('\n'),
    }],
    isError: resolution.status === 'unknown',
  };
}

export function getRepoArgument(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const repo = (value as { repo?: unknown }).repo;
  return typeof repo === 'string' && repo.trim() ? repo.trim() : undefined;
}

export function resolveRepoRoot(repo: string): string {
  const registered = findRepo(repo);
  const projectRoot = registered?.rootPath || resolve(repo);
  const dbPath = join(projectRoot, CONFIG_DIR, DATABASE_FILE);
  if (!existsSync(dbPath)) {
    throw new Error(
      'Repository "' + repo + '" is not registered and does not contain ' +
      join(CONFIG_DIR, DATABASE_FILE) + '. Run code-memory register or pass a repository root path.',
    );
  }
  return projectRoot;
}

function getDefaultProjectRoot(): string {
  const dbPath = getDbFilePath();
  if (!dbPath) return process.cwd();
  return dirname(dirname(dbPath));
}
