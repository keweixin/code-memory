import type { SqlJsDatabase } from '../storage/database.js';
import { getDbFilePath, openExistingDatabase } from '../storage/database.js';
import {
  resolveProject,
  type ProjectResolution,
  type ResolveProjectInput,
} from './project-resolver.js';

export interface RoutedProjectDatabase {
  db: SqlJsDatabase;
  projectRoot: string;
  resolution: ProjectResolution;
  freshness: {
    status: ProjectResolution['status'];
    recommendation: ProjectResolution['nextAction'];
  };
  close(): void;
}

export class DatabaseRouter {
  constructor(private readonly defaultDb?: SqlJsDatabase) {}

  resolve(input: ResolveProjectInput = {}): ProjectResolution {
    return resolveProject(input);
  }

  health(projectRoot: string): ProjectResolution {
    return resolveProject({ project: projectRoot });
  }

  open(input: ResolveProjectInput = {}): RoutedProjectDatabase {
    if (!input.repo && !input.project && this.defaultDb) {
      const dbFilePath = getDbFilePath();
      const projectRoot = dbFilePath
        ? dbFilePath.replace(/[\\/]\.code-memory[\\/]index\.db$/, '')
        : process.cwd();
      const resolution = resolveProject({ project: projectRoot });
      return {
        db: this.defaultDb,
        projectRoot: resolution.projectRoot ?? projectRoot,
        resolution,
        freshness: {
          status: resolution.status,
          recommendation: resolution.nextAction,
        },
        close() {
          // Default db lifecycle is owned by the caller/server.
        },
      };
    }

    const resolution = this.resolve(input);
    if (!resolution.projectRoot || !resolution.indexExists) {
      throw new ProjectNotReadyError(resolution);
    }

    const db = openExistingDatabase(resolution.projectRoot);
    return {
      db,
      projectRoot: resolution.projectRoot,
      resolution,
      freshness: {
        status: resolution.status,
        recommendation: resolution.nextAction,
      },
      close() {
        db.close();
      },
    };
  }

  async withResolvedProject<T>(
    input: ResolveProjectInput,
    callback: (routed: RoutedProjectDatabase) => Promise<T> | T,
  ): Promise<T> {
    const routed = this.open(input);
    try {
      return await callback(routed);
    } finally {
      routed.close();
    }
  }
}

export class ProjectNotReadyError extends Error {
  constructor(readonly resolution: ProjectResolution) {
    super('Code Memory project is not ready: ' + resolution.status);
    this.name = 'ProjectNotReadyError';
  }
}
