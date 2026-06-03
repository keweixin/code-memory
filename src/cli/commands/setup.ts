import type { Command } from 'commander';
import {
  formatAgentChanges,
  setupAgents,
  type AgentSelector,
  type RuntimeName,
} from '../agent-config.js';
import { createLogger } from '../../shared/logger.js';
import { resolveProjectPath } from '../project-path.js';
import {
  formatProjectOnboardingChanges,
  setupProjectOnboarding,
} from '../project-onboarding.js';
import { bootstrapProject } from './bootstrap.js';
import { runDoctor } from './doctor.js';

const log = createLogger('setup');

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Configure an AI agent to use the code-memory MCP server')
    .option('--agent <agent>', 'Agent: auto | claude | cursor | codex | gemini | opencode', 'auto')
    .option('--all', 'Configure all supported agents')
    .option('--project <path>', 'Project root path for onboarding and registration')
    .option('--bind-project', 'Bind generated MCP config to --project instead of global --auto-project routing')
    .option('--runtime <runtime>', 'Runtime: npx | global | local', 'npx')
    .option('--print-config <agent>', 'Print the generated MCP config for one agent without writing files')
    .option('--yes', 'Accept planned writes without prompting')
    .option('--no-bootstrap', 'Only write agent/project files; do not initialize or index')
    .option('--no-context', 'Do not write AGENTS.md / CLAUDE.md Code Memory context block')
    .option('--no-skills', 'Do not write .claude/skills/code-memory skill files')
    .option('--no-hooks', 'Do not write the minimal Claude Code PreToolUse hook')
    .option('--dry-run', 'Print planned changes without writing files')
    .action(async (options) => {
      try {
        const projectRoot = resolveProjectPath(options);
        const runtime = options.runtime as RuntimeName;
        const printConfig = options.printConfig as AgentSelector | undefined;
        if (options.bootstrap !== false && !options.dryRun && !printConfig) {
          await bootstrapProject({ project: projectRoot, embedding: 'none', workers: 'auto' });
        }
        const changes = setupAgents({
          agent: (printConfig ?? options.agent) as AgentSelector,
          all: Boolean(options.all),
          projectRoot,
          runtime,
          bindProject: Boolean(options.bindProject),
          dryRun: Boolean(options.dryRun) || Boolean(printConfig),
        });
        if (printConfig) {
          console.log(formatAgentChanges(changes, true));
          return;
        }
        const onboardingChanges = setupProjectOnboarding({
          projectRoot,
          dryRun: Boolean(options.dryRun),
          writeContext: options.context !== false,
          writeSkills: options.skills !== false,
          writeHooks: options.hooks !== false,
          runtime,
        });
        console.log(formatAgentChanges(changes, Boolean(options.dryRun)));
        console.log('');
        console.log(formatProjectOnboardingChanges(onboardingChanges, Boolean(options.dryRun)));
        if (!options.dryRun && options.bootstrap === false) {
          console.log('');
          console.log('Code Memory configuration was written.');
          console.log('');
          console.log('Project: ' + projectRoot);
          console.log('Agent: ' + (options.all ? 'all supported agents' : options.agent) + ' configured');
          console.log('MCP: ' + formatMcpCommand(runtime, projectRoot, Boolean(options.bindProject)));
          console.log('Bootstrap: skipped');
          console.log('Next: run `code-memory bootstrap --project ' + JSON.stringify(projectRoot) + '` when you want to initialize or refresh the index.');
        } else if (!options.dryRun) {
          console.log('');
          await runDoctor(false, false, false, projectRoot);
          console.log('');
          console.log('Code Memory is ready.');
          console.log('');
          console.log('Project: ' + projectRoot);
          console.log('Agent: ' + (options.all ? 'all supported agents' : options.agent) + ' configured');
          console.log('MCP: ' + formatMcpCommand(runtime, projectRoot, Boolean(options.bindProject)));
          console.log('Context files: ' + (options.context === false ? 'skipped' : 'AGENTS.md, CLAUDE.md'));
          console.log('Skills: ' + (options.skills === false ? 'skipped' : 'installed'));
          console.log('Hooks: ' + (options.hooks === false ? 'skipped' : 'installed for Claude Code when supported'));
          console.log('Next: reload your IDE, then run `code-memory doctor --project ' + JSON.stringify(projectRoot) + '` if the MCP server does not appear.');
        }
      } catch (err) {
        log.error('Setup failed', err);
        process.exit(1);
      }
    });
}

function formatMcpCommand(runtime: RuntimeName, projectRoot: string, bindProject = false): string {
  const args = bindProject
    ? ['serve', '--watch', '--project', projectRoot]
    : ['serve', '--watch', '--auto-project'];
  if (runtime === 'global') return ['code-memory', ...args].join(' ');
  if (runtime === 'local') return ['node', '<local dist/index.js>', ...args].join(' ');
  return ['npx', '-y', 'code-memory@latest', ...args].join(' ');
}
