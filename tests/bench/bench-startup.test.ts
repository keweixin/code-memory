import { describe, it, expect } from 'vitest';

describe('bench: startup', () => {
  it('measures module load time', async () => {
    const startMs = performance.now();
    await import('../../src/cli/cli.js');
    const elapsedMs = performance.now() - startMs;

    console.log(`Module load time: ${elapsedMs.toFixed(0)}ms`);
    expect(elapsedMs).toBeLessThan(3000);
  });
});
