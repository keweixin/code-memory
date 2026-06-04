import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, DATABASE_FILE } from '../../shared/constants.js';
import { createLogger } from '../../shared/logger.js';
import { writeWatchState } from '../../indexer/watch-state.js';
import { getDatabase, getDatabaseHealth, getDatabaseSync, saveDatabase } from '../../storage/database.js';
import { registerRepo } from '../registry.js';
import { resolveProjectPath } from '../project-path.js';
import { bootstrapProject } from './bootstrap.js';
import { indexProject } from './index.js';

const log = createLogger('lifecycle');

export function registerLifecycleCommands(program: Command): void {
  program
    .command('repair')
    .description('Repair a project by bootstrapping the index and registering it for global MCP routing')
    .option('--project <path>', 'Project root path (default: cwd or CODE_MEMORY_PROJECT env)')
    .option('--json', 'Output as JSON')
    .action(async (options) => runLifecycleCommand(options, repairProject));

  program
    .command('upgrade')
    .description('Upgrade project storage/schema in place and report whether a reindex is needed')
    .option('--project <path>', 'Project root path (default: cwd or CODE_MEMORY_PROJECT env)')
    .option('--json', 'Output as JSON')
    .action(async (options) => runLifecycleCommand(options, upgradeProject));

  program
    .command('clean')
    .description('Clean lifecycle state by syncing the index, clearing inactive watch state, and vacuuming SQLite')
    .option('--project <path>', 'Project root path (default: cwd or CODE_MEMORY_PROJECT env)')
    .option('--json', 'Output as JSON')
    .action(async (options) => runLifecycleCommand(options, cleanProject));
}

interface LifecycleOptions {
  project?: string;
  json?: boolean;
}

interface LifecycleResult {
  projectPath: string;
  actions: string[];
  status: 'ok' | 'warn' | 'error';
  needsReindex?: boolean;
}

async function runLifecycleCommand(
  options: LifecycleOptions,
  command: (projectPath: string) => Promise<LifecycleResult>,
): Promise<void> {
  try {
    const projectPath = resolveProjectPath(options);
    const result = await command(projectPath);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('Code Memory lifecycle: ' + result.status);
    for (const action of result.actions) console.log('- ' + action);
  } catch (err) {
    log.error('Lifecycle command failed', err);
    process.exit(1);
  }
}

async function repairProject(projectPath: string): Promise<LifecycleResult> {
  const actions: string[] = [];
  await bootstrapProject({ project: projectPath, embedding: 'none', workers: 'auto' });
  actions.push('Bootstrapped project index.');
  const entry = registerRepo(projectPath);
  actions.push('Registered repo: ' + entry.name + ' -> ' + entry.rootPath);
  return { projectPath, actions, status: 'ok' };
}

async function upgradeProject(projectPath: string): Promise<LifecycleResult> {
  const dbPath = join(projectPath, CONFIG_DIR, DATABASE_FILE);
  if (!existsSync(dbPath)) {
    await bootstrapProject({ project: projectPath, embedding: 'none', workers: 'auto' });
  }
  await getDatabase(projectPath);
  const health = getDatabaseHealth();
  await saveDatabase();
  const actions = [
    'Opened database and applied available schema migrations.',
    health.needsReindex
      ? 'Schema upgrade requires reindex: run code-memory bootstrap --project ' + JSON.stringify(projectPath)
      : 'Schema is current.',
  ];
  return { projectPath, actions, status: health.needsReindex ? 'warn' : 'ok', needsReindex: health.needsReindex };
}

async function cleanProject(projectPath: string): Promise<LifecycleResult> {
  const actions: string[] = [];
  const dbPath = join(projectPath, CONFIG_DIR, DATABASE_FILE);
  if (!existsSync(dbPath)) {
    await bootstrapProject({ project: projectPath, embedding: 'none', workers: 'auto' });
    actions.push('Bootstrapped missing index before cleanup.');
  } else {
    await indexProject(projectPath, { full: false, workers: 'auto' });
    actions.push('Synchronized changed files.');
  }
  writeWatchState(projectPath, {
    active: false,
    pid: null,
    pendingFiles: [],
    syncing: false,
  });
  actions.push('Cleared inactive watch state.');
  await getDatabase(projectPath);
  getDatabaseSync().run('VACUUM');
  await saveDatabase();
  actions.push('Vacuumed SQLite database.');
  return { projectPath, actions, status: 'ok' };
}
