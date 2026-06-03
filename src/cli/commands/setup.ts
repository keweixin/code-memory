import type { Command } from 'commander';
import {
  formatAgentChanges,
  setupAgents,
  type AgentName,
  type RuntimeName,
} from '../agent-config.js';
import { createLogger } from '../../shared/logger.js';
import { resolveProjectPath } from '../project-path.js';
import {
  formatProjectOnboardingChanges,
  setupProjectOnboarding,
} from '../project-onboarding.js';
import { bootstrapProject } from './bootstrap.js';

const log = createLogger('setup');

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Configure an AI agent to use the code-memory MCP server')
    .option('--agent <agent>', 'Agent: claude | cursor | codex | gemini | opencode', 'codex')
    .option('--all', 'Configure all supported agents')
    .option('--project <path>', 'Project root path to write into MCP args')
    .option('--runtime <runtime>', 'Runtime: npx | global | local', 'npx')
    .option('--no-bootstrap', 'Only write agent/project files; do not initialize or index')
    .option('--no-context', 'Do not write AGENTS.md / CLAUDE.md Code Memory context block')
    .option('--no-skills', 'Do not write .claude/skills/code-memory skill files')
    .option('--no-hooks', 'Do not write the minimal Claude Code PreToolUse hook')
    .option('--dry-run', 'Print planned changes without writing files')
    .action(async (options) => {
      try {
        const projectRoot = resolveProjectPath(options);
        if (options.bootstrap !== false && !options.dryRun) {
          await bootstrapProject({ project: projectRoot, embedding: 'none', workers: 'auto' });
        }
        const changes = setupAgents({
          agent: options.agent as AgentName,
          all: Boolean(options.all),
          projectRoot,
          runtime: options.runtime as RuntimeName,
          dryRun: Boolean(options.dryRun),
        });
        const onboardingChanges = setupProjectOnboarding({
          projectRoot,
          dryRun: Boolean(options.dryRun),
          writeContext: options.context !== false,
          writeSkills: options.skills !== false,
          writeHooks: options.hooks !== false,
        });
        console.log(formatAgentChanges(changes, Boolean(options.dryRun)));
        console.log('');
        console.log(formatProjectOnboardingChanges(onboardingChanges, Boolean(options.dryRun)));
      } catch (err) {
        log.error('Setup failed', err);
        process.exit(1);
      }
    });
}
