import type { Command } from 'commander';
import { createLogger } from '../../shared/logger.js';
import { resolveProjectPath } from '../project-path.js';
import {
  formatProjectOnboardingChanges,
  setupProjectOnboarding,
} from '../project-onboarding.js';
import { bootstrapProject } from './bootstrap.js';

const log = createLogger('analyze');

export function registerAnalyzeCommand(program: Command): void {
  program
    .command('analyze')
    .description('Bootstrap the index and install project AI context files without changing agent MCP config')
    .option('--project <path>', 'Project root path (default: cwd or CODE_MEMORY_PROJECT env)')
    .option('--embedding <provider>', 'Embedding provider: ollama | openai | none', 'none')
    .option('--workers <n>', 'Parse worker count', 'auto')
    .option('--no-context', 'Do not write AGENTS.md / CLAUDE.md Code Memory context block')
    .option('--no-skills', 'Do not write .claude/skills/code-memory skill files')
    .option('--no-hooks', 'Do not write the minimal Claude Code PreToolUse hook')
    .option('--dry-run', 'Print planned project file changes without indexing or writing')
    .action(async (options) => {
      try {
        const projectRoot = resolveProjectPath(options);
        if (!options.dryRun) {
          await bootstrapProject({
            project: projectRoot,
            embedding: options.embedding,
            workers: options.workers,
          });
        }
        const changes = setupProjectOnboarding({
          projectRoot,
          dryRun: Boolean(options.dryRun),
          writeContext: options.context !== false,
          writeSkills: options.skills !== false,
          writeHooks: options.hooks !== false,
        });
        console.log(formatProjectOnboardingChanges(changes, Boolean(options.dryRun)));
      } catch (err) {
        log.error('Analyze failed', err);
        process.exit(1);
      }
    });
}
