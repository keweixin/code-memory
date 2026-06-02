/**
 * code-memory index — Build/update the project index
 */

import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, CONFIG_FILE } from '../../shared/constants.js';
import type { CodeMemoryConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logger.js';
import { safeJsonParse } from '../../shared/utils.js';

const log = createLogger('index');

export function registerIndexCommand(program: Command): void {
  program
    .command('index [path]')
    .description('Build or update the project index')
    .option('--full', 'Force full re-index (ignore incremental)')
    .option('--workers <n>', 'Parse worker count: auto, 0, or a positive integer')
    .option('--embedding-batch-size <n>', 'Chunk embedding batch size')
    .option('--embedding-concurrency <n>', 'Chunk embedding concurrency')
    .option('-v, --verbose', 'Show detailed progress')
    .action(async (path, options) => {
      try {
        await indexProject(path || process.cwd(), options);
      } catch (err) {
        log.error('Indexing failed', err);
        process.exit(1);
      }
    });
}

export interface IndexOptions {
  full?: boolean;
  verbose?: boolean;
  workers?: string;
  embeddingBatchSize?: string;
  embeddingConcurrency?: string;
}

export async function indexProject(projectPath: string, options: IndexOptions): Promise<void> {
  log.info(`Indexing project at: ${projectPath}`);
  log.info(`Full re-index: ${options.full ? 'yes' : 'no'}`);

  // Load config
  const configPath = join(projectPath, CONFIG_DIR, CONFIG_FILE);
  let config: CodeMemoryConfig;
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = safeJsonParse<CodeMemoryConfig>(raw);
    if (!parsed) throw new Error('Invalid config JSON');
    config = parsed;
  } catch {
    log.error('No config found. Run "code-memory init" first.');
    process.exit(1);
  }

  config = applyIndexOverrides(config, options);

  // Dynamically import IndexManager (heavy deps: tree-sitter, native SQLite)
  const { IndexManager } = await import('../../indexer/index-manager.js');
  const manager = new IndexManager(projectPath, config);

  if (options.full) {
    await manager.fullIndex();
  } else {
    await manager.incrementalIndex();
  }
}

function applyIndexOverrides(config: CodeMemoryConfig, options: IndexOptions): CodeMemoryConfig {
  const next: CodeMemoryConfig = {
    ...config,
    embedding: { ...config.embedding },
    indexing: { ...(config.indexing || {}) },
  };
  if (options.workers !== undefined) {
    next.indexing = {
      ...(next.indexing || {}),
      workers: options.workers === 'auto' ? 'auto' : Number(options.workers),
    };
    if (typeof next.indexing.workers === 'number' && Number.isNaN(next.indexing.workers)) {
      throw new Error('--workers must be "auto", 0, or a positive integer');
    }
  }
  if (options.embeddingBatchSize !== undefined) {
    next.embedding.batchSize = Number(options.embeddingBatchSize);
  }
  if (options.embeddingConcurrency !== undefined) {
    next.embedding.concurrency = Number(options.embeddingConcurrency);
  }
  return next;
}
