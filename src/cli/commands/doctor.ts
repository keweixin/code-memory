/**
 * code-memory doctor — Check local configuration, index, and parser grammars.
 */

import type { Command } from 'commander';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  CONFIG_DIR,
  CONFIG_FILE,
  DATABASE_FILE,
  DEFAULT_EMBEDDING_DIMENSIONS,
  OPENAI_EMBEDDING_DIMENSIONS,
  VECTORS_DIR,
} from '../../shared/constants.js';
import { LANGUAGE_CONFIGS, PARSER_LANGUAGE_TO_LANGUAGE } from '../../parser/types.js';
import { createLogger } from '../../shared/logger.js';
import { safeJsonParse } from '../../shared/utils.js';
import { collectInvariants } from '../../storage/invariants.js';
import type { SqlJsDatabase } from '../../storage/database.js';
import { resolveEmbeddingConfig, resolveLlmConfig } from '../../shared/provider-config.js';
import { resolveProjectPath } from '../project-path.js';
import { readRegistry } from '../registry.js';
import { getIndexStaleness } from '../../indexer/staleness.js';
import { readWatchState } from '../../indexer/watch-state.js';

const log = createLogger('doctor');
const PROJECT_CONTEXT_MARKER = '<!-- CODE_MEMORY_CONTEXT_START -->';
const EXPECTED_CODE_MEMORY_SKILLS = [
  'code-memory-exploring.md',
  'code-memory-debugging.md',
  'code-memory-impact-analysis.md',
  'code-memory-refactoring.md',
];

