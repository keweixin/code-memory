import { parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import type { DiscoveredFile } from '../scanner/file-discovery.js';
import type { ParseResult } from '../shared/types.js';
import { generateId, normalizePath } from '../shared/utils.js';
import { initTreeSitter } from '../parser/parser-registry.js';
import { parseFile, resolveParserLanguage } from '../parser/tree-sitter-parser.js';

interface WorkerRequest {
  id: number;
  rootPath: string;
  discovered: DiscoveredFile;
}

interface WorkerResponse {
  id: number;
  result: ParseResult | null;
  error: string | null;
}

parentPort?.on('message', async (message: WorkerRequest) => {
  const response: WorkerResponse = { id: message.id, result: null, error: null };
  try {
    process.env.CODE_MEMORY_PROJECT_ROOT = message.rootPath;
    response.result = await indexDiscoveredFile(message.discovered);
  } catch (err) {
    response.error = err instanceof Error ? err.stack || err.message : String(err);
  }
  parentPort?.postMessage(response);
});

async function indexDiscoveredFile(discovered: DiscoveredFile): Promise<ParseResult | null> {
  const parserLang = resolveParserLanguage(discovered.path);
  if (!parserLang) {
    if (discovered.role === 'config' || discovered.role === 'doc') {
      return {
        fileId: generateId('file', normalizePath(discovered.relativePath)),
        filePath: discovered.path,
        language: discovered.language,
        symbols: [],
        imports: [],
        exports: [],
        edges: [],
        calls: [],
        scopeBindings: [],
        typeRelations: [],
        chunks: [],
        errors: [],
      };
    }
    return null;
  }
  await initTreeSitter();
  const sourceCode = readFileSync(discovered.path, 'utf-8');
  return parseFile(
    discovered.path,
    sourceCode,
    parserLang,
    generateId('file', normalizePath(discovered.relativePath)),
  );
}
