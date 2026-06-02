import type { Command } from 'commander';
import {
  formatAgentChanges,
  setupAgents,
  type AgentName,
} from '../agent-config.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('setup');

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Configure an AI agent to use the code-memory MCP server')
    .option('--agent <agent>', 'Agent: claude | cursor | codex | gemini | opencode', 'codex')
    .option('--all', 'Configure all supported agents')
    .option('--dry-run', 'Print planned changes without writing files')
    .action((options) => {
      try {
        const changes = setupAgents({
          agent: options.agent as AgentName,
          all: Boolean(options.all),
          dryRun: Boolean(options.dryRun),
        });
        console.log(formatAgentChanges(changes, Boolean(options.dryRun)));
      } catch (err) {
        log.error('Setup failed', err);
        process.exit(1);
      }
    });
}
