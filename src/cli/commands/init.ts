/**
 * code-memory init — Initialize a new project configuration
 */

import type { Command } from 'commander';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CodeMemoryConfig, Language } from '../../shared/types.js';
import {
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_IGNORE_PATTERNS,
} from '../../shared/constants.js';
import { DEFAULT_TOKEN_BUDGETS } from '../../shared/types.js';
import { createLogger } from '../../shared/logger.js';
import { resolveProjectPath } from '../project-path.js';

const log = createLogger('init');

export const INIT_NEXT_STEP_MESSAGE = '\nNext step: Run "code-memory bootstrap --project ." to build the project graph, or "code-memory setup --project ." for full AI onboarding.';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize code-memory configuration for the current project')
    .option('-n, --name <name>', 'Project name (auto-detected from package.json if omitted)')
    .option('--ignore <patterns...>', 'Additional ignore patterns')
    .option('--languages <langs...>', 'Languages to index', ['typescript', 'javascript', 'python', 'go'])
    .option('--embedding <provider>', 'Embedding provider: ollama | openai | none', 'none')
    .option('--embedding-model <model>', 'Embedding model name')
    .option('-i, --index', 'Run a full index immediately after writing config')
    .option('--workers <n>', 'Parse worker count for --index: auto, 0, or a positive integer')
    .option('--project <path>', 'Project root path (default: cwd or CODE_MEMORY_PROJECT env)')
    .action(async (options) => {
      try {
        await initProject(options);
      } catch (err) {
        log.error('Failed to initialize project', err);
        process.exit(1);
      }
    });
}

interface InitOptions {
  name?: string;
  ignore?: string[];
  languages?: string[];
  embedding?: string;
  embeddingModel?: string;
  index?: boolean;
  workers?: string;
  project?: string;
}

export async function initProject(options: InitOptions): Promise<void> {
  const projectPath = resolveProjectPath(options);
  const configDir = join(projectPath, CONFIG_DIR);

  // Detect project name
  let projectName = options.name;
  if (!projectName) {
    try {
      const pkgJson = await import(join(projectPath, 'package.json'), {
        with: { type: 'json' },
      });
      projectName = pkgJson.default?.name || pkgJson.default?.default?.name;
    } catch {
      // No package.json, use directory name
      projectName = projectPath.split(/[\\/]/).pop() || 'unknown-project';
    }
  }

  const embeddingProvider = (options.embedding || 'none') as 'ollama' | 'openai' | 'none';
  const embeddingModel = options.embeddingModel || getDefaultEmbeddingModel(embeddingProvider);

  // Build config
  const config: CodeMemoryConfig = {
    projectName: projectName || 'unknown-project',
    rootPath: projectPath,
    ignore: [...DEFAULT_IGNORE_PATTERNS, ...(options.ignore || [])],
    languages: (options.languages || ['typescript', 'javascript', 'python', 'go']) as Language[],
    embedding: {
      provider: embeddingProvider,
      model: embeddingModel,
      batchSize: 50,
      concurrency: 2,
    },
    indexing: {
      workers: 'auto',
      parseBatchSize: 100,
      edgeMode: 'full',
    },
    llm: null,
    realtime: {
      watch: true,
      debounceMs: 80,
    },
    tokenBudgets: { ...DEFAULT_TOKEN_BUDGETS },
  };

  // Create config directory
  await mkdir(configDir, { recursive: true });

  // Write config
  const configPath = join(configDir, CONFIG_FILE);
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');

  log.info(`Initialized code-memory for "${projectName}"`);
  log.info(`Config written to ${configPath}`);
  log.info(`Languages: ${config.languages.join(', ')}`);
  log.info(`Embedding: ${config.embedding.provider} (${config.embedding.model})`);
  if (options.index) {
    const { indexProject } = await import('./index.js');
    await indexProject(projectPath, { full: true, workers: options.workers || 'auto' });
  } else {
    log.info(INIT_NEXT_STEP_MESSAGE);
  }
}

function getDefaultEmbeddingModel(provider: 'ollama' | 'openai' | 'none'): string {
  if (provider === 'none') return 'none';
  if (provider === 'openai') return 'text-embedding-3-small';
  return 'nomic-embed-text';
}
