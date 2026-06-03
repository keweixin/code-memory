import type { Command } from 'commander';
import {
  formatAgentChanges,
  uninstallAgents,
  type AgentName,
} from '../agent-config.js';
import {
  formatProjectOnboardingChanges,
  uninstallProjectOnboarding,
} from '../project-onboarding.js';
import { createLogger } from '../../shared/logger.js';
import { resolveProjectPath } from '../project-path.js';

const log = createLogger('uninstall');

export function registerUninstallCommand(program: Command): void {
  program
    .command('uninstall')
    .description('Remove code-memory MCP configuration from AI agent config files')
    .option('--agent <agent>', 'Agent: claude | cursor | codex | gemini | opencode', 'codex')
    .option('--all', 'Remove configuration from all supported agents')
    .option('--project <path>', 'Project root path (default: cwd or CODE_MEMORY_PROJECT env)')
    .option('--no-context', 'Do not remove managed AGENTS.md / CLAUDE.md project context blocks')
    .option('--no-skills', 'Do not remove generated Claude Code skill files')
    .option('--no-hooks', 'Do not remove generated Claude Code hook files/settings')
    .option('--dry-run', 'Print planned changes without writing files')
    .action((options) => {
      try {
        const projectRoot = resolveProjectPath(options);
        const agentChanges = uninstallAgents({
          agent: options.agent as AgentName,
          all: Boolean(options.all),
          projectRoot,
          dryRun: Boolean(options.dryRun),
        });
        const onboardingChanges = uninstallProjectOnboarding({
          projectRoot,
          dryRun: Boolean(options.dryRun),
          writeContext: options.context,
          writeSkills: options.skills,
          writeHooks: options.hooks,
        });
        console.log(formatAgentChanges(agentChanges, Boolean(options.dryRun)));
        console.log('');
        console.log(formatProjectOnboardingChanges(onboardingChanges, Boolean(options.dryRun)));
      } catch (err) {
        log.error('Uninstall failed', err);
        process.exit(1);
      }
    });
}
