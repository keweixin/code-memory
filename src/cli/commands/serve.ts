/**
 * code-memory serve — Start the MCP Server
 */

import type { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CodeMemoryConfig } from '../../shared/types.js';
import { CONFIG_DIR, CONFIG_FILE } from '../../shared/constants.js';
import { createLogger } from '../../shared/logger.js';
import { stripUtf8Bom } from '../../shared/utils.js';
import { resolveProjectPath } from '../project-path.js';

const log = createLogger('serve');

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Start the MCP server for AI tool integration')
    .option('--mcp', 'Use MCP stdio transport (default)', true)
    .option('--no-mcp', 'Fail clearly; alternate transports are not supported yet')
    .option('--watch', 'Keep the index synchronized while serving MCP')
    .option('--auto-project', 'Start a global MCP router and resolve projects per tool call')
    .option('--auto-bootstrap', 'Auto-initialize or index before fixed-project serving')
    .option('--no-bootstrap', 'Do not auto-initialize or index before serving')
    .option('--project <path>', 'Project root path (default: cwd or CODE_MEMORY_PROJECT env)')
    .action(async (options) => {
      try {
        await startServer(options);
      } catch (err) {
        if (err instanceof ServeCommandError) {
          log.error(err.code + ': ' + err.message, err.cause);
        } else {
          log.error('MCP_START_FAILED: Server failed to start', err);
        }
        process.exit(1);
      }
    });
}

interface ServeOptions {
  mcp?: boolean;
  watch?: boolean;
  autoProject?: boolean;
  bootstrap?: boolean;
  project?: string;
}

export type ServeErrorCode =
  | 'BOOTSTRAP_FAILED'
  | 'CONFIG_MISSING'
  | 'CONFIG_INVALID_JSON'
  | 'CONFIG_INVALID_SCHEMA'
  | 'WATCH_START_FAILED'
  | 'MCP_START_FAILED'
  | 'UNSUPPORTED_TRANSPORT';

export class ServeCommandError extends Error {
  readonly code: ServeErrorCode;
  readonly cause?: unknown;

  constructor(code: ServeErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'ServeCommandError';
    this.code = code;
    this.cause = cause;
  }
}

export interface ServeDependencies {
  bootstrapProject?: (options: { project: string; embedding?: string; workers?: string }) => Promise<void>;
  startIndexWatcher?: (projectPath: string, config: CodeMemoryConfig) => unknown;
  watchRegistry?: WatchRegistry;
  startMcpServer?: (
    projectPath?: string,
    options?: { installSignalHandlers?: boolean; onShutdownComplete?: (signal: string) => void },
  ) => Promise<void>;
}

export async function startServer(options: ServeOptions, deps: ServeDependencies = {}): Promise<void> {
  if (options.mcp === false) {
    throw new ServeCommandError(
      'UNSUPPORTED_TRANSPORT',
      '--no-mcp is not supported yet. code-memory serve currently supports MCP stdio only.',
    );
  }

  if (options.autoProject) {
    log.info('Starting global MCP server with auto-project routing...');
    const defaultProject = getAutoProjectDefault(options);
    if (options.watch && defaultProject) {
      if (options.bootstrap !== false) {
        await bootstrapBeforeServe(defaultProject, deps);
      }
      const watchRegistry = deps.watchRegistry ?? new WatchRegistry(deps);
      await watchRegistry.ensureWatching(defaultProject);
    } else if (options.watch) {
      log.info('No default project found for --auto-project; watcher will not bind to cwd.');
    }
    await startMcp(undefined, deps);
    return;
  }

  const projectPath = resolveProjectPath(options);

  if (options.watch && options.bootstrap !== false) {
    await bootstrapBeforeServe(projectPath, deps);
  }

  const config = loadServeConfig(projectPath);

  if (options.watch) {
    await startWatcher(projectPath, config, deps);
  }

  log.info('Starting MCP server...');

  await startMcp(projectPath, deps);
}

export class WatchRegistry {
  private readonly handles = new Map<string, unknown>();

  constructor(private readonly deps: ServeDependencies = {}) {}

  async ensureWatching(projectRoot: string): Promise<void> {
    const root = resolve(projectRoot);
    if (this.handles.has(root)) return;
    const config = loadServeConfig(root);
    const handle = await startWatcher(root, config, this.deps);
    this.handles.set(root, handle);
  }

  async stopAll(): Promise<void> {
    const handles = [...this.handles.values()];
    this.handles.clear();
    for (const handle of handles) {
      await stopWatcherHandle(handle);
    }
  }
}

function getAutoProjectDefault(options: ServeOptions): string | null {
  const project = options.project?.trim();
  if (project) return resolve(project);
  const envProject = process.env.CODE_MEMORY_PROJECT?.trim();
  return envProject ? resolve(envProject) : null;
}

