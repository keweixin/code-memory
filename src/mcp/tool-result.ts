import { join } from 'node:path';
import { CONFIG_DIR, DATABASE_FILE } from '../shared/constants.js';
import type { SqlJsDatabase } from '../storage/database.js';
import { getIndexStaleness, type IndexFreshness } from '../indexer/staleness.js';
import type { ProjectResolution } from './project-resolver.js';

export type CodeMemoryToolStatus = 'ready' | 'needs_bootstrap' | 'needs_index' | 'stale' | 'error';

export interface CodeMemoryToolResult<T> {
  status: CodeMemoryToolStatus;
  project: {
    root: string;
    repoName: string;
    dbPath: string;
  };
  freshness: {
    indexStatus: string;
    changedFiles: string[];
    recommendedAction: string;
  };
  data: T;
  nextAction: {
    tool?: string;
    command?: string;
    reason: string;
  };
  display: string;
}

export interface ToolFreshnessInput {
  indexStatus: string;
  changedFiles?: string[];
  recommendedAction?: string | null;
}

export function formatStructuredToolResult<T>(result: CodeMemoryToolResult<T>): string {
  return JSON.stringify(result, null, 2);
}

export function createStructuredToolResult<T>(input: {
  status: CodeMemoryToolStatus;
  project: CodeMemoryToolResult<T>['project'];
  freshness: ToolFreshnessInput;
  data: T;
  nextAction: CodeMemoryToolResult<T>['nextAction'];
  display: string;
}): CodeMemoryToolResult<T> {
  return {
    status: input.status,
    project: input.project,
    freshness: normalizeFreshness(input.freshness),
    data: input.data,
    nextAction: input.nextAction,
    display: input.display,
  };
}

export function toolResultFromResolution<T>(
  resolution: ProjectResolution,
  data: T,
  display: string,
  nextActionReason?: string,
): CodeMemoryToolResult<T> {
  const freshness = freshnessFromResolution(resolution);
  return createStructuredToolResult({
    status: statusFromResolution(resolution),
    project: projectFromResolution(resolution),
    freshness,
    data,
    nextAction: {
      tool: toolForResolution(resolution),
      command: resolution.command ?? undefined,
      reason: nextActionReason ?? nextActionReasonFromResolution(resolution),
    },
    display,
  });
}

export function toolResultFromProject<T>(
  projectRoot: string,
  repoName: string,
  db: SqlJsDatabase,
  data: T,
  display: string,
  nextAction: CodeMemoryToolResult<T>['nextAction'],
): CodeMemoryToolResult<T> {
  const freshness = getIndexStaleness(projectRoot, db);
  return createStructuredToolResult({
    status: statusFromIndexFreshness(freshness.indexStatus),
    project: {
      root: projectRoot,
      repoName,
      dbPath: join(projectRoot, CONFIG_DIR, DATABASE_FILE),
    },
    freshness: {
      indexStatus: freshness.indexStatus,
      changedFiles: freshness.watchLastChangedPaths,
      recommendedAction: freshness.recommendedAction,
    },
    data,
    nextAction,
    display,
  });
}

export function errorToolResult<T>(message: string, data: T, display?: string): CodeMemoryToolResult<T> {
  return createStructuredToolResult({
    status: 'error',
    project: {
      root: '',
      repoName: '',
      dbPath: '',
    },
    freshness: {
      indexStatus: 'unknown',
      changedFiles: [],
      recommendedAction: 'inspect tool error',
    },
    data,
    nextAction: {
      reason: message,
    },
    display: display ?? ('Error: ' + message),
  });
}

export function statusFromIndexFreshness(indexStatus: IndexFreshness): CodeMemoryToolStatus {
  if (indexStatus === 'fresh') return 'ready';
  if (indexStatus === 'missing') return 'needs_index';
  if (indexStatus === 'stale' || indexStatus === 'failed' || indexStatus === 'rebuilding') return 'stale';
  return 'error';
}

function projectFromResolution(resolution: ProjectResolution): CodeMemoryToolResult<unknown>['project'] {
  return {
    root: resolution.projectRoot ?? '',
    repoName: resolution.repoName ?? '',
    dbPath: resolution.dbPath ?? '',
  };
}

function freshnessFromResolution(resolution: ProjectResolution): ToolFreshnessInput {
  if (!resolution.projectRoot || !resolution.indexExists) {
    return {
      indexStatus: resolution.indexStatus,
      changedFiles: [],
      recommendedAction: resolution.command ?? resolution.nextAction,
    };
  }

  const freshness = getIndexStaleness(resolution.projectRoot);
  return {
    indexStatus: freshness.indexStatus,
    changedFiles: freshness.watchLastChangedPaths,
    recommendedAction: freshness.recommendedAction ?? resolution.command ?? resolution.nextAction,
  };
}

function statusFromResolution(resolution: ProjectResolution): CodeMemoryToolStatus {
  if (resolution.status === 'unknown') return 'error';
  return resolution.status;
}

function toolForResolution(resolution: ProjectResolution): string | undefined {
  if (resolution.status === 'ready') return 'plan_context';
  if (resolution.status === 'stale') return 'sync_project';
  if (resolution.status === 'needs_bootstrap' || resolution.status === 'needs_index') return 'bootstrap_project';
  return 'register_project';
}

function nextActionReasonFromResolution(resolution: ProjectResolution): string {
  if (resolution.status === 'ready') return 'Project is ready. Continue with plan_context, then get_context_pack or search_code.';
  if (resolution.status === 'stale') return 'Index is stale. Run sync_project before trusting old evidence.';
  if (resolution.status === 'needs_index') return 'Config exists but index is missing. Run bootstrap_project or index the project.';
  if (resolution.status === 'needs_bootstrap') return 'Project is missing Code Memory config/index. Run bootstrap_project.';
  return resolution.reason || 'Project could not be resolved. Register a project or pass repo/project explicitly.';
}

function normalizeFreshness(input: ToolFreshnessInput): CodeMemoryToolResult<unknown>['freshness'] {
  return {
    indexStatus: input.indexStatus,
    changedFiles: input.changedFiles ?? [],
    recommendedAction: input.recommendedAction ?? 'none',
  };
}
