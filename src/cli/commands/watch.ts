import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, CONFIG_FILE } from '../../shared/constants.js';
import type { CodeMemoryConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logger.js';
import { safeJsonParse } from '../../shared/utils.js';

const log = createLogger('watch');

export function registerWatchCommand(program: Command): void {
  program
    .command('watch [path]')
    .description('Watch project files and keep the index synchronized')
    .option('--debounce-ms <n>', 'Debounce file changes before indexing')
    .action(async (path, options) => {
      try {
        const projectRoot = path || process.cwd();
        const config = loadConfig(projectRoot);
        const { startIndexWatcher } = await import('../../indexer/watch-service.js');
        startIndexWatcher(projectRoot, config, {
          debounceMs: options.debounceMs ? Number(options.debounceMs) : undefined,
        });
        log.info('Watching for changes in ' + projectRoot);
      } catch (err) {
        log.error('Watch failed', err);
        process.exit(1);
      }
    });
}

function loadConfig(projectRoot: string): CodeMemoryConfig {
  const raw = readFileSync(join(projectRoot, CONFIG_DIR, CONFIG_FILE), 'utf-8');
  const parsed = safeJsonParse<CodeMemoryConfig>(raw);
  if (!parsed) throw new Error('Invalid config JSON');
  return parsed;
}