async function startMcp(projectPath: string | undefined, deps: ServeDependencies): Promise<void> {
  try {
    const startMcpServer = deps.startMcpServer ?? (await import('../../mcp/server.js')).startServer;
    await startMcpServer(projectPath, {
      installSignalHandlers: true,
      onShutdownComplete: () => process.exit(0),
    });
  } catch (err) {
    if (err instanceof ServeCommandError) throw err;
    throw new ServeCommandError(
      'MCP_START_FAILED',
      'Failed to start the MCP stdio server.',
      err,
    );
  }
}

async function bootstrapBeforeServe(projectPath: string, deps: ServeDependencies): Promise<void> {
  try {
    const bootstrap = deps.bootstrapProject ?? (await import('./bootstrap.js')).bootstrapProject;
    await bootstrap({ project: projectPath, embedding: 'none', workers: 'auto' });
  } catch (err) {
    throw new ServeCommandError(
      'BOOTSTRAP_FAILED',
      'Auto-bootstrap failed. Run "code-memory bootstrap --project ' + projectPath + '" or retry with --no-bootstrap for strict startup.',
      err,
    );
  }
}

export function loadServeConfig(projectPath: string = process.cwd()): CodeMemoryConfig {
  const configPath = join(projectPath, CONFIG_DIR, CONFIG_FILE);
  if (!existsSync(configPath)) {
    throw new ServeCommandError(
      'CONFIG_MISSING',
      'Missing config. Run "code-memory setup --project ." for full AI onboarding, or omit --no-bootstrap so serve can initialize automatically.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripUtf8Bom(readFileSync(configPath, 'utf-8')));
  } catch (err) {
    throw new ServeCommandError(
      'CONFIG_INVALID_JSON',
      'Config JSON is invalid: ' + (err instanceof Error ? err.message : String(err)),
      err,
    );
  }

  if (!isServeConfig(parsed)) {
    throw new ServeCommandError(
      'CONFIG_INVALID_SCHEMA',
      'Config JSON is missing required code-memory fields. Run "code-memory setup --project ." to recreate onboarding, or "code-memory init --project ." for config-only setup.',
    );
  }

  return parsed;
}

async function startWatcher(
  projectPath: string,
  config: CodeMemoryConfig,
  deps: ServeDependencies,
): Promise<unknown> {
  try {
    const startIndexWatcher = deps.startIndexWatcher ??
      (await import('../../indexer/watch-service.js')).startIndexWatcher;
    const handle = startIndexWatcher(projectPath, config);
    log.info('Index watcher started');
    return handle;
  } catch (err) {
    throw new ServeCommandError(
      'WATCH_START_FAILED',
      'Failed to start the index watcher.',
      err,
    );
  }
}

async function stopWatcherHandle(handle: unknown): Promise<void> {
  if (!handle || typeof handle !== 'object') return;
  const candidate = handle as {
    stop?: () => void | Promise<void>;
    close?: () => void | Promise<void>;
  };
  if (typeof candidate.stop === 'function') {
    await candidate.stop();
    return;
  }
  if (typeof candidate.close === 'function') {
    await candidate.close();
  }
}

function isServeConfig(value: unknown): value is CodeMemoryConfig {
  if (!value || typeof value !== 'object') return false;
  const config = value as Partial<CodeMemoryConfig>;
  const embedding = config.embedding as Partial<CodeMemoryConfig['embedding']> | undefined;
  const realtime = config.realtime as Partial<CodeMemoryConfig['realtime']> | undefined;
  const tokenBudgets = config.tokenBudgets as Partial<CodeMemoryConfig['tokenBudgets']> | undefined;
  const llm = config.llm as Partial<NonNullable<CodeMemoryConfig['llm']>> | null | undefined;
  return typeof config.projectName === 'string' &&
    typeof config.rootPath === 'string' &&
    Array.isArray(config.ignore) && config.ignore.every((item) => typeof item === 'string') &&
    Array.isArray(config.languages) && config.languages.every((item) => typeof item === 'string') &&
    Boolean(embedding && typeof embedding === 'object') &&
    ['ollama', 'openai', 'none'].includes(String(embedding?.provider)) &&
    typeof embedding?.model === 'string' &&
    Boolean(realtime && typeof realtime === 'object') &&
    typeof realtime?.watch === 'boolean' &&
    typeof realtime?.debounceMs === 'number' &&
    Boolean(tokenBudgets && typeof tokenBudgets === 'object') &&
    ['L0', 'L1', 'L2', 'L3', 'L4'].every((key) =>
      typeof tokenBudgets?.[key as keyof CodeMemoryConfig['tokenBudgets']] === 'number') &&
    (config.llm === null || (
      Boolean(llm && typeof llm === 'object') &&
      ['ollama', 'openai', 'openai-compatible'].includes(String(llm?.provider)) &&
      typeof llm?.model === 'string'
    ));
}
