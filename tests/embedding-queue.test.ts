import { describe, expect, it, vi } from 'vitest';
import { EmbeddingQueue } from '../src/indexer/embedding-queue.js';

describe('EmbeddingQueue', () => {
  it('preserves input order across concurrent batches', async () => {
    const generator = {
      generateBatch: vi.fn(async (texts: string[]) => texts.map((text) => [text.length])),
    };
    const queue = new EmbeddingQueue(generator, {
      batchSize: 2,
      concurrency: 2,
      retries: 0,
      timeoutMs: 1000,
    });

    await expect(queue.embed(['a', 'bb', 'ccc'])).resolves.toEqual([[1], [2], [3]]);
  });

  it('returns empty vectors after retry exhaustion', async () => {
    const generator = {
      generateBatch: vi.fn(async () => {
        throw new Error('provider down');
      }),
    };
    const queue = new EmbeddingQueue(generator, {
      batchSize: 2,
      concurrency: 1,
      retries: 1,
      timeoutMs: 1000,
    });

    await expect(queue.embed(['a', 'b'])).resolves.toEqual([[], []]);
    expect(generator.generateBatch).toHaveBeenCalledTimes(2);
  });
});
