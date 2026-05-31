/**
 * code-memory index — Build/update the project index
 */

import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, CONFIG_FILE } from '../../shared/constants.js';
import type { CodeMemoryConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('index');

export function registerIndexCommand(program: Command): void {
  program
    .command('index [path]')
    .description('Build or update the project index')
    .option('--full', 'Force full re-index (ignore incremental)')
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

interface IndexOptions {
  full?: boolean;
  verbose?: boolean;
}

async function indexProject(projectPath: string, options: IndexOptions): Promise<void> {
  log.info(`Indexing project at: ${projectPath}`);
  log.info(`Full re-index: ${options.full ? 'yes' : 'no'}`);

  // Load config
  const configPath = join(projectPath, CONFIG_DIR, CONFIG_FILE);
  let config: CodeMemoryConfig;
  try {
    const raw = readFileSync(configPath, 'utf-8');
    config = JSON.parse(raw);
  } catch {
    log.error('No config found. Run "code-memory init" first.');
    process.exit(1);
  }

  // Dynamically import IndexManager (heavy deps: tree-sitter, sql.js)
  const { IndexManager } = await import('../../indexer/index-manager.js');
  const manager = new IndexManager(projectPath, config);

  if (options.full) {
    await manager.fullIndex();
  } else {
    await manager.incrementalIndex();
  }
}
