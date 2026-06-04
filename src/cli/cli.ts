/**
 * Code Memory Graph — CLI Framework
 *
 * Uses Commander.js to register subcommands.
 */

import { Command } from 'commander';
import { VERSION } from '../shared/constants.js';
import { registerInitCommand } from './commands/init.js';
import { registerIndexCommand } from './commands/index.js';
import { registerServeCommand } from './commands/serve.js';
import { registerQueryCommand } from './commands/query.js';
import { registerStatusCommand } from './commands/status.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerUninstallCommand } from './commands/uninstall.js';
import { registerSyncCommand } from './commands/sync.js';
import { registerWatchCommand } from './commands/watch.js';
import { registerRegistryCommands } from './commands/registry.js';
import { registerWikiCommand } from './commands/wiki.js';
import { registerBootstrapCommand } from './commands/bootstrap.js';
import { registerAnalyzeCommand } from './commands/analyze.js';
import { registerToolCommand } from './commands/tool.js';
import { registerLifecycleCommands } from './commands/lifecycle.js';

export function createCli(): Command {
  const program = new Command();

  program
    .name('code-memory')
    .description('AI Project Cognitive Engine — Code Memory Graph with MCP integration')
    .version(VERSION);

  registerInitCommand(program);
  registerIndexCommand(program);
  registerServeCommand(program);
  registerQueryCommand(program);
  registerStatusCommand(program);
  registerDoctorCommand(program);
  registerSetupCommand(program);
  registerUninstallCommand(program);
  registerSyncCommand(program);
  registerWatchCommand(program);
  registerRegistryCommands(program);
  registerWikiCommand(program);
  registerBootstrapCommand(program);
  registerAnalyzeCommand(program);
  registerToolCommand(program);
  registerLifecycleCommands(program);

  return program;
}
