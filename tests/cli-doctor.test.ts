import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createCli } from '../src/cli/cli.js';
import type { CodeMemoryConfig } from '../src/shared/types.js';
import { DEFAULT_TOKEN_BUDGETS } from '../src/shared/types.js';
import { DEFAULT_IGNORE_PATTERNS } from '../src/shared/constants.js';
import { IndexManager } from '../src/indexer/index-manager.js';
import { closeDatabase, getDatabaseSync } from '../src/storage/database.js';
import { addVectors, closeVectorStore, deleteVectors } from '../src/search/vector-search.js';

const fixtureRoot = resolve('tests/fixtures/sample-ts-project');
const VECTOR_DOCTOR_TIMEOUT_MS = 20_000;

function createEmbeddingConfig(rootPath: string): CodeMemoryConfig {
  return {
    projectName: 'doctor-sample',
    rootPath,
    ignore: [...DEFAULT_IGNORE_PATTERNS],
    languages: ['typescript', 'javascript'],
    embedding: {
      provider: 'ollama',
      model: 'test-embed',
      baseUrl: 'http://embedding.local',
      dimensions: 3,
    },
    llm: null,
    realtime: {
      watch: false,
      debounceMs: 80,
    },
    tokenBudgets: { ...DEFAULT_TOKEN_BUDGETS },
  };
}

function vectorFor(text: string): number[] {
  if (text.includes('async login')) return [1, 0, 0];
  if (text.includes('issueTokens')) return [0, 1, 0];
  return [0, 0, 1];
}

