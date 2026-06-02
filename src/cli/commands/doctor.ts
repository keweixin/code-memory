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

const log = createLogger('doctor');

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
    .action(async (options) => {
      try {
        if (options.perf) {
          await runPerfDiagnostics();
          return;
        }
        await runDoctor(Boolean(options.json), Boolean(options.fix), Boolean(options.deep));
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

async function runDoctor(asJson: boolean, fix = false, deep = false): Promise<void> {
  const projectPath = process.cwd();
  const checks: CheckResult[] = [];
  const configPath = join(projectPath, CONFIG_DIR, CONFIG_FILE);
  const dbPath = join(projectPath, CONFIG_DIR, DATABASE_FILE);
  const fixes: string[] = [];

  if (fix && !existsSync(configPath)) {
    const { initProject } = await import('./init.js');
    await initProject({});
    fixes.push('Created default .code-memory/config.json with embedding provider none.');
  }

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
  checks.push({
    name: 'local-storage-privacy',
    status: 'ok',
    message: '.code-memory stores local snippets, metadata, call evidence, memories, ledger history, and optional vectors. Keep it out of git and backups that should not contain code snippets.',
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
          ? `Index schema v${health.schemaVersion || 'unknown'} needs "code-memory index --full".`
          : `Index schema v${health.schemaVersion} is current.`,
      });
      try {
        const { getDatabaseSync } = await import('../../storage/database.js');
        checks.push(...collectInvariants(getDatabaseSync()));
        if (deep) {
          const vectorChecks = await collectDeepVectorChecks(projectPath, getDatabaseSync(), parsedConfig, fix);
          checks.push(...vectorChecks.checks);
          fixes.push(...vectorChecks.fixes);
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
    console.log(JSON.stringify({ projectPath, checks, fixes }, null, 2));
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
  }
}

async function runPerfDiagnostics(): Promise<void> {
  const projectPath = process.cwd();
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
    console.log('Database: not found (run "code-memory index --full" first)');
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
  const sqliteVectorIds = getStringColumn(db, 'SELECT embedding_id AS value FROM chunks WHERE embedding_id IS NOT NULL');
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
        : 'Embedding provider is none but SQLite still has vector refs; run "code-memory index --full --embedding none" to clear stale vector refs.',
    });
    return { checks, fixes };
  }

  const { getVectorStoreStats } = await import('../../search/vector-search.js');
  const stats = await getVectorStoreStats(join(projectPath, CONFIG_DIR, VECTORS_DIR), expectedDimensions);
  const vectorIdDrift = compareStringSets(sqliteVectorIds, stats.ids);
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

  const drift = !stats.available ||
    stats.rowCount !== sqliteVectorRefs ||
    vectorIdDrift.missing.length > 0 ||
    vectorIdDrift.orphaned.length > 0;
  checks.push({
    name: 'vector-drift',
    status: drift ? 'error' : 'ok',
    count: stats.rowCount,
    message: drift
      ? `Vector drift detected: SQLite vector refs=${sqliteVectorRefs}, LanceDB rows=${stats.rowCount}, missing=${vectorIdDrift.missing.length}, orphaned=${vectorIdDrift.orphaned.length}.`
      : `SQLite vector refs and LanceDB rows/ids match (${stats.rowCount}).`,
  });
  if (drift && fix) {
    fixes.push('Vector drift detected. Run "code-memory index --full" with the configured embedding provider to rebuild LanceDB from SQLite chunks.');
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

function getStringColumn(db: SqlJsDatabase, sql: string): string[] {
  return db.all<{ value: string | null }>(sql)
    .map((row) => row.value)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function compareStringSets(expected: string[], actual: string[]): { missing: string[]; orphaned: string[] } {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    missing: expected.filter((id) => !actualSet.has(id)),
    orphaned: actual.filter((id) => !expectedSet.has(id)),
  };
}
