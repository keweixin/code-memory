import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingGenerator } from '../src/indexer/embedding-generator.js';
import { SummaryGenerator } from '../src/indexer/summary-generator.js';
import {
  resolveEmbeddingConfig,
  resolveLlmConfig,
} from '../src/shared/provider-config.js';

describe('provider config secret resolution', () => {
  const envKeys = [
    'CODE_MEMORY_EMBEDDING_API_KEY',
    'CODE_MEMORY_EMBEDDING_BASE_URL',
    'CODE_MEMORY_LLM_API_KEY',
    'CODE_MEMORY_LLM_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_API_BASE',
    'OLLAMA_BASE_URL',
    'OLLAMA_HOST',
  ] as const;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('prefers embedding env vars over provider-specific env vars and config fallback', () => {
    const resolved = resolveEmbeddingConfig(
      {
        provider: 'openai',
        model: 'text-embedding-3-small',
        apiKey: 'config-key',
        baseUrl: 'https://config.example',
      },
      {
        CODE_MEMORY_EMBEDDING_API_KEY: 'code-memory-key',
        CODE_MEMORY_EMBEDDING_BASE_URL: 'https://code-memory.example',
        OPENAI_API_KEY: 'openai-key',
        OPENAI_BASE_URL: 'https://openai.example',
      },
    );

    expect(resolved.config.apiKey).toBe('code-memory-key');
    expect(resolved.config.baseUrl).toBe('https://code-memory.example');
    expect(resolved.apiKeySource).toBe('env');
    expect(resolved.baseUrlSource).toBe('env');
    expect(resolved.plaintextApiKeyConfigured).toBe(true);
  });

  it('falls back to provider-specific OpenAI env vars before plaintext embedding config', () => {
    const resolved = resolveEmbeddingConfig(
      {
        provider: 'openai',
        model: 'text-embedding-3-small',
        apiKey: 'config-key',
        baseUrl: 'https://config.example',
      },
      {
        OPENAI_API_KEY: 'openai-key',
        OPENAI_API_BASE: 'https://api-base.example',
      },
    );

    expect(resolved.config.apiKey).toBe('openai-key');
    expect(resolved.config.baseUrl).toBe('https://api-base.example');
    expect(resolved.apiKeySource).toBe('env');
    expect(resolved.baseUrlSource).toBe('env');
  });

  it('keeps plaintext embedding config as the final compatibility fallback', () => {
    const resolved = resolveEmbeddingConfig(
      {
        provider: 'openai',
        model: 'text-embedding-3-small',
        apiKey: 'config-key',
        baseUrl: 'https://config.example',
      },
      {},
    );

    expect(resolved.config.apiKey).toBe('config-key');
    expect(resolved.config.baseUrl).toBe('https://config.example');
    expect(resolved.apiKeySource).toBe('config');
    expect(resolved.baseUrlSource).toBe('config');
  });

  it('prefers LLM env vars over provider-specific env vars and config fallback', () => {
    const resolved = resolveLlmConfig(
      {
        provider: 'openai-compatible',
        model: 'gpt-compatible',
        apiKey: 'config-llm-key',
        baseUrl: 'https://llm-config.example',
      },
      {
        CODE_MEMORY_LLM_API_KEY: 'code-memory-llm-key',
        CODE_MEMORY_LLM_BASE_URL: 'https://code-memory-llm.example',
        OPENAI_API_KEY: 'openai-key',
        OPENAI_BASE_URL: 'https://openai.example',
      },
    );

    expect(resolved.config?.apiKey).toBe('code-memory-llm-key');
    expect(resolved.config?.baseUrl).toBe('https://code-memory-llm.example');
    expect(resolved.apiKeySource).toBe('env');
    expect(resolved.baseUrlSource).toBe('env');
    expect(resolved.plaintextApiKeyConfigured).toBe(true);
  });

  it('uses resolved embedding secrets when calling OpenAI embeddings', async () => {
    process.env.CODE_MEMORY_EMBEDDING_API_KEY = 'env-embedding-key';
    process.env.CODE_MEMORY_EMBEDDING_BASE_URL = 'https://embedding-env.example';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ embedding: [1, 2, 3] }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const generator = new EmbeddingGenerator({
      provider: 'openai',
      model: 'text-embedding-3-small',
      apiKey: 'config-key',
      baseUrl: 'https://config.example',
    });
    const vector = await generator.generate('hello');

    expect(vector).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://embedding-env.example/v1/embeddings',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer env-embedding-key',
        }),
      }),
    );
  });

  it('uses resolved LLM secrets when calling OpenAI chat completions', async () => {
    process.env.CODE_MEMORY_LLM_API_KEY = 'env-llm-key';
    process.env.CODE_MEMORY_LLM_BASE_URL = 'https://llm-env.example';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'summarized' } }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const generator = new SummaryGenerator({
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'config-key',
      baseUrl: 'https://config.example',
    });
    const summary = await generator.summarizeCode('export const x = 1;', 'x');

    expect(summary).toBe('summarized');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://llm-env.example/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer env-llm-key',
        }),
      }),
    );
  });
});
