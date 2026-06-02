import { describe, expect, it } from 'vitest';
import { resolveAutoWorkerCount } from '../src/indexer/index-manager.js';
import { resolveWorkerPoolSize } from '../src/indexer/parse-worker-pool.js';

describe('auto worker count', () => {
  it('keeps auto parsing parallelism bounded on high-core machines', () => {
    expect(resolveAutoWorkerCount(1)).toBe(1);
    expect(resolveAutoWorkerCount(2)).toBe(1);
    expect(resolveAutoWorkerCount(4)).toBe(3);
    expect(resolveAutoWorkerCount(9)).toBe(8);
    expect(resolveAutoWorkerCount(32)).toBe(8);
  });

  it('does not start more parse workers than files to parse', () => {
    expect(resolveWorkerPoolSize(8, 0)).toBe(0);
    expect(resolveWorkerPoolSize(8, 1)).toBe(1);
    expect(resolveWorkerPoolSize(8, 4)).toBe(4);
    expect(resolveWorkerPoolSize(8, 20)).toBe(8);
  });
});
