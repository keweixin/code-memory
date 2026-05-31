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

  return program;
}
