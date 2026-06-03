import type { Command } from 'commander';
import {
  findRepo,
  getRegistryPath,
  readRegistry,
  registerRepo,
  unregisterRepo,
} from '../registry.js';
import { createLogger } from '../../shared/logger.js';
import { basename } from 'node:path';
import { resolveProjectPath } from '../project-path.js';

const log = createLogger('registry');

export function registerRegistryCommands(program: Command): void {
  program
    .command('register')
    .description('Register the current repository in the global code-memory registry')
    .argument('[path]', 'Repository root path')
    .option('--project <path>', 'Project root path (overrides positional path, cwd, and CODE_MEMORY_PROJECT env)')
    .option('--name <name>', 'Registry name for the repository')
    .option('--dry-run', 'Print the entry without writing registry.json')
    .action((path: string, options) => {
      try {
        const rootPath = resolveProjectPath(options, path);
        if (options.dryRun) {
          const name = options.name || basename(rootPath) || 'repo';
          console.log(JSON.stringify({
            dryRun: true,
            registryPath: getRegistryPath(),
            entry: {
              name,
              rootPath,
            },
          }, null, 2));
          return;
        }
        const entry = registerRepo(rootPath, options.name);
        console.log('Registered ' + entry.name + ': ' + entry.rootPath);
      } catch (err) {
        log.error('Register failed', err);
        process.exit(1);
      }
    });

  program
    .command('list')
    .description('List repositories registered with code-memory')
    .option('--json', 'Output JSON')
    .option('--dry-run', 'Print registry path and entries without modifying registry.json')
    .action((options) => {
      const registry = readRegistry();
      if (options.dryRun) {
        console.log(JSON.stringify({
          dryRun: true,
          registryPath: getRegistryPath(),
          registry,
        }, null, 2));
        return;
      }
      if (options.json) {
        console.log(JSON.stringify(registry, null, 2));
        return;
      }
      if (registry.repos.length === 0) {
        console.log('No repositories registered.');
        return;
      }
      for (const repo of registry.repos) {
        console.log(repo.name + '\t' + repo.rootPath);
      }
    });

  program
    .command('unregister')
    .description('Remove a repository from the global code-memory registry')
    .argument('[nameOrPath]', 'Registered repo name or root path')
    .option('--project <path>', 'Project root path to unregister when nameOrPath is omitted')
    .option('--dry-run', 'Print the removal without writing registry.json')
    .action((nameOrPath: string, options) => {
      const target = nameOrPath || (options.project ? resolveProjectPath(options) : '');
      if (!target) {
        console.error('Repository name/path required, or pass --project <path>.');
        process.exit(1);
      }
      if (options.dryRun) {
        console.log(JSON.stringify({
          dryRun: true,
          registryPath: getRegistryPath(),
          match: findRepo(target),
        }, null, 2));
        return;
      }
      const removed = unregisterRepo(target);
      console.log('Removed repos: ' + removed);
    });

  program
    .command('open')
    .description('Print the root path for a registered repository')
    .argument('<repoName>', 'Registered repo name or root path')
    .action((repoName: string) => {
      const repo = findRepo(repoName);
      if (!repo) {
        console.error('Repository not registered: ' + repoName);
        process.exit(1);
      }
      console.log(repo.rootPath);
    });
}
