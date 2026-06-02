import { Worker } from 'node:worker_threads';
import type { DiscoveredFile } from '../scanner/file-discovery.js';
import type { ParseResult } from '../shared/types.js';

export interface ParseWorkerOptions {
  workers: number;
  rootPath: string;
}

export interface ParseWorkerResult {
  discovered: DiscoveredFile;
  result: ParseResult | null;
  error: unknown | null;
}

export const MAX_COLLECTING_PARSE_FILES = 500;

interface WorkerResponse {
  id: number;
  result: ParseResult | null;
  error: string | null;
}

interface PendingTask {
  id: number;
  discovered: DiscoveredFile;
  resolve: (value: ParseWorkerResult) => void;
}

export async function parseFilesWithWorkers(
  files: DiscoveredFile[],
  options: ParseWorkerOptions,
): Promise<ParseWorkerResult[]> {
  if (files.length > MAX_COLLECTING_PARSE_FILES) {
    throw new Error(
      'parseFilesWithWorkers collects all parse results in memory and is limited to ' +
      MAX_COLLECTING_PARSE_FILES + ' files. Use parseFilesWithWorkersBatched for large projects.',
    );
  }

  const results: ParseWorkerResult[] = [];
  for await (const batch of parseFilesWithWorkersBatched(files, {
    ...options,
    batchSize: files.length || 1,
  })) {
    results.push(...batch);
  }
  return results;
}

export async function* parseFilesWithWorkersBatched(
  files: DiscoveredFile[],
  options: ParseWorkerOptions & { batchSize: number },
): AsyncGenerator<ParseWorkerResult[]> {
  if (files.length === 0) return;
  const effectiveWorkers = resolveWorkerPoolSize(options.workers, files.length);
  const pool = new ParseWorkerPool(options.rootPath, effectiveWorkers);
  const batchSize = Math.max(1, Math.floor(options.batchSize));
  const maxInFlight = Math.max(1, Math.max(effectiveWorkers, batchSize));
  const inFlight = new Set<Promise<ParseWorkerResult>>();
  let nextFileIndex = 0;
  let batch: ParseWorkerResult[] = [];

  const enqueue = () => {
    while (nextFileIndex < files.length && inFlight.size < maxInFlight) {
      const promise = pool.run(files[nextFileIndex++]);
      inFlight.add(promise);
    }
  };

  try {
    enqueue();
    while (inFlight.size > 0) {
      const settled = await Promise.race(
        [...inFlight].map((promise) => promise.then((result) => ({ promise, result }))),
      );
      inFlight.delete(settled.promise);
      batch.push(settled.result);
      enqueue();

      if (batch.length >= batchSize) {
        yield batch;
        batch = [];
      }
    }

    if (batch.length > 0) yield batch;
  } finally {
    await pool.close();
  }
}

export function resolveWorkerPoolSize(requestedWorkers: number, fileCount: number): number {
  const files = Math.max(0, Math.floor(fileCount));
  if (files === 0) return 0;
  const workers = Math.max(1, Math.floor(requestedWorkers));
  return Math.max(1, Math.min(workers, files));
}

class ParseWorkerPool {
  private rootPath: string;
  private workers: Worker[] = [];
  private idleWorkers: Worker[] = [];
  private queue: PendingTask[] = [];
  private taskByWorker = new Map<Worker, PendingTask>();
  private nextId = 1;

  constructor(rootPath: string, size: number) {
    this.rootPath = rootPath;
    for (let i = 0; i < size; i++) this.addWorker();
  }

  run(discovered: DiscoveredFile): Promise<ParseWorkerResult> {
    return new Promise((resolve) => {
      const task = { id: this.nextId++, discovered, resolve };
      this.queue.push(task);
      this.pump();
    });
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.terminate()));
  }

  private addWorker(): void {
    const worker = new Worker(new URL('./parse-worker.js', import.meta.url));
    worker.on('message', (message: WorkerResponse) => this.handleMessage(worker, message));
    worker.on('error', (error) => this.handleFailure(worker, error));
    worker.on('exit', (code) => {
      if (code !== 0) this.handleFailure(worker, new Error('Parse worker exited with code ' + code));
    });
    this.workers.push(worker);
    this.idleWorkers.push(worker);
  }

  private pump(): void {
    while (this.idleWorkers.length > 0 && this.queue.length > 0) {
      const worker = this.idleWorkers.shift()!;
      const task = this.queue.shift()!;
      this.taskByWorker.set(worker, task);
      worker.postMessage({
        id: task.id,
        rootPath: this.rootPath,
        discovered: task.discovered,
      });
    }
  }

  private handleMessage(worker: Worker, message: WorkerResponse): void {
    const task = this.taskByWorker.get(worker);
    if (!task || task.id !== message.id) return;
    this.taskByWorker.delete(worker);
    this.idleWorkers.push(worker);
    task.resolve({
      discovered: task.discovered,
      result: message.result,
      error: message.error ? new Error(message.error) : null,
    });
    this.pump();
  }

  private handleFailure(worker: Worker, error: unknown): void {
    const task = this.taskByWorker.get(worker);
    this.taskByWorker.delete(worker);
    this.idleWorkers = this.idleWorkers.filter((idle) => idle !== worker);
    this.workers = this.workers.filter((item) => item !== worker);
    if (task) {
      task.resolve({ discovered: task.discovered, result: null, error });
    }
    if (this.queue.length > 0) this.addWorker();
    this.pump();
  }
}
