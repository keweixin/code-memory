import type { EmbeddingConfig, LlmConfig } from './types.js';

export type ProviderConfigKind = 'embedding' | 'llm';
export type ProviderSecretSource = 'env' | 'config' | 'none';

export interface ProviderConfigResolution<TConfig> {
  config: TConfig;
  apiKeySource: ProviderSecretSource;
  baseUrlSource: ProviderSecretSource;
  plaintextApiKeyConfigured: boolean;
}

type Env = NodeJS.ProcessEnv;

export function resolveEmbeddingConfig(
  config: EmbeddingConfig,
  env: Env = process.env,
): ProviderConfigResolution<EmbeddingConfig> {
  if (config.provider === 'none') {
    return {
      config,
      apiKeySource: 'none',
      baseUrlSource: config.baseUrl ? 'config' : 'none',
      plaintextApiKeyConfigured: Boolean(config.apiKey),
    };
  }

  const apiKey = firstNonEmpty([
    env.CODE_MEMORY_EMBEDDING_API_KEY,
    providerApiKey(config.provider, env),
    config.apiKey,
  ]);
  const baseUrl = firstNonEmpty([
    env.CODE_MEMORY_EMBEDDING_BASE_URL,
    providerBaseUrl(config.provider, env),
    config.baseUrl,
  ]);

  return {
    config: {
      ...config,
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    },
    apiKeySource: sourceOf(apiKey, [
      env.CODE_MEMORY_EMBEDDING_API_KEY,
      providerApiKey(config.provider, env),
      config.apiKey,
    ]),
    baseUrlSource: sourceOf(baseUrl, [
      env.CODE_MEMORY_EMBEDDING_BASE_URL,
      providerBaseUrl(config.provider, env),
      config.baseUrl,
    ]),
    plaintextApiKeyConfigured: Boolean(config.apiKey),
  };
}

export function resolveLlmConfig(
  config: LlmConfig | null,
  env: Env = process.env,
): ProviderConfigResolution<LlmConfig | null> {
  if (!config) {
    return {
      config: null,
      apiKeySource: 'none',
      baseUrlSource: 'none',
      plaintextApiKeyConfigured: false,
    };
  }

  const apiKey = firstNonEmpty([
    env.CODE_MEMORY_LLM_API_KEY,
    providerApiKey(config.provider, env),
    config.apiKey,
  ]);
  const baseUrl = firstNonEmpty([
    env.CODE_MEMORY_LLM_BASE_URL,
    providerBaseUrl(config.provider, env),
    config.baseUrl,
  ]);

  return {
    config: {
      ...config,
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    },
    apiKeySource: sourceOf(apiKey, [
      env.CODE_MEMORY_LLM_API_KEY,
      providerApiKey(config.provider, env),
      config.apiKey,
    ]),
    baseUrlSource: sourceOf(baseUrl, [
      env.CODE_MEMORY_LLM_BASE_URL,
      providerBaseUrl(config.provider, env),
      config.baseUrl,
    ]),
    plaintextApiKeyConfigured: Boolean(config.apiKey),
  };
}

function providerApiKey(provider: string, env: Env): string | undefined {
  if (provider === 'openai' || provider === 'openai-compatible') {
    return env.OPENAI_API_KEY;
  }
  return undefined;
}

function providerBaseUrl(provider: string, env: Env): string | undefined {
  if (provider === 'openai' || provider === 'openai-compatible') {
    return firstNonEmpty([env.OPENAI_BASE_URL, env.OPENAI_API_BASE]);
  }
  if (provider === 'ollama') {
    return firstNonEmpty([env.OLLAMA_BASE_URL, env.OLLAMA_HOST]);
  }
  return undefined;
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0);
}

function sourceOf(value: string | undefined, orderedValues: Array<string | undefined>): ProviderSecretSource {
  if (!value) return 'none';
  const index = orderedValues.findIndex((candidate) => candidate === value);
  return index >= 0 && index < orderedValues.length - 1 ? 'env' : 'config';
}
