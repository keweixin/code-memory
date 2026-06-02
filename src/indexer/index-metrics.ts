export interface IndexPhaseMetrics {
  scanMs: number;
  parseMs: number;
  writeMs: number;
  edgeMs: number;
  vectorMs: number;
  communityMs: number;
  processMs: number;
  totalMs: number;
  peakRssMb: number;
}

export class IndexMetricsRecorder {
  private marks = new Map<string, number>();

  mark(name: string): void {
    this.marks.set(name, Date.now());
  }

  elapsed(from: string, to: string): number {
    const start = this.marks.get(from);
    const end = this.marks.get(to);
    return start !== undefined && end !== undefined ? end - start : 0;
  }

  peakRssMb(): number {
    return Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10;
  }
}
