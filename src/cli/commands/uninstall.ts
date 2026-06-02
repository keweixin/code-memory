import type { Command } from 'commander';
import {
  formatAgentChanges,
  uninstallAgents,
  type AgentName,
} from '../agent-config.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('uninstall');

export function registerUninstallCommand(program: Command): void {
  program
    .command('uninstall')
    .description('Remove code-memory MCP configuration from AI agent config files')
    .option('--agent <agent>', 'Agent: claude | cursor | codex | gemini | opencode', 'codex')
    .option('--all', 'Remove configuration from all supported agents')
    .option('--dry-run', 'Print planned changes without writing files')
    .action((options) => {
      try {
        const changes = uninstallAgents({
          agent: options.agent as AgentName,
          all: Boolean(options.all),
          dryRun: Boolean(options.dryRun),
        });
        console.log(formatAgentChanges(changes, Boolean(options.dryRun)));
      } catch (err) {
        log.error('Uninstall failed', err);
        process.exit(1);
      }
    });
}
