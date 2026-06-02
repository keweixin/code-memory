/**
 * code-memory serve — Start the MCP Server
 */

import type { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodeMemoryConfig } from '../../shared/types.js';
import { CONFIG_DIR, CONFIG_FILE } from '../../shared/constants.js';
import { createLogger } from '../../shared/logger.js';
import { stripUtf8Bom } from '../../shared/utils.js';

const log = createLogger('serve');

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Start the MCP server for AI tool integration')
    .option('--mcp', 'Use MCP stdio transport (default)', true)
    .option('--no-mcp', 'Fail clearly; alternate transports are not supported yet')
    .option('--watch', 'Keep the index synchronized while serving MCP')
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
}

export type ServeErrorCode =
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
  startIndexWatcher?: (projectPath: string, config: CodeMemoryConfig) => unknown;
  startMcpServer?: (
    projectPath: string,
    options?: { installSignalHandlers?: boolean; onShutdownComplete?: (signal: string) => void },
  ) => Promise<void>;
}

export async function startServer(options: ServeOptions, deps: ServeDependencies = {}): Promise<void> {
  const projectPath = process.cwd();

  if (options.mcp === false) {
    throw new ServeCommandError(
      'UNSUPPORTED_TRANSPORT',
      '--no-mcp is not supported yet. code-memory serve currently supports MCP stdio only.',
    );
  }

  const config = loadServeConfig(projectPath);

  if (options.watch) {
    await startWatcher(projectPath, config, deps);
  }

  log.info('Starting MCP server...');

  try {
    const startMcp = deps.startMcpServer ?? (await import('../../mcp/server.js')).startServer;
    await startMcp(projectPath, {
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

export function loadServeConfig(projectPath: string = process.cwd()): CodeMemoryConfig {
  const configPath = join(projectPath, CONFIG_DIR, CONFIG_FILE);
  if (!existsSync(configPath)) {
    throw new ServeCommandError(
      'CONFIG_MISSING',
      'Missing config. Run "code-memory init" first.',
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
      'Config JSON is missing required code-memory fields. Run "code-memory init" to recreate it.',
    );
  }

  return parsed;
}

async function startWatcher(
  projectPath: string,
  config: CodeMemoryConfig,
  deps: ServeDependencies,
): Promise<void> {
  try {
    const startIndexWatcher = deps.startIndexWatcher ??
      (await import('../../indexer/watch-service.js')).startIndexWatcher;
    startIndexWatcher(projectPath, config);
    log.info('Index watcher started');
  } catch (err) {
    throw new ServeCommandError(
      'WATCH_START_FAILED',
      'Failed to start the index watcher.',
      err,
    );
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
