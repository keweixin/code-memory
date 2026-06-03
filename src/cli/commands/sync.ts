import type { Command } from 'commander';
import { indexProject } from './index.js';
import { createLogger } from '../../shared/logger.js';
import { resolveProjectPath } from '../project-path.js';

const log = createLogger('sync');

export function registerSyncCommand(program: Command): void {
  program
    .command('sync [path]')
    .description('Synchronize the index with changed files')
    .option('--project <path>', 'Project root path (overrides positional path, cwd, and CODE_MEMORY_PROJECT env)')
    .option('--workers <n>', 'Parse worker count: auto, 0, or a positive integer')
    .action(async (path, options) => {
      try {
        await indexProject(resolveProjectPath(options, path), {
          full: false,
          workers: options.workers,
        });
      } catch (err) {
        log.error('Sync failed', err);
        process.exit(1);
      }
    });
}
