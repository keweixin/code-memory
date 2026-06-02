import { describe, expect, it, vi } from 'vitest';
import { IndexMetricsRecorder } from '../src/indexer/index-metrics.js';

describe('IndexMetricsRecorder', () => {
  it('records elapsed time between marks', () => {
    vi.useFakeTimers();
    try {
      const recorder = new IndexMetricsRecorder();
      recorder.mark('start');
      vi.advanceTimersByTime(42);
      recorder.mark('end');

      expect(recorder.elapsed('start', 'end')).toBe(42);
      expect(recorder.elapsed('missing', 'end')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports current RSS in megabytes', () => {
    const recorder = new IndexMetricsRecorder();
    expect(recorder.peakRssMb()).toBeGreaterThan(0);
  });
});
