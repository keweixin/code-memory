import { createLogger } from '../shared/logger.js';

const log = createLogger('embedding-queue');

export interface EmbeddingBatchGenerator {
  generateBatch(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingQueueOptions {
  batchSize: number;
  concurrency: number;
  retries: number;
  timeoutMs: number;
}

export class EmbeddingQueue {
  constructor(
    private readonly generator: EmbeddingBatchGenerator,
    private readonly options: EmbeddingQueueOptions,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const results = Array.from({ length: texts.length }, () => [] as number[]);
    const batches = chunk(
      texts.map((text, index) => ({ text, index })),
      Math.max(1, Math.floor(this.options.batchSize)),
    );
    let nextBatch = 0;
    const workerCount = Math.min(Math.max(1, Math.floor(this.options.concurrency)), batches.length);

    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextBatch < batches.length) {
        const batch = batches[nextBatch++];
        const vectors = await this.runBatch(batch.map((item) => item.text));
        for (let index = 0; index < batch.length; index++) {
          results[batch[index].index] = vectors[index] || [];
        }
      }
    }));

    return results;
  }

  private async runBatch(texts: string[]): Promise<number[][]> {
    const retries = Math.max(0, Math.floor(this.options.retries));
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await withTimeout(this.generator.generateBatch(texts), this.options.timeoutMs);
      } catch (err) {
        if (attempt >= retries) {
          log.warn('Embedding batch failed after retries: ' + (err instanceof Error ? err.message : String(err)));
          return texts.map(() => []);
        }
      }
    }
    return texts.map(() => []);
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise;
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Embedding request timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
