import type { Command } from 'commander';
import { indexProject } from './index.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('sync');

export function registerSyncCommand(program: Command): void {
  program
    .command('sync [path]')
    .description('Synchronize the index with changed files')
    .option('--workers <n>', 'Parse worker count: auto, 0, or a positive integer')
    .action(async (path, options) => {
      try {
        await indexProject(path || process.cwd(), {
          full: false,
          workers: options.workers,
        });
      } catch (err) {
        log.error('Sync failed', err);
        process.exit(1);
      }
    });
}