describe('CLI doctor command', () => {
  let tempRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempRoot = mkdtempSync(join(tmpdir(), 'code-memory-doctor-'));
    mkdirSync(join(tempRoot, '.code-memory'), { recursive: true });
    writeFileSync(
      join(tempRoot, '.code-memory', 'config.json'),
      JSON.stringify({
        projectName: 'doctor-sample',
        languages: ['typescript', 'javascript'],
        embedding: {
          provider: 'none',
          model: 'none',
        },
      }, null, 2),
      'utf-8',
    );
    process.chdir(tempRoot);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    closeVectorStore();
    await closeDatabase();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('reports embedding and vector-search status honestly', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createCli();
    program.exitOverride();

    await program.parseAsync(['node', 'code-memory', 'doctor', '--json']);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    const result = JSON.parse(output) as {
      checks: Array<{ name: string; status: string; message: string }>;
    };

    expect(result.checks).toContainEqual({
      name: 'embedding',
      status: 'ok',
      message: 'Embedding provider: none (none).',
    });
    expect(result.checks).toContainEqual({
      name: 'vector-search',
      status: 'warn',
      message: 'Vector search is disabled because embedding provider is none; hybrid search is keyword + graph only.',
    });
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'local-storage-privacy',
      status: 'ok',
    }));
    expect(result.checks).toContainEqual({
      name: 'language-maturity',
      status: 'ok',
      message: 'typescript=stable, javascript=stable',
    });
  });

  it('skips deep vector drift checks when embeddings are disabled', async () => {
    cpSync(fixtureRoot, tempRoot, { recursive: true });
    const config = {
      projectName: 'doctor-sample',
      rootPath: tempRoot,
      ignore: [...DEFAULT_IGNORE_PATTERNS],
      languages: ['typescript', 'javascript'],
      embedding: {
        provider: 'none',
        model: 'none',
      },
      llm: null,
      realtime: {
        watch: false,
        debounceMs: 80,
      },
      tokenBudgets: { ...DEFAULT_TOKEN_BUDGETS },
    } satisfies CodeMemoryConfig;
    writeFileSync(
      join(tempRoot, '.code-memory', 'config.json'),
      JSON.stringify(config, null, 2),
      'utf-8',
    );
    await new IndexManager(tempRoot, config).fullIndex();

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createCli();
    program.exitOverride();

    await program.parseAsync(['node', 'code-memory', 'doctor', '--json', '--deep']);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    const result = JSON.parse(output) as {
      checks: Array<{ name: string; status: string; message: string }>;
    };

    expect(result.checks).toContainEqual({
      name: 'vector-drift',
      status: 'ok',
      message: 'Deep vector check skipped because embedding provider is none.',
      count: 0,
    });
  }, VECTOR_DOCTOR_TIMEOUT_MS);

  it('reports vector drift in deep mode after LanceDB rows are missing', async () => {
    cpSync(fixtureRoot, tempRoot, { recursive: true });
    const config = createEmbeddingConfig(tempRoot);
    writeFileSync(
      join(tempRoot, '.code-memory', 'config.json'),
      JSON.stringify(config, null, 2),
      'utf-8',
    );
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as { prompt?: string };
      return new Response(JSON.stringify({ embedding: vectorFor(body.prompt || '') }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    await new IndexManager(tempRoot, config).fullIndex();

    const vectorId = String(getDatabaseSync().get<{ embedding_id: string }>(
      'SELECT embedding_id FROM chunks WHERE embedding_id IS NOT NULL LIMIT 1',
    )?.embedding_id);
    expect(vectorId).toBeTruthy();
    await deleteVectors([vectorId]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createCli();
    program.exitOverride();

    await program.parseAsync(['node', 'code-memory', 'doctor', '--json', '--deep']);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    const result = JSON.parse(output) as {
      checks: Array<{ name: string; status: string; message: string; count?: number }>;
    };
    const drift = result.checks.find((check) => check.name === 'vector-drift');

    expect(drift).toEqual(expect.objectContaining({
      status: 'error',
      message: expect.stringContaining('Vector drift detected: SQLite vector refs='),
    }));
  }, VECTOR_DOCTOR_TIMEOUT_MS);

  it('reports no vector drift in deep mode when LanceDB row count matches', async () => {
    cpSync(fixtureRoot, tempRoot, { recursive: true });
    const config = createEmbeddingConfig(tempRoot);
    writeFileSync(
      join(tempRoot, '.code-memory', 'config.json'),
      JSON.stringify(config, null, 2),
      'utf-8',
    );
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as { prompt?: string };
      return new Response(JSON.stringify({ embedding: vectorFor(body.prompt || '') }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    await new IndexManager(tempRoot, config).fullIndex();

    const row = getDatabaseSync().get<{
      embedding_id: string;
      chunk_id: string;
      content_hash: string;
      file_path: string;
      symbol_name: string | null;
      symbol_kind: string | null;
    }>(`
      SELECT
        c.embedding_id,
        c.id AS chunk_id,
        c.content_hash,
        f.path AS file_path,
        s.name AS symbol_name,
        s.kind AS symbol_kind
      FROM chunks c
      JOIN files f ON f.id = c.file_id
      LEFT JOIN symbols s ON s.id = c.symbol_id
      WHERE c.embedding_id IS NOT NULL
      LIMIT 1
    `);
    expect(row?.embedding_id).toBeTruthy();
    await deleteVectors([row!.embedding_id]);
    await addVectors([{
      id: 'orphan-vector-row',
      vector: [0, 0, 1],
      name: row!.symbol_name || 'orphan',
      kind: row!.symbol_kind || 'chunk',
      filePath: row!.file_path,
      summary: 'orphan vector row',
      chunkId: row!.chunk_id,
      contentHash: row!.content_hash,
    }]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createCli();
    program.exitOverride();

    await program.parseAsync(['node', 'code-memory', 'doctor', '--json', '--deep']);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    const result = JSON.parse(output) as {
      checks: Array<{ name: string; status: string; message: string; count?: number }>;
    };
    const drift = result.checks.find((check) => check.name === 'vector-drift');

    expect(drift).toEqual(expect.objectContaining({
      status: 'ok',
      message: expect.stringContaining('row count match'),
    }));
  }, VECTOR_DOCTOR_TIMEOUT_MS);

  it('accepts config files with a UTF-8 BOM', async () => {
    writeFileSync(
      join(tempRoot, '.code-memory', 'config.json'),
      '\uFEFF\uFEFF' + JSON.stringify({
        projectName: 'doctor-sample',
        languages: ['typescript', 'javascript'],
        embedding: {
          provider: 'none',
          model: 'none',
        },
      }, null, 2),
      'utf-8',
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createCli();
    program.exitOverride();

    await program.parseAsync(['node', 'code-memory', 'doctor', '--json']);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    const result = JSON.parse(output) as {
      checks: Array<{ name: string; status: string; message: string }>;
    };

    expect(result.checks.some((check) => check.name === 'config-json')).toBe(false);
    expect(result.checks).toContainEqual({
      name: 'embedding',
      status: 'ok',
      message: 'Embedding provider: none (none).',
    });
  });

  it('reports vector search as available after configuring an embedding provider', async () => {
    writeFileSync(
      join(tempRoot, '.code-memory', 'config.json'),
      JSON.stringify({
        projectName: 'doctor-sample',
        languages: ['typescript', 'javascript'],
        embedding: {
          provider: 'ollama',
          model: 'nomic-embed-text',
        },
      }, null, 2),
      'utf-8',
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createCli();
    program.exitOverride();

    await program.parseAsync(['node', 'code-memory', 'doctor', '--json']);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    const result = JSON.parse(output) as {
      checks: Array<{ name: string; status: string; message: string }>;
    };

    expect(result.checks).toContainEqual({
      name: 'vector-search',
      status: 'ok',
      message: 'Vector search is configured; run "code-memory index --full" to generate chunk embeddings.',
    });
  });

  it('warns when OpenAI embeddings are configured without credentials', async () => {
    writeFileSync(
      join(tempRoot, '.code-memory', 'config.json'),
      JSON.stringify({
        projectName: 'doctor-sample',
        languages: ['typescript', 'javascript'],
        embedding: {
          provider: 'openai',
          model: 'text-embedding-3-small',
        },
      }, null, 2),
      'utf-8',
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createCli();
    program.exitOverride();

    await program.parseAsync(['node', 'code-memory', 'doctor', '--json']);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    const result = JSON.parse(output) as {
      checks: Array<{ name: string; status: string; message: string }>;
    };

    expect(result.checks).toContainEqual({
      name: 'embedding',
      status: 'warn',
      message: 'Embedding provider: openai (text-embedding-3-small) but no apiKey or custom baseUrl is configured.',
    });
    expect(result.checks).toContainEqual({
      name: 'vector-search',
      status: 'warn',
      message: 'Vector search needs an OpenAI apiKey or custom baseUrl before indexing embeddings.',
    });
  });

  it('warns that plaintext provider apiKeys are compatibility fallbacks', async () => {
    writeFileSync(
      join(tempRoot, '.code-memory', 'config.json'),
      JSON.stringify({
        projectName: 'doctor-sample',
        languages: ['typescript', 'javascript'],
        embedding: {
          provider: 'openai',
          model: 'text-embedding-3-small',
          apiKey: 'config-embedding-key',
        },
        llm: {
          provider: 'openai',
          model: 'gpt-4o-mini',
          apiKey: 'config-llm-key',
        },
      }, null, 2),
      'utf-8',
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createCli();
    program.exitOverride();

    await program.parseAsync(['node', 'code-memory', 'doctor', '--json']);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    const result = JSON.parse(output) as {
      checks: Array<{ name: string; status: string; message: string }>;
    };

    expect(result.checks).toContainEqual({
      name: 'embedding-config-api-key',
      status: 'warn',
      message: 'Plaintext embedding apiKey in config is supported only as a compatibility fallback. Prefer CODE_MEMORY_EMBEDDING_API_KEY or OPENAI_API_KEY.',
    });
    expect(result.checks).toContainEqual({
      name: 'llm-config-api-key',
      status: 'warn',
      message: 'Plaintext LLM apiKey in config is supported only as a compatibility fallback. Prefer CODE_MEMORY_LLM_API_KEY or OPENAI_API_KEY.',
    });
  });

  it('reports provider secrets as available from environment variables', async () => {
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'env-openai-key';
    try {
      writeFileSync(
        join(tempRoot, '.code-memory', 'config.json'),
        JSON.stringify({
          projectName: 'doctor-sample',
          languages: ['typescript', 'javascript'],
          embedding: {
            provider: 'openai',
            model: 'text-embedding-3-small',
          },
        }, null, 2),
        'utf-8',
      );
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const program = createCli();
      program.exitOverride();

      await program.parseAsync(['node', 'code-memory', 'doctor', '--json']);

      const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      const result = JSON.parse(output) as {
        checks: Array<{ name: string; status: string; message: string }>;
      };

      expect(result.checks).toContainEqual({
        name: 'embedding-secret',
        status: 'ok',
        message: 'Embedding API key is available from environment variables.',
      });
    } finally {
      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
    }
  });
});
