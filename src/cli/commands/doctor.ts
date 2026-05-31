/**
 * code-memory doctor — Check local configuration, index, and parser grammars.
 */

import type { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { CONFIG_DIR, CONFIG_FILE, DATABASE_FILE } from '../../shared/constants.js';
import { LANGUAGE_CONFIGS } from '../../parser/types.js';
import { createLogger } from '../../shared/logger.js';
import { safeJsonParse } from '../../shared/utils.js';

const log = createLogger('doctor');

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check code-memory configuration, index, and parser grammars')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        await runDoctor(Boolean(options.json));
      } catch (err) {
        log.error('Doctor failed', err);
        process.exit(1);
      }
    });
}

interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
}

interface DoctorConfig {
  languages?: string[];
  embedding?: {
    provider?: string;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
  };
}

async function runDoctor(asJson: boolean): Promise<void> {
  const projectPath = process.cwd();
  const checks: CheckResult[] = [];
  const configPath = join(projectPath, CONFIG_DIR, CONFIG_FILE);
  const dbPath = join(projectPath, CONFIG_DIR, DATABASE_FILE);

  checks.push({
    name: 'config',
    status: existsSync(configPath) ? 'ok' : 'error',
    message: existsSync(configPath)
      ? 'Found ' + configPath
      : 'Missing config. Run "code-memory init" first.',
  });

  checks.push({
    name: 'index',
    status: existsSync(dbPath) ? 'ok' : 'warn',
    message: existsSync(dbPath)
      ? 'Found ' + dbPath
      : 'No index found. Run "code-memory index --full".',
  });

  checks.push(await checkNativeSqlite());
  checks.push({
    name: 'worker_threads',
    status: typeof Worker !== 'undefined' ? 'ok' : 'error',
    message: typeof Worker !== 'undefined'
      ? 'worker_threads is available for parallel parsing.'
      : 'worker_threads is unavailable in this Node.js runtime.',
  });

  let parsedConfig: DoctorConfig | null = null;
  let configuredLanguages: string[] = [];
  if (existsSync(configPath)) {
    try {
      parsedConfig = safeJsonParse<DoctorConfig>(readFileSync(configPath, 'utf-8'));
      if (!parsedConfig) throw new Error('Invalid config JSON');
      configuredLanguages = parsedConfig.languages || [];
    } catch {
      checks.push({ name: 'config-json', status: 'error', message: 'Config JSON is invalid.' });
    }
  }

  if (parsedConfig) {
    const provider = parsedConfig.embedding?.provider || 'none';
    const model = parsedConfig.embedding?.model || 'none';
    const needsOpenAiKey = provider === 'openai'
      && !parsedConfig.embedding?.apiKey
      && !parsedConfig.embedding?.baseUrl;
    checks.push({
      name: 'embedding',
      status: needsOpenAiKey ? 'warn' : 'ok',
      message: needsOpenAiKey
        ? 'Embedding provider: openai (' + model + ') but no apiKey or custom baseUrl is configured.'
        : 'Embedding provider: ' + provider + ' (' + model + ').',
    });
    checks.push({
      name: 'vector-search',
      status: provider === 'none' || needsOpenAiKey ? 'warn' : 'ok',
      message: provider === 'none'
        ? 'Vector search is disabled because embedding provider is none; hybrid search is keyword + graph only.'
        : needsOpenAiKey
          ? 'Vector search needs an OpenAI apiKey or custom baseUrl before indexing embeddings.'
        : 'Vector search is configured; run "code-memory index --full" to generate chunk embeddings.',
    });
  }

  const grammarDirs = getGrammarSearchDirs(projectPath);
  const grammarFiles = new Set(Object.values(LANGUAGE_CONFIGS).map((config) => config.wasmFile));
  for (const grammarFile of grammarFiles) {
    const found = grammarDirs.find((dir) => existsSync(join(dir, grammarFile)));
    const isTsx = grammarFile.includes('tsx');
    checks.push({
      name: 'grammar:' + grammarFile,
      status: found ? 'ok' : (isTsx ? 'warn' : 'error'),
      message: found
        ? 'Found in ' + found
        : grammarFile + ' not found in CODE_MEMORY_GRAMMARS, project grammars/, or package grammars/.' +
          (isTsx ? ' TSX parsing is disabled until this grammar is added.' : ''),
    });
  }

  if (configuredLanguages.length > 0) {
    checks.push({
      name: 'languages',
      status: 'ok',
      message: 'Configured languages: ' + configuredLanguages.join(', '),
    });
  }

  if (existsSync(dbPath)) {
    try {
      const { getDatabase, getDatabaseHealth } = await import('../../storage/database.js');
      await getDatabase(projectPath);
      const health = getDatabaseHealth();
      checks.push({
        name: 'sqlite-wal',
        status: health.walEnabled ? 'ok' : 'warn',
        message: health.walEnabled ? 'SQLite WAL mode is enabled.' : 'SQLite WAL mode is not enabled.',
      });
      checks.push({
        name: 'sqlite-fts5',
        status: health.fts5Available ? 'ok' : 'error',
        message: health.fts5Available ? 'SQLite FTS5 is available.' : 'SQLite FTS5 is unavailable.',
      });
      checks.push({
        name: 'schema',
        status: health.needsReindex ? 'warn' : 'ok',
        message: health.needsReindex
          ? `Index schema v${health.schemaVersion || 'unknown'} needs "code-memory index --full".`
          : `Index schema v${health.schemaVersion} is current.`,
      });
    } catch (err) {
      checks.push({
        name: 'sqlite-open',
        status: 'error',
        message: 'Failed to open native SQLite database: ' + (err instanceof Error ? err.message : String(err)),
      });
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ projectPath, checks }, null, 2));
    return;
  }

  console.log('Code Memory Doctor');
  console.log('');
  for (const check of checks) {
    const label = check.status.toUpperCase().padEnd(5);
    console.log(label + ' ' + check.name + ' - ' + check.message);
  }
}

async function checkNativeSqlite(): Promise<CheckResult> {
  try {
    await import('better-sqlite3');
    return {
      name: 'native-sqlite',
      status: 'ok',
      message: 'better-sqlite3 native driver can be loaded.',
    };
  } catch (err) {
    return {
      name: 'native-sqlite',
      status: 'error',
      message: 'better-sqlite3 failed to load: ' + (err instanceof Error ? err.message : String(err)),
    };
  }
}

function getGrammarSearchDirs(projectPath: string): string[] {
  const dirs: string[] = [];
  if (process.env.CODE_MEMORY_GRAMMARS) dirs.push(process.env.CODE_MEMORY_GRAMMARS);
  dirs.push(join(projectPath, 'grammars'));

  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  dirs.push(join(packageRoot, 'grammars'));
  return dirs;
}
