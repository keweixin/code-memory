/**
 * code-memory bootstrap — Auto-initialize project for MCP use
 *
 * Checks if .code-memory/index.db exists. If not, runs init + index --full.
 * Designed for AI agents and first-time users: one command, zero decisions.
 */

import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, CONFIG_FILE, DATABASE_FILE } from '../../shared/constants.js';
import { createLogger } from '../../shared/logger.js';
import { resolveProjectPath } from '../project-path.js';

const log = createLogger('bootstrap');

export function registerBootstrapCommand(program: Command): void {
  program
    .command('bootstrap')
    .description('Auto-initialize code-memory for the current project. Checks for existing index, runs init + index --full if needed. Perfect for AI agents.')
    .option('--embedding <provider>', 'Embedding provider: ollama | openai | none', 'none')
    .option('--workers <n>', 'Parse worker count', 'auto')
    .option('--project <path>', 'Project root path (default: cwd or CODE_MEMORY_PROJECT env)')
    .action(async (options) => {
      try {
        await bootstrapProject(options);
      } catch (err) {
        log.error('Bootstrap failed', err);
        process.exit(1);
      }
    });
}

interface BootstrapOptions {
  embedding?: string;
  workers?: string;
  project?: string;
}

export async function bootstrapProject(options: BootstrapOptions): Promise<void> {
  const projectPath = resolveProjectPath(options);
  const configPath = join(projectPath, CONFIG_DIR, CONFIG_FILE);
  const dbPath = join(projectPath, CONFIG_DIR, DATABASE_FILE);

  if (existsSync(dbPath)) {
    log.info('Index already exists. Running incremental update...');
    const { indexProject } = await import('./index.js');
    await indexProject(projectPath, { full: false, workers: options.workers || 'auto' });
    log.info('Bootstrap complete — project is ready for MCP tools.');
    return;
  }

  if (existsSync(configPath)) {
    log.info('Config found but no index exists. Running full index...');
    const { indexProject } = await import('./index.js');
    await indexProject(projectPath, { full: true, workers: options.workers || 'auto' });
    log.info('Bootstrap complete — project is ready for MCP tools.');
    return;
  }

  log.info('No index found. Initializing project...');
  const { initProject } = await import('./init.js');
  await initProject({
    project: projectPath,
    embedding: options.embedding || 'none',
    workers: options.workers || 'auto',
    index: true,
  });

  log.info('Bootstrap complete — project is ready for MCP tools.');
}
