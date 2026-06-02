import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createVectorSearchProvider, type VectorSearchProvider } from '../search/vector-search.js';
import { CONFIG_DIR, CONFIG_FILE, VECTORS_DIR } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import type { CodeMemoryConfig } from '../shared/types.js';
import { safeJsonParse } from '../shared/utils.js';

const log = createLogger('mcp:vector-provider-router');

export type VectorSearchProviderResolver = (projectRoot: string) => Promise<VectorSearchProvider | null>;

export async function loadVectorSearchProviderForRepo(
  projectRoot: string,
): Promise<VectorSearchProvider | null> {
  const configPath = join(projectRoot, CONFIG_DIR, CONFIG_FILE);
  if (!existsSync(configPath)) return null;

  try {
    const config = safeJsonParse<CodeMemoryConfig>(readFileSync(configPath, 'utf-8'));
    if (!config || config.embedding.provider === 'none') return null;
    return await createVectorSearchProvider(
      join(projectRoot, CONFIG_DIR, VECTORS_DIR),
      config.embedding,
    );
  } catch (err) {
    log.warn(
      'Vector search provider unavailable for ' + projectRoot + ': ' +
      (err instanceof Error ? err.message : String(err)),
    );
    return null;
  }
}