const LANGUAGE_MATURITY: Record<string, string> = {
  typescript: 'stable',
  javascript: 'stable',
  python: 'beta/partial resolver precision',
  go: 'beta/partial resolver precision',
};

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check code-memory configuration, index, and parser grammars')
    .option('--json', 'Output as JSON')
    .option('--fix', 'Create a missing default config and report follow-up actions')
    .option('--deep', 'Run slower SQLite/LanceDB consistency checks')
    .option('--perf', 'Show performance diagnostics')
    .option('--project <path>', 'Project root path (default: cwd or CODE_MEMORY_PROJECT env)')
    .action(async (options) => {
      try {
        const projectPath = resolveProjectPath(options);
        if (options.perf) {
          await runPerfDiagnostics(projectPath);
          return;
        }
        await runDoctor(Boolean(options.json), Boolean(options.fix), Boolean(options.deep), projectPath);
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
  count?: number;
  suggestion?: string;
}

interface DoctorConfig {
  languages?: string[];
  embedding?: {
    provider?: string;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    dimensions?: number;
  };
  llm?: {
    provider?: string;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
  } | null;
}

export async function runDoctor(asJson: boolean, fix = false, deep = false, projectPath = process.cwd()): Promise<void> {
  const checks: CheckResult[] = [];
  const configPath = join(projectPath, CONFIG_DIR, CONFIG_FILE);
  const dbPath = join(projectPath, CONFIG_DIR, DATABASE_FILE);
  const fixes: string[] = [];

  if (fix && !existsSync(configPath)) {
    const { initProject } = await import('./init.js');
    await initProject({ project: projectPath });
    fixes.push('Created default .code-memory/config.json with embedding provider none.');
  }

  checks.push({
    name: 'config',
    status: existsSync(configPath) ? 'ok' : 'error',
    message: existsSync(configPath)
      ? 'Found ' + configPath
      : 'Missing config. Run "code-memory setup --project ." for full AI onboarding.',
  });

  checks.push({
    name: 'index',
    status: existsSync(dbPath) ? 'ok' : 'warn',
    message: existsSync(dbPath)
      ? 'Found ' + dbPath
      : 'No index found. Run "code-memory bootstrap --project .".',
  });

  checks.push(await checkNativeSqlite());
  checks.push({
    name: 'worker_threads',
    status: typeof Worker !== 'undefined' ? 'ok' : 'error',
    message: typeof Worker !== 'undefined'
      ? 'worker_threads is available for parallel parsing.'
      : 'worker_threads is unavailable in this Node.js runtime.',
  });
  checks.push({
    name: 'local-storage-privacy',
    status: 'ok',
    message: '.code-memory stores local snippets, metadata, call evidence, memories, ledger history, and optional vectors. Keep it out of git and backups that should not contain code snippets.',
  });
  checks.push(...collectOnboardingChecks(projectPath));

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
    const embeddingConfig = {
      provider: parsedConfig.embedding?.provider === 'ollama' || parsedConfig.embedding?.provider === 'openai'
        ? parsedConfig.embedding.provider
        : 'none',
      model: parsedConfig.embedding?.model || 'none',
      baseUrl: parsedConfig.embedding?.baseUrl,
      apiKey: parsedConfig.embedding?.apiKey,
      dimensions: parsedConfig.embedding?.dimensions,
    } as const;
    const embeddingResolution = resolveEmbeddingConfig(embeddingConfig);
    const provider = embeddingResolution.config.provider;
    const model = embeddingResolution.config.model || 'none';
    const needsOpenAiKey = provider === 'openai'
      && !embeddingResolution.config.apiKey
      && !embeddingResolution.config.baseUrl;
    checks.push({
      name: 'embedding',
      status: needsOpenAiKey ? 'warn' : 'ok',
      message: needsOpenAiKey
        ? 'Embedding provider: openai (' + model + ') but no apiKey or custom baseUrl is configured.'
        : 'Embedding provider: ' + provider + ' (' + model + ').',
    });
    if (provider === 'openai') {
      checks.push({
        name: 'embedding-secret',
        status: needsOpenAiKey || embeddingResolution.apiKeySource === 'config' ? 'warn' : 'ok',
        message: formatSecretMessage(
          'Embedding',
          embeddingResolution.apiKeySource,
          embeddingResolution.baseUrlSource,
        ),
      });
    }
    if (embeddingResolution.plaintextApiKeyConfigured) {
      checks.push({
        name: 'embedding-config-api-key',
        status: 'warn',
        message: 'Plaintext embedding apiKey in config is supported only as a compatibility fallback. Prefer CODE_MEMORY_EMBEDDING_API_KEY or OPENAI_API_KEY.',
      });
    }

    const llmResolution = resolveLlmConfig(
      parsedConfig.llm && parsedConfig.llm.provider && parsedConfig.llm.model
        ? {
            provider: parsedConfig.llm.provider === 'openai' || parsedConfig.llm.provider === 'openai-compatible'
              ? parsedConfig.llm.provider
              : 'ollama',
            model: parsedConfig.llm.model,
            baseUrl: parsedConfig.llm.baseUrl,
            apiKey: parsedConfig.llm.apiKey,
          }
        : null,
    );
    if (llmResolution.config && llmResolution.config.provider !== 'ollama') {
      checks.push({
        name: 'llm-secret',
        status: llmResolution.apiKeySource === 'none' || llmResolution.apiKeySource === 'config' ? 'warn' : 'ok',
        message: formatSecretMessage(
          'LLM',
          llmResolution.apiKeySource,
          llmResolution.baseUrlSource,
        ),
      });
    }
    if (llmResolution.plaintextApiKeyConfigured) {
      checks.push({
        name: 'llm-config-api-key',
        status: 'warn',
        message: 'Plaintext LLM apiKey in config is supported only as a compatibility fallback. Prefer CODE_MEMORY_LLM_API_KEY or OPENAI_API_KEY.',
      });
    }
    checks.push({
      name: 'vector-search',
      status: provider === 'none' || needsOpenAiKey ? 'warn' : 'ok',
      message: provider === 'none'
        ? 'Vector search is disabled because embedding provider is none; hybrid search is keyword + graph only.'
        : needsOpenAiKey
          ? 'Vector search needs an OpenAI apiKey or custom baseUrl before indexing embeddings.'
        : 'Vector search is configured; run "code-memory bootstrap --project ." to generate chunk embeddings.',
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
    const parserSupportedLanguages = new Set<string>(Object.values(PARSER_LANGUAGE_TO_LANGUAGE));
    const unsupportedLanguages = configuredLanguages.filter((language) => !parserSupportedLanguages.has(language));
    checks.push({
      name: 'languages',
      status: unsupportedLanguages.length > 0 ? 'warn' : 'ok',
      message: unsupportedLanguages.length > 0
        ? 'Configured languages include parser-unsupported values: ' + unsupportedLanguages.join(', ') + '. Supported parser languages: ' + [...parserSupportedLanguages].join(', ') + '.'
        : 'Configured languages: ' + configuredLanguages.join(', '),
    });
    checks.push({
      name: 'language-maturity',
      status: configuredLanguages.some((language) => LANGUAGE_MATURITY[language]?.startsWith('beta')) ? 'warn' : 'ok',
      message: configuredLanguages
        .map((language) => language + '=' + (LANGUAGE_MATURITY[language] || 'unsupported'))
        .join(', '),
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
          ? `Index schema v${health.schemaVersion || 'unknown'} needs "code-memory bootstrap --project .".`
          : `Index schema v${health.schemaVersion} is current.`,
      });
      try {
        const { getDatabaseSync } = await import('../../storage/database.js');
        checks.push(...collectInvariants(getDatabaseSync()));
        if (deep) {
          const vectorChecks = await collectDeepVectorChecks(projectPath, getDatabaseSync(), parsedConfig, fix);
          checks.push(...vectorChecks.checks);
          fixes.push(...vectorChecks.fixes);
          const perfChecks = collectDeepPerformanceChecks(getDatabaseSync());
          checks.push(...perfChecks);
        }
      } catch (err) {
        checks.push({
          name: 'index-invariants',
          status: 'warn',
          message: 'Could not inspect index invariants: ' + (err instanceof Error ? err.message : String(err)),
        });
      }
    } catch (err) {
      checks.push({
        name: 'sqlite-open',
        status: 'error',
        message: 'Failed to open native SQLite database: ' + (err instanceof Error ? err.message : String(err)),
      });
    }
  }

  if (asJson) {
    console.log(JSON.stringify({
      projectPath,
      checks,
      fixes,
      ...buildDoctorSummary(projectPath, checks, dbPath),
    }, null, 2));
    return;
  }

  console.log('Code Memory Doctor');
  console.log('');
  for (const fixMessage of fixes) {
    console.log('FIX   ' + fixMessage);
  }
  for (const check of checks) {
    const label = check.status.toUpperCase().padEnd(5);
    console.log(label + ' ' + check.name + ' - ' + check.message);
    if (check.suggestion) {
      console.log('      Suggestion: ' + check.suggestion);
    }
  }
}

function buildDoctorSummary(projectPath: string, checks: CheckResult[], dbPath: string): Record<string, unknown> {
  const byName = new Map(checks.map((check) => [check.name, check]));
  const configPath = join(projectPath, CONFIG_DIR, CONFIG_FILE);
  const registry = readRegistry();
  const registered = registry.repos.find((repo) => resolve(repo.rootPath) === resolve(projectPath)) || null;
  const watchState = readWatchState(projectPath);
  let staleness: unknown = null;
  try {
    staleness = getIndexStaleness(projectPath);
  } catch {
    staleness = null;
  }

  return {
    config: {
      exists: existsSync(configPath),
      path: configPath,
      status: byName.get('config')?.status ?? 'error',
    },
    index: {
      exists: existsSync(dbPath),
      path: dbPath,
      status: byName.get('index')?.status ?? 'warn',
    },
    schema: {
      status: byName.get('schema')?.status ?? 'warn',
      message: byName.get('schema')?.message ?? 'Schema unavailable until an index can be opened.',
    },
    registry: {
      registered: Boolean(registered),
      name: registered?.name ?? null,
      rootPath: registered?.rootPath ?? null,
      repoCount: registry.repos.length,
    },
    watcher: {
      active: Boolean(watchState?.active),
      pid: watchState?.pid ?? null,
      startedAt: watchState?.startedAt ?? null,
      lastSyncAt: watchState?.lastSyncAt ?? null,
      pendingFiles: watchState?.pendingFiles ?? [],
      syncing: watchState?.syncing ?? false,
      lastError: watchState?.lastError ?? null,
    },
    staleness,
    agentConfig: {
      context: byName.get('setup-context') ?? null,
      skills: byName.get('setup-skills') ?? null,
      hookScript: byName.get('setup-hook-script') ?? null,
      hookSettings: byName.get('setup-hook-settings') ?? null,
    },
    repairCommands: buildRepairCommands(projectPath, byName, registered, watchState),
  };
}

function buildRepairCommands(
  projectPath: string,
  checks: Map<string, CheckResult>,
  registered: unknown,
  watchState: ReturnType<typeof readWatchState>,
): string[] {
  const commands: string[] = [];
  if (checks.get('config')?.status === 'error') {
    commands.push('code-memory init --project ' + JSON.stringify(projectPath));
  }
  if (checks.get('index')?.status !== 'ok') {
    commands.push('code-memory bootstrap --project ' + JSON.stringify(projectPath));
  }
  if (!registered) {
    commands.push('code-memory register --project ' + JSON.stringify(projectPath));
  }
  if (watchState?.lastError) {
    commands.push('code-memory sync --project ' + JSON.stringify(projectPath));
  }
  commands.push('code-memory setup --project ' + JSON.stringify(projectPath));
  return [...new Set(commands)];
}

function collectOnboardingChecks(projectPath: string): CheckResult[] {
  const contextFiles = ['AGENTS.md', 'CLAUDE.md'];
  const contextReady = contextFiles.filter((fileName) => {
    const filePath = join(projectPath, fileName);
    return existsSync(filePath) && readFileSync(filePath, 'utf-8').includes(PROJECT_CONTEXT_MARKER);
  });
  const skillRoot = join(projectPath, '.claude', 'skills', 'code-memory');
  const installedSkills = EXPECTED_CODE_MEMORY_SKILLS.filter((fileName) => existsSync(join(skillRoot, fileName)));
  const hookPath = join(projectPath, '.claude', 'hooks', 'code-memory-pretooluse.mjs');
  const settingsPath = join(projectPath, '.claude', 'settings.json');

  return [
    {
      name: 'setup-context',
      status: contextReady.length === contextFiles.length ? 'ok' : 'warn',
      count: contextReady.length,
      message: contextReady.length === contextFiles.length
        ? 'AI project context is installed in AGENTS.md and CLAUDE.md.'
        : 'AI project context is incomplete. Run "code-memory setup --project .".',
    },
    {
      name: 'setup-skills',
      status: installedSkills.length === EXPECTED_CODE_MEMORY_SKILLS.length ? 'ok' : 'warn',
      count: installedSkills.length,
      message: installedSkills.length === EXPECTED_CODE_MEMORY_SKILLS.length
        ? 'Claude Code skills for Code Memory are installed.'
        : 'Claude Code skills are incomplete. Run "code-memory setup --project ." or disable with --no-skills.',
    },
    {
      name: 'setup-hook-script',
      status: existsSync(hookPath) ? 'ok' : 'warn',
      message: existsSync(hookPath)
        ? 'Claude Code PreToolUse hook script is installed.'
        : 'Claude Code PreToolUse hook script is missing. Run "code-memory setup --project ." or disable with --no-hooks.',
    },
    {
      name: 'setup-hook-settings',
      status: hasCodeMemoryHookSettings(settingsPath) ? 'ok' : 'warn',
      message: hasCodeMemoryHookSettings(settingsPath)
        ? 'Claude Code PreToolUse hook is registered in .claude/settings.json.'
        : 'Claude Code PreToolUse hook is not registered. Run "code-memory setup --project ." or disable with --no-hooks.',
    },
  ];
}

function hasCodeMemoryHookSettings(settingsPath: string): boolean {
  if (!existsSync(settingsPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.hooks) || !Array.isArray(parsed.hooks.PreToolUse)) {
      return false;
    }
    return parsed.hooks.PreToolUse.some((entry) => isCodeMemoryHookEntry(entry));
  } catch {
    return false;
  }
}

function isCodeMemoryHookEntry(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return false;
  return value.hooks.some((hook) => isRecord(hook) &&
    String(hook.command || '') === 'node' &&
    Array.isArray(hook.args) &&
    hook.args.some((arg) => String(arg).includes('code-memory-pretooluse.mjs')));
}

async function runPerfDiagnostics(projectPath: string): Promise<void> {
  const dbPath = join(projectPath, CONFIG_DIR, DATABASE_FILE);

  console.log('=== Performance Diagnostics ===');
  console.log('');

  // Database file size
  if (existsSync(dbPath)) {
    try {
      const dbSize = statSync(dbPath).size;
      console.log(`Database size: ${(dbSize / 1024 / 1024).toFixed(1)}MB`);
      console.log(`Database path: ${dbPath}`);
    } catch {
      console.log('Database size: (unable to stat)');
    }

    try {
      const { getDatabase, getDatabaseSync } = await import('../../storage/database.js');
      const { SCHEMA_VERSION } = await import('../../storage/schema.js');
      await getDatabase(projectPath);
      const db = getDatabaseSync();

      const fileCount = getCount(db, 'SELECT COUNT(*) AS count FROM files');
      const symbolCount = getCount(db, 'SELECT COUNT(*) AS count FROM symbols');
      const edgeCount = getCount(db, 'SELECT COUNT(*) AS count FROM edges');
      const chunkCount = getCount(db, 'SELECT COUNT(*) AS count FROM chunks');
      const memoryCount = getCount(db, 'SELECT COUNT(*) AS count FROM memories');

      console.log(`Files: ${fileCount}`);
      console.log(`Symbols: ${symbolCount}`);
      console.log(`Edges: ${edgeCount}`);
      console.log(`Chunks: ${chunkCount}`);
      console.log(`Memories: ${memoryCount}`);
      console.log(`Index version: ${SCHEMA_VERSION}`);

      // WAL mode check
      const walResult = db.exec('PRAGMA journal_mode');
      const walMode = String(walResult[0]?.values[0]?.[0] ?? '');
      console.log(`WAL mode: ${walMode}`);

      // Page info
      const pageSize = getCount(db, 'PRAGMA page_size');
      const pageCount = getCount(db, 'PRAGMA page_count');
      const freelistCount = getCount(db, 'PRAGMA freelist_count');
      console.log(`Page size: ${pageSize} bytes`);
      console.log(`Page count: ${pageCount}`);
      console.log(`Freelist pages: ${freelistCount}`);
      console.log(`Fragmentation: ${pageCount > 0 ? ((freelistCount / pageCount) * 100).toFixed(1) : 0}%`);

      // FTS5 stats
      try {
        const ftsSymbolCount = getCount(db, 'SELECT COUNT(*) AS count FROM symbols_fts');
        const ftsFileCount = getCount(db, 'SELECT COUNT(*) AS count FROM files_fts');
        console.log(`FTS5 symbol entries: ${ftsSymbolCount}`);
        console.log(`FTS5 file entries: ${ftsFileCount}`);
      } catch {
        console.log('FTS5: (not available)');
      }

      // Vector stats
      try {
        const vectorRefCount = getCount(db, 'SELECT COUNT(*) AS count FROM chunks WHERE embedding_id IS NOT NULL');
        console.log(`Vector refs: ${vectorRefCount}`);
      } catch {
        console.log('Vector refs: (not available)');
      }
    } catch (err) {
      console.log('Database query error: ' + (err instanceof Error ? err.message : String(err)));
    }
  } else {
    console.log('Database: not found (run "code-memory bootstrap --project ." first)');
  }

  // Vectors directory size
  const vectorsPath = join(projectPath, CONFIG_DIR, VECTORS_DIR);
  if (existsSync(vectorsPath)) {
    try {
      const { readdirSync, statSync: stat } = await import('node:fs');
      let totalSize = 0;
      let fileCount = 0;
      for (const entry of readdirSync(vectorsPath, { recursive: true })) {
        const fullPath = join(vectorsPath, String(entry));
        try {
          const s = stat(fullPath);
          if (s.isFile()) {
            totalSize += s.size;
            fileCount++;
          }
        } catch { /* skip */ }
      }
      console.log(`Vectors size: ${(totalSize / 1024 / 1024).toFixed(1)}MB (${fileCount} files)`);
    } catch {
      console.log('Vectors size: (unable to calculate)');
    }
  } else {
    console.log('Vectors: not found');
  }
}

function formatSecretMessage(
  label: string,
  apiKeySource: 'env' | 'config' | 'none',
  baseUrlSource: 'env' | 'config' | 'none',
): string {
  if (apiKeySource === 'env') {
    return label + ' API key is available from environment variables.';
  }
  if (apiKeySource === 'config') {
    return label + ' API key is read from plaintext config as a compatibility fallback; prefer environment variables.';
  }
  if (baseUrlSource === 'env') {
    return label + ' custom baseUrl is available from environment variables.';
  }
  if (baseUrlSource === 'config') {
    return label + ' custom baseUrl is read from config.';
  }
  return label + ' API key is not configured in environment variables or config.';
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

async function collectDeepVectorChecks(
  projectPath: string,
  db: SqlJsDatabase,
  config: DoctorConfig | null,
  fix: boolean,
): Promise<{ checks: CheckResult[]; fixes: string[] }> {
  const checks: CheckResult[] = [];
  const fixes: string[] = [];
  const provider = config?.embedding?.provider || 'none';
  const expectedDimensions = getConfiguredEmbeddingDimensions(config);
  const sqliteChunks = getCount(db, 'SELECT COUNT(*) AS count FROM chunks');
  const sqliteVectorRefs = getCount(db, 'SELECT COUNT(*) AS count FROM chunks WHERE embedding_id IS NOT NULL');
  const brokenVectorRefs = getCount(db, `
    SELECT COUNT(*) AS count
    FROM chunks c
    LEFT JOIN files f ON f.id = c.file_id
    LEFT JOIN symbols s ON s.id = c.symbol_id
    WHERE c.embedding_id IS NOT NULL
      AND (
        f.id IS NULL
        OR (c.symbol_id IS NOT NULL AND s.id IS NULL)
      )
  `);

  checks.push({
    name: 'vector-sqlite-refs',
    status: brokenVectorRefs === 0 ? 'ok' : 'error',
    count: sqliteVectorRefs,
    message: brokenVectorRefs === 0
      ? `SQLite has ${sqliteChunks} chunks and ${sqliteVectorRefs} vector refs.`
      : `SQLite has ${brokenVectorRefs} vector refs that do not join to chunks/files/symbols.`,
  });

  if (provider === 'none') {
    checks.push({
      name: 'vector-drift',
      status: sqliteVectorRefs === 0 ? 'ok' : 'warn',
      count: sqliteVectorRefs,
      message: sqliteVectorRefs === 0
        ? 'Deep vector check skipped because embedding provider is none.'
        : 'Embedding provider is none but SQLite still has vector refs; run "code-memory bootstrap --project . --embedding none" to clear stale vector refs.',
    });
    return { checks, fixes };
  }

  const { getVectorStoreStats } = await import('../../search/vector-search.js');
  const stats = await getVectorStoreStats(join(projectPath, CONFIG_DIR, VECTORS_DIR), expectedDimensions);
  checks.push({
    name: 'vector-dimensions',
    status: !stats.available || stats.dimensions === null || stats.dimensions === expectedDimensions ? 'ok' : 'error',
    count: stats.dimensions ?? undefined,
    message: !stats.available
      ? `Vector table ${stats.tableName} is unavailable: ${stats.error || 'not found'}.`
      : stats.dimensions === null
        ? `Vector table ${stats.tableName} has no rows to inspect dimensions.`
        : stats.dimensions === expectedDimensions
          ? `Vector table ${stats.tableName} dimensions match config (${expectedDimensions}).`
          : `Vector table ${stats.tableName} dimensions ${stats.dimensions} do not match config ${expectedDimensions}.`,
  });

  const drift = !stats.available || stats.rowCount !== sqliteVectorRefs;
  checks.push({
    name: 'vector-drift',
    status: drift ? 'error' : 'ok',
    count: stats.rowCount,
    message: drift
      ? `Vector drift detected: SQLite vector refs=${sqliteVectorRefs}, LanceDB rows=${stats.rowCount}.`
      : `SQLite vector refs and LanceDB row count match (${stats.rowCount}).`,
  });
  if (drift && fix) {
    fixes.push('Vector drift detected. Run "code-memory bootstrap --project ." with the configured embedding provider to rebuild LanceDB from SQLite chunks.');
  }

  return { checks, fixes };
}

function getConfiguredEmbeddingDimensions(config: DoctorConfig | null): number {
  if (config?.embedding?.dimensions && config.embedding.dimensions > 0) {
    return config.embedding.dimensions;
  }
  return config?.embedding?.provider === 'openai'
    ? OPENAI_EMBEDDING_DIMENSIONS
    : DEFAULT_EMBEDDING_DIMENSIONS;
}

function getCount(db: SqlJsDatabase, sql: string): number {
  const row = db.get<{ count: number | bigint }>(sql);
  return Number(row?.count ?? 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function collectDeepPerformanceChecks(db: SqlJsDatabase): CheckResult[] {
  const checks: CheckResult[] = [];

  // 1. Index duration check
  try {
    const durationRow = db.get<{ value: string } | null>(
      "SELECT value FROM index_metadata WHERE key = 'last_index_duration_ms'",
    );
    if (durationRow?.value) {
      const durationMs = Number(durationRow.value);
      if (durationMs > 120000) {
        checks.push({
          name: 'perf-index-duration',
          status: 'warn',
          message: `Last index took ${(durationMs / 1000).toFixed(1)}s, which exceeds the 2-minute threshold for small projects.`,
          suggestion: 'Consider reducing indexed languages, excluding large generated directories, or increasing parse workers in config.',
        });
      } else {
        checks.push({
          name: 'perf-index-duration',
          status: 'ok',
          message: `Last index took ${(durationMs / 1000).toFixed(1)}s.`,
        });
      }
    }
  } catch { /* metadata not available */ }

  // 2. Unresolved calls ratio
  try {
    const totalCalls = getCount(db, 'SELECT COUNT(*) AS count FROM call_refs');
    if (totalCalls > 0) {
      const unresolvedCalls = getCount(db, "SELECT COUNT(*) AS count FROM call_refs WHERE resolution_status != 'resolved'");
      const ratio = unresolvedCalls / totalCalls;
      if (ratio > 0.3) {
        checks.push({
          name: 'perf-unresolved-calls',
          status: 'warn',
          count: unresolvedCalls,
          message: `Unresolved calls ratio is ${(ratio * 100).toFixed(1)}% (${unresolvedCalls}/${totalCalls}), exceeding 30% threshold.`,
          suggestion: 'Review import resolution: ensure module paths are correct and re-export chains are resolvable. Run "code-memory bootstrap --project ." to re-resolve.',
        });
      } else {
        checks.push({
          name: 'perf-unresolved-calls',
          status: 'ok',
          count: unresolvedCalls,
          message: `Unresolved calls ratio is ${(ratio * 100).toFixed(1)}% (${unresolvedCalls}/${totalCalls}).`,
        });
      }
    }
  } catch { /* call_refs not available */ }

  // 3. Edge evidence coverage
  try {
    const totalEdges = getCount(db, 'SELECT COUNT(*) AS count FROM edges');
    if (totalEdges > 0) {
      const edgesWithEvidence = getCount(db, 'SELECT COUNT(*) AS count FROM graph_edge_evidence');
      const coverage = edgesWithEvidence / totalEdges;
      if (coverage < 0.95) {
        checks.push({
          name: 'perf-edge-evidence',
          status: 'warn',
          count: edgesWithEvidence,
          message: `Edge evidence coverage is ${(coverage * 100).toFixed(1)}% (${edgesWithEvidence}/${totalEdges}), below 95% threshold.`,
          suggestion: 'Missing evidence may indicate orphaned edges from a partial reindex. Run "code-memory bootstrap --project ." to rebuild all edge evidence.',
        });
      } else {
        checks.push({
          name: 'perf-edge-evidence',
          status: 'ok',
          count: edgesWithEvidence,
          message: `Edge evidence coverage is ${(coverage * 100).toFixed(1)}% (${edgesWithEvidence}/${totalEdges}).`,
        });
      }
    }
  } catch { /* tables not available */ }

  return checks;
}
