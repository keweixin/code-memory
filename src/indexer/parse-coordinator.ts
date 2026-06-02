import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ParseResult } from '../shared/types.js';
import type { DiscoveredFile } from '../scanner/file-discovery.js';
import { parseFilesWithWorkersBatched } from './parse-worker-pool.js';

export interface ParseBatchItem {
  discovered: DiscoveredFile;
  result: ParseResult | null;
  error: unknown | null;
}

export interface ParseCoordinatorOptions {
  workers: number;
  rootPath: string;
  batchSize: number;
  parseFile: (discovered: DiscoveredFile) => Promise<ParseResult | null>;
}

export async function* parseDiscoveredFilesBatched(
  files: DiscoveredFile[],
  options: ParseCoordinatorOptions,
): AsyncGenerator<ParseBatchItem[]> {
  if (files.length === 0) return;

  const workerEntry = fileURLToPath(new URL('./parse-worker.js', import.meta.url));
  if (options.workers > 0 && existsSync(workerEntry)) {
    yield* parseFilesWithWorkersBatched(files, {
      workers: options.workers,
      rootPath: options.rootPath,
      batchSize: options.batchSize,
    });
    return;
  }

  let batch: ParseBatchItem[] = [];
  for (const discovered of files) {
    try {
      batch.push({ discovered, result: await options.parseFile(discovered), error: null });
    } catch (error) {
      batch.push({ discovered, result: null, error });
    }
    if (batch.length >= options.batchSize) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}
